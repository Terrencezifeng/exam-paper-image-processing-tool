"""Create a privacy-sanitized repository copy of a worksheet photo."""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageOps


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--crop-height", type=int, required=True)
    args = parser.parse_args()

    with Image.open(args.source) as source:
        image = ImageOps.exif_transpose(source).convert("RGB")

    if not 1 <= args.crop_height <= image.height:
        raise ValueError(f"crop height must be between 1 and {image.height}")

    sanitized = image.crop((0, 0, image.width, args.crop_height))
    args.destination.parent.mkdir(parents=True, exist_ok=True)
    sanitized.save(
        args.destination,
        format="JPEG",
        quality=95,
        subsampling=0,
        optimize=True,
    )

    with Image.open(args.destination) as output:
        if output.getexif():
            raise RuntimeError("sanitized output unexpectedly contains EXIF metadata")


if __name__ == "__main__":
    main()
