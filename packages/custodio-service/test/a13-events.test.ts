import { afterEach, describe, expect, it } from 'vitest'
import { healthySmart } from '../src/adapters/sim/devices.js'
import { simpleSetup } from './support/backup.js'
import { eventsContract } from './support/contract.js'
import { createHarness, DAY, HOUR, type Harness } from './support/harness.js'

let h: Harness
afterEach(async () => h?.close())

describe('eventos', () => {
  it('A13 outbox persistente: cada evento se guarda con el cambio y sobrevive a un reinicio', async () => {
    h = await createHarness()
    await h.addDisk('uno')
    await h.scan()
    const before = (await h.get('/v1/events')).body.events
    expect(before.map((e: any) => e.type)).toEqual(['disk.detected'])

    await h.restart()
    expect((await h.get('/v1/events')).body.events).toEqual(before)

    // A change that rolls back takes its event with it
    expect(() =>
      h.s.core.store.transaction(() => {
        h.s.core.events.publish('backup.overdue', { policyId: 'p', projectId: 'x', lastSuccessAt: null, expectedIntervalMs: 1, overdueSince: h.clock.now().toISOString() })
        throw new Error('rollback')
      })
    ).toThrow('rollback')
    expect((await h.get('/v1/events')).body.events).toEqual(before)
  })

  it('A13 cursor GET /v1/events?after= con entrega al menos una vez', async () => {
    h = await createHarness()
    for (const name of ['a', 'b', 'c', 'd', 'e']) await h.addDisk(name)
    await h.scan()

    const first = (await h.get('/v1/events?after=0&limit=2')).body
    expect(first.events.map((e: any) => e.seq)).toEqual([1, 2])
    expect(first.nextCursor).toBe(2)
    const again = (await h.get('/v1/events?after=0&limit=2')).body
    expect(again).toEqual(first)

    const rest = (await h.get(`/v1/events?after=${first.nextCursor}`)).body
    expect(rest.events.map((e: any) => e.seq)).toEqual([3, 4, 5])
    const empty = (await h.get(`/v1/events?after=${rest.nextCursor}`)).body
    expect(empty).toEqual({ events: [], nextCursor: 5 })
    expect((await h.get('/v1/events?after=0&types=backup.completed')).body.events).toEqual([])
  })

  it('A13 consumo idempotente: un consumidor que recibe repetidos los aplica una sola vez', async () => {
    h = await createHarness()
    for (const name of ['a', 'b', 'c']) await h.addDisk(name)
    await h.scan()

    const applied: string[] = []
    const seen = new Set<string>()
    let cursor = 0
    const consume = async (limit: number, crashBeforeSavingCursor: boolean) => {
      const page = (await h.get(`/v1/events?after=${cursor}&limit=${limit}`)).body
      for (const event of page.events) {
        if (seen.has(event.id)) continue
        seen.add(event.id)
        applied.push(event.id)
      }
      if (!crashBeforeSavingCursor) cursor = page.nextCursor
    }
    await consume(2, true)
    await consume(10, false)
    await consume(10, false)
    expect(applied).toHaveLength(3)
    expect(new Set(applied).size).toBe(3)
  })

  it('A13 emite disk.detected, disk.health_changed, capacity.low, backup.completed, backup.failed y backup.overdue', async () => {
    h = await createHarness()
    const setup = await simpleSetup(h, { 'a.jpg': 'uno' })
    const policy = await h.policy(setup.projectId, { cron: '0 3 * * *', timezone: 'UTC', sources: [setup.storage.id], destinations: [setup.backup.id] })

    await h.run(policy.id)
    h.smart.set(setup.destination.devicePath, healthySmart({ attributes: { '198': 2 } }))
    h.volumes.set(setup.source.mountPath, { totalBytes: 1000, freeBytes: 50 })
    await h.scan()
    await h.run(policy.id)

    const types = new Set(h.events().map((e) => e.type))
    for (const type of ['disk.detected', 'disk.health_changed', 'capacity.low', 'backup.completed', 'backup.failed']) expect(types, type).toContain(type)

    // backup.overdue: no success in twice the interval (daily → 48 h)
    h.clock.advance(47 * HOUR)
    await h.s.scheduler.tick()
    await h.s.runner.idle()
    expect(h.events('backup.overdue')).toEqual([])
    h.clock.advance(2 * DAY)
    await h.s.scheduler.tick()
    await h.s.runner.idle()
    await h.s.scheduler.tick()
    const overdue = h.events('backup.overdue')
    expect(overdue).toHaveLength(1)
    expect(overdue[0]?.payload).toMatchObject({ policyId: policy.id, expectedIntervalMs: DAY })
    expect((await h.get(`/v1/policies/${policy.id}`)).body.overdueSince).toBe(overdue[0]?.payload && (overdue[0].payload as { overdueSince: string }).overdueSince)
    expect((await h.get('/v1/overview')).body).toMatchObject({ status: 'red', reasons: expect.arrayContaining(['backup_overdue', 'disk_failing']) })

    // Every type is documented and every emitted event matches docs/EVENTS.md
    expect(eventsContract.types).toEqual(expect.arrayContaining([...types]))
    for (const event of h.events()) expect(eventsContract.check(event)).toEqual([])
  })

  it('A13 backup.overdue se avisa una vez y se rearma con la siguiente copia exitosa', async () => {
    h = await createHarness()
    const setup = await simpleSetup(h, { 'a.jpg': 'uno' })
    const policy = await h.policy(setup.projectId, { cron: '0 3 * * *', timezone: 'UTC', paused: true, sources: [setup.storage.id], destinations: [setup.backup.id] })
    await h.patch(`/v1/policies/${policy.id}`, { paused: false })
    h.s.core.store.policies.update({ ...h.s.core.store.policies.get(policy.id)!, lastScheduledFor: new Date(h.clock.now().getTime() + 10 * DAY).toISOString() })

    h.clock.advance(3 * DAY)
    await h.s.scheduler.tick()
    await h.s.scheduler.tick()
    expect(h.events('backup.overdue')).toHaveLength(1)

    await h.run(policy.id)
    expect(h.s.core.store.policies.get(policy.id)?.overdueSince).toBeNull()
    h.clock.advance(3 * DAY)
    await h.s.scheduler.tick()
    expect(h.events('backup.overdue')).toHaveLength(2)
  })
})
