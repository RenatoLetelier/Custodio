import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { sha256, simpleSetup } from './support/backup.js'
import { createHarness, HOUR, type Harness } from './support/harness.js'

let h: Harness
afterEach(async () => h?.close())

// Deterministic "random" so the sample is the same on every run
const seeded = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) % 2 ** 31
  return seed / 2 ** 31
}

const files = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`foto-${i}.jpg`, `contenido ${i}`]))

describe('verificación periódica', () => {
  it('A12 la verificación por hash muestreado detecta un archivo corrupto en el destino y emite evento', async () => {
    h = await createHarness({ random: seeded(7) })
    const setup = await simpleSetup(h, files(10))
    const policy = await h.policy(setup.projectId, { verifySamplePercent: 100, sources: [setup.storage.id], destinations: [setup.backup.id] })
    await h.run(policy.id)

    const clean = await h.post(`/v1/policies/${policy.id}/verifications`, {})
    expect(clean.status).toBe(202)
    expect(await h.s.runner.settled(clean.body.job.id)).toMatchObject({ kind: 'verification', status: 'succeeded', result: { checked: 10, corrupted: [] } })

    // Bit rot on the backup disk: same size, different bytes
    await writeFile(join(setup.copyRoot, 'foto-4.jpg'), 'contenidO 4')
    const run = await h.post(`/v1/policies/${policy.id}/verifications`, { samplePercent: 100 })
    const job = await h.s.runner.settled(run.body.job.id)
    expect(job).toMatchObject({ status: 'failed', error: { code: 'corruption_detected' } })
    expect(job.result?.corrupted).toEqual([
      { destinationId: setup.backup.id, sourceId: setup.storage.id, path: 'foto-4.jpg', expectedSha256: sha256('contenido 4'), actualSha256: sha256('contenidO 4') }
    ])
    const events = h.events('backup.corruption_detected')
    expect(events).toHaveLength(1)
    expect(events[0]?.payload).toMatchObject({ policyId: policy.id, path: 'foto-4.jpg', diskId: h.diskId(setup.destination), jobId: job.id })
  })

  it('A12 una muestra parcial también encuentra copias desaparecidas', async () => {
    h = await createHarness({ random: seeded(3) })
    const setup = await simpleSetup(h, files(20))
    const policy = await h.policy(setup.projectId, { sources: [setup.storage.id], destinations: [setup.backup.id] })
    await h.run(policy.id)
    for (let i = 0; i < 20; i++) await rm(join(setup.copyRoot, `foto-${i}.jpg`))

    const job = await h.s.runner.settled(h.s.runner.startVerification(policy.id, { actor: 'tester', samplePercent: 10 }).id)
    expect(job.result?.checked).toBe(2)
    expect(job.result?.corrupted).toHaveLength(2)
    expect(h.events('backup.corruption_detected').map((e) => (e.payload as { actualSha256: string | null }).actualSha256)).toEqual([null, null])
  })

  it('A12 el scheduler la lanza sola cada cierto tiempo', async () => {
    h = await createHarness()
    const setup = await simpleSetup(h, files(3))
    const policy = await h.policy(setup.projectId, { cron: '0 3 * * *', timezone: 'UTC', verifyEveryHours: 24, verifySamplePercent: 100, sources: [setup.storage.id], destinations: [setup.backup.id] })
    await h.run(policy.id)

    h.clock.advance(23 * HOUR)
    expect((await h.s.scheduler.tick()).started.filter((j) => j.kind === 'verification')).toEqual([])
    await h.s.runner.idle()
    // Same size, different bytes: a backup run cannot notice it, only the hash check can
    await writeFile(join(setup.copyRoot, 'foto-1.jpg'), 'contenidO 1')
    h.clock.advance(2 * HOUR)
    const started = (await h.s.scheduler.tick()).started.filter((j) => j.kind === 'verification')
    expect(started).toHaveLength(1)
    await h.s.runner.idle()
    expect(h.events('backup.corruption_detected')).toHaveLength(1)
    expect(h.s.core.store.policies.get(policy.id)?.lastVerifiedAt).toBe(h.clock.now().toISOString())
  })
})
