# Third-Party Notices

## heic-to 1.5.2

This application uses `heic-to` for local HEIC/HEIF decoding when the browser cannot decode the file natively.

- Project: <https://github.com/hoppergee/heic-to>
- Package: <https://www.npmjs.com/package/heic-to/v/1.5.2>
- License: GNU Lesser General Public License v3.0 or later
- Local license copy: [LICENSES/heic-to-LGPL-3.0.txt](LICENSES/heic-to-LGPL-3.0.txt)

The decoder is delivered as a separate, lazily loaded JavaScript module. The package source and build instructions are available from the project link above.

## PaddleOCR PP-LCNet_x1_0_doc_ori

This application includes PaddleOCR's document image orientation classification weights, converted to ONNX for local browser inference.

- Upstream project and model documentation: <https://github.com/PaddlePaddle/PaddleOCR>
- ONNX conversion source: <https://huggingface.co/onnx-community/PP-LCNet_x1_0_doc_ori-ONNX>
- Included model: `public/models/pp-lcnet-x1-doc-orientation.onnx`
- SHA-256: `10453f80f6f50e8149161aef61b265119471e4010263a82682e5695914236f27`
- License: Apache License 2.0
- Local license copy: [LICENSES/PaddleOCR-Apache-2.0.txt](LICENSES/PaddleOCR-Apache-2.0.txt)
