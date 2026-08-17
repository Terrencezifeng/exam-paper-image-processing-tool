# Worksheet acceptance fixtures

The previous four temporary images are intentionally excluded. Add the replacement fixtures only after they are supplied and redistribution is confirmed.

Each sample uses one identifier and three files:

- `<id>.clean.jpg`: clean page photographed before writing.
- `<id>.written.jpg`: the same page and camera setup with black handwriting.
- `<id>.mask.png`: binary ground-truth mask; white is handwriting and black is background.

Update `manifest.json` with `expectedRotation` (the clockwise correction angle), four normalized `expectedCorners`, normalized `protectedRegions`, and `redistributionAuthorized: true`. Images and ONNX weights are tracked by Git LFS.

Before adding a public fixture, remove EXIF metadata and crop or redact any
burned-in location or device-identifying footer. Keep the supplied original
outside the repository and record the sanitization in `manifest.json`.
