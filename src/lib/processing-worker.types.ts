import type { ProcessOptions, ProcessResult } from './image-processing'
import type { ProcessingStage } from '../types'

export type WorkerProcessOptions = Omit<ProcessOptions, 'signal' | 'onProgress'>

export type ProcessingWorkerRequest =
  | { type: 'process'; id: string; blob: Blob; options: WorkerProcessOptions }
  | { type: 'cancel'; id: string }

export type ProcessingWorkerResponse =
  | { type: 'progress'; id: string; progress: number; stage: ProcessingStage }
  | { type: 'result'; id: string; result: ProcessResult }
  | { type: 'error'; id: string; name: string; message: string }
