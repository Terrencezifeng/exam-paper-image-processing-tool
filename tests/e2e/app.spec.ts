import { expect, test } from '@playwright/test'

test('shows the local worksheet upload flow', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveTitle('Exam Paper Image Processing Tool')
  await expect(page.getByText('Exam Paper')).toBeVisible()
  await expect(page.getByRole('heading', { name: '上传试卷图片' })).toBeVisible()
  await expect(page.getByText('图片仅在本机处理')).toBeVisible()
  await expect(page.getByText('最多 20 张批量处理')).toBeVisible()
})

test('processes a local image and opens PDF export settings', async ({ page }) => {
  await page.goto('/')
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  )
  await page.locator('input[type="file"]').first().setInputFiles({
    name: 'worksheet.png',
    mimeType: 'image/png',
    buffer: png,
  })
  await expect(page.getByText('worksheet.png').first()).toBeVisible()
  await expect(page.getByRole('button', { name: '导出 PDF' })).toBeEnabled({ timeout: 15_000 })
  await page.getByRole('button', { name: '导出 PDF' }).click()
  await expect(page.getByRole('dialog', { name: '导出 A4 PDF' })).toBeVisible()
  await expect(page.getByText('1 页将合并为一个文件')).toBeVisible()
})
