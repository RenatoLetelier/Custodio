import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      'packages/custodio-service/vitest.config.ts',
      'packages/custodio-ui/vitest.config.ts',
      { test: { name: 'tools', include: ['scripts/**/*.test.ts'], environment: 'node' } }
    ],
    reporters: ['default', 'json'],
    outputFile: { json: 'reports/vitest-unit.json' },
    passWithNoTests: true
  }
})
