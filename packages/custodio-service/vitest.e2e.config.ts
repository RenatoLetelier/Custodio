import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'service-e2e',
    environment: 'node',
    execArgv: ['--disable-warning=ExperimentalWarning'],
    include: ['test/e2e/**/*.e2e.test.ts'],
    testTimeout: 30_000,
    passWithNoTests: true
  }
})
