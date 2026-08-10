import type { PersistedPage, PersistedTask, WorksheetPage } from '../types'

const DB_NAME = 'jingjuan-local'
const STORE_NAME = 'tasks'
const TASK_ID = 'active-task'
const MAX_AGE = 24 * 60 * 60 * 1000

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

export async function saveTask(pages: WorksheetPage[]) {
  const task: PersistedTask = {
    id: TASK_ID,
    updatedAt: Date.now(),
    pages: pages.map(toPersistedPage),
  }
  await transaction('readwrite', (store) => store.put(task))
}

function toPersistedPage(page: WorksheetPage): PersistedPage {
  return {
    id: page.id,
    name: page.name,
    source: page.source,
    width: page.width,
    height: page.height,
    status: page.status,
    progress: page.progress,
    rotation: page.rotation,
    corners: page.corners,
    colorMode: page.colorMode,
    enhanced: page.enhanced,
    processed: page.processed,
    reviewRegions: page.reviewRegions,
    strokes: page.strokes,
    undoneStrokes: page.undoneStrokes,
    error: page.error,
  }
}

export async function loadTask(): Promise<WorksheetPage[]> {
  const task = await transaction<PersistedTask | undefined>('readonly', (store) => store.get(TASK_ID))
  if (!task) return []
  if (Date.now() - task.updatedAt > MAX_AGE) {
    await clearTask()
    return []
  }
  return task.pages.map((page) => ({
    ...page,
    status: page.status === 'processing' ? 'cancelled' : page.status,
    error: page.status === 'processing' ? '页面在上次关闭时仍在处理，请重新处理' : page.error,
    sourceUrl: URL.createObjectURL(page.source),
    enhancedUrl: page.enhanced ? URL.createObjectURL(page.enhanced) : undefined,
    processedUrl: page.processed ? URL.createObjectURL(page.processed) : undefined,
  }))
}

export async function clearTask() {
  await transaction('readwrite', (store) => store.delete(TASK_ID))
}
