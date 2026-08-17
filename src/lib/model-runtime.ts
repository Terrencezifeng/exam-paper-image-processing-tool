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
}

type ModelManifest = {
  orientation: ModelDescriptor
}

export type OrientationPrediction = {
  rotation: Rotation
  confidence: number
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

function imageToTensor(image: ImageData, size: number, ort: OrtModule) {
  const data = new Float32Array(3 * size * size)
  for (let y = 0; y < size; y += 1) {
    const sourceY = Math.min(image.height - 1, Math.floor((y / size) * image.height))
    for (let x = 0; x < size; x += 1) {
      const sourceX = Math.min(image.width - 1, Math.floor((x / size) * image.width))
      const source = (sourceY * image.width + sourceX) * 4
      const target = y * size + x
      data[target] = image.data[source] / 255
      data[size * size + target] = image.data[source + 1] / 255
      data[size * size * 2 + target] = image.data[source + 2] / 255
    }
  }
  return new ort.Tensor('float32', data, [1, 3, size, size])
}

export async function predictOrientation(image: ImageData): Promise<OrientationPrediction> {
  try {
    const manifest = await loadManifest()
    const descriptor = manifest.orientation
    if (descriptor.status !== 'ready') return { rotation: 0, confidence: 0, backend: 'unavailable' }
    const ort = await loadOrt()
    const { output, backend } = await retryOnWasm(descriptor, (session) => session.run({
      [descriptor.inputName]: imageToTensor(image, descriptor.inputSize, ort),
    }))
    const scores = Array.from(output[descriptor.outputName].data as Float32Array)
    const probabilities = scores.map((score) => Math.exp(score - Math.max(...scores)))
    const total = probabilities.reduce((sum, value) => sum + value, 0)
    const best = probabilities.indexOf(Math.max(...probabilities))
    return {
      rotation: ([0, 90, 180, 270] as Rotation[])[best] ?? 0,
      confidence: probabilities[best] / total,
      backend,
      modelVersion: descriptor.version,
    }
  } catch {
    return { rotation: 0, confidence: 0, backend: 'unavailable' }
  }
}
