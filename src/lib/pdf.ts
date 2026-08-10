import { jsPDF } from 'jspdf'
import type { ExportSettings, WorksheetPage } from '../types'
import { renderEditedPage } from './image-processing'

const QUALITY = {
  clear: { jpeg: 0.94, scale: 1 },
  standard: { jpeg: 0.82, scale: 0.82 },
  small: { jpeg: 0.65, scale: 0.58 },
} as const

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = sanitizePdfFilename(filename)
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function sanitizePdfFilename(filename: string) {
  const withoutControls = Array.from(filename, (character) =>
    character.charCodeAt(0) < 32 ? '_' : character,
  ).join('')
  const cleaned = withoutControls
    .trim()
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 80)
  const base = cleaned.replace(/\.pdf$/i, '') || '净化试卷'
  return `${base}.pdf`
}

export async function exportPdf(
  pages: WorksheetPage[],
  settings: ExportSettings,
  onProgress?: (progress: number) => void,
) {
  const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true })
  const pageWidth = 210
  const pageHeight = 297
  const availableWidth = pageWidth - settings.margin * 2
  const availableHeight = pageHeight - settings.margin * 2
  const quality = QUALITY[settings.quality]

  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index]
    if (!page.processedUrl || !page.enhancedUrl) continue
    if (index > 0) pdf.addPage('a4', 'portrait')
    const source = await renderEditedPage(page.processedUrl, page.enhancedUrl, page.strokes)
    const output = document.createElement('canvas')
    output.width = Math.max(1, Math.round(source.width * quality.scale))
    output.height = Math.max(1, Math.round(source.height * quality.scale))
    const context = output.getContext('2d')
    if (!context) throw new Error('无法准备 PDF 页面')
    if (settings.colorMode === 'mono') context.filter = 'grayscale(1)'
    context.drawImage(source, 0, 0, output.width, output.height)
    const ratio = Math.min(availableWidth / output.width, availableHeight / output.height)
    const width = output.width * ratio
    const height = output.height * ratio
    const x = (pageWidth - width) / 2
    const y = (pageHeight - height) / 2
    pdf.addImage(output.toDataURL('image/jpeg', quality.jpeg), 'JPEG', x, y, width, height, undefined, 'FAST')
    onProgress?.(Math.round(((index + 1) / pages.length) * 100))
  }
  download(pdf.output('blob'), settings.filename.trim() || '净化试卷')
}
