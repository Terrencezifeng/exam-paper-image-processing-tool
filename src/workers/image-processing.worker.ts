/// <reference lib="webworker" />

import { processWorksheet } from '../lib/image-processing'
import type { ProcessingWorkerRequest, ProcessingWorkerResponse } from '../lib/processing-worker.types'

const scope: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope
const controllers = new Map<string, AbortController>()

function send(message: ProcessingWorkerResponse) {
  scope.postMessage(message)
}

scope.onmessage = (event: MessageEvent<ProcessingWorkerRequest>) => {
  const request = event.data
  if (request.type === 'cancel') {
    controllers.get(request.id)?.abort()
    return
  }

  const controller = new AbortController()
  controllers.set(request.id, controller)
  void processWorksheet(request.blob, {
    ...request.options,
    signal: controller.signal,
    onProgress: (progress, stage) => send({ type: 'progress', id: request.id, progress, stage }),
  })
    .then((result) => send({ type: 'result', id: request.id, result }))
    .catch((error: unknown) => send({
      type: 'error',
      id: request.id,
      name: error instanceof DOMException ? error.name : 'Error',
      message: error instanceof Error ? error.message : '未知处理错误',
    }))
    .finally(() => controllers.delete(request.id))
}
