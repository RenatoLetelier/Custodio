import { readFileSync } from 'node:fs'
import { Validator } from '@seriousme/openapi-schema-validator'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { EVENTS_FILE, OPENAPI_FILE, eventsMarkdown, openApiYaml } from '../src/api/contracts-files.js'
import { ROUTES } from '../src/api/contract.js'
import { SimCopier } from '../src/adapters/sim/io.js'
import type { FileSystemPort } from '../src/core/ports/system.js'
import type { Job } from '../src/core/shared/model.js'
import { listFiles, simpleSetup } from './support/backup.js'
import { createHarness, TOKEN, type Harness } from './support/harness.js'

let h: Harness
afterEach(async () => h?.close())

describe('API /v1', () => {
  it('A14 openapi.yaml está generado desde el contrato, es OpenAPI 3.1 válido y el servicio lo publica', async () => {
    const committed = readFileSync(OPENAPI_FILE, 'utf8')
    expect(committed, 'openapi.yaml desactualizado: ejecuta npm run contracts').toBe(openApiYaml())
    const doc = parse(committed)
    const result = await new Validator().validate(doc)
    expect(result.errors ?? []).toEqual([])
    expect(result.valid).toBe(true)
    expect(doc.openapi).toBe('3.1.0')

    const operations = Object.values(doc.paths as Record<string, Record<string, { operationId: string }>>).flatMap((ops) => Object.values(ops).map((o) => o.operationId))
    expect(operations.sort()).toEqual(Object.keys(ROUTES).sort())

    h = await createHarness()
    const served = await h.get('/v1/openapi.json')
    expect(served.body).toEqual(doc)
  })

  it('A14 docs/EVENTS.md coincide con los esquemas de eventos del código', () => {
    const current = readFileSync(EVENTS_FILE, 'utf8')
    expect(current, 'docs/EVENTS.md desactualizado: ejecuta npm run contracts').toBe(eventsMarkdown(current))
  })

  it('A14 una operación larga responde 202 con un job consultable', async () => {
    h = await createHarness()
    await h.addDisk('uno')
    const scan = await h.post('/v1/disks/scan')
    expect(scan.status).toBe(202)
    expect(scan.headers.location).toBe(`/v1/jobs/${scan.body.job.id}`)
    expect(scan.body.job).toMatchObject({ kind: 'inventory_scan', status: 'running' })
    await h.s.runner.idle()
    const done = await h.get(scan.headers.location as string)
    expect(done.body).toMatchObject({ id: scan.body.job.id, status: 'succeeded', result: { detected: [expect.any(String)] } })
    expect((await h.get('/v1/jobs?kind=inventory_scan&status=succeeded')).body.jobs.map((j: any) => j.id)).toEqual([scan.body.job.id])
  })

  it('A14 un job en curso se puede cancelar', async () => {
    let sim!: SimCopier
    h = await createHarness({ copier: (fs) => (sim = new SimCopier(fs)) })
    const setup = await simpleSetup(h, { 'a.jpg': 'uno', 'b.jpg': 'dos' })
    const policy = await h.policy(setup.projectId, { sources: [setup.storage.id], destinations: [setup.backup.id] })
    let release!: () => void
    sim.gate = new Promise((resolve) => (release = resolve))

    const run = await h.post(`/v1/policies/${policy.id}/runs`, {})
    expect(run.status).toBe(202)
    const jobId = run.body.job.id
    await new Promise((resolve) => setTimeout(resolve, 20))
    const cancel = await h.post(`/v1/jobs/${jobId}/cancel`)
    expect(cancel.status).toBe(202)
    release()
    await h.s.runner.idle()
    expect((await h.get(`/v1/jobs/${jobId}`)).body).toMatchObject({ status: 'cancelled', error: { code: 'cancelled' } })
    const again = await h.post(`/v1/jobs/${jobId}/cancel`)
    expect(again.status).toBe(409)
    expect(h.events('backup.failed')).toEqual([])
  })

  it('A14 cancelar responde al instante diciendo que se está cancelando, y la copia se detiene aunque esté revisando qué falta copiar', async () => {
    let jobId = ''
    let reviewed = 0
    let cancel: Awaited<ReturnType<Harness['post']>> | null = null
    h = await createHarness({
      fs: (inner) => {
        const fs = Object.create(inner) as FileSystemPort
        fs.walk = async function* (root, skipDir, onUnreadable) {
          for await (const entry of inner.walk(root, skipDir, onUnreadable)) {
            if (jobId && ++reviewed === 3) cancel = await h.post(`/v1/jobs/${jobId}/cancel`)
            yield entry
          }
        }
        return fs
      }
    })
    const setup = await simpleSetup(h, Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`foto-${i}.jpg`, `foto ${i}`])))
    const policy = await h.policy(setup.projectId, { sources: [setup.storage.id], destinations: [setup.backup.id] })
    const updates: Job[] = []
    h.s.runner.onUpdate((job) => updates.push(job))

    jobId = (await h.post(`/v1/policies/${policy.id}/runs`, {})).body.job.id
    await h.s.runner.idle()
    expect(cancel).toMatchObject({ status: 202, body: { job: { status: 'running', cancelRequestedAt: expect.any(String) } } })
    expect(updates.find((u) => u.cancelRequestedAt && u.status === 'running')).toBeDefined()
    expect((await h.get(`/v1/jobs/${jobId}`)).body).toMatchObject({ status: 'cancelled', cancelRequestedAt: expect.any(String), progress: { phase: 'scanning' } })
    expect(reviewed).toBe(3)
    expect(await listFiles(setup.copyRoot)).toEqual([])
  })

  it('A14 los trabajos se filtran por varios tipos a la vez y las búsquedas de discos viejas no se acumulan', async () => {
    h = await createHarness()
    const setup = await simpleSetup(h, { 'a.jpg': 'uno' })
    const policy = await h.policy(setup.projectId, { sources: [setup.storage.id], destinations: [setup.backup.id] })
    await h.run(policy.id)
    for (let i = 0; i < 25; i++) await h.scan()
    expect((await h.get('/v1/jobs?kind=inventory_scan&limit=100')).body.jobs).toHaveLength(20)
    const mine = (await h.get('/v1/jobs?kind=backup,verification')).body.jobs
    expect(mine.map((j: Job) => j.kind)).toEqual(['backup'])
  })

  it('A14 con Idempotency-Key la misma petición devuelve la misma respuesta sin repetir el efecto', async () => {
    h = await createHarness()
    const first = await h.post('/v1/projects', { name: 'Vacaciones' }, { 'idempotency-key': 'crear-vacaciones' })
    const second = await h.post('/v1/projects', { name: 'Vacaciones' }, { 'idempotency-key': 'crear-vacaciones' })
    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    expect(second.body).toEqual(first.body)
    expect(second.headers['idempotent-replayed']).toBe('true')
    expect((await h.get('/v1/projects')).body.projects).toHaveLength(1)

    const conflict = await h.post('/v1/projects', { name: 'Otra' }, { 'idempotency-key': 'crear-vacaciones' })
    expect(conflict.status).toBe(409)
    expect(conflict.body.error.code).toBe('idempotency_conflict')

    const setup = await simpleSetup(h, { 'a.jpg': 'uno' })
    const policy = await h.policy(setup.projectId, { sources: [setup.storage.id], destinations: [setup.backup.id] })
    const runA = await h.post(`/v1/policies/${policy.id}/runs`, {}, { 'idempotency-key': 'copia-1' })
    await h.s.runner.idle()
    const runB = await h.post(`/v1/policies/${policy.id}/runs`, {}, { 'idempotency-key': 'copia-1' })
    expect(runB.body.job.id).toBe(runA.body.job.id)
    expect(h.s.core.store.jobs.list({ policyId: policy.id })).toHaveLength(1)
  })

  it('A14 todos los errores tienen el mismo formato y un código estable', async () => {
    h = await createHarness()
    const disk = await h.addDisk('uno')
    await h.scan()
    const cases = [
      [await h.post('/v1/projects', { nombre: 'sin name' }), 400, 'validation_failed'],
      [await h.request('GET', '/v1/disks', undefined, { authorization: 'Bearer otro' }), 401, 'unauthorized'],
      [await h.get('/v1/projects/no-existe'), 404, 'not_found'],
      [(await h.post('/v1/projects', { name: 'Uno' }), await h.post('/v1/projects', { name: 'Uno' })), 409, 'conflict'],
      [await h.post('/v1/projects/no-existe/plans', { actions: [{ type: 'add_assignment', diskId: h.diskId(disk), folder: 'A', role: 'storage' }] }), 404, 'not_found']
    ] as const
    for (const [response, status, code] of cases) {
      expect(response.status).toBe(status)
      expect(Object.keys(response.body)).toEqual(['error'])
      expect(response.body.error.code).toBe(code)
      expect(typeof response.body.error.message).toBe('string')
    }
    const unknownRoute = await h.service.app.inject({ method: 'GET', url: '/v1/nada', headers: { authorization: `Bearer ${TOKEN}` } })
    expect(unknownRoute.statusCode).toBe(404)
    expect(JSON.parse(unknownRoute.body)).toEqual({ error: { code: 'not_found', message: 'No existe GET /v1/nada.' } })
    const badJson = await h.service.app.inject({ method: 'POST', url: '/v1/projects', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, payload: '{' })
    expect(badJson.statusCode).toBe(400)
    expect(JSON.parse(badJson.body).error.code).toBe('validation_failed')
  })
})
