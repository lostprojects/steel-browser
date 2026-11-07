#!/usr/bin/env python3
"""Validate the owner's Muse media content before publishing its outputs.

Runs the installed create-muse-animation scripts in a private staging directory.
This local runtime prerequisite does not submit generations, provide a shell to
agents, or constitute durable jobs, hosted compute or human creative approval.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile

import numpy as np
from PIL import Image, __version__ as pillow_version

VERSION = "1.0.0"
MAX_EDGE = 1440
MAX_INPUT_BYTES = 100 * 1024 * 1024
MAX_SECONDS = 12
MAX_FRAMES = 360
SCRIPTS = ("prepare_still.py", "video_to_alpha.sh")


def digest(file: Path) -> str:
    checksum = hashlib.sha256()
    with file.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            checksum.update(chunk)
    return checksum.hexdigest()


def run(argv: list[str], timeout: int = 60) -> bytes:
    """Bound the subprocess lifetime and stop its descendants on interruption."""
    with tempfile.TemporaryDirectory(prefix="toolstack-muse-command-") as scratch, \
            tempfile.TemporaryFile(dir=scratch) as log:
        environment = {**os.environ, "TMPDIR": scratch,
                       "PATH": str(Path(sys.executable).parent) + os.pathsep + os.environ.get("PATH", "")}
        process = subprocess.Popen(argv, stdout=log, stderr=log, start_new_session=True,
                                   env=environment)
        try:
            status = process.wait(timeout=timeout)
        except BaseException:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
            raise
        log.seek(0, os.SEEK_END)
        size = log.tell()
        log.seek(max(0, size - 16_384))
        output = log.read()
        if status:
            raise RuntimeError(f"{Path(argv[0]).name} exited {status}: "
                               + output.decode("utf-8", errors="replace"))
        if size > 1_000_000:
            raise ValueError("A runtime command exceeded its diagnostic output budget")
        return output


def executable(name: str) -> str:
    found = shutil.which(name)
    if not found:
        raise ValueError(f"Required executable is unavailable: {name}")
    return found


def sources(root: Path) -> dict[str, str]:
    scripts = root.resolve() / "scripts"
    result = {}
    for name in SCRIPTS:
        file = scripts / name
        if not file.is_file() or file.is_symlink():
            raise ValueError(f"Required installed skill script is unavailable: {file}")
        result[name] = digest(file)
    return result


def preflight(root: Path, encode: bool) -> dict:
    provenance = sources(root)
    result = {"runtimeVersion": VERSION, "skillRoot": str(root.resolve()),
              "sourceSha256": provenance, "python": sys.version.split()[0],
              "numpy": np.__version__, "pillow": pillow_version}
    if encode:
        if sys.platform != "darwin":
            raise ValueError("HEVC alpha requires the macOS VideoToolbox runtime")
        ffmpeg, ffprobe = executable("ffmpeg"), executable("ffprobe")
        encoders = run([ffmpeg, "-hide_banner", "-encoders"]).decode()
        for encoder in ("hevc_videotoolbox", "libvpx-vp9"):
            if not re.search(r"\b" + encoder + r"\b", encoders):
                raise ValueError(f"Required system ffmpeg encoder is unavailable: {encoder}")
        result.update(ffmpeg=ffmpeg, ffprobe=ffprobe,
                      ffmpegVersion=run([ffmpeg, "-version"]).decode().splitlines()[0])
    return result


def input_file(file: Path) -> Path:
    file = file.resolve(strict=True)
    if not file.is_file() or not 0 < file.stat().st_size <= MAX_INPUT_BYTES:
        raise ValueError("Input must be a nonempty regular file of at most 100 MiB")
    return file


def video_info(file: Path) -> dict:
    value = json.loads(run([executable("ffprobe"), "-v", "error", "-select_streams", "v",
                           "-show_entries", "stream=codec_name,codec_tag_string,width,height,avg_frame_rate,nb_frames:format=duration",
                           "-of", "json", str(file)]))
    if len(value.get("streams", [])) != 1:
        raise ValueError("A clip must contain exactly one video stream")
    stream = value["streams"][0]
    width, height = stream["width"], stream["height"]
    duration = float(value["format"]["duration"])
    num, den = map(int, stream["avg_frame_rate"].split("/"))
    fps = num / den if den else 0
    if (not math.isfinite(duration) or not 0 < duration <= MAX_SECONDS
            or not 64 <= width <= MAX_EDGE or not 64 <= height <= MAX_EDGE
            or width % 2 or height % 2 or not 0 < fps <= 30
            or math.ceil(duration * fps) > MAX_FRAMES):
        raise ValueError("Clip exceeds the 1440px, 12s, 30fps or 360-frame budget")
    return {**stream, "duration": duration, "fps": fps}


def alpha_check(file: Path) -> dict:
    with Image.open(file) as image:
        if image.mode != "RGBA":
            raise ValueError(f"Missing alpha channel: {file.name}")
        alpha = np.asarray(image.getchannel("A"))
    corners = [int(alpha[y, x]) for y, x in [(5, 5), (5, -6), (-6, 5), (-6, -6)]]
    clear, solid = int(np.count_nonzero(alpha < 5)), int(np.count_nonzero(alpha > 250))
    if any(corners) or clear <= 1000 or solid <= 1000:
        raise ValueError(f"Alpha validation failed for {file.name}: corners={corners}, "
                         f"clear={clear}, solid={solid}")
    return {"cornerAlpha": corners, "clearPixels": clear, "solidPixels": solid}


def loop_check(file: Path, decoder: list[str], root: Path) -> dict:
    # The recoloured video has constant RGB; motion lives in alpha. Compare every
    # native matte frame so an opaque colour plane cannot conceal a visible cut.
    # The small rendition keeps memory independent of clip resolution.
    raw = root / "loop.gray"
    run([executable("ffmpeg"), "-v", "error", "-threads", "2", *decoder,
         "-i", str(file), "-an", "-vf", "alphaextract,scale=64:64,format=gray", "-pix_fmt", "gray",
         "-frames:v", str(MAX_FRAMES + 1),
         "-f", "rawvideo", "-y", str(raw)])
    first = previous = None
    maximum = 0.0
    count = 0
    with raw.open("rb") as stream:
        while data := stream.read(4096):
            if len(data) != 4096 or count >= MAX_FRAMES:
                raise ValueError("Decoded clip exceeds its frame budget or has an incomplete frame")
            frame = np.frombuffer(data, dtype=np.uint8).astype(np.int16)
            if first is None:
                first = frame
            else:
                maximum = max(maximum, float(np.abs(frame - previous).mean()))
            previous = frame
            count += 1
    raw.unlink()
    if count < 2:
        raise ValueError("A looping clip requires at least two decoded frames")
    seam = float(np.abs(first - previous).mean())
    if seam > maximum * 1.05 + 0.001:
        raise ValueError(f"Visible loop seam: {seam:.4f}, maximum native delta {maximum:.4f}")
    return {"frames": count, "sampleSize": "64x64", "seamDelta": seam,
            "maxConsecutiveDelta": maximum, "passed": True}


def verify_video(file: Path, root: Path, expected: str) -> dict:
    info = video_info(file)
    if info["codec_name"] != expected:
        raise ValueError(f"Unexpected codec in {file.name}")
    if expected == "hevc" and info.get("codec_tag_string") != "hvc1":
        raise ValueError("Safari HEVC output requires the hvc1 tag")
    decoder = ["-c:v", "libvpx-vp9"] if expected == "vp9" else []
    samples = []
    for ordinal, fraction in enumerate((0, 0.25, 0.5, 0.75)):
        frame = root / f"{expected}-{ordinal}.png"
        run([executable("ffmpeg"), "-v", "error", "-threads", "2", *decoder,
             "-ss", str(info["duration"] * fraction), "-i", str(file), "-frames:v", "1",
             "-pix_fmt", "rgba", "-y", str(frame)])
        samples.append(alpha_check(frame))
        frame.unlink()
    return {"codec": expected, "alphaSamples": samples,
            "loop": loop_check(file, decoder, root)}


def publish(operation: str, root: Path, source: Path, destination: Path,
            size: int = MAX_EDGE, ink: str = "1b2436") -> dict:
    source = input_file(source)
    destination = destination.absolute()
    if destination.exists() or destination.is_symlink():
        raise FileExistsError(f"Output directory already exists: {destination}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    provenance = preflight(root, operation == "encode")
    source_hash = digest(source)
    with tempfile.TemporaryDirectory(prefix="toolstack-muse-") as scratch:
        stage = Path(scratch)
        output = stage / "published"
        output.mkdir(mode=0o700)
        if operation == "prepare":
            if not 64 <= size <= MAX_EDGE:
                raise ValueError("Still size must be between 64 and 1440px")
            with Image.open(source) as image:
                if image.format != "PNG" or max(image.size) > MAX_EDGE:
                    raise ValueError("The bounded still runtime accepts PNG inputs up to 1440px")
            run([sys.executable, str(root / "scripts/prepare_still.py"), str(source),
                 str(output / "still.png"), "--ground", "white", "--size", str(size)])
            with Image.open(output / "still.png") as image:
                if image.mode != "RGB" or image.width != image.height or image.width > MAX_EDGE:
                    raise ValueError("Prepared still is not an opaque, bounded square")
                pixels = np.asarray(image)
                border = np.concatenate([pixels[0], pixels[-1], pixels[:, 0], pixels[:, -1]])
                if np.any(border != 255) or pixels.min() != 0:
                    raise ValueError("Prepared still requires pure white borders and black ink")
                validation = {"width": image.width, "height": image.height,
                              "opaque": True, "whiteBorder": True, "blackInk": True}
        else:
            if not re.fullmatch(r"[a-fA-F0-9]{6}", ink):
                raise ValueError("Ink must contain exactly six hexadecimal digits")
            video_info(source)
            run([executable("bash"), str(root / "scripts/video_to_alpha.sh"), "-i",
                 str(source), "-o", str(output / "animation"), "-k", ink.lower()], timeout=240)
            validation = {"mov": verify_video(output / "animation.mov", stage, "hevc"),
                          "webm": verify_video(output / "animation.webm", stage, "vp9"),
                          "poster": alpha_check(output / "animation.png")}
        if sources(root) != provenance["sourceSha256"] or digest(source) != source_hash:
            raise ValueError("The source or installed runtime changed during execution")
        artifacts = [{"name": p.name, "bytes": p.stat().st_size, "sha256": digest(p)}
                     for p in sorted(output.iterdir())]
        result = {"runtimeVersion": VERSION, "operation": operation, "sourceSha256": source_hash,
                  "method": provenance, "validation": validation, "artifacts": artifacts,
                  "reviewStatus": "candidate", "outputDirectory": str(destination)}
        (output / "validation.json").write_text(json.dumps(result, indent=2) + "\n")
        # Copy privately to the destination filesystem, then rename the complete
        # directory. Failed checks never publish a subset of playable outputs.
        with tempfile.TemporaryDirectory(prefix=".muse-publish-", dir=destination.parent) as incoming:
            ready = Path(incoming) / "ready"
            shutil.copytree(output, ready)
            for file in ready.iterdir():
                file.chmod(0o600)
            if destination.exists() or destination.is_symlink():
                raise FileExistsError(f"Output directory already exists: {destination}")
            ready.rename(destination)
        return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["doctor", "prepare", "encode"])
    parser.add_argument("--skill-root", type=Path,
                        default=os.environ.get("TOOLSTACK_MUSE_ANIMATION_SKILL"))
    parser.add_argument("--input", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--size", type=int, default=MAX_EDGE)
    parser.add_argument("--ink", default="1b2436")
    args = parser.parse_args()
    if not args.skill_root:
        parser.error("Set TOOLSTACK_MUSE_ANIMATION_SKILL or --skill-root")
    root = args.skill_root.resolve(strict=True)
    if args.operation == "doctor":
        result = preflight(root, True)
    else:
        if not args.input or not args.output:
            parser.error("--input and --output are required")
        result = publish(args.operation, root, args.input, args.output, args.size, args.ink)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
