import { copyFileSync, cpSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'

// Builds what the Windows installer ships in resources/service: the service, the helper, Node and the setup scripts
const ROOT = resolve(import.meta.dirname, '..')
const BUNDLE_DIR = join(ROOT, 'dist')

const [major = 0, minor = 0] = process.versions.node.split('.').map(Number)
if (major < 22 || (major === 22 && minor < 13)) throw new Error(`Node ${process.versions.node}: the service needs 22.13 or later (node:sqlite)`)

rmSync(BUNDLE_DIR, { recursive: true, force: true })
await build({
  entryPoints: { 'custodio-service': join(ROOT, 'src/main.ts'), 'custodio-helper': join(ROOT, 'src/helper/main.ts') },
  outdir: BUNDLE_DIR,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  // Fastify and pino are CommonJS and still call require inside the ES module bundle
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  legalComments: 'none',
  logLevel: 'warning'
})
cpSync(join(ROOT, 'deploy/windows'), BUNDLE_DIR, { recursive: true })
// The installed service runs on the same Node it was tested with, as its own process apart from Electron
if (process.platform === 'win32') copyFileSync(process.execPath, join(BUNDLE_DIR, 'node.exe'))
console.log(`custodio-service bundle ready in ${BUNDLE_DIR}`)
