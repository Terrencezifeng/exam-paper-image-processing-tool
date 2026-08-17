/* global console */
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(path.join(root, 'public/models/manifest.json'), 'utf8'))
const limits = { orientation: 7 * 1024 * 1024 }
let total = 0

async function verifyDescriptor(kind, descriptor, limit, includedInProductionBudget) {
  if (descriptor.status === 'pending') {
    console.log(`${kind}: pending`)
    return
  }
  const modelPath = path.join(root, 'public', descriptor.url.replace(/^\//, ''))
  const modelStat = await stat(modelPath)
  if (modelStat.size > limit) throw new Error(`${kind} model exceeds its size budget`)
  if (modelStat.size !== descriptor.sizeBytes) throw new Error(`${kind} model size does not match manifest`)
  const digest = createHash('sha256').update(await readFile(modelPath)).digest('hex')
  if (digest !== descriptor.sha256) throw new Error(`${kind} model hash does not match manifest`)
  if (includedInProductionBudget) total += modelStat.size
  console.log(`${kind}: ready (${(modelStat.size / 1024 / 1024).toFixed(2)} MB)`)
}

await verifyDescriptor('orientation', manifest.orientation, limits.orientation, true)
console.log(`production model assets: ${(total / 1024 / 1024).toFixed(2)} MB`)
