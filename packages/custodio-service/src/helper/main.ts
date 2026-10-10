import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pino } from 'pino'
import { assertRealAdaptersAllowed } from '../adapters/windows/guard.js'
import { defaultDataDir } from '../config.js'
import { ExecFileRunner, Helper } from './helper.js'
import { DEFAULT_PIPE, serveHelper } from './transport.js'

// custodio-helper runs elevated (installed as its own Windows service) and only answers the whitelist
const log = pino({ name: 'custodio-helper' })
assertRealAdaptersAllowed('custodio-helper')
const dataDir = process.env.CUSTODIO_DATA_DIR ?? defaultDataDir()
const secret = process.env.CUSTODIO_HELPER_SECRET ?? readFileSync(join(dataDir, 'helper-secret'), 'utf8').trim()
const pipe = process.env.CUSTODIO_HELPER_PIPE ?? DEFAULT_PIPE

const server = await serveHelper(new Helper(new ExecFileRunner(), secret), pipe)
log.info({ pipe }, 'custodio-helper listening')

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
