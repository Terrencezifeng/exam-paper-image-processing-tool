export type Point = { x: number; y: number }

export type PageStatus =
  | 'queued'
  | 'processing'
  | 'review'
  | 'ready'
  | 'failed'
  | 'cancelled'

export type ColorMode = 'color' | 'mono'
export type EditTool = 'eraser' | 'restore'

export type Stroke = {
  id: string
  tool: EditTool
  size: number
  points: Point[]
}

export type ReviewRegion = {
  x: number
  y: number
  width: number
  height: number
  reason: string
}

export type WorksheetPage = {
  id: string
  name: string
  source: Blob
  sourceUrl: string
  width: number
  height: number
  status: PageStatus
  progress: number
  rotation: 0 | 90 | 180 | 270
  corners: Point[]
  colorMode: ColorMode
  enhanced?: Blob
  enhancedUrl?: string
  processed?: Blob
  processedUrl?: string
  reviewRegions: ReviewRegion[]
  strokes: Stroke[]
  undoneStrokes: Stroke[]
  error?: string
}

export type ExportSettings = {
  colorMode: ColorMode
  quality: 'clear' | 'standard' | 'small'
  margin: 6 | 12 | 18
  filename: string
}

export type PersistedPage = Omit<
  WorksheetPage,
  'sourceUrl' | 'enhancedUrl' | 'processedUrl'
>

export type PersistedTask = {
  id: string
  updatedAt: number
  pages: PersistedPage[]
}
