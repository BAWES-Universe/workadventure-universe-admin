#!/usr/bin/env python3
"""Read a PNG on stdin, write lossless WebP, and assert decoded RGBA identity."""

import io
import sys
from pathlib import Path

from PIL import Image


def convert(png_bytes: bytes, destination: Path) -> None:
    with Image.open(io.BytesIO(png_bytes)) as original:
        source = original.convert("RGBA")
        source.save(destination, format="WEBP", lossless=True, exact=True, method=6)
        with Image.open(destination) as encoded:
            decoded = encoded.convert("RGBA")
            if decoded.size != source.size or decoded.tobytes() != source.tobytes():
                destination.unlink(missing_ok=True)
                raise AssertionError("Lossless WebP differs from the PNG screenshot")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: qa-orbit-lossless-webp.py OUTPUT.webp < SCREENSHOT.png")
    convert(sys.stdin.buffer.read(), Path(sys.argv[1]))
