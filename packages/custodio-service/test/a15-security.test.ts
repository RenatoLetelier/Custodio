import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runFile } from '../src/adapters/node/exec.js'
import { ROUTES, type RouteDef } from '../src/api/contract.js'
import { ServiceConfigSchema } from '../src/config.js'
import { resolveInside } from '../src/core/shared/paths.js'
import { hashTree, simpleSetup } from './support/backup.js'
import { createHarness, type Harness } from './support/harness.js'

let h: Harness
afterEach(async () => h?.close())

const MALICIOUS = ['"; rm -rf ~ ;"', '$(whoami)', '`id`', '& echo pwned > canario.txt', '| calc', '%PATH%', "it's \"quoted\"", '--help', '..\\..\\Windows']

describe('seguridad', () => {
  it('A15 el token del servicio es obligatorio en todas las operaciones', async () => {
    h = await createHarness()
    for (const [operationId, route] of Object.entries(ROUTES) as [string, RouteDef][]) {
      const url = route.path.replace(/\{\w+\}/g, 'x')
      for (const authorization of [undefined, 'Bearer token-equivocado-0123456789abcdef0123456789', 'Basic dGVzdDp0ZXN0']) {
        const response = await h.service.app.inject({ method: route.method, url, headers: authorization ? { authorization } : {} })
        expect(response.statusCode, `${operationId} ${authorization ?? 'sin token'}`).toBe(401)
        expect(JSON.parse(response.body).error.code).toBe('unauthorized')
      }
    }
  })

  it('A15 escucha en 127.0.0.1 por defecto y no acepta otras interfaces ni tokens débiles', async () => {
    const tokens = [{ name: 'ui', token: 'x'.repeat(32) }]
    expect(ServiceConfigSchema.parse({ dataDir: 'd', tokens }).host).toBe('127.0.0.1')
    for (const host of ['0.0.0.0', '192.168.1.10', '::']) expect(() => ServiceConfigSchema.parse({ dataDir: 'd', tokens, host })).toThrow()
    expect(() => ServiceConfigSchema.parse({ dataDir: 'd', tokens: [] })).toThrow()
    expect(() => ServiceConfigSchema.parse({ dataDir: 'd', tokens: [{ name: 'ui', token: 'corto' }] })).toThrow()

    h = await createHarness()
    const address = await h.service.app.listen({ host: ServiceConfigSchema.parse({ dataDir: h.dataDir, tokens }).host, port: 0 })
    expect(address).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  })

  it('A15 los comandos externos usan execFile con argumentos: nombres maliciosos llegan literales', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'custodio-exec-'))
    try {
      const script = 'process.stdout.write(JSON.stringify(process.argv.slice(1)))'
      const result = await runFile(process.execPath, ['-e', script, ...MALICIOUS])
      expect(result.exitCode).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual(MALICIOUS)
      expect(existsSync(join(dir, 'canario.txt'))).toBe(false)
      expect(existsSync(join(process.cwd(), 'canario.txt'))).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('A15 valida las rutas: nada sale de la carpeta asignada', async () => {
    const root = join(tmpdir(), 'raiz')
    for (const bad of ['../fuera', 'a/../../fuera', '/etc/passwd', 'C:\\Windows', '\\\\servidor\\compartido', 'a/CON', 'a/b:c', 'a\u0000b', 'termina.']) {
      expect(() => resolveInside(root, bad), bad).toThrow(expect.objectContaining({ code: 'invalid_path' }))
    }
    expect(resolveInside(root, 'Fotos/2024/a.jpg')).toBe(join(root, 'Fotos', '2024', 'a.jpg'))

    h = await createHarness()
    const disk = await h.addDisk('uno')
    await h.scan()
    const project = await h.post('/v1/projects', { name: 'Uno' })
    const escape = await h.post(`/v1/projects/${project.body.project.id}/plans`, {
      actions: [{ type: 'add_assignment', diskId: h.diskId(disk), folder: '../../Windows/System32', role: 'backup' }]
    })
    expect(escape.status).toBe(400)
    expect(escape.body.error.code).toBe('invalid_path')
  })

  it('A15 carpetas y archivos con nombres maliciosos se respaldan tal cual, sin interpretarse', async () => {
    h = await createHarness()
    const names = ['$(whoami).txt', '; rm -rf ~.txt', '`id`.jpg', '&calc.txt', "it's.txt", '%PATH%.txt', '$(rm -rf ~)/dentro.txt']
    const setup = await simpleSetup(h, Object.fromEntries(names.map((name) => [name, `contenido de ${name}`])))
    const policy = await h.policy(setup.projectId, { sources: [setup.storage.id], destinations: [setup.backup.id] })
    expect((await h.run(policy.id)).status).toBe('succeeded')
    const copied = await hashTree(setup.copyRoot)
    expect(Object.keys(copied).sort()).toEqual([...names].sort())
    expect(copied).toEqual(await hashTree(setup.sourceRoot))
    expect(await readFile(join(setup.copyRoot, '$(rm -rf ~)', 'dentro.txt'), 'utf8')).toBe('contenido de $(rm -rf ~)/dentro.txt')
  })

  it('A15 las operaciones destructivas exigen confirmación y la auditoría registra quién las pidió', async () => {
    h = await createHarness({ extraTokens: [{ name: 'otra-app', token: 'otra-app-token-0123456789abcdef0123' }] })
    const setup = await simpleSetup(h, { 'a.jpg': 'uno' })
    const policy = await h.policy(setup.projectId, { sources: [setup.storage.id], destinations: [setup.backup.id] })
    await h.run(policy.id)

    const other = { authorization: 'Bearer otra-app-token-0123456789abcdef0123' }
    const preview = await h.post(`/v1/projects/${setup.projectId}/deletions`, { items: [{ sourceId: setup.storage.id, path: 'a.jpg' }] }, other)
    expect(preview.status).toBe(201)
    expect(preview.body.preview).toMatchObject({ deletesData: true, filesToDelete: 1 })
    expect(existsSync(join(setup.copyRoot, 'a.jpg'))).toBe(true)

    const unconfirmed = await h.post(`/v1/plans/${preview.body.id}/confirm`, {}, other)
    expect(unconfirmed.status).toBe(400)
    const refused = await h.post(`/v1/plans/${preview.body.id}/confirm`, { confirm: false }, other)
    expect(refused.status).toBe(422)
    expect(existsSync(join(setup.copyRoot, 'a.jpg'))).toBe(true)

    await h.post(`/v1/plans/${preview.body.id}/confirm`, { confirm: true }, other)
    expect(existsSync(join(setup.copyRoot, 'a.jpg'))).toBe(false)
    const audit = (await h.get('/v1/audit')).body.entries
    expect(audit.filter((e: any) => e.actor === 'otra-app').map((e: any) => e.action)).toEqual(['deletion.ordered', 'plan.confirmed'])
    expect(audit.find((e: any) => e.action === 'deletion.applied')).toMatchObject({ actor: 'custodio', details: { requestedBy: 'otra-app' } })
    expect(audit.find((e: any) => e.action === 'assignments.changed')?.actor).toBe('tester')
  })
})
