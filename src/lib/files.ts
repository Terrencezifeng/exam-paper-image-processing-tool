export const MAX_FILES = 20
export const MAX_FILE_BYTES = 20 * 1024 * 1024
export const MAX_PIXELS = 40_000_000

const SUPPORTED_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/heic-sequence',
  'image/heif-sequence',
])
const SUPPORTED_EXTENSION = /\.(jpe?g|png|webp|heic|heif)$/i

export const IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp,image/heic,image/heif,.jpg,.jpeg,.png,.webp,.heic,.heif'

export type FileValidation =
  | { ok: true; file: File }
  | { ok: false; file: File; reason: string }

export function validateFile(file: File): FileValidation {
  if (!SUPPORTED_TYPES.has(file.type.toLowerCase()) && !SUPPORTED_EXTENSION.test(file.name)) {
    return { ok: false, file, reason: '仅支持 JPG、PNG、WebP、HEIC 或 HEIF 图片' }
  }
  if (file.size === 0) {
    return { ok: false, file, reason: '文件为空' }
  }
  if (file.size > MAX_FILE_BYTES) {
    return { ok: false, file, reason: '单张图片不能超过 20 MB' }
  }
  return { ok: true, file }
}

export function splitValidFiles(files: File[], remaining: number) {
  const accepted: File[] = []
  const rejected: Array<{ name: string; reason: string }> = []

  files.forEach((file) => {
    const result = validateFile(file)
    if (!result.ok) {
      rejected.push({ name: file.name, reason: result.reason })
    } else if (accepted.length >= remaining) {
      rejected.push({ name: file.name, reason: `单个任务最多 ${MAX_FILES} 张` })
    } else {
      accepted.push(file)
    }
  })

  return { accepted, rejected }
}
