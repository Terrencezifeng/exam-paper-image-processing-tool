import { describe, expect, it } from 'vitest'
import { MAX_FILES, splitValidFiles, validateFile } from './files'

describe('file validation', () => {
  it('accepts supported non-empty images', () => {
    const file = new File(['image'], 'paper.jpg', { type: 'image/jpeg' })
    expect(validateFile(file).ok).toBe(true)
  })

  it('accepts HEIC by MIME type or extension', () => {
    expect(validateFile(new File(['image'], 'paper.heic', { type: 'image/heic' })).ok).toBe(true)
    expect(validateFile(new File(['image'], 'paper.HEIF', { type: '' })).ok).toBe(true)
  })

  it('rejects unsupported and empty files with a reason', () => {
    const unsupported = new File(['image'], 'paper.pdf', { type: 'application/pdf' })
    const empty = new File([], 'empty.png', { type: 'image/png' })
    expect(validateFile(unsupported)).toMatchObject({ ok: false })
    expect(validateFile(empty)).toMatchObject({ ok: false, reason: '文件为空' })
  })

  it('keeps valid files when the selection exceeds the remaining limit', () => {
    const files = Array.from({ length: MAX_FILES + 2 }, (_, index) =>
      new File(['x'], `${index}.png`, { type: 'image/png' }),
    )
    const result = splitValidFiles(files, MAX_FILES)
    expect(result.accepted).toHaveLength(MAX_FILES)
    expect(result.rejected).toHaveLength(2)
  })
})
