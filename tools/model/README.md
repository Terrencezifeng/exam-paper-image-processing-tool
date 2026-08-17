# Local model training

Production uses only the document-orientation model. Training reads the four authorized sample groups from `tests/fixtures/worksheets/manifest.json` and writes the orientation model plus production manifest to `public/models/`.

```bash
python -m venv .venv-model
source .venv-model/bin/activate
pip install -r tools/model/requirements.txt
npm run train:models
npm run verify:models
npm run eval:samples
```

On Windows PowerShell, activate with `.venv-model\Scripts\Activate.ps1`.

The previous handwriting model and held-out fold models are research-only assets under `tools/model/artifacts/`. They are not referenced by the production manifest and are not copied into `dist/`.

To intentionally retrain those research assets together with the orientation model:

```bash
npm run train:handwriting:research
```

This research command must not be added to a production build or deployment pipeline.
