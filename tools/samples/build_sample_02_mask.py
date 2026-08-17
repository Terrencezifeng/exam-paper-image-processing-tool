"""Build the manually guided handwriting mask for sample-02."""

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
    stroke = max(8, round(width * 0.0032))

    def point(x: float, y: float) -> tuple[int, int]:
        return round(x * width), round(y * height)

    def line(values: list[tuple[float, float]]) -> None:
        draw.line([point(x, y) for x, y in values], fill=255, width=stroke, joint="curve")

    def letter_c(box: tuple[float, float, float, float]) -> None:
        x0, y0, x1, y1 = box
        draw.arc((*point(x0, y0), *point(x1, y1)), start=45, end=315, fill=255, width=stroke)

    # Question 9: circled printed term and B answer.
    draw.ellipse((*point(0.391, 0.061), *point(0.438, 0.088)), outline=255, width=stroke)
    line([(0.604, 0.091), (0.604, 0.066)])
    draw.arc((*point(0.596, 0.065), *point(0.626, 0.079)), start=-90, end=90, fill=255, width=stroke)
    draw.arc((*point(0.596, 0.077), *point(0.630, 0.094)), start=-90, end=90, fill=255, width=stroke)

    # Question 10 and question 11 answers.
    letter_c((0.462, 0.158, 0.500, 0.191))
    draw.ellipse((*point(0.478, 0.338), *point(0.536, 0.374)), outline=255, width=stroke)
    letter_c((0.694, 0.351, 0.730, 0.388))
    draw.rectangle((*point(0.404, 0.365), *point(0.480, 0.397)), fill=255)

    # Question 12 answer, underline, and arrow beside the IP address.
    letter_c((0.305, 0.431, 0.349, 0.466))
    line([(0.607, 0.434), (0.693, 0.439)])
    line([(0.704, 0.416), (0.727, 0.469)])

    # Question 13 annotations around the flowchart.
    draw.rectangle((*point(0.568, 0.615), *point(0.642, 0.652)), fill=255)
    draw.rectangle((*point(0.370, 0.650), *point(0.420, 0.686)), fill=255)
    draw.rectangle((*point(0.430, 0.750), *point(0.495, 0.790)), fill=255)

    guide_array = np.asarray(guide) > 0
    gray = np.asarray(written.convert("L"), dtype=np.uint8)
    candidate = guide_array & (gray < 135)
    candidate = ndimage.binary_closing(candidate, structure=np.ones((2, 2)))
    labels, count = ndimage.label(candidate)
    if count:
        sizes = np.bincount(labels.ravel())
        candidate = (labels > 0) & (sizes[labels] >= 8)
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
