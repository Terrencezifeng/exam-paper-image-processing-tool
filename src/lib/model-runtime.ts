import type { InferenceBackend, Rotation } from '../types'
import type * as Ort from 'onnxruntime-web'

type ModelDescriptor = {
  status: 'ready' | 'pending'
  version: string
  url: string
  inputName: string
  outputName: string
  inputSize: number
  sha256?: string
  sizeBytes?: number
  outputType?: 'logits' | 'probabilities'
  labelMode?: 'correction' | 'observed'
  autoThreshold?: number
  marginThreshold?: number
  preprocess?: {
    resizeShort: number
    cropSize: number
    mean: [number, number, number]
    std: [number, number, number]
    channelOrder?: 'rgb' | 'bgr'
  }
  preferPortrait?: boolean
}

type ModelManifest = {
  orientation: ModelDescriptor
}

export type OrientationPrediction = {
  rotation: Rotation
  confidence: number
  confidenceMargin: number
  accepted: boolean
  backend: InferenceBackend
  modelVersion?: string
}

type OrtModule = typeof Ort
type Session = Ort.InferenceSession

let manifestPromise: Promise<ModelManifest> | undefined
let ortPromise: Promise<OrtModule> | undefined
const sessions = new Map<string, Promise<{ session: Session; backend: Exclude<InferenceBackend, 'unavailable'> }>>()
const modelBytes = new Map<string, Promise<ArrayBuffer>>()
const failedWebGpuModels = new Set<string>()

async function loadManifest() {
  manifestPromise ??= fetch('/models/manifest.json', { cache: 'no-cache' }).then(async (response) => {
    if (!response.ok) throw new Error('无法读取本地模型清单')
    return response.json() as Promise<ModelManifest>
  })
  return manifestPromise
}

async function loadOrt() {
  ortPromise ??= ('gpu' in navigator
    ? import('onnxruntime-web/webgpu')
    : import('onnxruntime-web')) as Promise<OrtModule>
  return ortPromise
}

async function loadModelBytes(descriptor: ModelDescriptor) {
  const cached = modelBytes.get(descriptor.url)
  if (cached) return cached
  const created = (async () => {
    const modelUrl = new URL(descriptor.url, self.location.origin)
    if (modelUrl.origin !== self.location.origin || !modelUrl.pathname.startsWith('/models/')) {
      throw new Error('模型必须从同源 /models/ 路径加载')
    }
    if (!descriptor.sha256 || !descriptor.sizeBytes) throw new Error('模型缺少完整性元数据')
    const response = await fetch(modelUrl)
    if (!response.ok) throw new Error('模型加载失败')
    const modelBytes = await response.arrayBuffer()
    if (modelBytes.byteLength !== descriptor.sizeBytes) throw new Error('模型大小校验失败')
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', modelBytes)))
      .map((value) => value.toString(16).padStart(2, '0')).join('')
    if (digest !== descriptor.sha256.toLowerCase()) throw new Error('模型完整性校验失败')
    return modelBytes
  })()
  modelBytes.set(descriptor.url, created)
  return created
}

async function getSession(descriptor: ModelDescriptor, backend: Exclude<InferenceBackend, 'unavailable'>) {
  const key = `${descriptor.url}:${backend}`
  const cached = sessions.get(key)
  if (cached) return cached
  const created = (async () => {
    const ort = await loadOrt()
    const session = await ort.InferenceSession.create(await loadModelBytes(descriptor), {
      executionProviders: [backend],
      graphOptimizationLevel: 'all',
    })
    return { session, backend }
  })()
  sessions.set(key, created)
  return created
}

async function preferredSession(descriptor: ModelDescriptor) {
  if ('gpu' in navigator && !failedWebGpuModels.has(descriptor.url)) {
    try {
      return await getSession(descriptor, 'webgpu')
    } catch {
      failedWebGpuModels.add(descriptor.url)
    }
  }
  return getSession(descriptor, 'wasm')
}

async function retryOnWasm<T>(
  descriptor: ModelDescriptor,
  inference: (session: Session) => Promise<T>,
): Promise<{ output: T; backend: Exclude<InferenceBackend, 'unavailable'> }> {
  const selected = await preferredSession(descriptor)
  try {
    return { output: await inference(selected.session), backend: selected.backend }
  } catch (error) {
    if (selected.backend === 'wasm') throw error
    failedWebGpuModels.add(descriptor.url)
    const fallback = await getSession(descriptor, 'wasm')
    return { output: await inference(fallback.session), backend: fallback.backend }
  }
}

function bilinearChannel(image: ImageData, x: number, y: number, channel: number) {
  const left = Math.max(0, Math.min(image.width - 1, Math.floor(x)))
  const top = Math.max(0, Math.min(image.height - 1, Math.floor(y)))
  const right = Math.min(image.width - 1, left + 1)
  const bottom = Math.min(image.height - 1, top + 1)
  const weightX = x - Math.floor(x)
  const weightY = y - Math.floor(y)
  const topValue = image.data[(top * image.width + left) * 4 + channel] * (1 - weightX) +
    image.data[(top * image.width + right) * 4 + channel] * weightX
  const bottomValue = image.data[(bottom * image.width + left) * 4 + channel] * (1 - weightX) +
    image.data[(bottom * image.width + right) * 4 + channel] * weightX
  return topValue * (1 - weightY) + bottomValue * weightY
}

function imageToTensor(image: ImageData, descriptor: ModelDescriptor, ort: OrtModule) {
  const size = descriptor.inputSize
  const data = new Float32Array(3 * size * size)
  const preprocessing = descriptor.preprocess
  const resizeScale = preprocessing ? preprocessing.resizeShort / Math.min(image.width, image.height) : undefined
  const resizedWidth = resizeScale ? Math.round(image.width * resizeScale) : size
  const resizedHeight = resizeScale ? Math.round(image.height * resizeScale) : size
  const cropOffsetX = (resizedWidth - (preprocessing?.cropSize ?? size)) / 2
  const cropOffsetY = (resizedHeight - (preprocessing?.cropSize ?? size)) / 2
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const target = y * size + x
      if (preprocessing && resizeScale) {
        const sourceX = (x + cropOffsetX + 0.5) * image.width / resizedWidth - 0.5
        const sourceY = (y + cropOffsetY + 0.5) * image.height / resizedHeight - 0.5
        for (let channel = 0; channel < 3; channel += 1) {
          const sourceChannel = preprocessing.channelOrder === 'bgr' ? 2 - channel : channel
          const normalized = bilinearChannel(image, sourceX, sourceY, sourceChannel) / 255
          data[channel * size * size + target] = (normalized - preprocessing.mean[channel]) / preprocessing.std[channel]
        }
      } else {
        const sourceX = Math.min(image.width - 1, Math.floor((x / size) * image.width))
        const sourceY = Math.min(image.height - 1, Math.floor((y / size) * image.height))
        const source = (sourceY * image.width + sourceX) * 4
        data[target] = image.data[source] / 255
        data[size * size + target] = image.data[source + 1] / 255
        data[size * size * 2 + target] = image.data[source + 2] / 255
      }
    }
  }
  return new ort.Tensor('float32', data, [1, 3, size, size])
}

export async function predictOrientation(image: ImageData): Promise<OrientationPrediction> {
  try {
    const manifest = await loadManifest()
    const descriptor = manifest.orientation
    if (descriptor.status !== 'ready') return { rotation: 0, confidence: 0, confidenceMargin: 0, accepted: false, backend: 'unavailable' }
    const ort = await loadOrt()
    const { output, backend } = await retryOnWasm(descriptor, (session) => session.run({
      [descriptor.inputName]: imageToTensor(image, descriptor, ort),
    }))
    const scores = Array.from(output[descriptor.outputName].data as Float32Array)
    const probabilities = descriptor.outputType === 'probabilities'
      ? scores
      : scores.map((score) => Math.exp(score - Math.max(...scores)))
    const total = descriptor.outputType === 'probabilities'
      ? 1
      : probabilities.reduce((sum, value) => sum + value, 0)
    const best = probabilities.indexOf(Math.max(...probabilities))
    const confidence = probabilities[best] / total
    const ordered = probabilities.map((value) => value / total).sort((a, b) => b - a)
    const confidenceMargin = ordered[0] - (ordered[1] ?? 0)
    const observed = ([0, 90, 180, 270] as Rotation[])[best] ?? 0
    const rotation = descriptor.labelMode === 'observed'
      ? ((360 - observed) % 360) as Rotation
      : observed
    const landscape = image.width / image.height > 1.12
    const portrait = image.height / image.width > 1.12
    const producesPortrait = landscape ? rotation === 90 || rotation === 270
      : portrait ? rotation === 0 || rotation === 180
      : true
    return {
      rotation,
      confidence,
      confidenceMargin,
      accepted: confidence >= (descriptor.autoThreshold ?? 0.82) &&
        confidenceMargin >= (descriptor.marginThreshold ?? 0) &&
        (!descriptor.preferPortrait || producesPortrait),
      backend,
      modelVersion: descriptor.version,
    }
  } catch {
    return { rotation: 0, confidence: 0, confidenceMargin: 0, accepted: false, backend: 'unavailable' }
  }
}
