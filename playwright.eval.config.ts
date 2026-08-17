import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/evaluation',
  fullyParallel: false,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:4174', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
