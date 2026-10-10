import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Serves the renderer alone in a browser, as Playwright sees it
export default defineConfig({
  root: resolve('src/ui'),
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5290, strictPort: true }
})
