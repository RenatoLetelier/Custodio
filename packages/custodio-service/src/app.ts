import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { Logger as PinoLogger } from 'pino'
import { buildServer } from './api/server.js'
import { registerSimControl, type SimControlTarget } from './adapters/sim/control.js'
import { ServiceConfigSchema, type ServiceConfigInput } from './config.js'
import type { Clock, Copier, DiskProbe, DiskRepairer, FileSystemPort, Logger, Meter, SmartReader, VolumeReader } from './core/ports/system.js'
import { silentLogger } from './core/ports/system.js'
import { InventoryWatch } from './core/inventory-health/watch.js'
import { createServices, type Services } from './core/services.js'
import { SqliteIdempotencyStore } from './db/idempotency.js'
import { SqliteStore } from './db/store.js'

export const SERVICE_VERSION = '0.3.2'

export interface Adapters {
  clock: Clock
  disks: DiskProbe
  smart: SmartReader
  volumes: VolumeReader
  fs: FileSystemPort
  copier: Copier
  repairer: DiskRepairer
  meter?: Meter
  random?: () => number
}

export interface CustodioService {
  store: SqliteStore
  services: Services
  app: FastifyInstance
  start(): Promise<string>
  stop(): Promise<void>
}

export function pinoAdapter(log: PinoLogger): Logger {
  return {
    info: (message, data) => log.info(data ?? {}, message),
    warn: (message, data) => log.warn(data ?? {}, message),
    error: (message, data) => log.error(data ?? {}, message)
  }
}

export interface CreateOptions {
  logger?: PinoLogger
  // Tests drive the scheduler by hand; the real service runs its loop
  runScheduler?: boolean
  // Development and UI tests only: endpoints that move the simulated hardware
  simControl?: SimControlTarget
}

export function createService(input: ServiceConfigInput, adapters: Adapters, options: CreateOptions = {}): CustodioService {
  const config = ServiceConfigSchema.parse(input)
  const store = new SqliteStore(join(config.dataDir, 'custodio.db'))
  const services = createServices({ store, ...adapters, logger: options.logger ? pinoAdapter(options.logger) : silentLogger })
  const app = buildServer({
    services,
    tokens: config.tokens,
    idempotencyStore: new SqliteIdempotencyStore(store),
    version: SERVICE_VERSION,
    startedAt: adapters.clock.now().toISOString(),
    corsOrigins: config.corsOrigins,
    logger: options.logger
  })
  if (options.simControl) registerSimControl(app, options.simControl, services)
  const scan = () => services.runner.settled(services.runner.startScan({ actor: 'custodio' }).id)
  const watch = new InventoryWatch(adapters.clock, scan, config.scanEveryMs)

  return {
    store,
    services,
    app,
    async start() {
      services.runner.recover()
      const firstScan = await scan()
      await services.scheduler.tick()
      if (options.runScheduler !== false) {
        services.scheduler.start(config.tickEveryMs)
        watch.start(firstScan)
      }
      return app.listen({ host: config.host, port: config.port })
    },
    async stop() {
      services.scheduler.stop()
      watch.stop()
      await app.close()
      await services.runner.idle()
      store.close()
    }
  }
}
