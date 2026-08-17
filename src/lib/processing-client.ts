import type { ProcessResult } from './image-processing'
import type { ProcessingWorkerRequest, ProcessingWorkerResponse, WorkerProcessOptions } from './processing-worker.types'
import type { ProcessingStage } from '../types'

type PendingRequest = {
  resolve: (result: ProcessResult) => void
  reject: (reason: unknown) => void
  onProgress?: (progress: number, stage: ProcessingStage) => void
  signal?: AbortSignal
  onAbort: () => void
}

let sharedWorker: Worker | undefined
const pending = new Map<string, PendingRequest>()

function removePending(id: string) {
  const request = pending.get(id)
  if (!request) return undefined
  request.signal?.removeEventListener('abort', request.onAbort)
  pending.delete(id)
  return request
}

function failWorker() {
  const error = new Error('图像处理线程异常，请重试')
  for (const id of pending.keys()) removePending(id)?.reject(error)
  sharedWorker?.terminate()
  sharedWorker = undefined
}

function worker() {
  if (sharedWorker) return sharedWorker
  sharedWorker = new Worker(new URL('../workers/image-processing.worker.ts', import.meta.url), { type: 'module' })
  sharedWorker.onmessage = (event: MessageEvent<ProcessingWorkerResponse>) => {
    const message = event.data
    const request = pending.get(message.id)
    if (!request) return
    if (message.type === 'progress') {
      request.onProgress?.(message.progress, message.stage)
      return
    }
    removePending(message.id)
    if (message.type === 'result') request.resolve(message.result)
    else request.reject(message.name === 'AbortError'
      ? new DOMException(message.message, 'AbortError')
      : new Error(message.message))
  }
  sharedWorker.onerror = failWorker
  return sharedWorker
}

export function processWorksheetInWorker(
  id: string,
  blob: Blob,
  options: WorkerProcessOptions & {
    signal?: AbortSignal
    onProgress?: (progress: number, stage: ProcessingStage) => void
  },
) {
  if (typeof OffscreenCanvas === 'undefined') {
    return import('./image-processing').then(({ processWorksheet }) => processWorksheet(blob, {
      ...options,
      onProgress: options.onProgress,
      signal: options.signal,
    }))
  }

  return new Promise<ProcessResult>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new DOMException('处理已取消', 'AbortError'))
      return
    }
    const { signal, onProgress, ...workerOptions } = options
    const onAbort = () => {
      const message: ProcessingWorkerRequest = { type: 'cancel', id }
      sharedWorker?.postMessage(message)
      removePending(id)?.reject(new DOMException('处理已取消', 'AbortError'))
    }
    pending.set(id, { resolve, reject, onProgress, signal, onAbort })
    signal?.addEventListener('abort', onAbort, { once: true })
    const message: ProcessingWorkerRequest = { type: 'process', id, blob, options: workerOptions }
    worker().postMessage(message)
  })
}
