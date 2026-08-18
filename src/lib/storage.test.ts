import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearTask, loadTask, saveTask } from './storage'
import type { WorksheetPage } from '../types'

const baseline = new Blob(['baseline'], { type: 'image/jpeg' })

const basePage: WorksheetPage = {
  id: 'page-1',
  name: 'paper.jpg',
  source: new Blob(['source'], { type: 'image/jpeg' }),
  sourceUrl: 'blob:source',
  sourcePreview: new Blob(['preview'], { type: 'image/jpeg' }),
  sourcePreviewUrl: 'blob:preview',
  sourceWidth: 100,
  sourceHeight: 200,
  width: 100,
  height: 200,
  status: 'ready',
  progress: 100,
  rotation: 0,
  autoRotation: 0,
  enhancementPreset: 'clear',
  reviewReasons: ['boundary'],
  reviewConfirmed: false,
  corners: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
  processingStage: 'compositing',
  enhanced: baseline,
  processed: baseline,
  diagnostics: {
    autoRotation: 0,
    effectiveRotation: 0,
    orientationConfidence: 0.9,
    orientationMargin: 0.7,
    orientationAccepted: true,
    boundaryConfidence: 0.9,
    boundaryAccepted: true,
    orientationBackend: 'wasm',
    orientationModelVersion: 'orientation-v1',
  },
  strokes: [],
  undoneStrokes: [],
}

function putLegacyTask(page: Record<string, unknown>, version = 2) {
  return new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('jingjuan-local', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('tasks', { keyPath: 'id' })
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const database = request.result
      const transaction = database.transaction('tasks', 'readwrite')
      transaction.objectStore('tasks').put({ id: 'active-task', version, updatedAt: Date.now(), pages: [page] })
      transaction.oncomplete = () => { database.close(); resolve() }
      transaction.onerror = () => reject(transaction.error)
    }
  })
}

describe('task storage migration', () => {
  beforeEach(async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    await clearTask()
  })

  it('persists v4 enhancement and orientation diagnostics', async () => {
    await saveTask([basePage], 'highContrast')
    const restored = await loadTask()
    expect(restored.defaultEnhancementPreset).toBe('highContrast')
    expect(restored.pages[0]).toMatchObject({
      sourcePreview: basePage.sourcePreview,
      autoRotation: 0,
      processingStage: 'compositing',
      enhancementPreset: 'clear',
      reviewReasons: ['boundary'],
      reviewConfirmed: false,
      diagnostics: { boundaryAccepted: true, orientationBackend: 'wasm', orientationMargin: 0.7 },
    })
  })

  it('uses the pre-erasure enhanced image when loading a v2 task', async () => {
    const legacyProcessed = new Blob(['automatically-erased'], { type: 'image/jpeg' })
    await putLegacyTask({
      ...basePage,
      sourceUrl: undefined,
      sourcePreview: undefined,
      sourcePreviewUrl: undefined,
      enhancedUrl: undefined,
      processedUrl: undefined,
      enhanced: baseline,
      processed: legacyProcessed,
      status: 'review',
      smartEraseEnabled: true,
      autoEraseMask: new Blob(['mask']),
      reviewMask: new Blob(['review']),
    })
    const restored = await loadTask()
    expect(restored.pages[0].processed).toBe(restored.pages[0].enhanced)
    expect(restored.pages[0].status).toBe('ready')
    expect(restored.pages[0].enhancementPreset).toBe('soft')
    expect(restored.defaultEnhancementPreset).toBe('soft')
    expect(restored.pages[0].diagnostics.orientationBackend).toBe('unavailable')
  })

  it('preserves the processed image while migrating a v3 task to soft enhancement', async () => {
    const processed = new Blob(['v3-processed'], { type: 'image/jpeg' })
    await putLegacyTask({
      ...basePage,
      sourceUrl: undefined,
      sourcePreviewUrl: undefined,
      enhancedUrl: undefined,
      processedUrl: undefined,
      processed,
    }, 3)
    const restored = await loadTask()
    expect(restored.pages[0].processed).not.toBe(restored.pages[0].enhanced)
    expect(restored.pages[0].processed).toBeTruthy()
    expect(restored.pages[0].enhancementPreset).toBe('soft')
    expect(restored.pages[0].diagnostics.orientationBackend).toBe('wasm')
  })

  it('queues a v2 task for reprocessing when no enhanced baseline exists', async () => {
    const { enhanced: _enhanced, processed: _processed, ...legacy } = basePage
    void _enhanced
    void _processed
    await putLegacyTask({ ...legacy, sourceUrl: undefined, sourcePreviewUrl: undefined })
    const restored = await loadTask()
    expect(restored.pages[0]).toMatchObject({
      status: 'queued',
      processingStage: 'queued',
      error: '旧任务缺少未擦除基线，正在从原图重新处理',
    })
  })
})
