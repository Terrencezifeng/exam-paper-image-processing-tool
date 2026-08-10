import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import App from './App'
import { clearTask } from './lib/storage'

describe('application shell', () => {
  afterEach(async () => {
    await clearTask()
  })

  it('shows the private local upload entry point', async () => {
    render(<App />)
    await waitFor(() => expect(screen.getByRole('heading', { name: '上传试卷图片' })).toBeTruthy())
    expect(screen.getByText('Exam Paper')).toBeTruthy()
    expect(screen.getByText('Image Processing Tool')).toBeTruthy()
    expect(screen.getAllByText(/图片仅在本机处理|图片不会上传服务器/).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: /选择图片/ })).toBeTruthy()
  })
})
