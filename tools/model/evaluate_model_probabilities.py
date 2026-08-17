"""Inspect held-out handwriting probability calibration on the authorized samples."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image


ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "tests" / "fixtures" / "worksheets"
MODEL_DIR = ROOT / "public" / "models"
SIZE = 512


def image_tensor(path: Path) -> np.ndarray:
    with Image.open(path) as image:
        resized = image.convert("RGB").resize((SIZE, SIZE), Image.Resampling.BILINEAR)
    return np.asarray(resized, dtype=np.float32).transpose(2, 0, 1)[None] / 255.0


def mask_array(path: Path) -> np.ndarray:
    with Image.open(path) as image:
        resized = image.convert("L").resize((SIZE, SIZE), Image.Resampling.NEAREST)
    return np.asarray(resized) >= 128


manifest = json.loads((FIXTURES / "manifest.json").read_text(encoding="utf-8"))
for sample in manifest["samples"]:
    session = ort.InferenceSession(
        MODEL_DIR / "folds" / f"{sample['id']}.int8.onnx",
        providers=["CPUExecutionProvider"],
    )
    probabilities = session.run(["mask"], {"input": image_tensor(FIXTURES / sample["written"])})[0][0]
    truth = mask_array(FIXTURES / sample["mask"])
    positive = probabilities[truth]
    negative = probabilities[~truth]
    percentiles = (10, 50, 90, 99)
    print(sample["id"])
    print("  handwriting", {value: round(float(np.percentile(positive, value)), 4) for value in percentiles})
    print("  background ", {value: round(float(np.percentile(negative, value)), 4) for value in percentiles})
    print("  coverage   ", {
        threshold: round(float(np.mean(positive >= threshold)), 4)
        for threshold in (0.05, 0.1, 0.15, 0.2, 0.3, 0.45, 0.85)
    })
