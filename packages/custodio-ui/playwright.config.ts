import { resolve } from 'node:path'
import { defineConfig, devices } from '@playwright/test'

const RENDERER_URL = 'http://127.0.0.1:5290'

// The simulated service joins webServer once it exists (U1–U11 run against both)
export default defineConfig({
  testDir: 'e2e',
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: resolve(__dirname, '../../reports/playwright.json') }]],
  outputDir: 'test-results',
  use: {
    baseURL: RENDERER_URL,
    locale: 'es-CL',
    trace: 'retain-on-failure'
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 820 } }
    }
  ],
  webServer: {
    command: 'npm run dev:renderer',
    cwd: __dirname,
    url: RENDERER_URL,
    reuseExistingServer: !process.env.CI
  }
})
