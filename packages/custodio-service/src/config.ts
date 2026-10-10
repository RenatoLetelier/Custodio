import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

export const LOOPBACK_HOSTS = ['127.0.0.1', '::1', 'localhost']
export const DEFAULT_PORT = 47600
export const MIN_TOKEN_LENGTH = 32

export const ServiceConfigSchema = z.object({
  dataDir: z.string().min(1),
  // Remote access is out of scope: the service only ever listens on loopback
  host: z
    .string()
    .default('127.0.0.1')
    .refine((host) => LOOPBACK_HOSTS.includes(host), 'El servicio solo escucha en 127.0.0.1 (sin acceso remoto).'),
  port: z.number().int().min(0).max(65535).default(DEFAULT_PORT),
  tokens: z
    .array(z.object({ name: z.string().min(1), token: z.string().min(MIN_TOKEN_LENGTH, `El token debe tener al menos ${MIN_TOKEN_LENGTH} caracteres.`) }))
    .min(1, 'El servicio necesita un token.'),
  // Origins allowed to call the API from a browser engine: the desktop app (and the dev renderer in tests)
  corsOrigins: z.array(z.string().regex(/^(app:\/\/custodio|http:\/\/(127\.0\.0\.1|localhost):\d+)$/)).default(['app://custodio']),
  adapters: z.enum(['sim', 'windows']).default('sim'),
  simScenario: z.string().optional(),
  tickEveryMs: z.number().int().positive().default(30_000)
})

export type ServiceConfig = z.output<typeof ServiceConfigSchema>
export type ServiceConfigInput = z.input<typeof ServiceConfigSchema>

export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === 'win32') return join(env.ProgramData ?? 'C:\\ProgramData', 'Custodio')
  return join(homedir(), '.custodio')
}

// The UI reads this file to talk to the service; it is created once with a random token
export function ensureTokenFile(dataDir: string): string {
  const file = join(dataDir, 'service-token')
  if (existsSync(file)) return readFileSync(file, 'utf8').trim()
  mkdirSync(dataDir, { recursive: true })
  const token = randomBytes(32).toString('hex')
  writeFileSync(file, `${token}\n`, { encoding: 'utf8', flag: 'wx' })
  if (process.platform !== 'win32') chmodSync(file, 0o600)
  return token
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const dataDir = env.CUSTODIO_DATA_DIR ?? defaultDataDir(env)
  const token = env.CUSTODIO_TOKEN ?? ensureTokenFile(dataDir)
  return ServiceConfigSchema.parse({
    dataDir,
    host: env.CUSTODIO_HOST,
    port: env.CUSTODIO_PORT === undefined ? undefined : Number(env.CUSTODIO_PORT),
    tokens: [{ name: env.CUSTODIO_TOKEN_NAME ?? 'custodio-ui', token }],
    corsOrigins: env.CUSTODIO_CORS_ORIGINS?.split(',').map((o) => o.trim()).filter(Boolean),
    adapters: env.CUSTODIO_ADAPTERS,
    simScenario: env.CUSTODIO_SIM_SCENARIO,
    tickEveryMs: env.CUSTODIO_TICK_MS === undefined ? undefined : Number(env.CUSTODIO_TICK_MS)
  })
}
