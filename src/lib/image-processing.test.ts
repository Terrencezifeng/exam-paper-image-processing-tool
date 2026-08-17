import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const heicMocks = vi.hoisted(() => ({
  isHeic: vi.fn(),
  heicTo: vi.fn(),
}))

vi.mock('heic-to/csp', () => heicMocks)

import {
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
