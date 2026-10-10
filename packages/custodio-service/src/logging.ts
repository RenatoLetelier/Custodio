import { existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pino, type Logger } from 'pino'
import { defaultDataDir } from './config.js'

const MAX_LOG_BYTES = 10 * 1024 * 1024

// Installed, the service and the helper have no console: CUSTODIO_LOG_TO_FILE sends each one to <data>/logs/<name>.log
export function createLogger(name: string, env: NodeJS.ProcessEnv = process.env): Logger {
  const level = env.CUSTODIO_LOG_LEVEL ?? 'info'
  if (env.CUSTODIO_LOG_TO_FILE !== '1') return pino({ name, level })
  const dir = join(env.CUSTODIO_DATA_DIR ?? defaultDataDir(env), 'logs')
  const file = join(dir, `${name}.log`)
  mkdirSync(dir, { recursive: true })
  // One previous file is kept, so the logs never grow without bound
  if (existsSync(file) && statSync(file).size > MAX_LOG_BYTES) renameSync(file, `${file}.1`)
  return pino({ name, level }, pino.destination({ dest: file, append: true, sync: true }))
}
