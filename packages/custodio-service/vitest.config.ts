import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'service',
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['test/e2e/**'],
    passWithNoTests: true
  }
})
