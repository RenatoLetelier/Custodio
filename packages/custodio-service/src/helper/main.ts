import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertRealAdaptersAllowed } from '../adapters/windows/guard.js'
import { defaultDataDir } from '../config.js'
import { createLogger } from '../logging.js'
import { ExecFileRunner, Helper } from './helper.js'
import { DEFAULT_PIPE, serveHelper } from './transport.js'

// custodio-helper runs elevated (the installer registers it as a SYSTEM task) and only answers the whitelist
const log = createLogger('custodio-helper')
assertRealAdaptersAllowed('custodio-helper')
const dataDir = process.env.CUSTODIO_DATA_DIR ?? defaultDataDir()
const secret = process.env.CUSTODIO_HELPER_SECRET ?? readFileSync(join(dataDir, 'helper-secret'), 'utf8').trim()
const pipe = process.env.CUSTODIO_HELPER_PIPE ?? DEFAULT_PIPE

// The service runs without elevation, so the pipe must accept it; the secret is what authorizes each request
const server = await serveHelper(new Helper(new ExecFileRunner(), secret), pipe, { shared: true })
log.info({ pipe }, 'custodio-helper listening')

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
