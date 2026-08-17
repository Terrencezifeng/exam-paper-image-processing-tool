import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

type Region = { x: number; y: number; width: number; height: number }
type Sample = {
  id: string
  clean: string
  written: string
  expectedRotation: 0 | 90 | 180 | 270
  expectedCorners: Array<{ x: number; y: number }>
  protectedRegions: Region[]
  orientationVariants?: Array<{
    file: string
    expectedRotation: 0 | 90 | 180 | 270
    expectedCorners: Array<{ x: number; y: number }>
  }>
}

const fixtureRoot = path.resolve('tests/fixtures/worksheets')
const manifest = JSON.parse(await readFile(path.join(fixtureRoot, 'manifest.json'), 'utf8')) as { samples: Sample[] }

async function readStoredPage(page: Page) {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('jingjuan-local', 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const task = await new Promise<{ pages: Array<{
      corners: Array<{ x: number; y: number }>
      enhanced?: Blob
      processed?: Blob
      diagnostics: {
        autoRotation: number
        boundaryAccepted: boolean
        orientationBackend: string
      }
    }> }>((resolve, reject) => {
      const request = database.transaction('tasks').objectStore('tasks').get('active-task')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    database.close()
    return task.pages[0]
  })
}

async function pixelMetrics(page: Page, regions: Region[]) {
  return page.evaluate(async ({ regions }) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('jingjuan-local', 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const stored = await new Promise<{ enhanced?: Blob; processed?: Blob }>((resolve, reject) => {
      const request = database.transaction('tasks').objectStore('tasks').get('active-task')
      request.onsuccess = () => resolve((request.result as { pages: Array<{ enhanced?: Blob; processed?: Blob }> }).pages[0])
      request.onerror = () => reject(request.error)
    })
    database.close()
    if (!stored.enhanced || !stored.processed) return { protectedChange: 1, channelDifference: 255 }
    const pixels = async (blob: Blob) => {
      const bitmap = await createImageBitmap(blob)
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
      const context = canvas.getContext('2d', { willReadFrequently: true })
      if (!context) throw new Error('canvas unavailable')
      context.drawImage(bitmap, 0, 0)
      bitmap.close()
      return context.getImageData(0, 0, canvas.width, canvas.height)
    }
    const [before, after] = await Promise.all([pixels(stored.enhanced), pixels(stored.processed)])
    let protectedPixels = 0
    let changedPixels = 0
    let channelDifference = 0
    let samples = 0
    for (let y = 0; y < after.height; y += 8) {
      for (let x = 0; x < after.width; x += 8) {
        const index = (y * after.width + x) * 4
        channelDifference += Math.abs(after.data[index] - after.data[index + 1]) + Math.abs(after.data[index + 1] - after.data[index + 2])
        samples += 1
      }
    }
    for (const region of regions) {
      const startX = Math.floor(region.x * before.width)
      const endX = Math.ceil((region.x + region.width) * before.width)
      const startY = Math.floor(region.y * before.height)
      const endY = Math.ceil((region.y + region.height) * before.height)
      for (let y = startY; y < endY; y += 1) {
        for (let x = startX; x < endX; x += 1) {
          const index = (y * before.width + x) * 4
          if (before.data[index] + before.data[index + 1] + before.data[index + 2] >= 540) continue
          protectedPixels += 1
          const difference = Math.abs(before.data[index] - after.data[index]) +
            Math.abs(before.data[index + 1] - after.data[index + 1]) +
            Math.abs(before.data[index + 2] - after.data[index + 2])
          if (difference > 42) changedPixels += 1
        }
      }
    }
    return {
      protectedChange: changedPixels / Math.max(1, protectedPixels),
      channelDifference: channelDifference / Math.max(1, samples),
    }
  }, { regions })
}

async function uploadAndWait(page: Page, file: string) {
  await page.goto('/')
  await page.locator('input[type="file"]:not([capture])').first().setInputFiles(path.join(fixtureRoot, file))
  await expect(page.getByRole('button', { name: '导出 PDF' }).last()).toBeEnabled({ timeout: 60_000 })
  await page.waitForTimeout(900)
  return readStoredPage(page)
}

for (const sample of manifest.samples) {
  test(`${sample.id} clean page is corrected and exported as conservative grayscale`, async ({ page }) => {
    const result = await uploadAndWait(page, sample.clean)
    expect(result.diagnostics.boundaryAccepted).toBe(true)
    expect(result.diagnostics.autoRotation).toBe(sample.expectedRotation)
    const meanCornerError = result.corners.reduce((sum, corner, index) => {
      const expected = sample.expectedCorners[index]
      return sum + Math.hypot(corner.x - expected.x, corner.y - expected.y)
    }, 0) / 4
    expect(meanCornerError).toBeLessThanOrEqual(0.04)
    const metrics = await pixelMetrics(page, sample.protectedRegions)
    expect(metrics.protectedChange).toBe(0)
    expect(metrics.channelDifference).toBeLessThanOrEqual(1)
  })

  test(`${sample.id} written page is preserved for manual editing`, async ({ page }) => {
    const result = await uploadAndWait(page, sample.written)
    expect(result.enhanced).toBeTruthy()
    expect(result.processed).toBeTruthy()
    expect(await pixelMetrics(page, sample.protectedRegions)).toMatchObject({ protectedChange: 0 })
  })

  for (const [index, variant] of (sample.orientationVariants ?? []).entries()) {
    test(`${sample.id} orientation variant ${index + 1} is corrected and bounded`, async ({ page }) => {
      const result = await uploadAndWait(page, variant.file)
      expect(result.diagnostics.boundaryAccepted).toBe(true)
      expect(result.diagnostics.autoRotation).toBe(variant.expectedRotation)
      const meanCornerError = result.corners.reduce((sum, corner, cornerIndex) => {
        const expected = variant.expectedCorners[cornerIndex]
        return sum + Math.hypot(corner.x - expected.x, corner.y - expected.y)
      }, 0) / 4
      expect(meanCornerError).toBeLessThanOrEqual(0.04)
    })
  }
}
