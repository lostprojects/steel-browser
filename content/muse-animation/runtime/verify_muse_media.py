#!/usr/bin/env python3
"""Verify the owner's installed Muse scripts and codecs without a provider call.

Uses an existing reference only for an isolated static codec fixture. It does not
generate brand artwork, change the reference, or establish creative acceptance.
"""
import argparse
import json
from pathlib import Path
import tempfile

import muse_media as media


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skill-root", type=Path, required=True)
    parser.add_argument("--reference", type=Path, required=True)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="toolstack-muse-verify-") as scratch:
        root = Path(scratch)
        still = media.publish("prepare", args.skill_root.resolve(), args.reference,
                              root / "prepared")
        clip = root / "fixture.mp4"
        media.run([media.executable("ffmpeg"), "-v", "error", "-threads", "2", "-loop", "1",
                   "-i", str(root / "prepared/still.png"), "-t", "2", "-r", "12", "-an",
                   "-vf", "scale=256:256", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(clip)])
        encoded = media.publish("encode", args.skill_root.resolve(), clip, root / "encoded")
        for result in (still, encoded):
            for artifact in result["artifacts"]:
                file = Path(result["outputDirectory"]) / artifact["name"]
                assert media.digest(file) == artifact["sha256"]
        print(json.dumps({"passed": True, "runtimeVersion": media.VERSION,
                          "checks": ["established-still-script", "opaque-white-preparation",
                                     "established-alpha-script", "HEVC-alpha-four-frame-decode",
                                     "VP9-alpha-four-frame-decode", "poster-alpha",
                                     "native-frame-loop-check", "artifact-checksums"],
                          "sourceSha256": encoded["method"]["sourceSha256"],
                          "outputCount": len(still["artifacts"]) + len(encoded["artifacts"]),
                          "temporaryOutputPaths": [still["outputDirectory"], encoded["outputDirectory"]],
                          "outputsRemovedOnExit": True, "providerCalls": 0}, indent=2))


if __name__ == "__main__":
    main()
