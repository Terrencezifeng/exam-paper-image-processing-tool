"""Build a reviewable handwriting mask from a clean/written worksheet pair."""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from scipy import ndimage


def homography(source: np.ndarray, target: np.ndarray) -> np.ndarray:
    rows = []
    values = []
    for (x, y), (u, v) in zip(source, target, strict=True):
        rows.extend([[x, y, 1, 0, 0, 0, -u * x, -u * y], [0, 0, 0, x, y, 1, -v * x, -v * y]])
        values.extend([u, v])
    coefficients = np.linalg.solve(np.asarray(rows, dtype=np.float64), np.asarray(values, dtype=np.float64))
    return np.append(coefficients, 1).reshape(3, 3)


def warp_clean(clean: Image.Image, clean_corners: np.ndarray, written_corners: np.ndarray) -> Image.Image:
    # Pillow expects output-to-input perspective coefficients.
    output_to_input = homography(written_corners, clean_corners)
    coefficients = output_to_input.flatten()[:8] / output_to_input[2, 2]
    return clean.transform(
        clean.size,
        Image.Transform.PERSPECTIVE,
        tuple(coefficients),
        Image.Resampling.BICUBIC,
    )


def align_local(clean: np.ndarray, written: np.ndarray) -> np.ndarray:
    """Refine page homography with a robust local translation."""
    clean_edges = np.hypot(ndimage.sobel(clean, axis=0), ndimage.sobel(clean, axis=1))
    written_edges = np.hypot(ndimage.sobel(written, axis=0), ndimage.sobel(written, axis=1))
    clean_edges = ndimage.gaussian_filter(clean_edges, 1.2)
    written_edges = ndimage.gaussian_filter(written_edges, 1.2)
    clean_edges -= clean_edges.mean()
    written_edges -= written_edges.mean()
    cross_power = np.fft.fft2(written_edges) * np.conj(np.fft.fft2(clean_edges))
    cross_power /= np.maximum(np.abs(cross_power), 1e-9)
    peak = np.unravel_index(np.argmax(np.fft.ifft2(cross_power).real), clean.shape)
    shift = np.asarray(peak, dtype=np.float64)
    shift[shift > np.asarray(clean.shape) / 2] -= np.asarray(clean.shape)[shift > np.asarray(clean.shape) / 2]
    shift = np.clip(shift, -36, 36)
    return ndimage.shift(clean, shift=shift, order=1, mode="nearest")


def build_mask(clean: Image.Image, written: Image.Image, regions: list[tuple[float, float, float, float]]) -> Image.Image:
    clean_gray = np.asarray(clean.convert("L"), dtype=np.int16)
    written_gray = np.asarray(written.convert("L"), dtype=np.int16)
    height, width = written_gray.shape
    mask = np.zeros((height, width), dtype=bool)

    for x0, y0, x1, y1 in regions:
        left, top = int(x0 * width), int(y0 * height)
        right, bottom = int(x1 * width), int(y1 * height)
        margin = 42
        outer_left, outer_top = max(0, left - margin), max(0, top - margin)
        outer_right, outer_bottom = min(width, right + margin), min(height, bottom + margin)
        clean_patch = clean_gray[outer_top:outer_bottom, outer_left:outer_right].astype(np.float64)
        written_patch = written_gray[outer_top:outer_bottom, outer_left:outer_right].astype(np.float64)
        clean_patch = align_local(clean_patch, written_patch)
        inner = (
            slice(top - outer_top, bottom - outer_top),
            slice(left - outer_left, right - outer_left),
        )
        local_clean = clean_patch[inner]
        local_written = written_patch[inner]
        stable = (local_clean > 90) & (local_written > 90)
        brightness_offset = np.median(local_written[stable] - local_clean[stable]) if np.any(stable) else 0
        difference = local_clean + brightness_offset - local_written
        dark_written = local_written < 172
        candidate = (difference > 38) & dark_written
        candidate = ndimage.binary_opening(candidate, structure=np.ones((2, 2)))
        candidate = ndimage.binary_closing(candidate, structure=np.ones((2, 2)))
        candidate = ndimage.binary_dilation(candidate, iterations=1)
        labels, count = ndimage.label(candidate)
        if count:
            sizes = np.bincount(labels.ravel())
            candidate = (labels > 0) & (sizes[labels] >= 10)
        mask[top:bottom, left:right] |= candidate

    return Image.fromarray(np.where(mask, 255, 0).astype(np.uint8), mode="L")


def guided_mask(written: Image.Image) -> Image.Image:
    """Trace the seven deliberate sample-01 marks and retain only dark ink pixels."""
    width, height = written.size
    guide = Image.new("L", written.size, 0)
    draw = ImageDraw.Draw(guide)
    stroke = max(8, round(width * 0.0032))

    def points(values: list[tuple[float, float]]) -> list[tuple[int, int]]:
        return [(round(x * width), round(y * height)) for x, y in values]

    def line(values: list[tuple[float, float]]) -> None:
        draw.line(points(values), fill=255, width=stroke, joint="curve")

    def right_arc(box: tuple[float, float, float, float]) -> None:
        x0, y0, x1, y1 = box
        center_x, center_y = (x0 + x1) / 2, (y0 + y1) / 2
        radius_x, radius_y = (x1 - x0) / 2, (y1 - y0) / 2
        values = []
        for angle in np.linspace(-np.pi / 2, np.pi / 2, 32):
            values.append((center_x + radius_x * np.cos(angle), center_y + radius_y * np.sin(angle)))
        line(values)

    # Question 1: A
    line([(0.704, 0.348), (0.714, 0.322), (0.728, 0.349)])
    line([(0.708, 0.338), (0.724, 0.338)])
    # Question 2: A
    line([(0.405, 0.497), (0.417, 0.469), (0.435, 0.497)])
    line([(0.410, 0.486), (0.430, 0.486)])
    # Question 3: circle and D
    draw.ellipse((round(0.199 * width), round(0.522 * height), round(0.231 * width), round(0.551 * height)), outline=255, width=stroke)
    line([(0.555, 0.583), (0.555, 0.555)])
    right_arc((0.548, 0.554, 0.574, 0.584))
    # Question 4: B and circle
    line([(0.283, 0.676), (0.283, 0.650)])
    right_arc((0.276, 0.649, 0.307, 0.663))
    right_arc((0.276, 0.661, 0.311, 0.676))
    draw.ellipse((round(0.722 * width), round(0.610 * height), round(0.791 * width), round(0.654 * height)), outline=255, width=stroke)
    # Question 5: C
    draw.arc((round(0.264 * width), round(0.731 * height), round(0.301 * width), round(0.761 * height)), start=45, end=315, fill=255, width=stroke)

    guide_array = np.asarray(guide) > 0
    written_gray = np.asarray(written.convert("L"), dtype=np.uint8)
    candidate = guide_array & (written_gray < 205)
    candidate = ndimage.binary_closing(candidate, structure=np.ones((2, 2)))
    labels, count = ndimage.label(candidate)
    if count:
        sizes = np.bincount(labels.ravel())
        candidate = (labels > 0) & (sizes[labels] >= 8)
    return Image.fromarray(np.where(candidate, 255, 0).astype(np.uint8), mode="L")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("clean", type=Path)
    parser.add_argument("written", type=Path)
    parser.add_argument("mask", type=Path)
    parser.add_argument("--preview", type=Path)
    args = parser.parse_args()

    clean = Image.open(args.clean).convert("RGB")
    written = Image.open(args.written).convert("RGB")
    if clean.size != written.size:
        raise SystemExit("Clean and written images must have identical dimensions")

    width, height = clean.size
    clean_corners = np.asarray([
        [0.064 * width, 0.046 * height], [0.912 * width, 0.057 * height],
        [0.966 * width, 0.973 * height], [0.024 * width, 0.957 * height],
    ])
    written_corners = np.asarray([
        [0.086 * width, 0.050 * height], [0.917 * width, 0.062 * height],
        [0.969 * width, 0.958 * height], [0.047 * width, 0.932 * height],
    ])
    aligned_clean = warp_clean(clean, clean_corners, written_corners)
    # Tight regions around the seven deliberate handwriting groups.
    regions = [
        (0.695, 0.325, 0.765, 0.375),
        (0.398, 0.463, 0.458, 0.508),
        (0.188, 0.522, 0.235, 0.557),
        (0.535, 0.564, 0.596, 0.612),
        (0.270, 0.645, 0.332, 0.695),
        (0.723, 0.612, 0.805, 0.662),
        (0.260, 0.728, 0.325, 0.778),
    ]
    mask = guided_mask(written)
    args.mask.parent.mkdir(parents=True, exist_ok=True)
    mask.save(args.mask, optimize=True)

    if args.preview:
        overlay = written.copy()
        red = Image.new("RGB", written.size, (255, 20, 20))
        alpha = mask.filter(ImageFilter.MaxFilter(3)).point(lambda value: 150 if value else 0)
        overlay.paste(red, mask=alpha)
        draw = ImageDraw.Draw(overlay)
        for region in regions:
            draw.rectangle((region[0] * width, region[1] * height, region[2] * width, region[3] * height), outline=(0, 220, 255), width=5)
        args.preview.parent.mkdir(parents=True, exist_ok=True)
        overlay.thumbnail((1200, 1600))
        overlay.save(args.preview, quality=92)


if __name__ == "__main__":
    main()
