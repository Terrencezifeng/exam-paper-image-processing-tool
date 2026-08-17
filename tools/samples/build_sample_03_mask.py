"""Build the manually guided handwriting mask for sample-03."""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from scipy import ndimage


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("written", type=Path)
    parser.add_argument("mask", type=Path)
    parser.add_argument("--preview", type=Path)
    args = parser.parse_args()

    written = Image.open(args.written).convert("RGB")
    width, height = written.size
    guide = Image.new("L", written.size, 0)
    draw = ImageDraw.Draw(guide)
    stroke = max(9, round(width * 0.0036))

    def point(x: float, y: float) -> tuple[int, int]:
        return round(x * width), round(y * height)

    def line(values: list[tuple[float, float]], scale: float = 1.0) -> None:
        draw.line(
            [point(x, y) for x, y in values],
            fill=255,
            width=max(1, round(stroke * scale)),
            joint="curve",
        )

    # Question 1: circled printed phrase, selected answer, and check mark.
    draw.ellipse((*point(0.374, 0.226), *point(0.432, 0.250)), outline=255, width=stroke)
    line([(0.844, 0.226), (0.844, 0.255)])
    draw.arc((*point(0.832, 0.224), *point(0.876, 0.256)), start=70, end=285, fill=255, width=stroke)
    line([(0.866, 0.228), (0.881, 0.246), (0.897, 0.220)])

    # Question 2: underline through print, selected answer, arrow, and margin note.
    line([(0.472, 0.359), (0.623, 0.373), (0.704, 0.369)])
    draw.rectangle((*point(0.655, 0.378), *point(0.700, 0.408)), fill=255)
    line([(0.684, 0.378), (0.753, 0.391), (0.800, 0.387)])
    line([(0.782, 0.357), (0.818, 0.401)])
    draw.rectangle((*point(0.802, 0.374), *point(0.921, 0.430)), fill=255)

    # Long free-response handwriting. These guides intentionally avoid printed
    # prompts while covering every handwritten baseline and circled item marker.
    draw.rectangle((*point(0.169, 0.545), *point(0.718, 0.620)), fill=255)
    draw.rectangle((*point(0.212, 0.653), *point(0.935, 0.778)), fill=255)

    guide_array = np.asarray(guide) > 0
    gray = np.asarray(written.convert("L"), dtype=np.uint8)
    candidate = guide_array & (gray < 128)
    candidate = ndimage.binary_closing(candidate, structure=np.ones((2, 2)))
    labels, count = ndimage.label(candidate)
    if count:
        sizes = np.bincount(labels.ravel())
        candidate = (labels > 0) & (sizes[labels] >= 7)

    mask = Image.fromarray(np.where(candidate, 255, 0).astype(np.uint8), mode="L")
    args.mask.parent.mkdir(parents=True, exist_ok=True)
    mask.save(args.mask, optimize=True)

    if args.preview:
        overlay = written.copy()
        red = Image.new("RGB", written.size, (255, 20, 20))
        alpha = mask.filter(ImageFilter.MaxFilter(3)).point(lambda value: 150 if value else 0)
        overlay.paste(red, mask=alpha)
        overlay.thumbnail((1200, 1600))
        args.preview.parent.mkdir(parents=True, exist_ok=True)
        overlay.save(args.preview, quality=92)


if __name__ == "__main__":
    main()
