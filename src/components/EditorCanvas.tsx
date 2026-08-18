import { Check, Maximize2, ZoomIn, ZoomOut } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { drawStroke, loadImage, renderEditedPage } from '../lib/image-processing'
import type { EditorTool, Point, Stroke, WorksheetPage } from '../types'

type ViewTransform = { scale: number; x: number; y: number }
type PointerPosition = { x: number; y: number }

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value))
}

function distance(a: PointerPosition, b: PointerPosition) {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function center(a: PointerPosition, b: PointerPosition) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

export function EditorCanvas({
  page,
  tool,
  size,
  compare,
  onStroke,
  onConfirmReview,
}: {
  page: WorksheetPage
  tool: EditorTool
  size: number
  compare: boolean
  onStroke: (stroke: Stroke) => void
  onConfirmReview: () => void
}) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const enhancedRef = useRef<HTMLImageElement | undefined>(undefined)
  const drawingRef = useRef<{ pointerId: number; points: Point[] } | undefined>(undefined)
  const pointers = useRef(new Map<number, PointerPosition>())
  const panStart = useRef<{ pointerId: number; point: PointerPosition; view: ViewTransform } | undefined>(undefined)
  const pinchStart = useRef<{ distance: number; center: PointerPosition; view: ViewTransform } | undefined>(undefined)
  const fitScaleRef = useRef(1)
  const fittedPageRef = useRef<string | undefined>(undefined)
  const viewRef = useRef<ViewTransform>({ scale: 1, x: 0, y: 0 })
  const [view, setViewState] = useState(viewRef.current)

  const setView = useCallback((next: ViewTransform) => {
    viewRef.current = next
    setViewState(next)
  }, [])

  const fitCanvas = useCallback((force = false) => {
    const viewport = viewportRef.current
    const canvas = canvasRef.current
    if (!viewport || !canvas || canvas.width === 0 || canvas.height === 0) return
    const padding = viewport.clientWidth < 700 ? 16 : 48
    const availableWidth = Math.max(1, viewport.clientWidth - padding)
    const availableHeight = Math.max(1, viewport.clientHeight - padding)
    const scale = Math.min(1, availableWidth / canvas.width, availableHeight / canvas.height)
    fitScaleRef.current = scale
    const key = `${page.id}:${canvas.width}x${canvas.height}`
    if (!force && fittedPageRef.current === key) return
    fittedPageRef.current = key
    setView({
      scale,
      x: (viewport.clientWidth - canvas.width * scale) / 2,
      y: (viewport.clientHeight - canvas.height * scale) / 2,
    })
  }, [page.id, setView])

  useEffect(() => {
    let active = true
    async function render() {
      if (!page.processedUrl || !page.enhancedUrl) return
      const [rendered, enhanced] = await Promise.all([
        compare
          ? renderEditedPage(page.enhancedUrl, page.enhancedUrl, [])
          : renderEditedPage(page.processedUrl, page.enhancedUrl, page.strokes),
        loadImage(page.enhancedUrl),
      ])
      if (!active || !canvasRef.current || !overlayRef.current) return
      enhancedRef.current = enhanced
      for (const target of [canvasRef.current, overlayRef.current]) {
        target.width = rendered.width
        target.height = rendered.height
      }
      const context = canvasRef.current.getContext('2d')
      context?.clearRect(0, 0, rendered.width, rendered.height)
      context?.drawImage(rendered, 0, 0)
      overlayRef.current.getContext('2d')?.clearRect(0, 0, rendered.width, rendered.height)
      requestAnimationFrame(() => fitCanvas())
    }
    void render()
    return () => { active = false }
  }, [compare, fitCanvas, page.enhancedUrl, page.processedUrl, page.strokes])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const observer = new ResizeObserver(() => fitCanvas(true))
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [fitCanvas])

  const zoomAt = useCallback((requestedScale: number, anchor: PointerPosition) => {
    const current = viewRef.current
    const minimum = Math.max(0.04, fitScaleRef.current * 0.5)
    const nextScale = clamp(requestedScale, minimum, 3)
    const ratio = nextScale / current.scale
    setView({
      scale: nextScale,
      x: anchor.x - (anchor.x - current.x) * ratio,
      y: anchor.y - (anchor.y - current.y) * ratio,
    })
  }, [setView])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = viewport.getBoundingClientRect()
      zoomAt(viewRef.current.scale * Math.exp(-event.deltaY * 0.0012), {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      })
    }
    viewport.addEventListener('wheel', handleWheel, { passive: false })
    return () => viewport.removeEventListener('wheel', handleWheel)
  }, [zoomAt])

  function localPointer(event: React.PointerEvent) {
    const rect = viewportRef.current?.getBoundingClientRect()
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) }
  }

  function imagePoint(position: PointerPosition): Point {
    const current = viewRef.current
    const canvas = canvasRef.current
    return {
      x: clamp((position.x - current.x) / current.scale, 0, canvas?.width ?? 0),
      y: clamp((position.y - current.y) / current.scale, 0, canvas?.height ?? 0),
    }
  }

  function paintDrawing(points: Point[]) {
    const overlay = overlayRef.current
    if (!overlay) return
    const context = overlay.getContext('2d')
    if (!context) return
    context.clearRect(0, 0, overlay.width, overlay.height)
    if (tool === 'pan') return
    drawStroke(context, { id: 'preview', tool, size, points }, enhancedRef.current)
  }

  function beginPinch() {
    const values = Array.from(pointers.current.values())
    if (values.length < 2) return
    const [first, second] = values
    drawingRef.current = undefined
    overlayRef.current?.getContext('2d')?.clearRect(0, 0, overlayRef.current.width, overlayRef.current.height)
    pinchStart.current = {
      distance: Math.max(1, distance(first, second)),
      center: center(first, second),
      view: viewRef.current,
    }
    panStart.current = undefined
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 && event.pointerType === 'mouse') return
    event.currentTarget.setPointerCapture(event.pointerId)
    const point = localPointer(event)
    pointers.current.set(event.pointerId, point)
    if (pointers.current.size >= 2) {
      beginPinch()
      return
    }
    if (tool === 'pan' || compare) {
      panStart.current = { pointerId: event.pointerId, point, view: viewRef.current }
      return
    }
    const first = imagePoint(point)
    drawingRef.current = { pointerId: event.pointerId, points: [first] }
    paintDrawing([first])
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!pointers.current.has(event.pointerId)) return
    const point = localPointer(event)
    pointers.current.set(event.pointerId, point)
    if (pointers.current.size >= 2 && pinchStart.current) {
      const [first, second] = Array.from(pointers.current.values())
      const gesture = pinchStart.current
      const nextCenter = center(first, second)
      const minimum = Math.max(0.04, fitScaleRef.current * 0.5)
      const scale = clamp(gesture.view.scale * distance(first, second) / gesture.distance, minimum, 3)
      const ratio = scale / gesture.view.scale
      setView({
        scale,
        x: nextCenter.x - (gesture.center.x - gesture.view.x) * ratio,
        y: nextCenter.y - (gesture.center.y - gesture.view.y) * ratio,
      })
      return
    }
    if (panStart.current?.pointerId === event.pointerId) {
      const start = panStart.current
      setView({
        ...viewRef.current,
        x: start.view.x + point.x - start.point.x,
        y: start.view.y + point.y - start.point.y,
      })
      return
    }
    const drawing = drawingRef.current
    if (drawing?.pointerId !== event.pointerId) return
    const next = imagePoint(point)
    const previous = drawing.points[drawing.points.length - 1]
    if (previous && Math.hypot(next.x - previous.x, next.y - previous.y) < 0.75) return
    drawing.points.push(next)
    paintDrawing(drawing.points)
  }

  function finishPointer(event: React.PointerEvent<HTMLDivElement>, cancelled: boolean) {
    const drawing = drawingRef.current
    if (!cancelled && drawing?.pointerId === event.pointerId && drawing.points.length > 0 && tool !== 'pan') {
      onStroke({ id: crypto.randomUUID(), tool, size, points: drawing.points })
    }
    if (drawing?.pointerId === event.pointerId) drawingRef.current = undefined
    pointers.current.delete(event.pointerId)
    overlayRef.current?.getContext('2d')?.clearRect(0, 0, overlayRef.current.width, overlayRef.current.height)
    if (pointers.current.size < 2) pinchStart.current = undefined
    const remaining = Array.from(pointers.current.entries())[0]
    panStart.current = remaining
      ? { pointerId: remaining[0], point: remaining[1], view: viewRef.current }
      : undefined
  }

  function zoomFromCenter(multiplier: number) {
    const viewport = viewportRef.current
    if (!viewport) return
    zoomAt(viewRef.current.scale * multiplier, { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 })
  }

  function actualSize() {
    const viewport = viewportRef.current
    if (!viewport) return
    const scale = 1
    setView({
      scale,
      x: (viewport.clientWidth - (canvasRef.current?.width ?? 0)) / 2,
      y: (viewport.clientHeight - (canvasRef.current?.height ?? 0)) / 2,
    })
  }

  return (
    <div
      ref={viewportRef}
      className={`canvas-viewport tool-${compare ? 'pan' : tool}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={(event) => finishPointer(event, false)}
      onPointerCancel={(event) => finishPointer(event, true)}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div
        className="canvas-surface"
        style={{ transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})` }}
      >
        <canvas ref={canvasRef} aria-label="试卷编辑画布" />
        <canvas ref={overlayRef} className="drawing-overlay" aria-hidden="true" />
      </div>
      {page.reviewReasons.length > 0 && !page.reviewConfirmed && <div className="canvas-warning"><span>{page.diagnostics.warning ?? '请核对当前页面的方向和纸张边界'}</span><button className="canvas-confirm" onPointerDown={(event) => event.stopPropagation()} onClick={onConfirmReview}><Check />已确认本页</button></div>}
      {compare && <span className="compare-label">手动修改前</span>}
      <div className="zoom-controls" aria-label="缩放控制">
        <button onClick={() => zoomFromCenter(0.8)} title="缩小" aria-label="缩小"><ZoomOut /></button>
        <button className="zoom-value" onClick={actualSize} title="显示 100%" aria-label="显示 100%">{Math.round(view.scale * 100)}%</button>
        <button onClick={() => zoomFromCenter(1.25)} title="放大" aria-label="放大"><ZoomIn /></button>
        <button onClick={() => fitCanvas(true)} title="适合窗口" aria-label="适合窗口"><Maximize2 /></button>
      </div>
    </div>
  )
}
