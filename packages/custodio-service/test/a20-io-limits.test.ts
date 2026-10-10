import { readdir } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { MEGABYTE } from '../src/core/backup/throttle.js'
import { isWindowOpen } from '../src/core/backup/schedule.js'
import { hashTree, listFiles, simpleSetup } from './support/backup.js'
import { createHarness, type Harness } from './support/harness.js'

let h: Harness
afterEach(async () => h?.close())

const files = (count: number, size: number) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`f${i}.bin`, Buffer.alloc(size, String(i))]))
const CHUNK = 256 * 1024

describe('límites de I/O', () => {
  it('A20 la copia respeta el límite de MB/s configurado (reloj y medidor simulados)', async () => {
    h = await createHarness({ start: '2026-10-01T12:00:00.000Z', clockMode: 'instant' })
    const setup = await simpleSetup(h, files(5, 2 * MEGABYTE))
    const policy = await h.policy(setup.projectId, { maxMegabytesPerSecond: 2, sources: [setup.storage.id], destinations: [setup.backup.id] })

    const startedAt = h.clock.now().getTime()
    const job = await h.run(policy.id)
    const elapsedMs = h.clock.now().getTime() - startedAt
    expect(job.status).toBe('succeeded')
    expect(h.meter.totalBytes).toBe(10 * MEGABYTE)
    expect(elapsedMs).toBeGreaterThanOrEqual(4500)
    expect(h.meter.peakBytes(1000)).toBeLessThanOrEqual(2 * MEGABYTE + CHUNK)
    expect(await hashTree(setup.copyRoot)).toEqual(await hashTree(setup.sourceRoot))

    // Raising the limit makes the same work take proportionally less time
    await h.patch(`/v1/policies/${policy.id}`, { maxMegabytesPerSecond: 10 })
    await h.writeFile(setup.source, 'Fotos/extra.bin', Buffer.alloc(10 * MEGABYTE, 'x'))
    const before = h.clock.now().getTime()
    await h.run(policy.id)
    expect(h.clock.now().getTime() - before).toBeLessThanOrEqual(1000 + 100)
    expect(h.clock.now().getTime() - before).toBeGreaterThanOrEqual(1000 - 300)
  })

  it('A20 sin límite configurado no espera nunca', async () => {
    h = await createHarness({ clockMode: 'instant' })
    const setup = await simpleSetup(h, files(3, MEGABYTE))
    const policy = await h.policy(setup.projectId, { sources: [setup.storage.id], destinations: [setup.backup.id] })
    await h.run(policy.id)
    expect(h.clock.sleptMs).toBe(0)
    expect(h.meter.totalBytes).toBe(3 * MEGABYTE)
  })

  it('A20 la ventana horaria se evalúa en la zona de la política y puede cruzar la medianoche', () => {
    const window = { start: '22:00', end: '06:00' }
    expect(isWindowOpen(window, 'UTC', new Date('2026-10-01T23:30:00Z'))).toBe(true)
    expect(isWindowOpen(window, 'UTC', new Date('2026-10-01T05:59:00Z'))).toBe(true)
    expect(isWindowOpen(window, 'UTC', new Date('2026-10-01T06:00:00Z'))).toBe(false)
    expect(isWindowOpen(window, 'UTC', new Date('2026-10-01T12:00:00Z'))).toBe(false)
    // 23:30 in Santiago (UTC-3 in October) is 02:30 UTC
    expect(isWindowOpen(window, 'America/Santiago', new Date('2026-10-02T02:30:00Z'))).toBe(true)
    expect(isWindowOpen({ start: '01:00', end: '05:00' }, 'UTC', new Date('2026-10-01T03:00:00Z'))).toBe(true)
    expect(isWindowOpen(null, 'UTC', new Date())).toBe(true)
  })

  it('A20 no copia fuera de la ventana horaria', async () => {
    h = await createHarness({ start: '2026-10-01T12:00:00.000Z' })
    const setup = await simpleSetup(h, files(2, 1000))
    const policy = await h.policy(setup.projectId, { window: { start: '22:00', end: '06:00' }, timezone: 'UTC', sources: [setup.storage.id], destinations: [setup.backup.id] })
    const outside = await h.run(policy.id)
    expect(outside).toMatchObject({ status: 'interrupted', error: { code: 'outside_window' } })
    expect(await listFiles(setup.copyRoot)).toEqual([])
    expect(h.events('backup.failed')).toEqual([])

    h.clock.set('2026-10-01T22:30:00.000Z')
    expect((await h.run(policy.id)).status).toBe('succeeded')
    expect(await listFiles(setup.copyRoot)).toEqual(['f0.bin', 'f1.bin'])
  })

  it('A20 si la ventana se cierra a mitad de copia se detiene sin dejar archivos a medias y sigue en la siguiente', async () => {
    h = await createHarness({ start: '2026-10-01T05:59:57.000Z', clockMode: 'instant' })
    const setup = await simpleSetup(h, files(6, MEGABYTE + 100_000))
    const policy = await h.policy(setup.projectId, { window: { start: '22:00', end: '06:00' }, timezone: 'UTC', maxMegabytesPerSecond: 1, sources: [setup.storage.id], destinations: [setup.backup.id] })

    const cut = await h.run(policy.id)
    expect(cut).toMatchObject({ status: 'interrupted', error: { code: 'outside_window' } })
    expect(h.clock.now().toISOString() >= '2026-10-01T06:00:00.000Z').toBe(true)
    const partial = await listFiles(setup.copyRoot)
    expect(partial.length).toBeGreaterThan(0)
    expect(partial.length).toBeLessThan(6)
    const source = await hashTree(setup.sourceRoot)
    for (const [name, hash] of Object.entries(await hashTree(setup.copyRoot))) expect(hash, name).toBe(source[name])
    expect((await readdir(setup.copyRoot)).filter((n) => n.endsWith('.tmp'))).toEqual([])

    h.clock.set('2026-10-01T22:00:00.000Z')
    const resumed = await h.run(policy.id)
    expect(resumed.status).toBe('succeeded')
    expect(resumed.result).toMatchObject({ filesUpToDate: partial.length, filesCopied: 6 - partial.length })
    expect(await hashTree(setup.copyRoot)).toEqual(source)
  })
})
