/* global console, process */
import { access, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixtureRoot = path.join(root, 'tests/fixtures/worksheets')
const manifest = JSON.parse(await readFile(path.join(fixtureRoot, 'manifest.json'), 'utf8'))

if (!Array.isArray(manifest.samples) || manifest.samples.length === 0) {
  console.log('PENDING: replacement clean/written/mask sample pairs have not been supplied.')
  process.exit(0)
}
if (manifest.samples.length < 4) {
  console.log(`PENDING: received ${manifest.samples.length}/4 replacement sample pairs.`)
  process.exit(0)
}
const modelManifest = JSON.parse(await readFile(path.join(root, 'public/models/manifest.json'), 'utf8'))
if (modelManifest.orientation?.status !== 'ready') throw new Error('orientation model is not ready; run npm run train:models')
for (const sample of manifest.samples) {
  for (const key of ['clean', 'written']) {
    if (!sample[key]) throw new Error(`${sample.id ?? 'sample'} is missing ${key}`)
    await access(path.join(fixtureRoot, sample[key]))
  }
  if (!Array.isArray(sample.protectedRegions)) throw new Error(`${sample.id} is missing protectedRegions`)
  if (!Array.isArray(sample.expectedCorners) || sample.expectedCorners.length !== 4) throw new Error(`${sample.id} is missing expectedCorners`)
  if (sample.redistributionAuthorized !== true) throw new Error(`${sample.id} lacks redistribution authorization`)
  if (![0, 90, 180, 270].includes(sample.expectedRotation)) throw new Error(`${sample.id} has an invalid expectedRotation`)
  for (const variant of sample.orientationVariants ?? []) {
    if (!variant.file) throw new Error(`${sample.id} has an orientation variant without a file`)
    await access(path.join(fixtureRoot, variant.file))
    if (![0, 90, 180, 270].includes(variant.expectedRotation)) throw new Error(`${sample.id} has an orientation variant with invalid expectedRotation`)
    if (!Array.isArray(variant.expectedCorners) || variant.expectedCorners.length !== 4) throw new Error(`${sample.id} has an orientation variant without expectedCorners`)
  }
}

const result = spawnSync(
  process.execPath,
  [path.join(root, 'scripts', 'run-e2e.mjs'), '--config', 'playwright.eval.config.ts'],
  { cwd: root, stdio: 'inherit', env: { ...process.env, PLAYWRIGHT_PORT: '4174' } },
)
process.exit(result.status ?? 1)
