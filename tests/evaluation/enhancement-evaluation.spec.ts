import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const fixtureRoot = path.resolve('tests/fixtures/worksheets')
const manifest = JSON.parse(await readFile(path.join(fixtureRoot, 'manifest.json'), 'utf8')) as {
  samples: Array<{ id: string; clean: string; expectedCorners: Array<{ x: number; y: number }> }>
}

for (const sample of manifest.samples) {
  test(`${sample.id} clear and high contrast presets protect the normalized page`, async ({ page }) => {
    test.setTimeout(90_000)
    await page.goto('/')
    const bytes = await readFile(path.join(fixtureRoot, sample.clean))
    const metrics = await page.evaluate(async ({ base64, corners }) => {
      const binary = atob(base64)
      const bytes = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
      const modulePath = '/src/lib/image-processing.ts'
      const { applyEnhancementPreset, processWorksheet } = await import(/* @vite-ignore */ modulePath)
      const result = await processWorksheet(new Blob([bytes], { type: 'image/jpeg' }), {
        corners,
        enhancementPreset: 'soft',
      })
      const bitmap = await createImageBitmap(result.enhanced)
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
      const context = canvas.getContext('2d', { willReadFrequently: true })!
      context.drawImage(bitmap, 0, 0)
      bitmap.close()
      const soft = context.getImageData(0, 0, canvas.width, canvas.height)
      const clone = () => new ImageData(new Uint8ClampedArray(soft.data), soft.width, soft.height)
      const clear = applyEnhancementPreset(clone(), 'clear')
      const high = applyEnhancementPreset(clone(), 'highContrast')

      const summarize = (image: ImageData) => {
        const background: number[] = []
        const inkValues: number[] = []
        let retained = 0
        let ink = 0
        for (let y = 0; y < image.height; y += 3) {
          for (let x = 0; x < image.width; x += 3) {
            const pixel = (y * image.width + x) * 4
            const value = image.data[pixel]
            const softValue = soft.data[pixel]
            if (softValue >= 235) background.push(value)
            if (softValue < 205) {
              ink += 1
              inkValues.push(value)
              if (value < 220) retained += 1
            }
          }
        }
        const mean = background.reduce((sum, value) => sum + value, 0) / Math.max(1, background.length)
        const inkMean = inkValues.reduce((sum, value) => sum + value, 0) / Math.max(1, inkValues.length)
        const deviation = Math.sqrt(background.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, background.length))
        return { contrast: mean - inkMean, deviation, retention: retained / Math.max(1, ink) }
      }
      return { soft: summarize(soft), clear: summarize(clear), high: summarize(high) }
    }, { base64: bytes.toString('base64'), corners: sample.expectedCorners })

    expect(metrics.clear.contrast / metrics.soft.contrast).toBeGreaterThanOrEqual(1.1)
    expect(metrics.high.contrast / metrics.soft.contrast).toBeGreaterThanOrEqual(1.2)
    expect(metrics.clear.deviation).toBeLessThanOrEqual(metrics.soft.deviation)
    expect(metrics.high.deviation).toBeLessThanOrEqual(metrics.soft.deviation)
    expect(metrics.clear.retention).toBeGreaterThanOrEqual(0.995)
    expect(metrics.high.retention).toBeGreaterThanOrEqual(0.995)
  })
}
