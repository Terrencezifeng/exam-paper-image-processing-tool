import { beforeEach, describe, expect, it, vi } from 'vitest'

const ortMocks = vi.hoisted(() => ({
  create: vi.fn(),
  webgpuRun: vi.fn(),
  wasmRun: vi.fn(),
}))

vi.mock('onnxruntime-web/webgpu', () => ({
  Tensor: class Tensor {
    constructor(
      public type: string,
      public data: Float32Array,
      public dims: number[],
    ) {}
  },
  InferenceSession: {
    create: ortMocks.create,
  },
}))

describe('model runtime backend fallback', () => {
  beforeEach(() => {
    vi.resetModules()
    ortMocks.create.mockReset()
    ortMocks.webgpuRun.mockReset().mockRejectedValue(new Error('WebGPU kernel failed'))
    ortMocks.wasmRun.mockReset().mockResolvedValue({
      output: { data: new Float32Array([0, 4, 0, 0]) },
    })
    ortMocks.create.mockImplementation(async (_bytes, options: { executionProviders: string[] }) => ({
      run: options.executionProviders[0] === 'webgpu' ? ortMocks.webgpuRun : ortMocks.wasmRun,
    }))
    Object.defineProperty(navigator, 'gpu', { configurable: true, value: {} })
    const manifest = {
      orientation: {
        status: 'ready',
        version: 'test',
        url: '/models/orientation.onnx',
        sha256: '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81',
        sizeBytes: 3,
        inputName: 'input',
        outputName: 'output',
        inputSize: 1,
      },
    }
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      return url.includes('manifest.json')
        ? new Response(JSON.stringify(manifest), { status: 200 })
        : new Response(new Uint8Array([1, 2, 3]), { status: 200 })
    }))
  })

  it('retries a failed WebGPU inference with WASM and remembers the failure', async () => {
    const { predictOrientation } = await import('./model-runtime')
    const image = {
      width: 1,
      height: 1,
      data: new Uint8ClampedArray([255, 255, 255, 255]),
    } as ImageData

    const first = await predictOrientation(image)
    const second = await predictOrientation(image)

    expect(first.backend).toBe('wasm')
    expect(first.rotation).toBe(90)
    expect(first.accepted).toBe(true)
    expect(second.backend).toBe('wasm')
    expect(ortMocks.webgpuRun).toHaveBeenCalledTimes(1)
    expect(ortMocks.wasmRun).toHaveBeenCalledTimes(2)
    expect(ortMocks.create.mock.calls.map((call) => call[1].executionProviders[0])).toEqual(['webgpu', 'wasm'])
  })

  it('interprets Paddle probabilities as observed orientation and enforces both thresholds', async () => {
    vi.resetModules()
    Object.defineProperty(navigator, 'gpu', { configurable: true, value: undefined })
    ortMocks.create.mockReset().mockResolvedValue({
      run: vi.fn().mockResolvedValue({
        probabilities: { data: new Float32Array([0.02, 0.82, 0.1, 0.06]) },
      }),
    })
    const manifest = {
      orientation: {
        status: 'ready', version: 'paddle-test', url: '/models/paddle.onnx',
        sha256: '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81',
        sizeBytes: 3, inputName: 'x', outputName: 'probabilities', inputSize: 1,
        outputType: 'probabilities', labelMode: 'observed', autoThreshold: 0.7, marginThreshold: 0.15,
        preprocess: { resizeShort: 1, cropSize: 1, mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225] },
      },
    }
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => String(input).includes('manifest.json')
      ? new Response(JSON.stringify(manifest), { status: 200 })
      : new Response(new Uint8Array([1, 2, 3]), { status: 200 })))
    const { predictOrientation } = await import('./model-runtime')
    const result = await predictOrientation({ width: 1, height: 1, data: new Uint8ClampedArray([255, 255, 255, 255]) } as ImageData)
    expect(result).toMatchObject({
      rotation: 270,
      accepted: true,
    })
    expect(result.confidence).toBeCloseTo(0.82)
    expect(result.confidenceMargin).toBeCloseTo(0.72)
  })
})
