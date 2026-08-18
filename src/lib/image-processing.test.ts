import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const heicMocks = vi.hoisted(() => ({
  isHeic: vi.fn(),
  heicTo: vi.fn(),
}))

vi.mock('heic-to/csp', () => heicMocks)

import {
  applyEnhancementPreset,
  decodeBlob,
  defaultCorners,
  detectPaperBoundary,
  perspectiveCoefficients,
  polygonArea,
  projectPoint,
} from './image-processing'
import type { Point } from '../types'

describe('image decoding', () => {
  beforeEach(() => {
    heicMocks.isHeic.mockReset()
    heicMocks.heicTo.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses the browser decoder when the format is supported natively', async () => {
    const bitmap = { width: 1200, height: 1600, close: vi.fn() } as unknown as ImageBitmap
    const nativeDecoder = vi.fn().mockResolvedValue(bitmap)
    vi.stubGlobal('createImageBitmap', nativeDecoder)

    await expect(decodeBlob(new Blob(['jpeg'], { type: 'image/jpeg' }))).resolves.toBe(bitmap)
    expect(nativeDecoder).toHaveBeenCalledOnce()
    expect(heicMocks.isHeic).not.toHaveBeenCalled()
  })

  it('loads the local HEIC decoder only after native decoding fails', async () => {
    const nativeError = new Error('unsupported image format')
    const bitmap = { width: 1200, height: 1600, close: vi.fn() } as unknown as ImageBitmap
    vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(nativeError))
    heicMocks.isHeic.mockResolvedValue(true)
    heicMocks.heicTo.mockResolvedValue(bitmap)

    await expect(decodeBlob(new Blob(['heic'], { type: 'image/heic' }))).resolves.toBe(bitmap)
    expect(heicMocks.isHeic).toHaveBeenCalledOnce()
    expect(heicMocks.heicTo).toHaveBeenCalledWith(expect.objectContaining({
      type: 'bitmap',
      options: { imageOrientation: 'from-image' },
    }))
  })

  it('preserves the native decoding error for unsupported non-HEIC files', async () => {
    const nativeError = new Error('unsupported image format')
    vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(nativeError))
    heicMocks.isHeic.mockResolvedValue(false)

    await expect(decodeBlob(new Blob(['unknown']))).rejects.toBe(nativeError)
    expect(heicMocks.heicTo).not.toHaveBeenCalled()
  })
})

describe('perspective geometry', () => {
  it('keeps the default page as a unit square', () => {
    expect(polygonArea(defaultCorners())).toBe(1)
  })

  it('maps all destination corners to a skewed source quadrilateral', () => {
    const destination: Point[] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 200 },
      { x: 0, y: 200 },
    ]
    const source: Point[] = [
      { x: 12, y: 20 },
      { x: 92, y: 5 },
      { x: 100, y: 198 },
      { x: 2, y: 180 },
    ]
    const coefficients = perspectiveCoefficients(destination, source)
    destination.forEach((point, index) => {
      expect(projectPoint(point, coefficients).x).toBeCloseTo(source[index].x, 5)
      expect(projectPoint(point, coefficients).y).toBeCloseTo(source[index].y, 5)
    })
  })
})

describe('conservative page detection', () => {
  it('rejects a blank image instead of inventing a crop', () => {
    const image = { width: 80, height: 100, data: new Uint8ClampedArray(80 * 100 * 4).fill(255) } as ImageData
    const result = detectPaperBoundary(image)
    expect(result.accepted).toBe(false)
    expect(result.corners).toEqual(defaultCorners())
  })
})

describe('text enhancement presets', () => {
  function fixture() {
    const width = 96
    const height = 64
    const data = new Uint8ClampedArray(width * height * 4)
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = (y * width + x) * 4
        const background = 242 + Math.round((x / (width - 1)) * 6)
        const isText = (x >= 18 && x <= 20 && y >= 10 && y <= 53) ||
          (x >= 38 && x <= 76 && y >= 28 && y <= 30)
        const value = isText ? 165 : background
        data[index] = value
        data[index + 1] = value
        data[index + 2] = value
        data[index + 3] = 255
      }
    }
    return { width, height, data } as ImageData
  }

  function metrics(image: ImageData) {
    const background: number[] = []
    const ink: number[] = []
    for (let y = 0; y < image.height; y += 1) {
      for (let x = 0; x < image.width; x += 1) {
        const value = image.data[(y * image.width + x) * 4]
        const isText = (x >= 18 && x <= 20 && y >= 10 && y <= 53) ||
          (x >= 38 && x <= 76 && y >= 28 && y <= 30)
        ;(isText ? ink : background).push(value)
      }
    }
    const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length
    const backgroundMean = mean(background)
    const variance = mean(background.map((value) => (value - backgroundMean) ** 2))
    return {
      contrast: backgroundMean - mean(ink),
      backgroundDeviation: Math.sqrt(variance),
      retainedInk: ink.filter((value) => value < 210).length / ink.length,
    }
  }

  it('increases local text contrast without losing thin lines or worsening the bright background', () => {
    const soft = fixture()
    const clear = applyEnhancementPreset(fixture(), 'clear')
    const high = applyEnhancementPreset(fixture(), 'highContrast')
    const softMetrics = metrics(soft)
    const clearMetrics = metrics(clear)
    const highMetrics = metrics(high)
    expect(clearMetrics.contrast / softMetrics.contrast).toBeGreaterThanOrEqual(1.1)
    expect(highMetrics.contrast / softMetrics.contrast).toBeGreaterThanOrEqual(1.2)
    expect(clearMetrics.backgroundDeviation).toBeLessThanOrEqual(softMetrics.backgroundDeviation)
    expect(highMetrics.backgroundDeviation).toBeLessThanOrEqual(softMetrics.backgroundDeviation)
    expect(clearMetrics.retainedInk).toBeGreaterThanOrEqual(0.995)
    expect(highMetrics.retainedInk).toBeGreaterThanOrEqual(0.995)
  })
})
