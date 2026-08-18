import type { EnhancementPreset, PersistedBinary, PersistedPage, PersistedTask, ReviewReason, WorksheetPage } from '../types'

const DB_NAME = 'jingjuan-local'
const STORE_NAME = 'tasks'
const TASK_ID = 'active-task'
const MAX_AGE = 24 * 60 * 60 * 1000
const TASK_VERSION = 4 as const
let requiresBinaryRecords = false

const defaultDiagnostics = {
  autoRotation: 0 as const,
  effectiveRotation: 0 as const,
  orientationConfidence: 0,
  orientationMargin: 0,
  orientationAccepted: false,
  boundaryConfidence: 0,
  boundaryAccepted: false,
  orientationBackend: 'unavailable' as const,
}

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: 'id' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('无法打开本地存储'))
  })
}

function transaction<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>) {
  return openDatabase().then(
    (database) =>
      new Promise<T>((resolve, reject) => {
        const tx = database.transaction(STORE_NAME, mode)
        const request = operation(tx.objectStore(STORE_NAME))
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error ?? new Error('本地存储操作失败'))
        tx.oncomplete = () => database.close()
        tx.onerror = () => reject(tx.error ?? new Error('本地存储事务失败'))
      }),
  )
}

export async function saveTask(pages: WorksheetPage[], defaultEnhancementPreset: EnhancementPreset = 'clear') {
  const createTask = async (useBinaryRecords: boolean): Promise<PersistedTask> => ({
    id: TASK_ID,
    version: TASK_VERSION,
    updatedAt: Date.now(),
    defaultEnhancementPreset,
    pages: await Promise.all(pages.map((page) => toPersistedPage(page, useBinaryRecords))),
  })
  try {
    const task = await createTask(requiresBinaryRecords)
    await transaction('readwrite', (store) => store.put(task))
  } catch (error) {
    if (requiresBinaryRecords) throw error
    requiresBinaryRecords = true
    const task = await createTask(true)
    await transaction('readwrite', (store) => store.put(task))
  }
}

async function storeBinary(blob: Blob | undefined, useBinaryRecords: boolean): Promise<PersistedBinary | undefined> {
  if (!blob) return undefined
  if (!useBinaryRecords) return blob.slice(0, blob.size, blob.type)
  return { bytes: await blob.arrayBuffer(), type: blob.type }
}

function restoreBinary(value: PersistedBinary | undefined): Blob | undefined {
  if (!value) return undefined
  if (value instanceof Blob) return value
  return new Blob([value.bytes], { type: value.type })
}

async function toPersistedPage(page: WorksheetPage, useBinaryRecords: boolean): Promise<PersistedPage> {
  return {
    id: page.id,
    name: page.name,
    source: (await storeBinary(page.source, useBinaryRecords))!,
    sourcePreview: await storeBinary(page.sourcePreview, useBinaryRecords),
    sourceWidth: page.sourceWidth,
    sourceHeight: page.sourceHeight,
    width: page.width,
    height: page.height,
    status: page.status,
    progress: page.progress,
    rotation: page.rotation,
    autoRotation: page.autoRotation,
    enhancementPreset: page.enhancementPreset,
    reviewReasons: page.reviewReasons,
    reviewConfirmed: page.reviewConfirmed,
    corners: page.corners,
    processingStage: page.processingStage,
    enhanced: await storeBinary(page.enhanced, useBinaryRecords),
    processed: await storeBinary(page.processed, useBinaryRecords),
    diagnostics: page.diagnostics,
    strokes: page.strokes,
    undoneStrokes: page.undoneStrokes,
    error: page.error,
  }
}

type LegacyPage = Omit<Partial<PersistedPage>, 'processingStage' | 'status' | 'diagnostics'> & {
  source: PersistedBinary
  width: number
  height: number
  processingStage?: string
  status?: string
  diagnostics?: Partial<WorksheetPage['diagnostics']> & {
    inferenceBackend?: string
    modelVersion?: string
  }
}

export async function loadTask(): Promise<{ pages: WorksheetPage[]; defaultEnhancementPreset: EnhancementPreset }> {
  const task = await transaction<(Omit<Partial<PersistedTask>, 'version' | 'pages'> & { version?: number; updatedAt: number; pages: LegacyPage[] }) | undefined>('readonly', (store) => store.get(TASK_ID))
  if (!task) return { pages: [], defaultEnhancementPreset: 'clear' }
  if (Date.now() - task.updatedAt > MAX_AGE) {
    await clearTask()
    return { pages: [], defaultEnhancementPreset: 'clear' }
  }
  const version = task.version ?? 2
  const preV3Task = version < 3
  const preV4Task = version < 4
  const pages = task.pages.map((page) => {
    const source = restoreBinary(page.source)!
    const sourcePreview = restoreBinary(page.sourcePreview)
    const storedEnhanced = restoreBinary(page.enhanced)
    const storedProcessed = restoreBinary(page.processed)
    const enhanced = storedEnhanced
    const processed = preV3Task ? storedEnhanced : storedProcessed
    const needsReprocessing = preV3Task && !enhanced
    const diagnostics = page.diagnostics
    const orientationAccepted = diagnostics?.orientationAccepted ?? (
      (diagnostics?.orientationConfidence ?? 0) >= 0.7 &&
      (diagnostics?.orientationMargin ?? 0) >= 0.15 &&
      diagnostics?.orientationBackend !== 'unavailable' &&
      !diagnostics?.warning?.includes('方向')
    )
    const inferredReviewReasons = [
      !orientationAccepted ? 'orientation' : undefined,
      !(diagnostics?.boundaryAccepted ?? false) ? 'boundary' : undefined,
    ].filter((reason): reason is ReviewReason => Boolean(reason))
    return {
      ...page,
      sourceWidth: page.sourceWidth ?? page.width,
      sourceHeight: page.sourceHeight ?? page.height,
      autoRotation: page.autoRotation ?? 0,
      enhancementPreset: preV4Task ? 'soft' : (page.enhancementPreset ?? 'clear'),
      reviewReasons: page.reviewReasons ?? inferredReviewReasons,
      reviewConfirmed: page.reviewConfirmed ?? false,
      processingStage: needsReprocessing
        ? 'queued'
        : String(page.processingStage) === 'erasure' ? 'compositing' : (page.processingStage ?? 'queued'),
      enhanced,
      processed,
      diagnostics: {
        ...defaultDiagnostics,
        autoRotation: diagnostics?.autoRotation ?? page.autoRotation ?? 0,
        effectiveRotation: diagnostics?.effectiveRotation ?? page.rotation ?? 0,
        orientationConfidence: diagnostics?.orientationConfidence ?? 0,
        orientationMargin: diagnostics?.orientationMargin ?? 0,
        orientationAccepted,
        boundaryConfidence: diagnostics?.boundaryConfidence ?? 0,
        boundaryAccepted: diagnostics?.boundaryAccepted ?? false,
        orientationBackend: preV3Task ? 'unavailable' : (diagnostics?.orientationBackend ?? 'unavailable'),
        orientationModelVersion: preV3Task ? undefined : diagnostics?.orientationModelVersion,
        warning: diagnostics?.warning,
      },
      strokes: page.strokes ?? [],
      undoneStrokes: page.undoneStrokes ?? [],
      status: needsReprocessing
        ? 'queued'
        : page.status === 'processing' ? 'cancelled' : String(page.status) === 'review' ? 'ready' : (page.status ?? 'queued'),
      error: needsReprocessing
        ? '旧任务缺少未擦除基线，正在从原图重新处理'
        : page.status === 'processing' ? '页面在上次关闭时仍在处理，请重新处理' : page.error,
      source,
      sourcePreview,
      sourceUrl: URL.createObjectURL(source),
      sourcePreviewUrl: sourcePreview ? URL.createObjectURL(sourcePreview) : undefined,
      enhancedUrl: enhanced ? URL.createObjectURL(enhanced) : undefined,
      processedUrl: processed ? URL.createObjectURL(processed) : undefined,
    } as WorksheetPage
  })
  const defaultEnhancementPreset = preV4Task
    ? 'soft'
    : (task.defaultEnhancementPreset ?? pages[0]?.enhancementPreset ?? 'clear')
  return { pages, defaultEnhancementPreset }
}

export async function clearTask() {
  await transaction('readwrite', (store) => store.delete(TASK_ID))
}
