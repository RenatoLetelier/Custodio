import { readFile, stat, utimes, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { FileSystemPort } from '../src/core/ports/system.js'
import type { Job } from '../src/core/shared/model.js'
import { listFiles } from './support/backup.js'
import { createHarness, type Harness, type SimDisk } from './support/harness.js'

let h: Harness
afterEach(async () => h?.close())

const DAILY = { cron: '0 3 * * *', timezone: 'America/Santiago' }

// LocalCloud's disk and two backup disks, like the N100: D: keeps lc/prod and the photos, E: and F: keep copies
async function disks() {
  const datos = await h.addDisk('datos')
  const uno = await h.addDisk('uno')
  const dos = await h.addDisk('dos')
  await h.scan()
  await h.writeFile(datos, 'lc/prod/blobs/aa/bb/aabb01', 'un blob')
  await h.writeFile(datos, 'lc/prod/derived/lp/t1/master.m3u8', '#EXTM3U')
  await h.writeFile(datos, 'LocalProcessor-Photos/2024/foto.jpg', 'una foto')
  await h.writeFile(datos, 'otra/cosa.txt', 'fuera del proyecto')
  return { datos, uno, dos }
}

const setupBody = (d: { datos: SimDisk; uno: SimDisk; dos?: SimDisk }, extra: Record<string, unknown> = {}) => ({
  name: 'Localcloud',
  sources: [
    { diskId: h.diskId(d.datos), folder: '\\lc\\prod' },
    { diskId: h.diskId(d.datos), folder: 'LocalProcessor-Photos' }
  ],
  destinations: [h.diskId(d.uno), ...(d.dos ? [h.diskId(d.dos)] : [])],
  schedule: DAILY,
  ...extra
})

async function confirmSetup(body: unknown): Promise<string> {
  const proposal = await h.post('/v1/setups', body)
  expect(proposal.status).toBe(201)
  const confirmed = await h.post(`/v1/plans/${proposal.body.plan.id}/confirm`, { confirm: true })
  expect(confirmed.status).toBe(200)
  return confirmed.body.result.projectId as string
}

const policyOf = async (projectId: string) => (await h.get(`/v1/projects/${projectId}`)).body.policies[0]

describe('proyectos completos', () => {
  it('A7 configurar un proyecto completo devuelve un plan en palabras simples y no cambia nada hasta confirmarlo', async () => {
    h = await createHarness()
    const d = await disks()
    const proposal = await h.post('/v1/setups', setupBody(d))
    expect(proposal.status).toBe(201)
    expect(proposal.body.plan).toMatchObject({ kind: 'setup', status: 'pending', projectId: null })
    const lines: string[] = proposal.body.plan.preview.lines
    expect(lines[0]).toBe(`Se respaldará ${join(d.datos.mountPath, 'lc', 'prod')} en ${join(d.uno.mountPath, 'lc', 'prod')} y ${join(d.dos.mountPath, 'lc', 'prod')}.`)
    expect(lines).toContain('Ahora no se moverá ni se borrará ningún archivo.')
    expect((await h.get('/v1/projects')).body.projects).toEqual([])

    const projectId = (await h.post(`/v1/plans/${proposal.body.plan.id}/confirm`, { confirm: true })).body.result.projectId
    const view = (await h.get(`/v1/projects/${projectId}`)).body
    expect(view.project.name).toBe('Localcloud')
    const sources = view.assignments.filter((a: any) => a.role === 'storage')
    expect(sources.map((a: any) => a.folder)).toEqual(['lc/prod', 'LocalProcessor-Photos'])
    const backups = view.assignments.filter((a: any) => a.role === 'backup')
    expect(backups).toHaveLength(4)
    for (const backup of backups) expect(backup.folder).toBe(sources.find((s: any) => s.id === backup.mirrorOf).folder)
    expect(backups.map((a: any) => a.label).sort()).toEqual(['Copia de LocalProcessor-Photos', 'Copia de LocalProcessor-Photos 2', 'Copia de prod', 'Copia de prod 2'])
    expect(view.policies).toEqual([expect.objectContaining({ cron: '0 3 * * *', sources: sources.map((a: any) => a.id), destinations: backups.map((a: any) => a.id) })])
  })

  it('A9 cada carpeta se copia con la misma ruta en cada disco de respaldo, y lo que no está en el proyecto no se copia', async () => {
    h = await createHarness()
    const d = await disks()
    const projectId = await confirmSetup(setupBody(d))
    const run = await h.run((await policyOf(projectId)).id)
    expect(run.status).toBe('succeeded')
    for (const disk of [d.uno, d.dos]) {
      expect(await listFiles(disk.mountPath)).toEqual(['LocalProcessor-Photos/2024/foto.jpg', 'lc/prod/blobs/aa/bb/aabb01', 'lc/prod/derived/lp/t1/master.m3u8'])
      expect(await readFile(join(disk.mountPath, 'lc', 'prod', 'blobs', 'aa', 'bb', 'aabb01'), 'utf8')).toBe('un blob')
    }
    const folder = join(d.datos.mountPath, 'lc', 'prod', 'derived', 'lp', 't1')
    const status = (await h.get(`/v1/backups/status?path=${encodeURIComponent(folder)}`)).body
    expect(status).toMatchObject({ files: 1, backedUp: true })
    expect(status.destinations.map((x: any) => x.complete)).toEqual([true, true])
  })

  it('A9 lo que ya está en el disco de respaldo con el mismo contenido se reconoce sin copiarlo, y lo distinto se vuelve a copiar', async () => {
    h = await createHarness()
    const d = await disks()
    await h.writeFile(d.datos, 'lc/prod/blobs/aa/bb/aabb02', 'otro blob')
    // An older copy made by other means, at the same paths and with the same dates
    const same = join(d.uno.mountPath, 'lc', 'prod', 'blobs', 'aa', 'bb', 'aabb01')
    const damaged = join(d.uno.mountPath, 'lc', 'prod', 'blobs', 'aa', 'bb', 'aabb02')
    await mkdir(dirname(same), { recursive: true })
    await writeFile(same, 'un blob')
    await writeFile(damaged, 'otro bloX')
    for (const [copy, rel] of [
      [same, 'lc/prod/blobs/aa/bb/aabb01'],
      [damaged, 'lc/prod/blobs/aa/bb/aabb02']
    ] as const) {
      const source = await stat(h.path(d.datos, rel))
      await utimes(copy, source.atime, source.mtime)
    }

    const projectId = await confirmSetup({ ...setupBody({ datos: d.datos, uno: d.uno }), sources: [{ diskId: h.diskId(d.datos), folder: 'lc/prod/blobs' }] })
    const run = await h.run((await policyOf(projectId)).id)
    expect(run.status).toBe('succeeded')
    expect(run.result).toMatchObject({ filesCopied: 1, filesUpToDate: 1 })
    expect(await readFile(damaged, 'utf8')).toBe('otro blob')
  })

  it('A9 comparar una réplica anterior muestra su avance, lee ambos discos a la vez y se puede cancelar a mitad sin perder lo ya comparado', async () => {
    let jobId = ''
    let cancelAt = 3
    let destinationReads = 0
    let reading = 0
    let together = 0
    h = await createHarness({
      fs: (inner) => {
        const fs = Object.create(inner) as FileSystemPort
        fs.openRead = async function* (path) {
          reading++
          together = Math.max(together, reading)
          try {
            if (path.startsWith(d.uno.mountPath) && ++destinationReads === cancelAt) h.s.runner.cancel(jobId, 'tester')
            yield* inner.openRead(path)
          } finally {
            reading--
          }
        }
        return fs
      }
    })
    const d = await disks()
    // LocalCloud's earlier replica in E:\lc\prod: every file with its date, nothing left to copy
    const files = ['lc/prod/blobs/aa/bb/aabb01', 'lc/prod/derived/lp/t1/master.m3u8', ...Array.from({ length: 4 }, (_, i) => `lc/prod/blobs/cc/blob${i}`)]
    for (const rel of files.slice(2)) await h.writeFile(d.datos, rel, Buffer.alloc(600_000, rel))
    for (const rel of files) {
      const copy = join(d.uno.mountPath, ...rel.split('/'))
      await mkdir(dirname(copy), { recursive: true })
      await writeFile(copy, await readFile(h.path(d.datos, rel)))
      const source = await stat(h.path(d.datos, rel))
      await utimes(copy, source.atime, source.mtime)
    }
    const projectId = await confirmSetup({ ...setupBody({ datos: d.datos, uno: d.uno }), sources: [{ diskId: h.diskId(d.datos), folder: 'lc/prod' }] })
    const policy = await policyOf(projectId)
    const updates: Job[] = []
    h.s.runner.onUpdate((job) => updates.push(job))

    jobId = h.s.runner.startBackup(policy.id, { actor: 'tester' }).id
    expect((await h.s.runner.settled(jobId)).status).toBe('cancelled')
    expect(together).toBe(2)
    const copyId = h.s.core.store.assignments.list().find((a) => a.diskId === h.diskId(d.uno))?.id as string
    const compared = h.s.core.store.manifest.list(copyId).map((m) => m.relPath)
    expect(compared).toHaveLength(2)
    // The job is announced before it starts, without a phase
    const phases = updates.filter((u) => u.id === jobId && u.progress.phase).map((u) => u.progress.phase)
    expect(phases[0]).toBe('scanning')
    expect(phases).toContain('checking')
    expect(phases).not.toContain('copying')

    cancelAt = 0
    const resumed = await h.run(policy.id)
    expect(resumed.status).toBe('succeeded')
    expect(resumed.result).toMatchObject({ filesCopied: 0, filesUpToDate: files.length })
    const seen = updates.filter((u) => u.id === resumed.id && u.progress.phase).map((u) => u.progress)
    expect([...new Set(seen.map((p) => p.phase))]).toEqual(['scanning', 'checking', 'copying'])
    // Only what was not compared before the cancel is read again
    const checked = seen.filter((p) => p.phase === 'checking')
    let pending = 0
    for (const rel of files.filter((f) => !compared.includes(f.slice('lc/prod/'.length)))) pending += (await stat(h.path(d.datos, rel))).size
    expect(checked[0]).toMatchObject({ filesDone: 0, filesTotal: files.length - 2, bytesDone: 0, bytesTotal: pending })
    expect(checked.at(-1)).toMatchObject({ filesDone: files.length - 2, bytesDone: pending })
  })

  it('A6 una carpeta no puede cruzarse con otra de otro proyecto en el mismo disco, ni copiarse en su mismo disco', async () => {
    h = await createHarness()
    const d = await disks()
    await confirmSetup({ ...setupBody(d), name: 'Todo el disco', sources: [{ diskId: h.diskId(d.datos), folder: '' }] })

    const inside = await h.post('/v1/setups', { ...setupBody(d), name: 'Otro', sources: [{ diskId: h.diskId(d.datos), folder: 'otra' }] })
    expect(inside.status).toBe(409)
    expect(inside.body.error.message).toContain('se cruza con')
    expect(inside.body.error.message).toContain('"Todo el disco"')

    const libre = await h.addDisk('libre')
    await h.scan()
    const sameDisk = await h.post('/v1/setups', { ...setupBody(d), name: 'Otro', sources: [{ diskId: h.diskId(libre), folder: '' }], destinations: [h.diskId(libre)] })
    expect(sameDisk.status).toBe(422)
    expect(sameDisk.body.error.code).toBe('topology_invalid')
    expect(sameDisk.body.error.details.errors.map((e: any) => e.code)).toContain('same_disk')
    const missing = await h.post('/v1/setups', { ...setupBody(d), name: 'Otro', sources: [{ diskId: h.diskId(libre), folder: 'no-existe' }], destinations: [h.diskId(d.uno)] })
    expect(missing.status).toBe(400)
    expect(missing.body.error.message).toContain('no existe')
  })

  it('A5 editar un proyecto conserva lo que no cambió: lo ya copiado no se vuelve a copiar', async () => {
    h = await createHarness()
    const d = await disks()
    const projectId = await confirmSetup(setupBody({ datos: d.datos, uno: d.uno }))
    const first = await h.run((await policyOf(projectId)).id)
    expect(first.result).toMatchObject({ filesCopied: 3 })

    // Without the photos, a second backup disk and a weekly schedule
    await confirmSetup({ ...setupBody(d), projectId, name: 'Localcloud prod', sources: [{ diskId: h.diskId(d.datos), folder: 'lc/prod' }], schedule: { cron: '0 2 * * 1,3,5', timezone: DAILY.timezone } })
    const view = (await h.get(`/v1/projects/${projectId}`)).body
    expect(view.project.name).toBe('Localcloud prod')
    expect(view.assignments.map((a: any) => [a.role, a.folder])).toEqual([
      ['storage', 'lc/prod'],
      ['backup', 'lc/prod'],
      ['backup', 'lc/prod']
    ])
    const policy = await policyOf(projectId)
    expect(policy.cron).toBe('0 2 * * 1,3,5')
    const second = await h.run(policy.id)
    expect(second.result).toMatchObject({ filesCopied: 2, filesUpToDate: 2 })
    // The photos already copied stay where they were
    expect(await readFile(join(d.uno.mountPath, 'LocalProcessor-Photos', '2024', 'foto.jpg'), 'utf8')).toBe('una foto')
  })

  it('A17 un proyecto con copias de la misma ruta se reconstruye desde los discos y sigue sin copiar de nuevo', async () => {
    h = await createHarness()
    const d = await disks()
    const projectId = await confirmSetup(setupBody(d))
    await h.run((await policyOf(projectId)).id)
    const original = (await h.get(`/v1/projects/${projectId}`)).body

    await h.resetDatabase()
    await h.scan()
    expect((await h.post('/v1/recovery/import', { projectId })).status).toBe(201)
    const recovered = (await h.get(`/v1/projects/${projectId}`)).body
    expect(recovered.assignments.map((a: any) => [a.id, a.folder, a.role, a.mirrorOf])).toEqual(original.assignments.map((a: any) => [a.id, a.folder, a.role, a.mirrorOf]))
    const run = await h.run((await policyOf(projectId)).id)
    expect(run.result).toMatchObject({ filesCopied: 0, filesUpToDate: 6 })
  })

  it('A18 eliminar un proyecto pide confirmación y no borra ningún archivo: ni los originales ni las copias', async () => {
    h = await createHarness()
    const d = await disks()
    const projectId = await confirmSetup(setupBody(d))
    await h.run((await policyOf(projectId)).id)
    const before = { datos: await listFiles(d.datos.mountPath), uno: await listFiles(d.uno.mountPath) }

    const proposal = await h.post(`/v1/projects/${projectId}/removals`)
    expect(proposal.status).toBe(201)
    expect(proposal.body.plan.preview.lines).toContain('No se borra ningún archivo: los originales y las copias se quedan donde están.')
    expect((await h.get(`/v1/projects/${projectId}`)).status).toBe(200)

    await h.post(`/v1/plans/${proposal.body.plan.id}/confirm`, { confirm: true })
    expect((await h.get(`/v1/projects/${projectId}`)).status).toBe(404)
    expect((await h.get('/v1/projects')).body.projects).toEqual([])
    expect(await listFiles(d.datos.mountPath)).toEqual(before.datos)
    expect(await listFiles(d.uno.mountPath)).toEqual(before.uno)
    const disksNow = (await h.get('/v1/disks')).body.disks
    expect(disksNow.every((x: any) => x.state === 'unassigned')).toBe(true)
  })
})
