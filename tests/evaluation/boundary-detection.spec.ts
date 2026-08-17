import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

const fixtureRoot = path.resolve('tests/fixtures/worksheets')
const manifest = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'manifest.json'), 'utf8')) as {
  samples: Array<{
    id: string
    clean: string
    written: string
    expectedCorners: Array<{ x: number; y: number }>
    orientationVariants?: Array<{
      file: string
      expectedCorners: Array<{ x: number; y: number }>
    }>
  }>
}

interface BoundaryResult {
  corners: Array<{ x: number; y: number }>
  confidence: number
  accepted: boolean
}

async function detect(page: Page, file: string): Promise<BoundaryResult> {
  const dataUrl = `data:image/jpeg;base64,${fs.readFileSync(path.join(fixtureRoot, file)).toString('base64')}`
  await page.goto('/')
  return page.evaluate(async (url) => {
    const image = new Image()
    image.src = url
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('Canvas 2D context unavailable')
    context.drawImage(image, 0, 0)
    const modulePath = '/src/lib/image-processing.ts'
    const processing = await import(/* @vite-ignore */ modulePath) as {
      detectPaperBoundary: (image: ImageData) => BoundaryResult
    }
    return processing.detectPaperBoundary(context.getImageData(0, 0, canvas.width, canvas.height))
  }, dataUrl)
}

for (const sample of manifest.samples) {
  test(`${sample.id} boundary detector follows the paper outline`, async ({ page }) => {
    const result = await detect(page, sample.clean)
    console.log(`${sample.id} boundary-only`, result)
    expect(result.accepted).toBe(true)
    const meanCornerError = result.corners.reduce((sum, corner, index) => {
      const expected = sample.expectedCorners[index]
      return sum + Math.hypot(corner.x - expected.x, corner.y - expected.y)
    }, 0) / 4
    expect(meanCornerError).toBeLessThanOrEqual(0.04)
  })

  test(`${sample.id} written boundary does not crop answer space`, async ({ page }) => {
    const result = await detect(page, sample.written)
    console.log(`${sample.id} written boundary-only`, result)
    if (result.accepted) {
      const meanCornerError = result.corners.reduce((sum, corner, index) => {
        const expected = sample.expectedCorners[index]
        return sum + Math.hypot(corner.x - expected.x, corner.y - expected.y)
      }, 0) / 4
      expect(meanCornerError).toBeLessThanOrEqual(0.08)
    } else {
      expect(result.corners).toEqual([
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: 0, y: 1 },
      ])
    }
  })

  for (const [index, variant] of (sample.orientationVariants ?? []).entries()) {
    test(`${sample.id} boundary detector handles variant ${index + 1}`, async ({ page }) => {
      const result = await detect(page, variant.file)
      console.log(`${sample.id} variant ${index + 1} boundary-only`, result)
      expect(result.accepted).toBe(true)
      const meanCornerError = result.corners.reduce((sum, corner, cornerIndex) => {
        const expected = variant.expectedCorners[cornerIndex]
        return sum + Math.hypot(corner.x - expected.x, corner.y - expected.y)
      }, 0) / 4
      expect(meanCornerError).toBeLessThanOrEqual(0.04)
    })
  }
}
