import { afterEach, describe, expect, it, vi } from 'vitest'
import { processWorksheetInWorker } from './processing-client'

class WorkerMock {
  static instances: WorkerMock[] = []
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  postMessage = vi.fn()
  terminate = vi.fn()

  constructor() {
    WorkerMock.instances.push(this)
  }
}

describe('processing worker client', () => {
  afterEach(() => {
    WorkerMock.instances = []
    vi.unstubAllGlobals()
  })

  it('cancels only the requested page while keeping the shared worker available', async () => {
    vi.stubGlobal('Worker', WorkerMock)
    vi.stubGlobal('OffscreenCanvas', class {})
    const controller = new AbortController()
    const promise = processWorksheetInWorker('page:request', new Blob(['image']), {
      signal: controller.signal,
    })
    controller.abort()
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    const worker = WorkerMock.instances[0]
    expect(worker.postMessage).toHaveBeenCalledWith({ type: 'cancel', id: 'page:request' })
    expect(worker.terminate).not.toHaveBeenCalled()
  })
})
