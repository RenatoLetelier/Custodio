import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// What the Windows installer ships in resources/service, built the same way npm run dist:win builds it
const SERVICE_DIR = resolve(import.meta.dirname, '../..')
const DIST = join(SERVICE_DIR, 'dist')
const NODE = process.platform === 'win32' ? join(DIST, 'node.exe') : process.execPath

let root: string

beforeAll(async () => {
  const bundle = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/bundle.ts'], { cwd: SERVICE_DIR, encoding: 'utf8' })
  expect(bundle.status, `${bundle.stdout}\n${bundle.stderr}`).toBe(0)
  root = await mkdtemp(join(tmpdir(), 'custodio-bundle-'))
}, 120_000)

afterAll(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('servicio empaquetado para el instalador', () => {
  it('A15 el servicio empaquetado escucha solo en 127.0.0.1 y exige el token que crea para la aplicación', async () => {
    const dataDir = join(root, 'service')
    const env: NodeJS.ProcessEnv = { ...process.env, CUSTODIO_ADAPTERS: 'sim', CUSTODIO_DATA_DIR: dataDir, CUSTODIO_PORT: '0' }
    delete env.CUSTODIO_TOKEN
    const child = spawn(NODE, ['--disable-warning=ExperimentalWarning', join(DIST, 'custodio-service.mjs')], {
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let log = ''
    child.stderr.on('data', (chunk: Buffer) => (log += chunk.toString()))
    try {
      const address = await new Promise<string>((resolveAddress, reject) => {
        const timer = setTimeout(() => reject(new Error(`El servicio empaquetado no arrancó:\n${log}`)), 25_000)
        child.stdout.on('data', (chunk: Buffer) => {
          log += chunk.toString()
          const found = /"address":"([^"]+)","adapters":"sim","msg":"custodio listening"/.exec(log)
          if (found?.[1]) {
            clearTimeout(timer)
            resolveAddress(found[1])
          }
        })
        child.on('exit', (code) => reject(new Error(`El servicio empaquetado terminó con código ${code}:\n${log}`)))
      })
      expect(address).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      const token = (await readFile(join(dataDir, 'service-token'), 'utf8')).trim()
      expect(token.length).toBeGreaterThanOrEqual(32)
      expect((await fetch(`${address}/v1/disks`)).status).toBe(401)
      const health = await fetch(`${address}/v1/health`, { headers: { authorization: `Bearer ${token}` } })
      expect(health.status).toBe(200)
      expect(await health.json()).toMatchObject({ status: 'ok' })
    } finally {
      const exited = new Promise((resolveExit) => child.once('exit', resolveExit))
      if (child.exitCode === null && child.signalCode === null) child.kill()
      await exited
    }
  })

  it('A16 el helper empaquetado se niega a correr con NODE_ENV=test', () => {
    const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\custodio-test-${randomBytes(6).toString('hex')}` : join(root, 'helper.sock')
    const result = spawnSync(NODE, [join(DIST, 'custodio-helper.mjs')], {
      env: { ...process.env, NODE_ENV: 'test', CUSTODIO_DATA_DIR: join(root, 'helper'), CUSTODIO_HELPER_PIPE: pipe, CUSTODIO_HELPER_SECRET: 'x'.repeat(32) },
      encoding: 'utf8',
      timeout: 15_000
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/RealAdapterBlockedError|blocked while NODE_ENV=test/)
  })

  it('A16 el paquete del instalador trae el servicio, el helper y sus scripts, y los arranca con los adaptadores reales de Windows', async () => {
    const env = await readFile(join(DIST, 'production.env'), 'utf8')
    expect(env).toMatch(/^CUSTODIO_ADAPTERS=windows$/m)
    expect(env).toMatch(/^NODE_ENV=production$/m)
    for (const file of ['custodio-service.mjs', 'custodio-helper.mjs', 'install-tasks.ps1', 'uninstall-tasks.ps1']) expect(existsSync(join(DIST, file)), file).toBe(true)
    if (process.platform === 'win32') expect(existsSync(NODE)).toBe(true)
  })
})
