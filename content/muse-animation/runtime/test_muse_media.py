"""Publication checks for the owner's installed Muse animation runtime."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image

import muse_media as media


class MediaPublicationTests(unittest.TestCase):
    def test_opaque_video_frame_is_refused_even_when_it_has_an_alpha_channel(self):
        with tempfile.TemporaryDirectory() as scratch:
            frame = Path(scratch) / "opaque.png"
            Image.new("RGBA", (128, 128), (0, 0, 0, 255)).save(frame)
            with self.assertRaisesRegex(ValueError, "Alpha validation failed"):
                media.alpha_check(frame)

    def test_successful_script_cannot_publish_an_invalid_still(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            scripts = root / "skill/scripts"
            scripts.mkdir(parents=True)
            (scripts / "prepare_still.py").write_text(
                "import sys\nfrom PIL import Image\n"
                "Image.new('RGB', (128,128), 'white').save(sys.argv[2])\n"
            )
            (scripts / "video_to_alpha.sh").write_text("exit 0\n")
            source = root / "source.png"
            Image.new("RGB", (128, 128), "white").save(source)
            destination = root / "result"
            with self.assertRaisesRegex(ValueError, "white borders and black ink"):
                media.publish("prepare", root / "skill", source, destination, size=128)
            self.assertFalse(destination.exists())
            self.assertFalse(list(root.glob(".muse-publish-*")))

    def test_existing_output_is_preserved(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            source = root / "source.png"
            Image.new("RGB", (128, 128), "white").save(source)
            output = root / "existing"
            output.mkdir()
            sentinel = output / "asset.png"
            sentinel.write_bytes(b"existing-artwork")
            with self.assertRaises(FileExistsError):
                media.publish("prepare", root / "skill", source, output)
            self.assertEqual(sentinel.read_bytes(), b"existing-artwork")

    def test_unbounded_provider_clip_is_refused_before_encoding(self):
        oversized = {"streams": [{"width": 4096, "height": 4096, "avg_frame_rate": "60/1"}],
                     "format": {"duration": "60"}}
        with patch.object(media, "run", return_value=json.dumps(oversized).encode()), \
                patch.object(media, "executable", return_value="ffprobe"):
            with self.assertRaisesRegex(ValueError, "budget"):
                media.video_info(Path("clip.mp4"))

    def test_visible_loop_seam_is_refused(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)

            def frames(argv, **_kwargs):
                self.assertIn("alphaextract,scale=64:64,format=gray", argv)
                # Gradual motion, followed by an abrupt last-to-first cut.
                (root / "loop.gray").write_bytes(b"".join(bytes([v]) * 4096 for v in range(20)))

            with patch.object(media, "run", side_effect=frames), \
                    patch.object(media, "executable", return_value="ffmpeg"):
                with self.assertRaisesRegex(ValueError, "Visible loop seam"):
                    media.loop_check(Path("clip.mp4"), [], root)

    def test_subprocess_timeout_stops_waiting_work(self):
        with self.assertRaises(subprocess.TimeoutExpired):
            media.run([sys.executable, "-c", "import time; time.sleep(30)"], timeout=0.1)


if __name__ == "__main__":
    unittest.main()
