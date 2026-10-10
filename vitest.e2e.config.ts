import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: ['packages/custodio-service/vitest.e2e.config.ts'],
    reporters: ['default', 'json'],
    outputFile: { json: 'reports/vitest-e2e.json' },
    passWithNoTests: true
  }
})
