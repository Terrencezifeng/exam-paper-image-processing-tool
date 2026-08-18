import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const fixtureRoot = path.resolve('tests/fixtures/worksheets')
const manifest = JSON.parse(await readFile(path.join(fixtureRoot, 'manifest.json'), 'utf8')) as {
  samples: Array<{ id: string; clean: string; written: string }>
}

test('official orientation model safely auto-corrects at least 90% of 32 rotations', async ({ page }) => {
  test.setTimeout(180_000)
  await page.goto('/')
  const results: Array<{ sample: string; inputRotation: number; expected: number; actual: number; accepted: boolean; confidence: number; margin: number }> = []

  for (const sample of manifest.samples) {
    for (const kind of ['clean', 'written'] as const) {
      const bytes = await readFile(path.join(fixtureRoot, sample[kind]))
      const predictions = await page.evaluate(async ({ base64 }) => {
        const binary = atob(base64)
        const bytes = new Uint8Array(binary.length)
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
        const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }), { imageOrientation: 'from-image' })
        const modulePath = '/src/lib/model-runtime.ts'
        const { predictOrientation } = await import(/* @vite-ignore */ modulePath)
        const rotations = [0, 90, 180, 270] as const
        const output = []
        for (const inputRotation of rotations) {
          const swap = inputRotation === 90 || inputRotation === 270
          const maximumEdge = 2400
          const scale = Math.min(1, maximumEdge / Math.max(bitmap.width, bitmap.height))
          const sourceWidth = Math.round(bitmap.width * scale)
          const sourceHeight = Math.round(bitmap.height * scale)
          const canvas = document.createElement('canvas')
          canvas.width = swap ? sourceHeight : sourceWidth
          canvas.height = swap ? sourceWidth : sourceHeight
          const context = canvas.getContext('2d', { willReadFrequently: true })!
          context.translate(canvas.width / 2, canvas.height / 2)
          context.rotate((inputRotation * Math.PI) / 180)
          context.drawImage(bitmap, -sourceWidth / 2, -sourceHeight / 2, sourceWidth, sourceHeight)
          output.push({ inputRotation, ...(await predictOrientation(context.getImageData(0, 0, canvas.width, canvas.height))) })
        }
        bitmap.close()
        return output
      }, { base64: bytes.toString('base64') })

      for (const prediction of predictions) {
        results.push({
          sample: `${sample.id}.${kind}`,
          inputRotation: prediction.inputRotation,
          expected: (360 - prediction.inputRotation) % 360,
          actual: prediction.rotation,
          accepted: prediction.accepted,
          confidence: prediction.confidence,
          margin: prediction.confidenceMargin,
        })
      }
    }
  }

  const accepted = results.filter((result) => result.accepted)
  const wrong = accepted.filter((result) => result.actual !== result.expected)
  expect(wrong, JSON.stringify(wrong, null, 2)).toHaveLength(0)
  expect(accepted.length / results.length, JSON.stringify(results.filter((result) => !result.accepted), null, 2)).toBeGreaterThanOrEqual(0.9)
  expect(results).toHaveLength(32)
})
