import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pino } from 'pino'
import { AtomicCopier } from './adapters/node/atomic-copier.js'
import { NodeFileSystem } from './adapters/node/filesystem.js'
import { SystemClock } from './adapters/node/system-clock.js'
import { createSimAdapters, loadScenario } from './adapters/sim/scenario.js'
import { WindowsDiskProbe, WindowsSmartReader, WindowsVolumeReader } from './adapters/windows/adapters.js'
import { createService, type Adapters } from './app.js'
import { configFromEnv, type ServiceConfig } from './config.js'
import { DEFAULT_PIPE, HelperClient } from './helper/transport.js'

function helperSecret(dataDir: string): string {
  const file = join(dataDir, 'helper-secret')
  if (!existsSync(file)) {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(file, `${randomBytes(32).toString('hex')}\n`, { flag: 'wx' })
  }
  return readFileSync(file, 'utf8').trim()
}

function windowsAdapters(config: ServiceConfig): Adapters {
  const helper = new HelperClient(process.env.CUSTODIO_HELPER_PIPE ?? DEFAULT_PIPE, process.env.CUSTODIO_HELPER_SECRET ?? helperSecret(config.dataDir))
  const fs = new NodeFileSystem()
  return {
    clock: new SystemClock(),
    disks: new WindowsDiskProbe(helper),
    smart: new WindowsSmartReader(helper),
    volumes: new WindowsVolumeReader(helper),
    fs,
    copier: new AtomicCopier(fs)
  }
}

const log = pino({ name: 'custodio-service' })
const config = configFromEnv()
const adapters = config.adapters === 'windows' ? windowsAdapters(config) : createSimAdapters(config.simScenario ? loadScenario(config.simScenario) : undefined)
const service = createService(config, adapters, { logger: log })
const address = await service.start()
log.info({ address, adapters: config.adapters }, 'custodio listening')

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void service.stop().then(() => process.exit(0))
  })
}
