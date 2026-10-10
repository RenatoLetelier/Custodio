import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import es from '../src/ui/i18n/es.json'
import { captureEvidence } from './evidence'
import { expect, goTo, openApp, test } from './support/fixtures'
import { RENDERER_ORIGIN } from './support/service'

const UI_SRC = resolve(__dirname, '../src/ui')
const PACKAGE = resolve(__dirname, '../package.json')
const SECTIONS = ['overview', 'disks', 'projects', 'backups', 'activity', 'settings'] as const

test('U11 detener la UI no detiene el scheduler y la UI solo usa la API /v1 por loopback con token', async ({ browser, service }) => {
  const { policyId } = await service.standardProject()
  const context = await browser.newContext()
  const page = await context.newPage()
  const calls: { url: string; auth: string | null }[] = []
  page.on('request', (request) => calls.push({ url: request.url(), auth: request.headers().authorization ?? null }))

  await openApp(page, service)
  for (const section of SECTIONS) await goTo(page, es.nav[section])
  await goTo(page, es.nav.overview)
  await captureEvidence(page, 'U11-antes-de-cerrar')

  // Beyond its own files, the window talks only to the service's /v1 API on loopback, always with the token
  const apiCalls = calls.filter((c) => new URL(c.url).origin !== RENDERER_ORIGIN)
  expect(apiCalls.length).toBeGreaterThan(0)
  for (const call of apiCalls) {
    const url = new URL(call.url)
    expect(url.origin).toBe(service.baseUrl)
    expect(url.hostname).toBe('127.0.0.1')
    expect(url.pathname.startsWith('/v1/')).toBe(true)
    expect(call.auth).toBe(`Bearer ${service.token}`)
  }

  // The interface goes away completely
  await context.close()

  // Time reaches the next scheduled copy: the service runs it on its own
  const policy = await service.api('GET', `/v1/policies/${policyId}`)
  await service.sim('/clock/advance', { ms: Date.parse(policy.nextRunAt) - Date.now() + 60_000 })
  await expect
    .poll(async () => (await service.api('GET', `/v1/jobs?policyId=${policyId}`)).jobs.filter((j: any) => j.trigger !== 'manual').map((j: any) => j.status), { timeout: 15_000 })
    .toContain('succeeded')

  // By construction: the renderer has no Node access and no other way out than the API client
  const files = readdirSync(UI_SRC, { recursive: true, withFileTypes: true }).filter((e) => e.isFile() && /\.tsx?$/.test(e.name))
  for (const file of files) {
    const path = join(file.parentPath, file.name)
    const rel = relative(UI_SRC, path).split(sep).join('/')
    const text = readFileSync(path, 'utf8')
    expect(text, rel).not.toMatch(/from ['"](node:|electron|fs|child_process|custodio-service)/)
    expect(text, rel).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)/)
    if (rel !== 'api/client.ts') expect(text, rel).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|EventSource/)
  }
  const pkg = JSON.parse(readFileSync(PACKAGE, 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
  expect(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })).not.toContain('custodio-service')
})
