import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { VolumeDescriptorSchema } from '../src/core/allocation/descriptor.js'
import { hashTree } from './support/backup.js'
import { createHarness, type Harness, type SimDisk } from './support/harness.js'

let h: Harness
afterEach(async () => h?.close())

async function threeDiskProject() {
  const main = await h.addDisk('principal', { serial: 'SER-MAIN', wwn: '5000c500aaaa0001' })
  const copyA = await h.addDisk('copia-a', { serial: 'SER-A' })
  const copyB = await h.addDisk('copia-b', { serial: 'SER-B' })
  await h.scan()
  await h.writeFile(main, 'Familia/Fotos/2024/a.jpg', 'foto a')
  await h.writeFile(main, 'Familia/Documentos/b.pdf', 'documento b')
  const { projectId, assignments } = await h.project('Familia', [
    { disk: main, folder: 'Familia/Fotos', role: 'storage', label: 'Fotos' },
    { disk: main, folder: 'Familia/Documentos', role: 'storage', label: 'Documentos' },
    { disk: copyA, folder: 'Respaldo', role: 'backup', label: 'Copia A' },
    { disk: copyB, folder: '', role: 'backup', label: 'Copia B' }
  ])
  const id = (label: string) => assignments.find((a) => a.label === label)!.id
  const nightly = await h.policy(projectId, { name: 'Cada noche', cron: '0 3 * * *', timezone: 'America/Santiago', sources: [id('Fotos'), id('Documentos')], destinations: [id('Copia A'), id('Copia B')] })
  const weekly = await h.policy(projectId, { name: 'Domingos', cron: '0 4 * * 0', timezone: 'America/Santiago', mode: 'retention', retentionDays: 60, sources: [id('Documentos')], destinations: [id('Copia B')], maxMegabytesPerSecond: 50, window: { start: '01:00', end: '06:00' } })
  return { main, copyA, copyB, projectId, nightly, weekly, id }
}

const descriptorOf = async (disk: SimDisk, folder: string) =>
  VolumeDescriptorSchema.parse(JSON.parse(await readFile(join(disk.mountPath, ...folder.split('/').filter(Boolean), '.diskmanager', 'volume.json'), 'utf8')))

describe('autodescripción', () => {
  it('A17 cada carpeta asignada contiene .diskmanager/volume.json con todo su proyecto', async () => {
    h = await createHarness()
    const { main, copyA, copyB, projectId } = await threeDiskProject()
    const project = (await h.get(`/v1/projects/${projectId}`)).body

    for (const [disk, folder, role] of [
      [main, 'Familia/Fotos', 'storage'],
      [main, 'Familia/Documentos', 'storage'],
      [copyA, 'Respaldo', 'backup'],
      [copyB, '', 'backup']
    ] as const) {
      const descriptor = await descriptorOf(disk, folder)
      expect(descriptor.disk.serial).toBe(disk.serial)
      expect(descriptor.assignment).toMatchObject({ folder, role })
      expect(descriptor.project).toMatchObject({ id: projectId, name: 'Familia', revision: project.project.revision })
      expect(descriptor.project.assignments).toHaveLength(4)
      expect(descriptor.project.policies.map((p) => p.name)).toEqual(['Cada noche', 'Domingos'])
    }
    const index = JSON.parse(await readFile(join(main.mountPath, '.diskmanager', 'index.json'), 'utf8'))
    expect(index.folders.map((f: any) => f.folder).sort()).toEqual(['Familia/Documentos', 'Familia/Fotos'])
  })

  it('A17 reconstruye la configuración de un proyecto solo desde los discos', async () => {
    h = await createHarness()
    const { projectId, nightly } = await threeDiskProject()
    await h.run(nightly.id)
    const original = (await h.get(`/v1/projects/${projectId}`)).body
    const serialOf = new Map(original.assignments.map((a: any) => [a.id, h.s.core.store.disks.get(a.diskId)?.serial]))

    // The database is gone; only the disks remain
    await h.resetDatabase()
    await h.scan()
    expect((await h.get('/v1/projects')).body.projects).toEqual([])

    const found = (await h.post('/v1/recovery/scan')).body.projects
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ id: projectId, name: 'Familia', revision: original.project.revision })
    expect(found[0].foundOn).toHaveLength(4)
    expect(found[0].assignments.map((a: any) => [a.label, a.folder, a.role, a.disk.serial]).sort()).toEqual(
      original.assignments.map((a: any) => [a.label, a.folder, a.role, serialOf.get(a.id)]).sort()
    )
    const strip = ({ projectId: _p, lastScheduledFor: _s, lastSuccessAt: _l, lastVerifiedAt: _v, overdueSince: _o, nextRunAt: _n, ...config }: any) => config
    expect(found[0].policies).toEqual(original.policies.map(strip))

    const imported = await h.post('/v1/recovery/import', { projectId })
    expect(imported.status).toBe(201)
    const recovered = (await h.get(`/v1/projects/${projectId}`)).body
    expect(recovered.project).toEqual(original.project)
    expect(recovered.assignments.map((a: any) => [a.id, a.label, a.folder, a.role])).toEqual(original.assignments.map((a: any) => [a.id, a.label, a.folder, a.role]))
    expect(recovered.policies.map(strip)).toEqual(original.policies.map(strip))

    // And it keeps working: the copies already on disk are recognised, not copied again
    const run = await h.run(nightly.id)
    expect(run.status).toBe('succeeded')
    expect(run.result).toMatchObject({ filesCopied: 0, filesUpToDate: 4 })
  })

  it('A17 un solo disco basta para reconstruir, y al reconectar otro se pone al día', async () => {
    h = await createHarness()
    const { main, copyA, copyB, projectId, id } = await threeDiskProject()
    h.disks.remove(copyB.devicePath)
    h.disks.remove(main.devicePath)
    await h.scan()
    // A change while two disks are away: only copy A learns about it right now
    await h.patch(`/v1/policies/${(await h.get(`/v1/projects/${projectId}`)).body.policies[1].id}`, { paused: true })
    const revision = (await h.get(`/v1/projects/${projectId}`)).body.project.revision
    expect((await descriptorOf(copyA, 'Respaldo')).project.revision).toBe(revision)
    expect((await descriptorOf(copyB, '')).project.revision).toBeLessThan(revision)

    await h.resetDatabase()
    await h.scan()
    const fromOne = (await h.post('/v1/recovery/scan')).body.projects
    expect(fromOne[0]).toMatchObject({ revision, foundOn: [{ folder: 'Respaldo', revision }] })
    expect(fromOne[0].policies[1].paused).toBe(true)
    expect((await h.post('/v1/recovery/import', { projectId })).status).toBe(201)
    const away = (await h.get('/v1/disks')).body.disks.filter((d: any) => !d.connected)
    expect(away.map((d: any) => d.serial).sort()).toEqual(['SER-B', 'SER-MAIN'])

    h.disks.add({ serial: 'SER-B', wwn: null, model: 'Disco copia-b', sizeBytes: 2e12, bus: 'usb', devicePath: copyB.devicePath, mountPath: copyB.mountPath })
    h.disks.add({ serial: 'SER-MAIN', wwn: '5000c500aaaa0001', model: 'Disco principal', sizeBytes: 2e12, bus: 'usb', devicePath: main.devicePath, mountPath: main.mountPath })
    await h.scan()
    expect((await h.get('/v1/disks')).body.disks).toHaveLength(3)
    expect((await descriptorOf(copyB, '')).project.revision).toBe(revision)
    expect((await descriptorOf(main, 'Familia/Fotos')).assignment.id).toBe(id('Fotos'))
    expect(await hashTree(join(main.mountPath, 'Familia'))).toEqual({ 'Documentos/b.pdf': expect.any(String), 'Fotos/2024/a.jpg': expect.any(String) })
  })
})
