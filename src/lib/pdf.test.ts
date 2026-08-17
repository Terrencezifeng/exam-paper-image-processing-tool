import { describe, expect, it } from 'vitest'
import { sanitizePdfFilename } from './pdf'

describe('PDF filename safety', () => {
  it('removes path and platform control characters', () => {
    expect(sanitizePdfFilename(' ../班级/试卷:*? ')).toBe('.._班级_试卷___.pdf')
  })

  it('uses a safe default and avoids duplicate extensions', () => {
    expect(sanitizePdfFilename('   ')).toBe('整理后的试卷.pdf')
    expect(sanitizePdfFilename('练习.PDF')).toBe('练习.pdf')
  })
})
