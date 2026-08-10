import {
  ArrowDown,
  ArrowLeftRight,
  ArrowUp,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Crop,
  Download,
  Eraser,
  FileImage,
  FileText,
  FolderOpen,
  GripVertical,
  ImagePlus,
  LoaderCircle,
  LockKeyhole,
  Redo2,
  RefreshCw,
  RotateCcw,
  RotateCw,
  ShieldCheck,
  Sparkles,
  Trash2,
  Undo2,
  WandSparkles,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { MAX_FILES, splitValidFiles } from './lib/files'
import { decodeBlob, processWorksheet, renderEditedPage } from './lib/image-processing'
import { clearTask, loadTask, saveTask } from './lib/storage'
import type {
  EditTool,
  ExportSettings,
  Point,
  Stroke,
  WorksheetPage,
} from './types'

const initialExportSettings: ExportSettings = {
  colorMode: 'color',
  quality: 'standard',
  margin: 12,
  filename: '净化试卷',
}

const statusLabel = {
  queued: '等待处理',
  processing: '正在处理',
  review: '需要复核',
  ready: '处理完成',
  failed: '处理失败',
  cancelled: '已取消',
} as const

function createId() {
  return crypto.randomUUID()
}

function revokePageUrls(page: WorksheetPage) {
  URL.revokeObjectURL(page.sourceUrl)
  if (page.enhancedUrl) URL.revokeObjectURL(page.enhancedUrl)
  if (page.processedUrl) URL.revokeObjectURL(page.processedUrl)
}

function App() {
  const [pages, setPages] = useState<WorksheetPage[]>([])
  const [selectedId, setSelectedId] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [restoring, setRestoring] = useState(true)
  const [tool, setTool] = useState<EditTool>('eraser')
  const [brushSize, setBrushSize] = useState(36)
  const [compare, setCompare] = useState(false)
  const [cropPage, setCropPage] = useState<WorksheetPage>()
  const [showExport, setShowExport] = useState(false)
  const [exporting, setExporting] = useState(0)
  const [exportSettings, setExportSettings] = useState(initialExportSettings)
  const controllers = useRef(new Map<string, AbortController>())
  const saveTimer = useRef<number | undefined>(undefined)
  const pagesRef = useRef(pages)

  useEffect(() => {
    pagesRef.current = pages
  }, [pages])

  useEffect(() => {
    void loadTask()
      .then((restored) => {
        setPages(restored)
        setSelectedId(restored[0]?.id)
      })
      .catch(() => setNotice('未能恢复上次任务，你仍可新建任务'))
      .finally(() => setRestoring(false))
  }, [])

  useEffect(() => {
    if (restoring) return
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      void saveTask(pages).catch(() => setNotice('本地空间不足，当前更改可能无法在刷新后恢复'))
    }, 700)
    return () => window.clearTimeout(saveTimer.current)
  }, [pages, restoring])

  useEffect(
    () => () => {
      controllers.current.forEach((controller) => controller.abort())
      pagesRef.current.forEach(revokePageUrls)
    },
    [],
  )

  const selected = pages.find((page) => page.id === selectedId) ?? pages[0]
  const finishedPages = pages.filter((page) => page.status === 'ready' || page.status === 'review')
  const processingCount = pages.filter((page) => page.status === 'processing').length

  const replacePage = useCallback((id: string, updater: (page: WorksheetPage) => WorksheetPage) => {
    setPages((current) => current.map((page) => (page.id === id ? updater(page) : page)))
  }, [])

  const runPage = useCallback(
    async (page: WorksheetPage, overrides?: Partial<Pick<WorksheetPage, 'corners' | 'rotation' | 'colorMode'>>) => {
      const controller = new AbortController()
      controllers.current.set(page.id, controller)
      replacePage(page.id, (current) => ({
        ...current,
        status: 'processing',
        progress: 2,
        error: undefined,
        ...overrides,
      }))
      try {
        const result = await processWorksheet(page.source, {
          corners: overrides?.corners ?? (page.processed ? page.corners : undefined),
          rotation: overrides?.rotation ?? page.rotation,
          colorMode: overrides?.colorMode ?? page.colorMode,
          signal: controller.signal,
          onProgress: (progress) => replacePage(page.id, (current) => ({ ...current, progress })),
        })
        replacePage(page.id, (current) => {
          if (current.enhancedUrl) URL.revokeObjectURL(current.enhancedUrl)
          if (current.processedUrl) URL.revokeObjectURL(current.processedUrl)
          return {
            ...current,
            ...overrides,
            enhanced: result.enhanced,
            enhancedUrl: URL.createObjectURL(result.enhanced),
            processed: result.processed,
            processedUrl: URL.createObjectURL(result.processed),
            width: result.width,
            height: result.height,
            corners: result.corners,
            reviewRegions: result.reviewRegions,
            strokes: [],
            undoneStrokes: [],
            progress: 100,
            status: result.reviewRegions.length > 0 ? 'review' : 'ready',
          }
        })
      } catch (error) {
        const cancelled = error instanceof DOMException && error.name === 'AbortError'
        replacePage(page.id, (current) => ({
          ...current,
          status: cancelled ? 'cancelled' : 'failed',
          progress: 0,
          error: cancelled ? '处理已取消' : error instanceof Error ? error.message : '未知处理错误',
        }))
      } finally {
        controllers.current.delete(page.id)
      }
    },
    [replacePage],
  )

  async function addFiles(files: File[]) {
    const { accepted, rejected } = splitValidFiles(files, MAX_FILES - pages.length)
    if (rejected.length > 0) {
      setNotice(rejected.map((item) => `${item.name}：${item.reason}`).join('；'))
    }
    const created: WorksheetPage[] = []
    for (const file of accepted) {
      try {
        const bitmap = await decodeBlob(file)
        const page: WorksheetPage = {
          id: createId(),
          name: file.name,
          source: file,
          sourceUrl: URL.createObjectURL(file),
          width: bitmap.width,
          height: bitmap.height,
          status: 'queued',
          progress: 0,
          rotation: 0,
          corners: [
            { x: 0, y: 0 },
            { x: 1, y: 0 },
            { x: 1, y: 1 },
            { x: 0, y: 1 },
          ],
          colorMode: 'color',
          reviewRegions: [],
          strokes: [],
          undoneStrokes: [],
        }
        bitmap.close()
        created.push(page)
      } catch (error) {
        setNotice(`${file.name}：${error instanceof Error ? error.message : '无法读取图片'}`)
      }
    }
    if (created.length === 0) return
    setPages((current) => [...current, ...created])
    setSelectedId((current) => current ?? created[0].id)
    for (const page of created) await runPage(page)
  }

  function deletePage(id: string) {
    controllers.current.get(id)?.abort()
    setPages((current) => {
      const removed = current.find((page) => page.id === id)
      if (removed) revokePageUrls(removed)
      const next = current.filter((page) => page.id !== id)
      if (selectedId === id) setSelectedId(next[0]?.id)
      return next
    })
  }

  function movePage(id: string, direction: -1 | 1) {
    setPages((current) => {
      const index = current.findIndex((page) => page.id === id)
      const target = index + direction
      if (index < 0 || target < 0 || target >= current.length) return current
      const next = [...current]
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }

  function reorderPage(sourceId: string, targetId: string) {
    if (sourceId === targetId) return
    setPages((current) => {
      const sourceIndex = current.findIndex((page) => page.id === sourceId)
      const targetIndex = current.findIndex((page) => page.id === targetId)
      if (sourceIndex < 0 || targetIndex < 0) return current
      const next = [...current]
      const [moved] = next.splice(sourceIndex, 1)
      next.splice(targetIndex, 0, moved)
      return next
    })
  }

  function selectRelative(direction: -1 | 1) {
    if (!selected) return
    const index = pages.findIndex((page) => page.id === selected.id)
    const target = pages[index + direction]
    if (target) setSelectedId(target.id)
  }

  function addStroke(stroke: Stroke) {
    if (!selected) return
    replacePage(selected.id, (page) => ({ ...page, strokes: [...page.strokes, stroke], undoneStrokes: [] }))
  }

  function undo() {
    if (!selected?.strokes.length) return
    replacePage(selected.id, (page) => {
      const strokes = [...page.strokes]
      const removed = strokes.pop()
      return { ...page, strokes, undoneStrokes: removed ? [...page.undoneStrokes, removed] : page.undoneStrokes }
    })
  }

  function redo() {
    if (!selected?.undoneStrokes.length) return
    replacePage(selected.id, (page) => {
      const undone = [...page.undoneStrokes]
      const restored = undone.pop()
      return { ...page, strokes: restored ? [...page.strokes, restored] : page.strokes, undoneStrokes: undone }
    })
  }

  async function resetTask() {
    if (!window.confirm('确定清空当前任务吗？所有页面和编辑记录都会从本机删除。')) return
    controllers.current.forEach((controller) => controller.abort())
    pages.forEach(revokePageUrls)
    setPages([])
    setSelectedId(undefined)
    await clearTask()
  }

  async function startExport() {
    if (finishedPages.length === 0) return
    const risky = pages.filter((page) => page.status !== 'ready')
    if (risky.length > 0 && !window.confirm(`有 ${risky.length} 页需要复核或处理失败，确定仅导出当前可用页面吗？`)) return
    setExporting(1)
    try {
      const { exportPdf } = await import('./lib/pdf')
      await exportPdf(finishedPages, exportSettings, setExporting)
      setShowExport(false)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'PDF 导出失败，请重试')
    } finally {
      setExporting(0)
    }
  }

  if (restoring) {
    return <div className="loading-screen"><LoaderCircle className="spin" />正在恢复本地任务…</div>
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand"><span className="brand-mark"><FileText /></span><div><strong>Exam Paper</strong><small>Image Processing Tool</small></div></div>
        <div className="header-steps" aria-label="工作流程"><span className="active">1 上传</span><i /><span className={pages.length ? 'active' : ''}>2 净化</span><i /><span className={finishedPages.length ? 'active' : ''}>3 导出</span></div>
        <div className="privacy-badge"><LockKeyhole size={15} />图片仅在本机处理</div>
      </header>

      {notice && <div className="notice" role="alert"><CircleAlert size={18} /><span>{notice}</span><button onClick={() => setNotice(undefined)} aria-label="关闭提示"><X size={16} /></button></div>}

      {pages.length === 0 ? (
        <Welcome onFiles={(files) => void addFiles(files)} />
      ) : (
        <main className="workspace">
          <PageRail
            pages={pages}
            selectedId={selected?.id}
            onSelect={setSelectedId}
            onAdd={(files) => void addFiles(files)}
            onMove={movePage}
            onReorder={reorderPage}
            onDelete={deletePage}
          />
          <section className="editor-area">
            <div className="editor-topbar">
              <div><strong>{selected?.name}</strong><span>{selected ? `${selected.width} × ${selected.height}` : ''}</span></div>
              <div className="toolbar-group">
                <button onClick={() => setCompare((value) => !value)} className={compare ? 'selected' : ''}><ArrowLeftRight />原图对比</button>
                <button onClick={undo} disabled={!selected?.strokes.length}><Undo2 />撤销</button>
                <button onClick={redo} disabled={!selected?.undoneStrokes.length}><Redo2 />重做</button>
              </div>
            </div>
            <div className="canvas-stage">
              {selected?.status === 'processing' ? (
                <ProcessingView page={selected} onCancel={() => controllers.current.get(selected.id)?.abort()} />
              ) : selected?.processedUrl && selected.enhancedUrl ? (
                <EditorCanvas page={selected} tool={tool} size={brushSize} compare={compare} onStroke={addStroke} />
              ) : (
                <FailureView page={selected} onRetry={() => selected && void runPage(selected)} />
              )}
            </div>
            <div className="page-nav"><button onClick={() => selectRelative(-1)} disabled={pages.findIndex((page) => page.id === selected?.id) <= 0}><ChevronLeft />上一页</button><span>{pages.findIndex((page) => page.id === selected?.id) + 1} / {pages.length}</span><button onClick={() => selectRelative(1)} disabled={pages.findIndex((page) => page.id === selected?.id) >= pages.length - 1}>下一页<ChevronRight /></button></div>
          </section>
          <aside className="tool-panel">
            <div className="panel-heading"><div><WandSparkles /><span><strong>页面工具</strong><small>所有修改都可以恢复</small></span></div></div>
            {selected?.status === 'review' && <div className="review-card"><CircleAlert /><div><strong>需要人工复核</strong><span>{selected.reviewRegions[0]?.reason ?? '智能擦除发现不确定区域'}</span></div></div>}
            <ToolSection title="校正">
              <div className="button-grid">
                <button onClick={() => selected && setCropPage(selected)}><Crop />调整边界</button>
                <button onClick={() => selected && void runPage(selected, { rotation: ((selected.rotation + 270) % 360) as WorksheetPage['rotation'] })}><RotateCcw />向左旋转</button>
                <button onClick={() => selected && void runPage(selected, { rotation: ((selected.rotation + 90) % 360) as WorksheetPage['rotation'] })}><RotateCw />向右旋转</button>
              </div>
            </ToolSection>
            <ToolSection title="画面增强">
              <div className="segmented"><button className={selected?.colorMode === 'color' ? 'active' : ''} onClick={() => selected && void runPage(selected, { colorMode: 'color' })}>保留彩色</button><button className={selected?.colorMode === 'mono' ? 'active' : ''} onClick={() => selected && void runPage(selected, { colorMode: 'mono' })}>黑白清晰</button></div>
              <p className="helper"><Sparkles />自动增白纸张、压低阴影并加深印刷文字</p>
            </ToolSection>
            <ToolSection title="手动补修">
              <div className="tool-choice"><button className={tool === 'eraser' ? 'active' : ''} onClick={() => setTool('eraser')}><Eraser />橡皮擦</button><button className={tool === 'restore' ? 'active' : ''} onClick={() => setTool('restore')}><RefreshCw />恢复笔</button></div>
              <label className="range-label"><span>笔刷大小</span><strong>{brushSize}px</strong><input type="range" min="8" max="96" value={brushSize} onChange={(event) => setBrushSize(Number(event.target.value))} /></label>
            </ToolSection>
            <div className="panel-footer"><button className="secondary danger" onClick={() => void resetTask()}><Trash2 />清空任务</button><button className="primary" disabled={!finishedPages.length || processingCount > 0} onClick={() => setShowExport(true)}><Download />导出 PDF</button></div>
          </aside>
        </main>
      )}

      {cropPage && <CropDialog page={cropPage} onClose={() => setCropPage(undefined)} onApply={(corners) => { setCropPage(undefined); void runPage(cropPage, { corners }) }} />}
      {showExport && <ExportDialog pages={finishedPages} settings={exportSettings} progress={exporting} onChange={setExportSettings} onClose={() => setShowExport(false)} onExport={() => void startExport()} />}
    </div>
  )
}

function Welcome({ onFiles }: { onFiles: (files: File[]) => void }) {
  const input = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  return <main className="welcome"><section className="hero-copy"><span className="eyebrow"><ShieldCheck />本地处理 · 无需登录</span><h1>把拍下来的试卷，<br /><em>还原成干净电子版</em></h1><p>批量校正角度、增强文字、擦除手写与浅色水印，最后生成可直接分享和打印的 A4 PDF。</p><div className="feature-list"><span><Check />最多 20 张批量处理</span><span><Check />黑、蓝、红手写识别</span><span><Check />可撤销人工补修</span></div></section><section className="upload-card"><div className={`drop-zone ${dragging ? 'dragging' : ''}`} onDragOver={(event) => { event.preventDefault(); setDragging(true) }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); onFiles(Array.from(event.dataTransfer.files)) }}><div className="upload-icon"><ImagePlus /></div><h2>上传试卷图片</h2><p>拖入图片，或从电脑中选择</p><button className="primary large" onClick={() => input.current?.click()}><FolderOpen />选择图片</button><input ref={input} hidden type="file" multiple accept="image/jpeg,image/png,image/webp" onChange={(event) => onFiles(Array.from(event.target.files ?? []))} /><small>JPG / PNG / WebP · 单张不超过 20MB</small></div><div className="local-note"><LockKeyhole /><span><strong>隐私优先</strong><small>图片不会上传服务器，关闭任务后可主动清除</small></span></div></section></main>
}

function PageRail({ pages, selectedId, onSelect, onAdd, onMove, onReorder, onDelete }: { pages: WorksheetPage[]; selectedId?: string; onSelect: (id: string) => void; onAdd: (files: File[]) => void; onMove: (id: string, direction: -1 | 1) => void; onReorder: (sourceId: string, targetId: string) => void; onDelete: (id: string) => void }) {
  const input = useRef<HTMLInputElement>(null)
  const [draggedId, setDraggedId] = useState<string>()
  return <aside className="page-rail"><div className="rail-title"><div><strong>页面</strong><span>{pages.length} / {MAX_FILES}</span></div><button onClick={() => input.current?.click()} aria-label="继续添加图片"><ImagePlus /></button><input ref={input} hidden type="file" multiple accept="image/jpeg,image/png,image/webp" onChange={(event) => onAdd(Array.from(event.target.files ?? []))} /></div><div className="page-list">{pages.map((page, index) => <div key={page.id} draggable className={`page-thumb ${page.id === selectedId ? 'active' : ''}`} onDragStart={() => setDraggedId(page.id)} onDragEnd={() => setDraggedId(undefined)} onDragOver={(event) => event.preventDefault()} onDrop={() => { if (draggedId) onReorder(draggedId, page.id); setDraggedId(undefined) }} onClick={() => onSelect(page.id)}><GripVertical className="grip" /><div className="thumb-image">{page.processedUrl || page.sourceUrl ? <img src={page.processedUrl ?? page.sourceUrl} alt="" /> : <FileImage />}<span>{index + 1}</span></div><div className="thumb-copy"><strong>{page.name}</strong><small className={`status ${page.status}`}>{page.status === 'processing' && <LoaderCircle className="spin" />}{statusLabel[page.status]}</small></div><div className="thumb-actions"><button onClick={(event) => { event.stopPropagation(); onMove(page.id, -1) }} disabled={index === 0} aria-label="上移"><ArrowUp /></button><button onClick={(event) => { event.stopPropagation(); onMove(page.id, 1) }} disabled={index === pages.length - 1} aria-label="下移"><ArrowDown /></button><button onClick={(event) => { event.stopPropagation(); onDelete(page.id) }} aria-label="删除"><Trash2 /></button></div></div>)}</div></aside>
}

function EditorCanvas({ page, tool, size, compare, onStroke }: { page: WorksheetPage; tool: EditTool; size: number; compare: boolean; onStroke: (stroke: Stroke) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [drawing, setDrawing] = useState<Point[]>([])
  const sourceUrl = compare ? page.enhancedUrl : page.processedUrl
  const render = useCallback(async () => {
    if (!canvasRef.current || !sourceUrl || !page.enhancedUrl || !page.processedUrl) return
    const canvas = compare ? await renderEditedPage(page.enhancedUrl, page.enhancedUrl, []) : await renderEditedPage(page.processedUrl, page.enhancedUrl, page.strokes)
    const target = canvasRef.current
    target.width = canvas.width
    target.height = canvas.height
    target.getContext('2d')?.drawImage(canvas, 0, 0)
  }, [compare, page.enhancedUrl, page.processedUrl, page.strokes, sourceUrl])
  useEffect(() => { void render() }, [render])
  function pointFromEvent(event: React.PointerEvent<HTMLCanvasElement>) { const rect = event.currentTarget.getBoundingClientRect(); return { x: (event.clientX - rect.left) * event.currentTarget.width / rect.width, y: (event.clientY - rect.top) * event.currentTarget.height / rect.height } }
  return <div className="canvas-wrap"><canvas ref={canvasRef} aria-label="试卷编辑画布" onPointerDown={(event) => { if (compare) return; event.currentTarget.setPointerCapture(event.pointerId); setDrawing([pointFromEvent(event)]) }} onPointerMove={(event) => { if (drawing.length) setDrawing((points) => [...points, pointFromEvent(event)]) }} onPointerUp={() => { if (drawing.length) onStroke({ id: createId(), tool, size, points: drawing }); setDrawing([]) }} />{page.reviewRegions.map((region, index) => <div key={index} className="review-region" style={{ left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.width * 100}%`, height: `${region.height * 100}%` }} />)}{compare && <span className="compare-label">增强前 / 擦除前</span>}</div>
}

function ProcessingView({ page, onCancel }: { page: WorksheetPage; onCancel: () => void }) { return <div className="processing-view"><div className="processing-orbit"><WandSparkles /><LoaderCircle className="spin" /></div><h2>正在净化本页</h2><p>校正角度、增强文字并识别手写内容</p><div className="progress"><i style={{ width: `${page.progress}%` }} /></div><span>{page.progress}%</span><button className="secondary" onClick={onCancel}>取消本页</button></div> }

function FailureView({ page, onRetry }: { page?: WorksheetPage; onRetry: () => void }) { return <div className="failure-view"><CircleAlert /><h2>{page?.status === 'cancelled' ? '本页处理已取消' : '暂时无法处理本页'}</h2><p>{page?.error ?? '请重试或删除此页'}</p><button className="primary" onClick={onRetry}><RefreshCw />重新处理</button></div> }

function ToolSection({ title, children }: { title: string; children: React.ReactNode }) { return <section className="tool-section"><h3>{title}</h3>{children}</section> }

function CropDialog({ page, onClose, onApply }: { page: WorksheetPage; onClose: () => void; onApply: (corners: Point[]) => void }) {
  const [corners, setCorners] = useState(page.corners)
  const [dragging, setDragging] = useState<number>()
  const stage = useRef<HTMLDivElement>(null)
  const dialog = useDialogFocus(onClose)
  function move(event: React.PointerEvent) { if (dragging === undefined || !stage.current) return; const rect = stage.current.getBoundingClientRect(); const point = { x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)), y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)) }; setCorners((current) => current.map((corner, index) => index === dragging ? point : corner)) }
  return <div className="modal-backdrop"><div ref={dialog} tabIndex={-1} className="modal crop-modal" role="dialog" aria-modal="true" aria-labelledby="crop-title"><div className="modal-header"><div><h2 id="crop-title">调整试卷边界</h2><p>拖动四个圆点，使边框贴合纸张四角</p></div><button onClick={onClose} aria-label="关闭"><X /></button></div><div ref={stage} className="crop-stage" style={{ aspectRatio: `${page.width} / ${page.height}` }} onPointerMove={move} onPointerUp={() => setDragging(undefined)}><img src={page.sourceUrl} alt="原始试卷" /><svg viewBox="0 0 100 100" preserveAspectRatio="none"><polygon points={corners.map((point) => `${point.x * 100},${point.y * 100}`).join(' ')} /></svg>{corners.map((point, index) => <button key={index} className="crop-handle" style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }} onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); setDragging(index) }} aria-label={`第 ${index + 1} 个角点`} />)}</div><div className="modal-actions"><button className="secondary" onClick={onClose}>取消</button><button className="primary" onClick={() => onApply(corners)}><Crop />应用校正</button></div></div></div>
}

function ExportDialog({ pages, settings, progress, onChange, onClose, onExport }: { pages: WorksheetPage[]; settings: ExportSettings; progress: number; onChange: (settings: ExportSettings) => void; onClose: () => void; onExport: () => void }) {
  const preview = pages[0]?.processedUrl
  const dialog = useDialogFocus(progress > 0 ? () => undefined : onClose)
  return <div className="modal-backdrop"><div ref={dialog} tabIndex={-1} className="modal export-modal" role="dialog" aria-modal="true" aria-labelledby="export-title"><div className="modal-header"><div><h2 id="export-title">导出 A4 PDF</h2><p>{pages.length} 页将合并为一个文件</p></div><button onClick={onClose} disabled={progress > 0} aria-label="关闭"><X /></button></div><div className="export-content"><div className="paper-preview">{preview && <img src={preview} alt="PDF 首页面预览" />}<span>A4 · 第 1 页</span></div><div className="export-options"><label>文件名<input value={settings.filename} maxLength={80} onChange={(event) => onChange({ ...settings, filename: event.target.value })} /></label><fieldset><legend>输出模式</legend><div className="segmented"><button className={settings.colorMode === 'color' ? 'active' : ''} onClick={() => onChange({ ...settings, colorMode: 'color' })}>彩色</button><button className={settings.colorMode === 'mono' ? 'active' : ''} onClick={() => onChange({ ...settings, colorMode: 'mono' })}>黑白</button></div></fieldset><fieldset><legend>清晰度</legend><div className="quality-options">{([['clear','清晰','适合打印'],['standard','标准','推荐'],['small','小文件','适合分享']] as const).map(([value,label,help]) => <button key={value} className={settings.quality === value ? 'active' : ''} onClick={() => onChange({ ...settings, quality: value })}><strong>{label}</strong><small>{help}</small></button>)}</div></fieldset><label>页边距<select value={settings.margin} onChange={(event) => onChange({ ...settings, margin: Number(event.target.value) as ExportSettings['margin'] })}><option value={6}>窄（6 mm）</option><option value={12}>标准（12 mm）</option><option value={18}>宽（18 mm）</option></select></label><div className="export-safe"><ShieldCheck /><span>PDF 在浏览器本地生成，不会上传图片</span></div></div></div>{progress > 0 && <div className="export-progress"><div className="progress"><i style={{ width: `${progress}%` }} /></div><span>正在生成 {progress}%</span></div>}<div className="modal-actions"><button className="secondary" onClick={onClose} disabled={progress > 0}>取消</button><button className="primary" onClick={onExport} disabled={progress > 0}><Download />{progress > 0 ? '正在生成…' : '下载 PDF'}</button></div></div></div>
}

function useDialogFocus(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    ref.current?.focus()
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current()
    }
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('keydown', handleKey)
      previous?.focus()
    }
  }, [])
  return ref
}

export default App
