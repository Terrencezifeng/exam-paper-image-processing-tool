"""Train and export the local worksheet models from four authorized sample pairs."""

from __future__ import annotations

import argparse
import hashlib
import json
import random
from pathlib import Path

import numpy as np
import torch
from PIL import Image, ImageEnhance
from torch import nn
from torch.utils.data import DataLoader, Dataset


ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "tests" / "fixtures" / "worksheets"
MODEL_DIR = ROOT / "public" / "models"
RESEARCH_MODEL_DIR = ROOT / "tools" / "model" / "artifacts"
SEGMENTATION_SIZE = 512
ORIENTATION_SIZE = 224


class SeparableBlock(nn.Module):
    def __init__(self, source: int, target: int, stride: int = 1) -> None:
        super().__init__()
        self.block = nn.Sequential(
            nn.Conv2d(source, source, 3, stride, 1, groups=source, bias=False),
            nn.BatchNorm2d(source),
            nn.ReLU6(inplace=True),
            nn.Conv2d(source, target, 1, bias=False),
            nn.BatchNorm2d(target),
            nn.ReLU6(inplace=True),
        )

    def forward(self, value: torch.Tensor) -> torch.Tensor:
        return self.block(value)


class HandwritingNet(nn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.encoder = nn.Sequential(
            nn.Conv2d(3, 24, 3, 2, 1, bias=False), nn.BatchNorm2d(24), nn.ReLU6(inplace=True),
            SeparableBlock(24, 48, 2), SeparableBlock(48, 72, 2),
            SeparableBlock(72, 96, 2), SeparableBlock(96, 128, 2),
        )
        self.decoder = nn.Sequential(
            nn.Conv2d(128, 64, 1), nn.ReLU6(inplace=True),
            nn.Upsample(scale_factor=4, mode="bilinear", align_corners=False),
            SeparableBlock(64, 32), nn.Upsample(scale_factor=8, mode="bilinear", align_corners=False),
            nn.Conv2d(32, 1, 1),
        )

    def forward(self, value: torch.Tensor) -> torch.Tensor:
        return self.decoder(self.encoder(value))


class ExportedHandwritingNet(nn.Module):
    def __init__(self, model: HandwritingNet) -> None:
        super().__init__()
        self.model = model

    def forward(self, value: torch.Tensor) -> torch.Tensor:
        return torch.sigmoid(self.model(value)).squeeze(1)


class OrientationNet(nn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.features = nn.Sequential(
            nn.Conv2d(3, 24, 3, 2, 1), nn.ReLU6(inplace=True),
            SeparableBlock(24, 48, 2), SeparableBlock(48, 96, 2),
            SeparableBlock(96, 128, 2), nn.AdaptiveAvgPool2d(1),
        )
        self.classifier = nn.Linear(128, 4)

    def forward(self, value: torch.Tensor) -> torch.Tensor:
        return self.classifier(self.features(value).flatten(1))


def as_tensor(image: Image.Image, size: int) -> torch.Tensor:
    resized = image.convert("RGB").resize((size, size), Image.Resampling.BILINEAR)
    return torch.from_numpy(np.asarray(resized, dtype=np.float32).copy()).permute(2, 0, 1) / 255.0


class PatchDataset(Dataset):
    def __init__(self, samples: list[dict], length: int, seed: int) -> None:
        self.samples = samples
        self.length = length
        self.seed = seed
        self.images = []
        self.positive_positions = []
        for sample in samples:
            with Image.open(FIXTURES / sample["clean"]) as clean:
                clean_image = clean.convert("RGB")
            with Image.open(FIXTURES / sample["written"]) as written:
                written_image = written.convert("RGB")
            with Image.open(FIXTURES / sample["mask"]) as mask:
                mask_image = mask.convert("L")
            self.images.append((clean_image, written_image, mask_image))
            self.positive_positions.append(np.argwhere(np.asarray(mask_image) >= 128))

    def __len__(self) -> int:
        return self.length

    def __getitem__(self, index: int) -> tuple[torch.Tensor, torch.Tensor]:
        rng = random.Random(self.seed + index)
        sample_index = index % len(self.samples)
        clean_negative = index % 5 == 0
        clean, written, handwriting_mask = self.images[sample_index]
        image = clean if clean_negative else written
        mask = Image.new("L", image.size, 0) if clean_negative else handwriting_mask
        width, height = image.size
        max_side = min(width, height, 1400)
        side = rng.randint(min(480, max_side), max_side)
        positions = self.positive_positions[sample_index]
        if not clean_negative and len(positions) and rng.random() < 0.9:
            center_y, center_x = positions[rng.randrange(len(positions))]
            jitter = side // 5
            left = max(0, min(width - side, int(center_x) - side // 2 + rng.randint(-jitter, jitter)))
            top = max(0, min(height - side, int(center_y) - side // 2 + rng.randint(-jitter, jitter)))
        else:
            left = rng.randint(0, max(0, width - side))
            top = rng.randint(0, max(0, height - side))
        image = image.crop((left, top, left + side, top + side))
        mask = mask.crop((left, top, left + side, top + side))
        if rng.random() < 0.5:
            image = image.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
            mask = mask.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
        image = ImageEnhance.Brightness(image).enhance(rng.uniform(0.82, 1.18))
        image_tensor = as_tensor(image, SEGMENTATION_SIZE)
        mask_array = np.asarray(mask.resize((SEGMENTATION_SIZE, SEGMENTATION_SIZE), Image.Resampling.NEAREST), dtype=np.uint8)
        mask_tensor = torch.from_numpy((mask_array >= 128).astype(np.float32).copy()).unsqueeze(0)
        return image_tensor, mask_tensor


class OrientationDataset(Dataset):
    def __init__(self, samples: list[dict], repeats: int) -> None:
        self.samples = samples
        self.images = []
        for sample in samples:
            with Image.open(FIXTURES / sample["clean"]) as image:
                self.images.append(image.convert("RGB"))
        self.repeats = repeats

    def __len__(self) -> int:
        return len(self.images) * self.repeats * 4

    def __getitem__(self, index: int) -> tuple[torch.Tensor, int]:
        label = index % 4
        sample_index = (index // 4) % len(self.images)
        image = self.images[sample_index]
        expected_rotation = self.samples[sample_index].get("expectedRotation", 0)
        image = image.rotate(-expected_rotation, expand=True)
        # The label is the clockwise correction applied by the browser pipeline.
        image = image.rotate(90 * label, expand=True)
        return as_tensor(image, ORIENTATION_SIZE), label


def train_segmentation(samples: list[dict], epochs: int, seed: int, device: torch.device) -> HandwritingNet:
    torch.manual_seed(seed)
    model = HandwritingNet().to(device)
    loader = DataLoader(PatchDataset(samples, max(96, len(samples) * 64), seed), batch_size=2, shuffle=True)
    optimizer = torch.optim.AdamW(model.parameters(), lr=2e-3, weight_decay=1e-4)
    loss_function = nn.BCEWithLogitsLoss(pos_weight=torch.tensor([8.0], device=device))
    model.train()
    for _ in range(epochs):
        for images, masks in loader:
            optimizer.zero_grad(set_to_none=True)
            expected = masks.to(device)
            logits = model(images.to(device))
            probabilities = torch.sigmoid(logits)
            intersection = (probabilities * expected).sum(dim=(1, 2, 3))
            dice_loss = 1 - ((2 * intersection + 1) / (probabilities.sum(dim=(1, 2, 3)) + expected.sum(dim=(1, 2, 3)) + 1)).mean()
            loss = loss_function(logits, expected) + 0.75 * dice_loss
            loss.backward()
            optimizer.step()
    return model.cpu().eval()


def train_orientation(samples: list[dict], epochs: int, seed: int, device: torch.device) -> OrientationNet:
    torch.manual_seed(seed)
    model = OrientationNet().to(device)
    loader = DataLoader(OrientationDataset(samples, 24), batch_size=8, shuffle=True)
    optimizer = torch.optim.AdamW(model.parameters(), lr=2e-3)
    model.train()
    for _ in range(epochs):
        for images, labels in loader:
            optimizer.zero_grad(set_to_none=True)
            loss = nn.functional.cross_entropy(model(images.to(device)), labels.to(device))
            loss.backward()
            optimizer.step()
    return model.cpu().eval()


def calibration_inputs(samples: list[dict], input_size: int, include_written: bool) -> list[np.ndarray]:
    paths = [FIXTURES / sample["clean"] for sample in samples]
    if include_written:
        paths.extend(FIXTURES / sample["written"] for sample in samples)
    return [as_tensor(Image.open(path), input_size).unsqueeze(0).numpy() for path in paths]


def quantize(model_path: Path, quantized_path: Path, values: list[np.ndarray]) -> None:
    from onnxruntime.quantization import CalibrationDataReader, QuantFormat, QuantType, quantize_static

    class Reader(CalibrationDataReader):
        def __init__(self) -> None:
            self.values = iter({"input": value} for value in values)

        def get_next(self) -> dict | None:
            return next(self.values, None)

    quantize_static(
        model_path,
        quantized_path,
        Reader(),
        quant_format=QuantFormat.QDQ,
        activation_type=QuantType.QUInt8,
        weight_type=QuantType.QInt8,
    )
    model_path.unlink()


def export_segmentation(model: HandwritingNet, target: Path, samples: list[dict]) -> None:
    temporary = target.with_suffix(".fp32.onnx")
    torch.onnx.export(
        ExportedHandwritingNet(model), torch.zeros(1, 3, SEGMENTATION_SIZE, SEGMENTATION_SIZE), temporary,
        input_names=["input"], output_names=["mask"], opset_version=17,
    )
    quantize(temporary, target, calibration_inputs(samples, SEGMENTATION_SIZE, True))


def export_orientation(model: OrientationNet, target: Path, samples: list[dict]) -> None:
    temporary = target.with_suffix(".fp32.onnx")
    torch.onnx.export(
        model, torch.zeros(1, 3, ORIENTATION_SIZE, ORIENTATION_SIZE), temporary,
        input_names=["input"], output_names=["output"], opset_version=17,
    )
    quantize(temporary, target, calibration_inputs(samples, ORIENTATION_SIZE, False))


def descriptor(target: Path, url: str, version: str, kind: str) -> dict:
    data = target.read_bytes()
    result = {
        "status": "ready", "version": version, "url": url,
        "sha256": hashlib.sha256(data).hexdigest(), "sizeBytes": len(data),
        "inputName": "input", "outputName": "mask" if kind == "handwriting" else "output",
        "inputSize": SEGMENTATION_SIZE if kind == "handwriting" else ORIENTATION_SIZE,
    }
    if kind == "handwriting":
        result.update({"autoThreshold": 0.85, "reviewThreshold": 0.45})
    return result


def load_samples() -> list[dict]:
    manifest = json.loads((FIXTURES / "manifest.json").read_text(encoding="utf-8"))
    samples = manifest.get("samples", [])
    if len(samples) != 4:
        raise SystemExit("Expected exactly four replacement sample groups; old images must not be used.")
    for sample in samples:
        if sample.get("redistributionAuthorized") is not True:
            raise SystemExit(f"{sample.get('id', 'sample')} lacks redistribution authorization")
        for key in ("clean", "written", "mask"):
            if not (FIXTURES / sample[key]).is_file():
                raise SystemExit(f"{sample['id']} is missing {key}")
    return samples


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--epochs", type=int, default=24)
    parser.add_argument("--seed", type=int, default=20250814)
    parser.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    parser.add_argument("--include-handwriting-research", action="store_true")
    args = parser.parse_args()
    samples = load_samples()
    device = torch.device(args.device)
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    version = f"black-v1-seed-{args.seed}-epochs-{args.epochs}"

    orientation_path = MODEL_DIR / "document-orientation.int8.onnx"
    print(f"Training orientation model ({args.epochs} epochs)", flush=True)
    export_orientation(train_orientation(samples, args.epochs, args.seed, device), orientation_path, samples)
    manifest = {
        "version": 2,
        "orientation": descriptor(orientation_path, "/models/document-orientation.int8.onnx", version, "orientation"),
    }
    (MODEL_DIR / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    if args.include_handwriting_research:
        RESEARCH_MODEL_DIR.mkdir(parents=True, exist_ok=True)
        folds_dir = RESEARCH_MODEL_DIR / "folds"
        folds_dir.mkdir(exist_ok=True)
        research_path = RESEARCH_MODEL_DIR / "black-handwriting-segmentation.int8.onnx"
        print(f"Training research handwriting model ({args.epochs} epochs)", flush=True)
        export_segmentation(train_segmentation(samples, args.epochs, args.seed, device), research_path, samples)
        fold_descriptors = []
        for index, held_out in enumerate(samples):
            print(f"Training research held-out fold for {held_out['id']}", flush=True)
            fold_path = folds_dir / f"{held_out['id']}.int8.onnx"
            training = [sample for sample in samples if sample["id"] != held_out["id"]]
            export_segmentation(train_segmentation(training, args.epochs, args.seed + index + 1, device), fold_path, training)
            fold_descriptors.append({
                "sampleId": held_out["id"],
                **descriptor(fold_path, str(fold_path.relative_to(ROOT)), f"{version}-holdout-{held_out['id']}", "handwriting"),
            })
        research_manifest = {
            "version": 1,
            "status": "research-only",
            "handwriting": descriptor(research_path, str(research_path.relative_to(ROOT)), version, "handwriting"),
            "evaluationFolds": fold_descriptors,
        }
        (RESEARCH_MODEL_DIR / "manifest.json").write_text(
            json.dumps(research_manifest, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )


if __name__ == "__main__":
    main()
