import { MAX_PIXELS } from './files'
import type { ColorMode, Point, ReviewRegion, Stroke } from '../types'

const MAX_PROCESS_EDGE = 2400

export type ProcessResult = {
  enhanced: Blob
  processed: Blob
  width: number
  height: number
  corners: Point[]
  reviewRegions: ReviewRegion[]
}

export type ProcessOptions = {
  corners?: Point[]
  rotation?: 0 | 90 | 180 | 270
  colorMode?: ColorMode
  signal?: AbortSignal
  onProgress?: (progress: number) => void
}

function assertActive(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('处理已取消', 'AbortError')
}

function canvasToBlob(canvas: HTMLCanvasElement, quality = 0.92): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('无法生成处理后的图片'))),
      'image/jpeg',
      quality,
    )
  })
}

export async function decodeBlob(blob: Blob): Promise<ImageBitmap> {
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' })
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
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('浏览器无法创建图像画布')
  context.fillStyle = '#fff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  return canvas
}

export function detectPaperCorners(image: ImageData): Point[] {
  const { width, height, data } = image
  const step = Math.max(1, Math.floor(Math.max(width, height) / 360))
  const candidates: Point[] = []

  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const index = (y * width + x) * 4
      const r = data[index]
      const g = data[index + 1]
      const b = data[index + 2]
      const max = Math.max(r, g, b)
      const min = Math.min(r, g, b)
      const luminance = 0.299 * r + 0.587 * g + 0.114 * b
      if (luminance > 150 && max - min < 58) candidates.push({ x, y })
    }
  }

  if (candidates.length < (width * height) / (step * step) * 0.12) return defaultCorners()

  const topLeft = candidates.reduce((a, b) => (a.x + a.y < b.x + b.y ? a : b))
  const bottomRight = candidates.reduce((a, b) => (a.x + a.y > b.x + b.y ? a : b))
  const topRight = candidates.reduce((a, b) => (a.x - a.y > b.x - b.y ? a : b))
  const bottomLeft = candidates.reduce((a, b) => (a.x - a.y < b.x - b.y ? a : b))

  const normalized = [topLeft, topRight, bottomRight, bottomLeft].map(({ x, y }) => ({
    x: Math.min(1, Math.max(0, x / width)),
    y: Math.min(1, Math.max(0, y / height)),
  }))
  const area = polygonArea(normalized)
  return area > 0.3 ? normalized : defaultCorners()
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
      for (let item = column; item <= size; item += 1) {
        augmented[row][item] -= factor * augmented[column][item]
      }
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

function warpPerspective(source: HTMLCanvasElement, normalizedCorners: Point[]) {
  const corners = normalizedCorners.map((point) => ({
    x: point.x * source.width,
    y: point.y * source.height,
  }))
  const width = Math.max(distance(corners[0], corners[1]), distance(corners[3], corners[2]))
  const height = Math.max(distance(corners[0], corners[3]), distance(corners[1], corners[2]))
  const output = document.createElement('canvas')
  output.width = Math.max(2, Math.min(MAX_PROCESS_EDGE, Math.round(width)))
  output.height = Math.max(2, Math.round((output.width * height) / Math.max(1, width)))

  const sourceContext = source.getContext('2d', { willReadFrequently: true })
  const outputContext = output.getContext('2d')
  if (!sourceContext || !outputContext) throw new Error('无法读取图像画布')
  const input = sourceContext.getImageData(0, 0, source.width, source.height)
  const result = outputContext.createImageData(output.width, output.height)
  const destination = [
    { x: 0, y: 0 },
    { x: output.width - 1, y: 0 },
    { x: output.width - 1, y: output.height - 1 },
    { x: 0, y: output.height - 1 },
  ]
  const coefficients = perspectiveCoefficients(destination, corners)

  for (let y = 0; y < output.height; y += 1) {
    for (let x = 0; x < output.width; x += 1) {
      const mapped = projectPoint({ x, y }, coefficients)
      const sourceX = Math.min(source.width - 1, Math.max(0, Math.round(mapped.x)))
      const sourceY = Math.min(source.height - 1, Math.max(0, Math.round(mapped.y)))
      const sourceIndex = (sourceY * source.width + sourceX) * 4
      const targetIndex = (y * output.width + x) * 4
      result.data[targetIndex] = input.data[sourceIndex]
      result.data[targetIndex + 1] = input.data[sourceIndex + 1]
      result.data[targetIndex + 2] = input.data[sourceIndex + 2]
      result.data[targetIndex + 3] = 255
    }
  }
  outputContext.putImageData(result, 0, 0)
  return output
}

function rotateCanvas(source: HTMLCanvasElement, degrees: number) {
  if (degrees === 0) return source
  const output = document.createElement('canvas')
  const swap = degrees === 90 || degrees === 270
  output.width = swap ? source.height : source.width
  output.height = swap ? source.width : source.height
  const context = output.getContext('2d')
  if (!context) throw new Error('无法旋转图像')
  context.translate(output.width / 2, output.height / 2)
  context.rotate((degrees * Math.PI) / 180)
  context.drawImage(source, -source.width / 2, -source.height / 2)
  return output
}

function enhance(source: HTMLCanvasElement, mode: ColorMode) {
  const output = document.createElement('canvas')
  output.width = source.width
  output.height = source.height
  const context = output.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('无法增强图像')
  context.drawImage(source, 0, 0)
  const image = context.getImageData(0, 0, output.width, output.height)
  const { data } = image
  for (let index = 0; index < data.length; index += 4) {
    const r = data[index]
    const g = data[index + 1]
    const b = data[index + 2]
    const luminance = 0.299 * r + 0.587 * g + 0.114 * b
    const contrast = luminance < 165 ? 0.72 : 1 + (255 - luminance) * 0.018
    const target = Math.max(0, Math.min(255, luminance * contrast))
    if (mode === 'mono') {
      data[index] = target
      data[index + 1] = target
      data[index + 2] = target
    } else {
      const ratio = luminance > 0 ? target / luminance : 1
      data[index] = Math.min(255, r * ratio)
      data[index + 1] = Math.min(255, g * ratio)
      data[index + 2] = Math.min(255, b * ratio)
    }
  }
  context.putImageData(image, 0, 0)
  return output
}

function smartErase(source: HTMLCanvasElement) {
  const output = document.createElement('canvas')
  output.width = source.width
  output.height = source.height
  const context = output.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('无法执行智能擦除')
  context.drawImage(source, 0, 0)
  const image = context.getImageData(0, 0, output.width, output.height)
  const { data, width, height } = image
  const rowDensity = new Float32Array(height)

  for (let y = 0; y < height; y += 1) {
    let dark = 0
    for (let x = 0; x < width; x += 2) {
      const index = (y * width + x) * 4
      const luminance = 0.299 * data[index] + 0.587 * data[index + 1] + 0.114 * data[index + 2]
      if (luminance < 125) dark += 1
    }
    rowDensity[y] = dark / Math.ceil(width / 2)
  }

  const reviewRegions: ReviewRegion[] = []
  const gridColumns = 4
  const gridRows = 6
  const uncertainGrid = new Uint32Array(gridColumns * gridRows)

  for (let y = 1; y < height - 1; y += 1) {
    const inPrintedBand =
      rowDensity[Math.max(0, y - 2)] > 0.045 ||
      rowDensity[y] > 0.045 ||
      rowDensity[Math.min(height - 1, y + 2)] > 0.045
    for (let x = 1; x < width - 1; x += 1) {
      const index = (y * width + x) * 4
      const r = data[index]
      const g = data[index + 1]
      const b = data[index + 2]
      const max = Math.max(r, g, b)
      const min = Math.min(r, g, b)
      const chroma = max - min
      const luminance = 0.299 * r + 0.587 * g + 0.114 * b
      const coloredInk = chroma > 48 && luminance < 210 && (b > r * 1.12 || r > g * 1.25)
      const localVertical =
        Math.abs(data[index - width * 4] - r) + Math.abs(data[index + width * 4] - r)
      const blackHandwritingCandidate =
        luminance < 82 && !inPrintedBand && localVertical > 18 && y > height * 0.04
      const faintWatermark = luminance > 178 && luminance < 232 && chroma < 18

      if (coloredInk || blackHandwritingCandidate || faintWatermark) {
        const strength = coloredInk ? 1 : blackHandwritingCandidate ? 0.92 : 0.55
        const paper = 255 - (1 - strength) * (255 - luminance)
        data[index] = paper
        data[index + 1] = paper
        data[index + 2] = paper
      } else if (luminance < 100 && inPrintedBand && localVertical > 55) {
        const column = Math.min(gridColumns - 1, Math.floor((x / width) * gridColumns))
        const row = Math.min(gridRows - 1, Math.floor((y / height) * gridRows))
        uncertainGrid[row * gridColumns + column] += 1
      }
    }
  }

  const cellThreshold = (width * height) / (gridColumns * gridRows) * 0.004
  uncertainGrid.forEach((count, index) => {
    if (count < cellThreshold || reviewRegions.length >= 6) return
    reviewRegions.push({
      x: (index % gridColumns) / gridColumns,
      y: Math.floor(index / gridColumns) / gridRows,
      width: 1 / gridColumns,
      height: 1 / gridRows,
      reason: '检测到与印刷文字相邻的黑色笔迹，请复核',
    })
  })
  context.putImageData(image, 0, 0)
  return { canvas: output, reviewRegions }
}

export async function processWorksheet(blob: Blob, options: ProcessOptions = {}): Promise<ProcessResult> {
  const report = options.onProgress ?? (() => undefined)
  assertActive(options.signal)
  report(8)
  const bitmap = await decodeBlob(blob)
  try {
    const source = createScaledCanvas(bitmap)
    report(20)
    assertActive(options.signal)
    const sourceContext = source.getContext('2d', { willReadFrequently: true })
    if (!sourceContext) throw new Error('无法读取图片')
    const detected = options.corners ?? detectPaperCorners(
      sourceContext.getImageData(0, 0, source.width, source.height),
    )
    const warped = warpPerspective(source, detected)
    const rotated = rotateCanvas(warped, options.rotation ?? 0)
    report(48)
    assertActive(options.signal)
    const enhancedCanvas = enhance(rotated, options.colorMode ?? 'color')
    const enhanced = await canvasToBlob(enhancedCanvas)
    report(68)
    assertActive(options.signal)
    const erased = smartErase(enhancedCanvas)
    const processed = await canvasToBlob(erased.canvas)
    report(100)
    return {
      enhanced,
      processed,
      width: erased.canvas.width,
      height: erased.canvas.height,
      corners: detected,
      reviewRegions: erased.reviewRegions,
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
  stroke.points.forEach((point, index) => {
    if (index === 0) context.moveTo(point.x, point.y)
    else context.lineTo(point.x, point.y)
  })
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

export async function renderEditedPage(
  processedUrl: string,
  enhancedUrl: string,
  strokes: Stroke[],
) {
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
