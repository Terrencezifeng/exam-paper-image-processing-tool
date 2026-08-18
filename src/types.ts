export type Point = { x: number; y: number }

export type PageStatus =
  | 'queued'
  | 'processing'
  | 'ready'
  | 'failed'
  | 'cancelled'

export type EditTool = 'eraser' | 'restore'
export type EditorTool = 'pan' | EditTool
export type Rotation = 0 | 90 | 180 | 270
export type EnhancementPreset = 'soft' | 'clear' | 'highContrast'
export type ReviewReason = 'orientation' | 'boundary'
export type InferenceBackend = 'webgpu' | 'wasm' | 'unavailable'
export type ProcessingStage =
  | 'queued'
  | 'decoding'
  | 'orientation'
  | 'boundary'
  | 'enhancement'
  | 'compositing'

export type Stroke = {
  id: string
  tool: EditTool
  size: number
  points: Point[]
}

export type ProcessingDiagnostics = {
  autoRotation: Rotation
  effectiveRotation: Rotation
  orientationConfidence: number
  orientationMargin: number
  orientationAccepted: boolean
  boundaryConfidence: number
  boundaryAccepted: boolean
  orientationBackend: InferenceBackend
  orientationModelVersion?: string
  warning?: string
}

export type WorksheetPage = {
  id: string
  name: string
  source: Blob
  sourceUrl: string
  sourcePreview?: Blob
  sourcePreviewUrl?: string
  sourceWidth: number
  sourceHeight: number
  width: number
  height: number
  status: PageStatus
  progress: number
  rotation: Rotation
  autoRotation: Rotation
  enhancementPreset: EnhancementPreset
  reviewReasons: ReviewReason[]
  reviewConfirmed: boolean
  corners: Point[]
  processingStage: ProcessingStage
  enhanced?: Blob
  enhancedUrl?: string
  processed?: Blob
  processedUrl?: string
  diagnostics: ProcessingDiagnostics
  strokes: Stroke[]
  undoneStrokes: Stroke[]
  error?: string
}

export type ExportSettings = {
  quality: 'clear' | 'standard' | 'small'
  margin: 6 | 12 | 18
  filename: string
}

export type PersistedBinary = Blob | { bytes: ArrayBuffer; type: string }

export type PersistedPage = Omit<
  WorksheetPage,
  | 'source'
  | 'sourcePreview'
  | 'enhanced'
  | 'processed'
  | 'sourceUrl'
  | 'sourcePreviewUrl'
  | 'enhancedUrl'
  | 'processedUrl'
> & {
  source: PersistedBinary
  sourcePreview?: PersistedBinary
  enhanced?: PersistedBinary
  processed?: PersistedBinary
}

export type PersistedTask = {
  id: string
  version: 4
  updatedAt: number
  defaultEnhancementPreset: EnhancementPreset
  pages: PersistedPage[]
}
