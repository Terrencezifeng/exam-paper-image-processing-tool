"""Build the manually guided handwriting mask for sample-04."""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from scipy import ndimage


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("clean", type=Path)
    parser.add_argument("written", type=Path)
    parser.add_argument("mask", type=Path)
    parser.add_argument("--preview", type=Path)
    args = parser.parse_args()

    clean = Image.open(args.clean)
    written = Image.open(args.written).convert("RGB")
    if clean.size != written.size:
        raise SystemExit("Clean and written images must have identical dimensions")

    width, height = written.size
    safe_guide = Image.new("L", written.size, 0)
    narrow_guide = Image.new("L", written.size, 0)
    dense_guide = Image.new("L", written.size, 0)
    safe = ImageDraw.Draw(safe_guide)
    overlap = ImageDraw.Draw(narrow_guide)
    dense = ImageDraw.Draw(dense_guide)
    stroke = max(9, round(width * 0.0035))

    def point(x: float, y: float) -> tuple[int, int]:
        return round(x * width), round(y * height)

    def line(draw: ImageDraw.ImageDraw, values: list[tuple[float, float]], scale: float = 1.0) -> None:
        draw.line(
            [point(x, y) for x, y in values],
            fill=255,
            width=max(1, round(stroke * scale)),
            joint="curve",
        )

    # Question 1: circle, C answer, strike-through, and the freehand drawing.
    overlap.ellipse((*point(0.532, 0.274), *point(0.603, 0.304)), outline=255, width=stroke)
    overlap.arc((*point(0.615, 0.275), *point(0.675, 0.307)), start=45, end=315, fill=255, width=stroke)
    line(overlap, [(0.283, 0.298), (0.350, 0.310), (0.472, 0.326)], 0.75)
    safe.rectangle((*point(0.650, 0.319), *point(0.770, 0.388)), fill=255)

    # Question 2: selected answer, long underline, and leading sweep.
    safe.rectangle((*point(0.318, 0.400), *point(0.382, 0.448)), fill=255)
    line(overlap, [(0.775, 0.401), (0.895, 0.410)], 0.75)
    line(overlap, [(0.178, 0.420), (0.220, 0.435), (0.295, 0.438)], 0.75)

    # Dense margin notes. The lower lines touch printed question 3 and therefore
    # use the stricter overlap threshold.
    safe.rectangle((*point(0.632, 0.423), *point(0.910, 0.487)), fill=255)
    dense.rectangle((*point(0.632, 0.483), *point(0.920, 0.548)), fill=255)
    line(overlap, [(0.355, 0.505), (0.380, 0.520), (0.410, 0.524), (0.440, 0.512), (0.470, 0.523), (0.512, 0.510)])

    # Question 4 circles plus calculations in the open right column.
    overlap.ellipse((*point(0.205, 0.584), *point(0.408, 0.626)), outline=255, width=stroke)
    safe.rectangle((*point(0.455, 0.584), *point(0.515, 0.628)), fill=255)
    safe.rectangle((*point(0.630, 0.565), *point(0.920, 0.678)), fill=255)

    # Question 5 leading check and circled printed term.
    line(safe, [(0.137, 0.687), (0.150, 0.711), (0.175, 0.715), (0.207, 0.676)])
    overlap.ellipse((*point(0.645, 0.669), *point(0.722, 0.706)), outline=255, width=stroke)

    gray = np.asarray(written.convert("L"), dtype=np.uint8)
    candidate = (
        ((np.asarray(safe_guide) > 0) & (gray < 132))
        | ((np.asarray(narrow_guide) > 0) & (gray < 132))
        | ((np.asarray(dense_guide) > 0) & (gray < 82))
    )
    candidate = ndimage.binary_closing(candidate, structure=np.ones((2, 2)))
    labels, count = ndimage.label(candidate)
    if count:
        sizes = np.bincount(labels.ravel())
        candidate = (labels > 0) & (sizes[labels] >= 7)

    mask = Image.fromarray(np.where(candidate, 255, 0).astype(np.uint8), mode="L")
    args.mask.parent.mkdir(parents=True, exist_ok=True)
    mask.save(args.mask, optimize=True)

    if args.preview:
        overlay_image = written.copy()
        red = Image.new("RGB", written.size, (255, 20, 20))
        alpha = mask.filter(ImageFilter.MaxFilter(3)).point(lambda value: 150 if value else 0)
        overlay_image.paste(red, mask=alpha)
        overlay_image.thumbnail((1200, 1600))
        args.preview.parent.mkdir(parents=True, exist_ok=True)
        overlay_image.save(args.preview, quality=92)


if __name__ == "__main__":
    main()
