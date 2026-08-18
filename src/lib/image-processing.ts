import { MAX_PIXELS } from './files'
import { predictOrientation } from './model-runtime'
import type {
  EnhancementPreset,
  InferenceBackend,
  Point,
  ProcessingDiagnostics,
  ProcessingStage,
  Rotation,
  Stroke,
} from '../types'

const MAX_PROCESS_EDGE = 2400
const BOUNDARY_ACCEPTANCE = 0.72

type CanvasLike = HTMLCanvasElement | OffscreenCanvas
type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

export type ProcessResult = {
  sourcePreview: Blob
  sourceWidth: number
  sourceHeight: number
  enhanced: Blob
  processed: Blob
  width: number
  height: number
  corners: Point[]
  diagnostics: ProcessingDiagnostics
}

export type ProcessOptions = {
  corners?: Point[]
  rotation?: Rotation
  enhancementPreset?: EnhancementPreset
  lockedGeometry?: {
    corners: Point[]
    autoRotation: Rotation
    effectiveRotation: Rotation
    orientationConfidence: number
    orientationMargin: number
    orientationAccepted: boolean
    boundaryConfidence: number
    boundaryAccepted: boolean
    orientationBackend: InferenceBackend
    orientationModelVersion?: string
    warning?: string
  }
  signal?: AbortSignal
  onProgress?: (progress: number, stage: ProcessingStage) => void
}

export type BoundaryDetection = {
  corners: Point[]
  confidence: number
  accepted: boolean
}

function assertActive(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('处理已取消', 'AbortError')
}

function createCanvas(width: number, height: number): CanvasLike {
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    return canvas
  }
  return new OffscreenCanvas(width, height)
}

function context2d(canvas: CanvasLike, frequent = false): Context2D {
  const context = canvas.getContext('2d', frequent ? { willReadFrequently: true } : undefined)
  if (!context) throw new Error('浏览器无法创建图像画布')
  return context as Context2D
}

function canvasToBlob(canvas: CanvasLike, quality = 0.92): Promise<Blob> {
  if (typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas) {
    return canvas.convertToBlob({ type: 'image/jpeg', quality })
  }
  return new Promise((resolve, reject) => {
    const htmlCanvas = canvas as HTMLCanvasElement
    htmlCanvas.toBlob(
      (blob: Blob | null) => (blob ? resolve(blob) : reject(new Error('无法生成处理后的图片'))),
      'image/jpeg',
      quality,
    )
  })
}

export async function decodeBlob(blob: Blob): Promise<ImageBitmap> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' })
  } catch (error) {
    const { isHeic, heicTo } = await import('heic-to/csp')
    const candidate = new File([blob], 'worksheet', { type: blob.type })
    if (!(await isHeic(candidate))) throw error
    bitmap = await heicTo({ blob, type: 'bitmap', options: { imageOrientation: 'from-image' } })
  }
  if (bitmap.width * bitmap.height > MAX_PIXELS) {
    bitmap.close()
    throw new Error('图片像素过大，请压缩到 4000 万像素以内')
  }
  return bitmap
}

export function defaultCorners(): Point[] {
  return [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ]
}

function createScaledCanvas(bitmap: ImageBitmap) {
  const scale = Math.min(1, MAX_PROCESS_EDGE / Math.max(bitmap.width, bitmap.height))
  const canvas = createCanvas(
    Math.max(1, Math.round(bitmap.width * scale)),
    Math.max(1, Math.round(bitmap.height * scale)),
  )
  const context = context2d(canvas, true)
  context.fillStyle = '#fff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  return canvas
}

function luminanceAt(data: Uint8ClampedArray, index: number) {
  return 0.299 * data[index] + 0.587 * data[index + 1] + 0.114 * data[index + 2]
}

function percentile(values: number[], ratio: number) {
  if (values.length === 0) return 0
  values.sort((a, b) => a - b)
  return values[Math.min(values.length - 1, Math.floor(values.length * ratio))]
}

interface FittedLine {
  slope: number
  intercept: number
  residual: number
  support: number
}

interface EdgeScan {
  position: number
  candidates: Array<{ coordinate: number; strength: number }>
}

function houghLine(scans: EdgeScan[], side: 'min' | 'max'): FittedLine | undefined {
  if (scans.length < 4) return undefined
  const binSize = 0.004
  const minimumIntercept = -0.1
  const binCount = 300
  let best: FittedLine | undefined
  let bestScore = -Infinity
  for (let slopeIndex = 0; slopeIndex <= 80; slopeIndex += 1) {
    const slope = -0.08 + slopeIndex * 0.002
    const strengths = new Float32Array(binCount)
    const support = new Uint16Array(binCount)
    const rowStrength = new Float32Array(binCount)
    for (const scan of scans) {
      const touched: number[] = []
      for (const candidate of scan.candidates) {
        const intercept = candidate.coordinate - slope * scan.position
        const bin = Math.round((intercept - minimumIntercept) / binSize)
        if (bin < 0 || bin >= binCount) continue
        if (rowStrength[bin] === 0) touched.push(bin)
        rowStrength[bin] = Math.max(rowStrength[bin], Math.min(40, candidate.strength))
      }
      for (const bin of touched) {
        strengths[bin] += rowStrength[bin]
        support[bin] += 1
        rowStrength[bin] = 0
      }
    }
    for (let bin = 0; bin < binCount; bin += 1) {
      const score = support[bin] + strengths[bin] / 200 - Math.abs(slope) * 200
      if (score <= bestScore) continue
      bestScore = score
      best = {
        slope,
        intercept: minimumIntercept + bin * binSize,
        residual: Math.max(0.004, 1 - support[bin] / scans.length) * 0.02,
        support: support[bin] / scans.length,
      }
    }
  }
  if (!best || best.support >= 0.14) return best
  return { slope: 0, intercept: side === 'min' ? 0 : 1, residual: 0.025, support: best.support }
}

function intersect(vertical: FittedLine | undefined, horizontal: FittedLine | undefined) {
  if (!vertical || !horizontal) return undefined
  const denominator = 1 - vertical.slope * horizontal.slope
  if (Math.abs(denominator) < 1e-6) return undefined
  const y = (horizontal.slope * vertical.intercept + horizontal.intercept) / denominator
  return { x: vertical.slope * y + vertical.intercept, y }
}

export function detectPaperBoundary(image: ImageData): BoundaryDetection {
  const { width, height, data } = image
  const scale = Math.max(width, height)
  const step = Math.max(2, Math.floor(scale / 240))
  const gridWidth = Math.ceil(width / step)
  const gridHeight = Math.ceil(height / step)
  const luminance = new Float32Array(gridWidth * gridHeight)
  for (let row = 0; row < gridHeight; row += 1) {
    for (let column = 0; column < gridWidth; column += 1) {
      const x = Math.min(width - 1, column * step)
      const y = Math.min(height - 1, row * step)
      luminance[row * gridWidth + column] = luminanceAt(data, (y * width + x) * 4)
    }
  }
  const smoothed = new Float32Array(luminance.length)
  for (let row = 1; row < gridHeight - 1; row += 1) {
    for (let column = 1; column < gridWidth - 1; column += 1) {
      let sum = 0
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          sum += luminance[(row + offsetY) * gridWidth + column + offsetX]
        }
      }
      smoothed[row * gridWidth + column] = sum / 9
    }
  }
  const left: EdgeScan[] = []
  const right: EdgeScan[] = []
  for (let row = 2; row < gridHeight - 2; row += 1) {
    const leftScan: EdgeScan = { position: row / gridHeight, candidates: [] }
    const rightScan: EdgeScan = { position: row / gridHeight, candidates: [] }
    for (let column = 2; column < gridWidth - 2; column += 1) {
      const gradient = (smoothed[row * gridWidth + column + 1] - smoothed[row * gridWidth + column - 1]) / 2
      const coordinate = column / gridWidth
      if (coordinate >= 0.015 && coordinate < 0.4 && gradient > 4) {
        leftScan.candidates.push({ coordinate, strength: gradient })
      }
      if (coordinate > 0.6 && coordinate <= 0.985 && gradient < -4) {
        rightScan.candidates.push({ coordinate, strength: -gradient })
      }
    }
    left.push(leftScan)
    right.push(rightScan)
  }
  const top: EdgeScan[] = []
  const bottom: EdgeScan[] = []
  for (let column = 2; column < gridWidth - 2; column += 1) {
    const topScan: EdgeScan = { position: column / gridWidth, candidates: [] }
    const bottomScan: EdgeScan = { position: column / gridWidth, candidates: [] }
    for (let row = 2; row < gridHeight - 2; row += 1) {
      const gradient = (smoothed[(row + 1) * gridWidth + column] - smoothed[(row - 1) * gridWidth + column]) / 2
      const coordinate = row / gridHeight
      if (coordinate >= 0.015 && coordinate < 0.35 && gradient > 4) {
        topScan.candidates.push({ coordinate, strength: gradient })
      }
      if (coordinate > 0.65 && coordinate <= 0.985 && gradient < -4) {
        bottomScan.candidates.push({ coordinate, strength: -gradient })
      }
    }
    top.push(topScan)
    bottom.push(bottomScan)
  }

  const leftLine = houghLine(left, 'min')
  const rightLine = houghLine(right, 'max')
  const topLine = houghLine(top, 'min')
  const bottomLine = houghLine(bottom, 'max')
  const intersections = [
    intersect(leftLine, topLine),
    intersect(rightLine, topLine),
    intersect(rightLine, bottomLine),
    intersect(leftLine, bottomLine),
  ]
  if (intersections.some((point) => !point)) {
    return { corners: defaultCorners(), confidence: 0, accepted: false }
  }
  const corners = intersections.map((point) => ({
    x: Math.min(1, Math.max(0, point?.x ?? 0)),
    y: Math.min(1, Math.max(0, point?.y ?? 0)),
  }))
  const area = polygonArea(corners)
  const support = [leftLine, rightLine, topLine, bottomLine]
    .filter((line): line is FittedLine => Boolean(line))
    .reduce((sum, line) => sum + line.support, 0) / 4
  const residual = [leftLine, rightLine, topLine, bottomLine]
    .filter((line): line is NonNullable<typeof line> => Boolean(line))
    .reduce((sum, line) => sum + line.residual, 0) / 4
  const geometry = area >= 0.42 && area <= 1.02 ? 1 : Math.max(0, 1 - Math.abs(area - 0.72) * 3)
  const rawConfidence = Math.max(0, Math.min(1, support * 0.45 + geometry * 0.4 + Math.max(0, 1 - residual * 18) * 0.15))
  const meanTop = (corners[0].y + corners[1].y) / 2
  const meanRight = (corners[1].x + corners[2].x) / 2
  const meanBottom = (corners[2].y + corners[3].y) / 2
  const meanLeft = (corners[0].x + corners[3].x) / 2
  const coversPlausiblePage = meanTop <= 0.28 && meanRight >= 0.7 && meanBottom >= 0.76 && meanLeft <= 0.34
  const confidence = coversPlausiblePage
    ? rawConfidence
    : Math.min(rawConfidence, BOUNDARY_ACCEPTANCE - 0.01)
  return {
    corners: confidence >= BOUNDARY_ACCEPTANCE ? corners : defaultCorners(),
    confidence,
    accepted: confidence >= BOUNDARY_ACCEPTANCE,
  }
}

export function detectPaperCorners(image: ImageData): Point[] {
  return detectPaperBoundary(image).corners
}

export function polygonArea(points: Point[]) {
  return Math.abs(
    points.reduce((sum, point, index) => {
      const next = points[(index + 1) % points.length]
      return sum + point.x * next.y - next.x * point.y
    }, 0) / 2,
  )
}

function distance(a: Point, b: Point) {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function solveLinear(matrix: number[][], values: number[]) {
  const size = values.length
  const augmented = matrix.map((row, index) => [...row, values[index]])
  for (let column = 0; column < size; column += 1) {
    let pivot = column
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row
    }
    ;[augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]]
    const divisor = augmented[column][column]
    if (Math.abs(divisor) < 1e-8) throw new Error('无法计算透视校正参数')
    for (let item = column; item <= size; item += 1) augmented[column][item] /= divisor
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue
      const factor = augmented[row][column]
      for (let item = column; item <= size; item += 1) augmented[row][item] -= factor * augmented[column][item]
    }
  }
  return augmented.map((row) => row[size])
}

export function perspectiveCoefficients(from: Point[], to: Point[]) {
  const matrix: number[][] = []
  const values: number[] = []
  from.forEach((point, index) => {
    const target = to[index]
    matrix.push([point.x, point.y, 1, 0, 0, 0, -target.x * point.x, -target.x * point.y])
    values.push(target.x)
    matrix.push([0, 0, 0, point.x, point.y, 1, -target.y * point.x, -target.y * point.y])
    values.push(target.y)
  })
  return solveLinear(matrix, values)
}

export function projectPoint(point: Point, coefficients: number[]): Point {
  const denominator = coefficients[6] * point.x + coefficients[7] * point.y + 1
  return {
    x: (coefficients[0] * point.x + coefficients[1] * point.y + coefficients[2]) / denominator,
    y: (coefficients[3] * point.x + coefficients[4] * point.y + coefficients[5]) / denominator,
  }
}

function warpPerspective(source: CanvasLike, normalizedCorners: Point[]) {
  const corners = normalizedCorners.map((point) => ({ x: point.x * source.width, y: point.y * source.height }))
  const width = Math.max(distance(corners[0], corners[1]), distance(corners[3], corners[2]))
  const height = Math.max(distance(corners[0], corners[3]), distance(corners[1], corners[2]))
  const outputWidth = Math.max(2, Math.min(MAX_PROCESS_EDGE, Math.round(width)))
  const output = createCanvas(outputWidth, Math.max(2, Math.round((outputWidth * height) / Math.max(1, width))))
  const input = context2d(source, true).getImageData(0, 0, source.width, source.height)
  const outputContext = context2d(output)
  const result = outputContext.createImageData(output.width, output.height)
  const destination = [
    { x: 0, y: 0 }, { x: output.width - 1, y: 0 },
    { x: output.width - 1, y: output.height - 1 }, { x: 0, y: output.height - 1 },
  ]
  const coefficients = perspectiveCoefficients(destination, corners)
  for (let y = 0; y < output.height; y += 1) {
    for (let x = 0; x < output.width; x += 1) {
      const mapped = projectPoint({ x, y }, coefficients)
      const targetIndex = (y * output.width + x) * 4
      const sourceX = Math.min(source.width - 1, Math.max(0, mapped.x))
      const sourceY = Math.min(source.height - 1, Math.max(0, mapped.y))
      const left = Math.floor(sourceX)
      const top = Math.floor(sourceY)
      const right = Math.min(source.width - 1, left + 1)
      const bottom = Math.min(source.height - 1, top + 1)
      const weightX = sourceX - left
      const weightY = sourceY - top
      const topLeft = (top * source.width + left) * 4
      const topRight = (top * source.width + right) * 4
      const bottomLeft = (bottom * source.width + left) * 4
      const bottomRight = (bottom * source.width + right) * 4
      for (let channel = 0; channel < 3; channel += 1) {
        const topValue = input.data[topLeft + channel] * (1 - weightX) + input.data[topRight + channel] * weightX
        const bottomValue = input.data[bottomLeft + channel] * (1 - weightX) + input.data[bottomRight + channel] * weightX
        result.data[targetIndex + channel] = Math.round(topValue * (1 - weightY) + bottomValue * weightY)
      }
      result.data[targetIndex + 3] = 255
    }
  }
  outputContext.putImageData(result, 0, 0)
  return output
}

function rotateCanvas(source: CanvasLike, degrees: Rotation) {
  if (degrees === 0) return source
  const swap = degrees === 90 || degrees === 270
  const output = createCanvas(swap ? source.height : source.width, swap ? source.width : source.height)
  const context = context2d(output)
  context.translate(output.width / 2, output.height / 2)
  context.rotate((degrees * Math.PI) / 180)
  context.drawImage(source, -source.width / 2, -source.height / 2)
  return output
}

export function applyEnhancementPreset(image: ImageData, preset: EnhancementPreset) {
  if (preset === 'soft') return image
  const contrast = preset === 'clear' ? 1.18 : 1.35
  const amount = preset === 'clear' ? 0.55 : 0.8
  const pixels = image.width * image.height
  const contrasted = new Uint8ClampedArray(pixels)
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    contrasted[pixel] = Math.max(0, Math.min(255, 220 + (image.data[pixel * 4] - 220) * contrast))
  }
  const horizontal = new Uint8ClampedArray(pixels)
  const blurred = new Uint8ClampedArray(pixels)
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const left = y * image.width + Math.max(0, x - 1)
      const center = y * image.width + x
      const right = y * image.width + Math.min(image.width - 1, x + 1)
      horizontal[center] = (contrasted[left] + 2 * contrasted[center] + contrasted[right]) / 4
    }
  }
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const top = Math.max(0, y - 1) * image.width + x
      const center = y * image.width + x
      const bottom = Math.min(image.height - 1, y + 1) * image.width + x
      blurred[center] = (horizontal[top] + 2 * horizontal[center] + horizontal[bottom]) / 4
    }
  }
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const index = pixel * 4
    const original = image.data[index]
    const sharpened = contrasted[pixel] + amount * (contrasted[pixel] - blurred[pixel])
    const target = original >= 235
      ? Math.max(0, Math.min(255, 246 + (original - 246) * 0.5))
      : Math.max(0, Math.min(255, sharpened))
    image.data[index] = target
    image.data[index + 1] = target
    image.data[index + 2] = target
  }
  return image
}

function enhance(source: CanvasLike, preset: EnhancementPreset) {
  const output = createCanvas(source.width, source.height)
  const context = context2d(output, true)
  context.drawImage(source, 0, 0)
  const image = context.getImageData(0, 0, output.width, output.height)
  const tileSize = 48
  const columns = Math.ceil(output.width / tileSize)
  const rows = Math.ceil(output.height / tileSize)
  const background = new Float32Array(columns * rows)
  for (let tileY = 0; tileY < rows; tileY += 1) {
    for (let tileX = 0; tileX < columns; tileX += 1) {
      const values: number[] = []
      for (let y = tileY * tileSize; y < Math.min(output.height, (tileY + 1) * tileSize); y += 4) {
        for (let x = tileX * tileSize; x < Math.min(output.width, (tileX + 1) * tileSize); x += 4) {
          values.push(luminanceAt(image.data, (y * output.width + x) * 4))
        }
      }
      background[tileY * columns + tileX] = percentile(values, 0.82) || 235
    }
  }
  for (let y = 0; y < output.height; y += 1) {
    for (let x = 0; x < output.width; x += 1) {
      const index = (y * output.width + x) * 4
      const luminance = luminanceAt(image.data, index)
      const tileX = Math.min(columns - 1, Math.floor(x / tileSize))
      const tileY = Math.min(rows - 1, Math.floor(y / tileSize))
      const nextX = Math.min(columns - 1, tileX + 1)
      const nextY = Math.min(rows - 1, tileY + 1)
      const blendX = (x % tileSize) / tileSize
      const blendY = (y % tileSize) / tileSize
      const topPaper = background[tileY * columns + tileX] * (1 - blendX) + background[tileY * columns + nextX] * blendX
      const bottomPaper = background[nextY * columns + tileX] * (1 - blendX) + background[nextY * columns + nextX] * blendX
      const paper = topPaper * (1 - blendY) + bottomPaper * blendY
      const normalized = Math.max(0, Math.min(255, luminance + (246 - paper) * 0.82))
      const target = Math.max(0, Math.min(255, normalized < 205 ? 205 + (normalized - 205) * 1.08 : normalized))
      image.data[index] = target
      image.data[index + 1] = target
      image.data[index + 2] = target
    }
  }
  applyEnhancementPreset(image, preset)
  context.putImageData(image, 0, 0)
  return output
}

export async function processWorksheet(blob: Blob, options: ProcessOptions = {}): Promise<ProcessResult> {
  const report = options.onProgress ?? (() => undefined)
  assertActive(options.signal)
  report(5, 'decoding')
  const bitmap = await decodeBlob(blob)
  try {
    const source = createScaledCanvas(bitmap)
    const sourcePreview = await canvasToBlob(source, 0.9)
    const sourceImage = context2d(source, true).getImageData(0, 0, source.width, source.height)
    report(16, 'orientation')
    const orientation = options.lockedGeometry
      ? {
          rotation: options.lockedGeometry.autoRotation,
          confidence: options.lockedGeometry.orientationConfidence,
          confidenceMargin: options.lockedGeometry.orientationMargin,
          accepted: options.lockedGeometry.orientationAccepted,
          backend: options.lockedGeometry.orientationBackend,
          modelVersion: options.lockedGeometry.orientationModelVersion,
        }
      : await predictOrientation(sourceImage)
    assertActive(options.signal)
    const autoRotation = options.lockedGeometry?.autoRotation ?? (orientation.accepted ? orientation.rotation : 0)
    const boundary = options.lockedGeometry
      ? {
          corners: options.lockedGeometry.corners,
          confidence: options.lockedGeometry.boundaryConfidence,
          accepted: options.lockedGeometry.boundaryAccepted,
        }
      : options.corners
      ? { corners: options.corners, confidence: 1, accepted: true }
      : detectPaperBoundary(sourceImage)
    report(34, 'boundary')
    const warped = warpPerspective(source, boundary.corners)
    const effectiveRotation = options.lockedGeometry?.effectiveRotation ??
      ((autoRotation + (options.rotation ?? 0)) % 360) as Rotation
    const rotated = rotateCanvas(warped, effectiveRotation)
    assertActive(options.signal)
    report(56, 'enhancement')
    const enhancedCanvas = enhance(rotated, options.enhancementPreset ?? 'clear')
    const enhanced = await canvasToBlob(enhancedCanvas)
    assertActive(options.signal)
    report(94, 'compositing')
    const processed = enhanced
    const warnings = options.lockedGeometry?.warning ? [options.lockedGeometry.warning] : [
      !boundary.accepted ? '未可靠检测到纸张边界，已保留完整画面，请调整四角' : undefined,
      !orientation.accepted
        ? '未能可靠判断页面方向，请确认是否需要旋转'
        : undefined,
    ].filter(Boolean)
    report(100, 'compositing')
    return {
      sourcePreview,
      sourceWidth: bitmap.width,
      sourceHeight: bitmap.height,
      enhanced,
      processed,
      width: enhancedCanvas.width,
      height: enhancedCanvas.height,
      corners: boundary.corners,
      diagnostics: {
        autoRotation,
        effectiveRotation,
        orientationConfidence: orientation.confidence,
        orientationMargin: orientation.confidenceMargin,
        orientationAccepted: orientation.accepted,
        boundaryConfidence: boundary.confidence,
        boundaryAccepted: boundary.accepted,
        orientationBackend: orientation.backend,
        orientationModelVersion: orientation.modelVersion,
        warning: warnings.join('；') || undefined,
      },
    }
  } finally {
    bitmap.close()
  }
}

function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('无法载入编辑图像'))
    image.src = url
  })
}

function drawStroke(context: CanvasRenderingContext2D, stroke: Stroke, source?: HTMLImageElement) {
  if (stroke.points.length === 0) return
  context.save()
  context.lineCap = 'round'
  context.lineJoin = 'round'
  context.lineWidth = stroke.size
  context.beginPath()
  stroke.points.forEach((point, index) => index === 0 ? context.moveTo(point.x, point.y) : context.lineTo(point.x, point.y))
  if (stroke.points.length === 1) {
    const point = stroke.points[0]
    context.arc(point.x, point.y, stroke.size / 2, 0, Math.PI * 2)
  }
  if (stroke.tool === 'eraser') {
    context.strokeStyle = '#fff'
    context.fillStyle = '#fff'
    context.stroke()
    context.fill()
  } else if (source) {
    context.clip()
    context.drawImage(source, 0, 0, context.canvas.width, context.canvas.height)
  }
  context.restore()
}

export async function renderEditedPage(processedUrl: string, enhancedUrl: string, strokes: Stroke[]) {
  const [processed, enhanced] = await Promise.all([loadImage(processedUrl), loadImage(enhancedUrl)])
  const canvas = document.createElement('canvas')
  canvas.width = processed.naturalWidth
  canvas.height = processed.naturalHeight
  const context = canvas.getContext('2d')
  if (!context) throw new Error('无法渲染编辑结果')
  context.drawImage(processed, 0, 0)
  strokes.forEach((stroke) => drawStroke(context, stroke, enhanced))
  return canvas
}

export { drawStroke, loadImage }
