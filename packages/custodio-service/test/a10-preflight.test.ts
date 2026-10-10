import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { healthySmart } from '../src/adapters/sim/devices.js'
import { listFiles, simpleSetup } from './support/backup.js'
import { createHarness, type Harness } from './support/harness.js'

let h: Harness
afterEach(async () => h?.close())

async function prepared() {
  h = await createHarness()
  const setup = await simpleSetup(h, { 'a.jpg': 'uno', 'b.jpg': 'dos' })
  const policy = await h.policy(setup.projectId, { sources: [setup.storage.id], destinations: [setup.backup.id] })
  return { setup, policy }
}

const issueCodes = (job: { error: { details?: unknown } | null }) => ((job.error?.details as { issues: { code: string }[] }).issues ?? []).map((i) => i.code)

describe('preflight', () => {
  it('A10 se niega a correr si el origen o el destino están en rojo', async () => {
    const { setup, policy } = await prepared()
    h.smart.set(setup.destination.devicePath, healthySmart({ attributes: { '198': 4 } }))
    await h.scan()
    const job = await h.run(policy.id)
    expect(job.status).toBe('failed')
    expect(job.error?.code).toBe('preflight_failed')
    expect(issueCodes(job)).toEqual(['disk_unhealthy'])
    expect(await listFiles(setup.copyRoot)).toEqual([])
    expect(h.events('backup.failed').map((e) => e.payload)).toEqual([expect.objectContaining({ code: 'preflight_failed', jobId: job.id })])

    h.smart.set(setup.destination.devicePath, healthySmart())
    h.smart.set(setup.source.devicePath, healthySmart({ passed: false }))
    await h.scan()
    expect(issueCodes(await h.run(policy.id))).toEqual(['disk_unhealthy'])
  })

  it('A10 se niega a correr si el número de serie no coincide', async () => {
    const { setup, policy } = await prepared()
    // Another disk now answers at the destination's drive letter
    h.disks.update(setup.destination.devicePath, { serial: 'OTRO-DISCO-123' })
    const swapped = await h.run(policy.id)
    expect(swapped.status).toBe('failed')
    expect(issueCodes(swapped)).toEqual(['serial_mismatch'])
    expect(await listFiles(setup.copyRoot)).toEqual([])

    // The folder's volume.json says it belongs to a different disk (copied over from elsewhere)
    h.disks.update(setup.destination.devicePath, { serial: setup.destination.serial })
    const file = join(setup.destination.mountPath, 'Copias', '.diskmanager', 'volume.json')
    const descriptor = JSON.parse(await (await import('node:fs/promises')).readFile(file, 'utf8'))
    descriptor.disk.serial = 'SN-DE-OTRO'
    await writeFile(file, JSON.stringify(descriptor))
    expect(issueCodes(await h.run(policy.id))).toEqual(['serial_mismatch'])
  })

  it('A10 se niega a correr si falta .diskmanager/volume.json', async () => {
    const { setup, policy } = await prepared()
    await rm(join(setup.source.mountPath, 'Fotos', '.diskmanager'), { recursive: true })
    const job = await h.run(policy.id)
    expect(job.status).toBe('failed')
    expect(issueCodes(job)).toEqual(['descriptor_missing'])
    expect(job.error?.message).toContain('.diskmanager/volume.json')
    expect(await listFiles(setup.copyRoot)).toEqual([])
  })

  it('A10 se niega a correr si no hay espacio', async () => {
    const { setup, policy } = await prepared()
    h.volumes.set(setup.destination.mountPath, { totalBytes: 1_000_000, freeBytes: 4 })
    const job = await h.run(policy.id)
    expect(job.status).toBe('failed')
    expect(issueCodes(job)).toEqual(['insufficient_space'])
    expect(await listFiles(setup.copyRoot)).toEqual([])

    h.volumes.set(setup.destination.mountPath, { totalBytes: 1_000_000, freeBytes: 500_000 })
    expect((await h.run(policy.id)).status).toBe('succeeded')
  })

  it('A10 un disco desconectado también detiene la copia antes de empezar', async () => {
    const { setup, policy } = await prepared()
    h.disks.remove(setup.destination.devicePath)
    await h.scan()
    const job = await h.run(policy.id)
    expect(issueCodes(job)).toEqual(['disk_disconnected'])
  })
})
