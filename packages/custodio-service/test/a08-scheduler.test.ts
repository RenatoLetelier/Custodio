import { afterEach, describe, expect, it } from 'vitest'
import { SimCopier } from '../src/adapters/sim/io.js'
import { simpleSetup } from './support/backup.js'
import { createHarness, type Harness } from './support/harness.js'

let h: Harness
afterEach(async () => h?.close())

const backupJobs = (policyId: string) => h.s.core.store.jobs.list({ policyId, kind: 'backup' }).reverse()

describe('programación de copias', () => {
  it('A8 dispara según cron y zona horaria IANA con reloj simulado y registra la ejecución', async () => {
    h = await createHarness({ start: '2026-10-01T12:00:00.000Z' })
    const setup = await simpleSetup(h, { 'a.jpg': 'uno' })
    const santiago = await h.policy(setup.projectId, { name: 'Santiago', cron: '0 3 * * *', timezone: 'America/Santiago', sources: [setup.storage.id], destinations: [setup.backup.id] })

    expect((await h.s.scheduler.tick()).started).toEqual([])
    expect((await h.get(`/v1/policies/${santiago.id}`)).body.nextRunAt).toBe('2026-10-02T06:00:00.000Z')

    h.clock.set('2026-10-02T05:59:00.000Z')
    expect((await h.s.scheduler.tick()).started).toEqual([])

    h.clock.set('2026-10-02T06:00:20.000Z')
    const { started } = await h.s.scheduler.tick()
    expect(started).toHaveLength(1)
    await h.s.runner.idle()
    expect((await h.s.scheduler.tick()).started).toEqual([])

    const jobs = (await h.get(`/v1/jobs?policyId=${santiago.id}`)).body.jobs
    expect(jobs).toEqual([
      expect.objectContaining({ kind: 'backup', trigger: 'schedule', scheduledFor: '2026-10-02T06:00:00.000Z', status: 'succeeded', requestedBy: 'custodio' })
    ])
    expect((await h.get(`/v1/policies/${santiago.id}`)).body).toMatchObject({
      lastScheduledFor: '2026-10-02T06:00:00.000Z',
      lastSuccessAt: '2026-10-02T06:00:20.000Z',
      nextRunAt: '2026-10-03T06:00:00.000Z'
    })
  })

  it('A8 la misma hora local respeta cada zona horaria y el cambio de horario', async () => {
    h = await createHarness({ start: '2026-07-01T00:00:00.000Z' })
    const setup = await simpleSetup(h, { 'a.jpg': 'uno' })
    const utc = await h.policy(setup.projectId, { name: 'UTC', cron: '0 3 * * *', timezone: 'UTC', sources: [setup.storage.id], destinations: [setup.backup.id] })
    const madrid = await h.policy(setup.projectId, { name: 'Madrid', cron: '0 3 * * *', timezone: 'Europe/Madrid', sources: [setup.storage.id], destinations: [setup.backup.id] })
    const santiago = await h.policy(setup.projectId, { name: 'Santiago', cron: '0 3 * * *', timezone: 'America/Santiago', sources: [setup.storage.id], destinations: [setup.backup.id] })
    // July: Madrid UTC+2, Santiago UTC-4
    expect((await h.get(`/v1/policies/${madrid.id}`)).body.nextRunAt).toBe('2026-07-01T01:00:00.000Z')
    expect((await h.get(`/v1/policies/${utc.id}`)).body.nextRunAt).toBe('2026-07-01T03:00:00.000Z')
    expect((await h.get(`/v1/policies/${santiago.id}`)).body.nextRunAt).toBe('2026-07-01T07:00:00.000Z')
  })

  it('A8 hace un único catch-up tras una caída y cierra lo que quedó a medias', async () => {
    h = await createHarness({ start: '2026-10-01T12:00:00.000Z' })
    const setup = await simpleSetup(h, { 'a.jpg': 'uno' })
    const policy = await h.policy(setup.projectId, { cron: '0 3 * * *', timezone: 'America/Santiago', sources: [setup.storage.id], destinations: [setup.backup.id] })
    h.clock.set('2026-10-02T06:00:05.000Z')
    await h.s.scheduler.tick()
    await h.s.runner.idle()

    // A run was in progress when the machine lost power
    const store = h.s.core.store
    store.jobs.insert({ ...backupJobs(policy.id)[0]!, id: 'colgado', status: 'running', finishedAt: null, result: null })
    store.locks.acquire(policy.id, 'colgado', '2026-10-02T07:00:00.000Z')

    // Three days down: the 3, 4 and 5 October slots were missed
    h.clock.set('2026-10-05T10:00:00.000Z')
    await h.restart()
    expect(h.s.core.store.jobs.get('colgado')).toMatchObject({ status: 'interrupted', error: { code: 'service_restarted' } })
    expect(h.s.core.store.locks.holder(policy.id)).toBeNull()

    const { started } = await h.s.scheduler.tick()
    expect(started).toHaveLength(1)
    expect(started[0]).toMatchObject({ trigger: 'catch_up', scheduledFor: '2026-10-05T06:00:00.000Z' })
    await h.s.runner.idle()
    expect((await h.s.scheduler.tick()).started).toEqual([])
    expect(backupJobs(policy.id).map((j) => [j.trigger, j.status])).toEqual([
      ['schedule', 'succeeded'],
      ['schedule', 'interrupted'],
      ['catch_up', 'succeeded']
    ])
  })

  it('A8 un lock evita solapar ejecuciones de la misma política', async () => {
    let sim!: SimCopier
    h = await createHarness({ start: '2026-10-01T12:01:00.000Z', copier: (fs) => (sim = new SimCopier(fs)) })
    const setup = await simpleSetup(h, { 'a.jpg': 'uno' })
    const policy = await h.policy(setup.projectId, { cron: '*/5 * * * *', timezone: 'UTC', sources: [setup.storage.id], destinations: [setup.backup.id] })
    let release!: () => void
    sim.gate = new Promise((resolve) => (release = resolve))

    h.clock.set('2026-10-01T12:05:00.000Z')
    const [first] = (await h.s.scheduler.tick()).started
    expect(first?.status).toBe('running')

    h.clock.set('2026-10-01T12:10:00.000Z')
    const [second] = (await h.s.scheduler.tick()).started
    expect(second).toMatchObject({ status: 'skipped', error: { code: 'policy_locked', details: { runningJobId: first?.id } } })
    expect((await h.post(`/v1/policies/${policy.id}/runs`, {})).status).toBe(409)

    release()
    sim.gate = null
    expect((await h.s.runner.settled(first!.id)).status).toBe('succeeded')
    h.clock.set('2026-10-01T12:15:00.000Z')
    const [third] = (await h.s.scheduler.tick()).started
    expect((await h.s.runner.settled(third!.id)).status).toBe('succeeded')
    expect(backupJobs(policy.id).map((j) => j.status)).toEqual(['succeeded', 'skipped', 'succeeded'])
    expect(h.s.core.store.locks.holder(policy.id)).toBeNull()
  })

  it('A8 las políticas fallan de forma independiente', async () => {
    let sim!: SimCopier
    h = await createHarness({ start: '2026-10-01T12:00:00.000Z', copier: (fs) => (sim = new SimCopier(fs)) })
    const a = await h.addDisk('a')
    const b = await h.addDisk('b')
    const c = await h.addDisk('c')
    await h.scan()
    await h.writeFile(a, 'Rota/x.jpg', 'x')
    await h.writeFile(b, 'Sana/y.jpg', 'y')
    const { projectId, assignments } = await h.project('Mixto', [
      { disk: a, folder: 'Rota', role: 'storage' },
      { disk: b, folder: 'Sana', role: 'storage' },
      { disk: c, folder: 'Copias', role: 'backup' }
    ])
    const id = (label: string) => assignments.find((x) => x.label === label)!.id
    const broken = await h.policy(projectId, { name: 'Rota', cron: '0 * * * *', timezone: 'UTC', sources: [id('Rota')], destinations: [id('Copias')] })
    const healthy = await h.policy(projectId, { name: 'Sana', cron: '0 * * * *', timezone: 'UTC', sources: [id('Sana')], destinations: [id('Copias')] })
    const corrupt = await h.policy(projectId, { name: 'Dañada', cron: '30 * * * *', timezone: 'UTC', sources: [id('Sana')], destinations: [id('Copias')] })
    // A policy whose stored schedule got corrupted must not stop the others
    h.s.core.store.policies.update({ ...h.s.core.store.policies.get(corrupt.id)!, cron: 'esto no es cron' })
    sim.failWhen = (request) => (request.sourcePath.includes('Rota') ? new Error('El disco no responde') : null)

    h.clock.set('2026-10-01T13:00:30.000Z')
    const tick = await h.s.scheduler.tick()
    expect(tick.started).toHaveLength(2)
    expect(tick.errors).toEqual([expect.objectContaining({ policyId: corrupt.id })])
    await h.s.runner.idle()

    expect(backupJobs(broken.id)[0]).toMatchObject({ status: 'failed', error: { code: 'unexpected', message: 'El disco no responde' } })
    expect(backupJobs(healthy.id)[0]).toMatchObject({ status: 'succeeded' })
    expect(h.events('backup.failed').map((e) => (e.payload as { policyId: string }).policyId)).toEqual([broken.id])
    expect(h.events('backup.completed').map((e) => (e.payload as { policyId: string }).policyId)).toEqual([healthy.id])

    h.clock.set('2026-10-01T14:00:30.000Z')
    sim.failWhen = null
    await h.s.scheduler.tick()
    await h.s.runner.idle()
    expect(backupJobs(broken.id).map((j) => j.status)).toEqual(['failed', 'succeeded'])
  })
})
