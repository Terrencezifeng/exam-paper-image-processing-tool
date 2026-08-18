import { expect, test } from '@playwright/test'
import { basename } from 'node:path'

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

test('shows the local worksheet upload flow', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveTitle('Exam Paper Image Processing Tool')
  await expect(page.getByText('Exam Paper')).toBeVisible()
  await expect(page.getByRole('heading', { name: '上传试卷图片' })).toBeVisible()
  await expect(page.getByText(/图片不会上传服务器/)).toBeVisible()
  await expect(page.getByText('最多 20 张批量处理')).toBeVisible()
})

test('processes a local image and opens PDF export settings', async ({ page }) => {
  await page.goto('/')
  const visualSample = process.env.VISUAL_SAMPLE
  const expectedName = visualSample ? basename(visualSample) : 'worksheet.png'
  await page.locator('input[type="file"]').first().setInputFiles(visualSample ?? {
    name: expectedName,
    mimeType: 'image/png',
    buffer: png,
  })
  await expect(page.getByText(expectedName).first()).toBeVisible()
  await expect(page.getByRole('button', { name: '导出 PDF' })).toBeEnabled({ timeout: 15_000 })
  if (process.env.CAPTURE_UI === '1') {
    await page.screenshot({ path: `test-results/workbench-${test.info().project.name}.png`, fullPage: true })
  }
  await page.getByRole('button', { name: '导出 PDF' }).click()
  await expect(page.getByRole('dialog', { name: '导出 A4 PDF' })).toBeVisible()
  await expect(page.getByText('1 页将按当前顺序合并')).toBeVisible()
})

test('keeps a 20-page batch ordered and exports 20 PDF pages', async ({ page, isMobile }) => {
  test.skip(Boolean(isMobile), '20-page export stress runs once on desktop')
  test.setTimeout(90_000)
  await page.goto('/')
  const files = Array.from({ length: 20 }, (_, index) => ({
    name: `page-${String(index + 1).padStart(2, '0')}.png`,
    mimeType: 'image/png',
    buffer: png,
  }))
  await page.locator('input[type="file"]').first().setInputFiles(files)
  await expect(page.getByText('20 / 20')).toBeVisible()
  await expect(page.getByRole('button', { name: '导出 PDF' })).toBeEnabled({ timeout: 60_000 })
  const names = await page.locator('.page-thumb .thumb-copy strong').allTextContents()
  expect(names).toEqual(files.map((file) => file.name))

  const lastPage = page.locator('.page-thumb').last()
  await lastPage.getByRole('button', { name: '上移' }).click()
  await expect(page.locator('.page-thumb .thumb-copy strong').nth(18)).toHaveText('page-20.png')

  await page.locator('.panel-footer').getByRole('button', { name: '导出 PDF' }).click()
  await expect(page.getByRole('dialog', { name: '导出 A4 PDF' })).toBeVisible()
  await expect(page.getByText('20 页将按当前顺序合并')).toBeVisible()
  page.once('dialog', (dialog) => dialog.accept())
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: /下载 PDF/ }).click()
  const download = await downloadPromise
  const stream = await download.createReadStream()
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  const pdfText = Buffer.concat(chunks).toString('latin1')
  expect((pdfText.match(/\/Type \/Page\b/g) ?? []).length).toBe(20)
})

test('restores a processed task after reload', async ({ page }) => {
  await page.goto('/')
  await page.locator('input[type="file"]').first().setInputFiles({
    name: 'restore-me.png',
    mimeType: 'image/png',
    buffer: png,
  })
  await expect(page.getByRole('button', { name: '导出 PDF' })).toBeEnabled({ timeout: 15_000 })
  await page.waitForTimeout(900)
  await expect(page.getByRole('alert')).toHaveCount(0)
  await page.reload()
  await expect(page.getByText('restore-me.png').first()).toBeVisible()
  await expect(page.getByRole('button', { name: '导出 PDF' })).toBeEnabled()
})

test('supports manual erase, enhancement persistence and responsive controls', async ({ page, isMobile }) => {
  test.setTimeout(60_000)
  await page.goto('/')
  await page.locator('input[type="file"]:not([capture])').first().setInputFiles({
    name: 'edit-me.png',
    mimeType: 'image/png',
    buffer: png,
  })
  await expect(page.getByRole('button', { name: '导出 PDF' })).toBeEnabled({ timeout: 15_000 })
  await page.getByRole('button', { name: '擦除' }).click()
  const viewport = page.locator('.canvas-viewport')
  const box = await viewport.boundingBox()
  expect(box).toBeTruthy()
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 8, box.y + box.height / 2 + 8)
    await page.mouse.up()
  }
  await expect(page.getByRole('button', { name: '撤销' }).first()).toBeEnabled()
  if (isMobile) {
    await page.getByRole('combobox', { name: '文字增强强度' }).selectOption('highContrast')
    await expect(page.getByRole('combobox', { name: '文字增强强度' })).toHaveValue('highContrast')
  } else {
    await page.locator('.tool-panel').getByRole('button', { name: '高对比' }).click()
    await expect(page.locator('.tool-panel').getByRole('button', { name: '高对比' })).toHaveAttribute('aria-pressed', 'true')
  }
  await expect(page.getByRole('button', { name: '导出 PDF' }).last()).toBeEnabled({ timeout: 15_000 })
  await expect(page.getByRole('button', { name: '撤销' }).first()).toBeEnabled()
  await page.waitForTimeout(900)
  await page.reload()
  if (isMobile) {
    await expect(page.getByRole('combobox', { name: '文字增强强度' })).toHaveValue('highContrast')
  } else {
    await expect(page.locator('.tool-panel').getByRole('button', { name: '高对比' })).toHaveAttribute('aria-pressed', 'true')
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await expect(page.getByRole('button', { name: '适合窗口' })).toBeVisible()
})

test('marks uncertain pages and warns again before PDF export', async ({ page, isMobile }) => {
  await page.goto('/')
  await page.locator('input[type="file"]').first().setInputFiles({
    name: 'needs-review.png',
    mimeType: 'image/png',
    buffer: png,
  })
  await expect(page.getByRole('button', { name: '导出 PDF' })).toBeEnabled({ timeout: 15_000 })
  await expect(page.locator('.page-thumb .review-marker')).toBeVisible()
  await expect(page.locator('.page-thumb .status')).toHaveText('待确认')

  await page.getByRole('button', { name: '导出 PDF' }).click()
  await expect(page.getByRole('alert')).toContainText('1 页尚未确认')
  await expect(page.getByRole('button', { name: '仍然下载 PDF' })).toBeVisible()
  await page.getByRole('button', { name: '返回检查第 1 页' }).click()
  if (isMobile) await expect(page.locator('.canvas-confirm')).toBeVisible()
  await page.getByRole('button', { name: '已确认本页' }).click()
  await expect(page.locator('.page-thumb .review-marker')).toHaveCount(0)

  await page.waitForTimeout(900)
  await page.reload()
  await expect(page.locator('.page-thumb .review-marker')).toHaveCount(0)
})

test('applies one enhancement preset to all pages and uses it for later uploads', async ({ page, isMobile }) => {
  test.setTimeout(60_000)
  await page.goto('/')
  await page.locator('input[type="file"]').first().setInputFiles([
    { name: 'batch-01.png', mimeType: 'image/png', buffer: png },
    { name: 'batch-02.png', mimeType: 'image/png', buffer: png },
  ])
  await expect(page.getByRole('button', { name: '导出 PDF' })).toBeEnabled({ timeout: 30_000 })
  const highContrast = page.locator('.tool-panel').getByRole('button', { name: '高对比' })
  const mobilePreset = page.getByRole('combobox', { name: '文字增强强度' })
  if (isMobile) await mobilePreset.selectOption('highContrast')
  else await highContrast.click()
  await expect(page.getByRole('button', { name: '导出 PDF' })).toBeEnabled({ timeout: 15_000 })
  if (isMobile) await page.getByRole('button', { name: '应用当前增强到全部页面' }).click()
  else await page.getByRole('button', { name: '应用到全部 2 页' }).click()
  await expect(page.getByText('已将 1 页批量设为高对比')).toBeVisible({ timeout: 15_000 })

  for (const index of [0, 1]) {
    await page.locator('.page-thumb').nth(index).click()
    if (isMobile) await expect(mobilePreset).toHaveValue('highContrast')
    else await expect(highContrast).toHaveAttribute('aria-pressed', 'true')
  }

  await page.locator('.page-rail input[type="file"]').setInputFiles({
    name: 'batch-03.png',
    mimeType: 'image/png',
    buffer: png,
  })
  await expect(page.getByRole('button', { name: '导出 PDF' })).toBeEnabled({ timeout: 15_000 })
  await page.locator('.page-thumb').last().click()
  if (isMobile) await expect(mobilePreset).toHaveValue('highContrast')
  else await expect(highContrast).toHaveAttribute('aria-pressed', 'true')
})
