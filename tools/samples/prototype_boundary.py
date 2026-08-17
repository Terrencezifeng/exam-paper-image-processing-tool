from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage


ROOT = Path(__file__).resolve().parents[2]


def inspect(path: Path) -> None:
    image = Image.open(path).convert("RGB")
    image.thumbnail((300, 300))
    rgb = np.asarray(image, dtype=np.float32)
    luminance = rgb @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    saturation = rgb.max(axis=2) - rgb.min(axis=2)
    print(path.parent.name, rgb.shape[:2])
    for percentile in (20, 30, 40, 50):
        threshold = np.percentile(luminance, percentile)
        candidate = (luminance >= threshold) & (saturation <= 55)
        candidate = ndimage.binary_closing(candidate, iterations=2)
        candidate = ndimage.binary_fill_holes(candidate)
        labels, count = ndimage.label(candidate)
        objects = ndimage.find_objects(labels)
        components = []
        for label, slices in enumerate(objects, 1):
            if slices is None:
                continue
            area = int(np.count_nonzero(labels[slices] == label))
            if area < candidate.size * 0.02:
                continue
            y_slice, x_slice = slices
            components.append((
                area / candidate.size,
                x_slice.start / candidate.shape[1],
                y_slice.start / candidate.shape[0],
                x_slice.stop / candidate.shape[1],
                y_slice.stop / candidate.shape[0],
            ))
        print(percentile, sorted(components, reverse=True)[:3])

    smooth = ndimage.gaussian_filter(luminance, 1.0)
    gradient_x = ndimage.sobel(smooth, axis=1) / 8
    gradient_y = ndimage.sobel(smooth, axis=0) / 8

    def hough(gradient, scan_axis, start, end, sign):
        slopes = np.linspace(-0.08, 0.08, 81)
        bin_size = 0.004
        bins = int(1.25 / bin_size)
        best = None
        scans = gradient.shape[0] if scan_axis == 0 else gradient.shape[1]
        cross = gradient.shape[1] if scan_axis == 0 else gradient.shape[0]
        for slope in slopes:
            strength = np.zeros(bins, dtype=np.float32)
            support = np.zeros(bins, dtype=np.int32)
            for scan in range(scans):
                line = gradient[scan, :] if scan_axis == 0 else gradient[:, scan]
                indices = np.flatnonzero((sign * line > 4) &
                                         (np.arange(cross) >= max(.015, start) * cross) &
                                         (np.arange(cross) < end * cross))
                if not len(indices):
                    continue
                intercepts = indices / cross - slope * (scan / scans)
                line_bins = np.clip((intercepts / bin_size).astype(int), 0, bins - 1)
                row_strength = np.zeros(bins, dtype=np.float32)
                np.maximum.at(row_strength, line_bins, np.minimum(40, sign * line[indices]))
                present = row_strength > 0
                strength[present] += row_strength[present]
                support[present] += 1
            score = support + strength / 200 - abs(slope) * 200
            index = int(np.argmax(score))
            candidate = (float(score[index]), float(slope), index * bin_size, int(support[index]))
            if best is None or candidate > best:
                best = candidate
        return best

    print("hough", {
        "left": hough(gradient_x, 0, 0, .4, 1),
        "right": hough(gradient_x, 0, .6, 1, -1),
        "top": hough(gradient_y, 1, 0, .35, 1),
        "bottom": hough(gradient_y, 1, .65, 1, -1),
    })


for sample in sorted((ROOT / "tests/fixtures/worksheets").glob("sample-*/sample-*.clean.jpg")):
    inspect(sample)
