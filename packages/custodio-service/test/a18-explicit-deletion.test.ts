import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Assignment } from '../src/core/shared/model.js'
import { createHarness, type Harness } from './support/harness.js'

let h: Harness
afterEach(async () => h?.close())

async function twoCopies() {
  const main = await h.addDisk('principal')
  const copyA = await h.addDisk('copia-a')
  const copyB = await h.addDisk('copia-b')
  await h.scan()
  await h.writeFile(main, 'Fotos/viaje/a.jpg', 'a')
  await h.writeFile(main, 'Fotos/viaje/b.jpg', 'b')
  await h.writeFile(main, 'Fotos/c.jpg', 'c')
  const { projectId, assignments } = await h.project('Familia', [
    { disk: main, folder: 'Fotos', role: 'storage' },
    { disk: copyA, folder: 'Copia', role: 'backup', label: 'Copia A' },
    { disk: copyB, folder: 'Copia', role: 'backup', label: 'Copia B' }
  ])
  const byLabel = (label: string) => assignments.find((a) => a.label === label) as Assignment
  const policy = await h.policy(projectId, { sources: [byLabel('Fotos').id], destinations: [byLabel('Copia A').id, byLabel('Copia B').id] })
  await h.run(policy.id)
  const copyPath = (disk: typeof copyA, rel: string) => join(disk.mountPath, 'Copia', 'Fotos', ...rel.split('/'))
  return { main, copyA, copyB, projectId, policy, source: byLabel('Fotos'), copyPath }
}

describe('borrado explícito', () => {
  it('A18 la orden de borrado se aplica a todas las copias y nunca toca el origen', async () => {
    h = await createHarness()
    const { main, copyA, copyB, projectId, policy, source, copyPath } = await twoCopies()

    const plan = await h.post(`/v1/projects/${projectId}/deletions`, { items: [{ sourceId: source.id, path: 'viaje' }, { sourceId: source.id, path: 'c.jpg' }] })
    expect(plan.status).toBe(201)
    expect(plan.body.preview.lines).toContain('Los archivos originales no se tocan.')
    expect(existsSync(copyPath(copyA, 'c.jpg'))).toBe(true)

    const confirmed = await h.post(`/v1/plans/${plan.body.id}/confirm`, { confirm: true })
    expect(confirmed.body.result.order).toMatchObject({ status: 'completed', requestedBy: 'tester' })
    for (const disk of [copyA, copyB]) {
      expect(existsSync(copyPath(disk, 'viaje/a.jpg'))).toBe(false)
      expect(existsSync(copyPath(disk, 'viaje'))).toBe(false)
      expect(existsSync(copyPath(disk, 'c.jpg'))).toBe(false)
    }
    expect(await readFile(join(main.mountPath, 'Fotos', 'viaje', 'a.jpg'), 'utf8')).toBe('a')
    expect(await readFile(join(main.mountPath, 'Fotos', 'c.jpg'), 'utf8')).toBe('c')
    expect(h.s.core.store.manifest.list(confirmed.body.result.order.targets[0].destinationId)).toHaveLength(0)

    // The next backup does not bring them back while the originals stay unchanged
    const next = await h.run(policy.id)
    expect(next.result).toMatchObject({ filesCopied: 0 })
    expect(next.result?.skipped).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'c.jpg', reason: 'deleted_by_order' })]))
    expect(existsSync(copyPath(copyA, 'c.jpg'))).toBe(false)
  })

  it('A18 si un disco está desconectado la orden queda pendiente y se reintenta hasta confirmarse', async () => {
    h = await createHarness()
    const { copyA, copyB, projectId, source, copyPath } = await twoCopies()
    h.disks.remove(copyB.devicePath)
    await h.scan()

    const plan = await h.post(`/v1/projects/${projectId}/deletions`, { items: [{ sourceId: source.id, path: 'c.jpg' }] })
    expect(plan.body.preview.lines).toContain('"Copia B" está desconectado: se borrará cuando lo vuelvas a conectar.')
    const order = (await h.post(`/v1/plans/${plan.body.id}/confirm`, { confirm: true })).body.result.order
    expect(order.status).toBe('pending')
    const target = (label: string) => order.targets.find((t: any) => t.destinationId === h.s.core.store.assignments.byProject(projectId).find((a) => a.label === label)?.id)
    expect(target('Copia A')).toMatchObject({ status: 'done', attempts: 1 })
    expect(target('Copia B')).toMatchObject({ status: 'pending', attempts: 1, lastError: 'disk_disconnected' })
    expect(existsSync(copyPath(copyA, 'c.jpg'))).toBe(false)

    await h.s.scheduler.tick()
    const stillPending = (await h.get(`/v1/projects/${projectId}/deletions`)).body.orders[0]
    expect(stillPending.status).toBe('pending')
    expect(stillPending.targets.find((t: any) => t.status === 'pending').attempts).toBe(2)
    expect(existsSync(copyPath(copyB, 'c.jpg'))).toBe(true)

    h.disks.add({ serial: copyB.serial, wwn: null, model: 'Disco copia-b', sizeBytes: 2e12, bus: 'usb', devicePath: copyB.devicePath, mountPath: copyB.mountPath })
    await h.scan()
    const done = (await h.get(`/v1/projects/${projectId}/deletions`)).body.orders[0]
    expect(done.status).toBe('completed')
    expect(done.targets.every((t: any) => t.status === 'done')).toBe(true)
    expect(existsSync(copyPath(copyB, 'c.jpg'))).toBe(false)
  })

  it('A18 la orden y cada borrado quedan en la auditoría', async () => {
    h = await createHarness()
    const { projectId, source } = await twoCopies()
    const plan = await h.post(`/v1/projects/${projectId}/deletions`, { items: [{ sourceId: source.id, path: 'c.jpg' }] })
    const order = (await h.post(`/v1/plans/${plan.body.id}/confirm`, { confirm: true })).body.result.order
    const entries = (await h.get('/v1/audit?limit=500')).body.entries
    expect(entries.find((e: any) => e.action === 'deletion.ordered')).toMatchObject({ actor: 'tester', target: order.id, details: { items: [{ sourceId: source.id, path: 'c.jpg' }] } })
    expect(entries.filter((e: any) => e.action === 'deletion.applied')).toHaveLength(2)
    expect(entries.find((e: any) => e.action === 'plan.confirmed' && e.target === plan.body.id)?.actor).toBe('tester')
  })

  it('A18 nunca borra en el origen: una carpeta de origen no puede ser destino de una orden', async () => {
    h = await createHarness()
    const { projectId, source } = await twoCopies()
    const refused = await h.post(`/v1/projects/${projectId}/deletions`, { items: [{ sourceId: source.id, path: 'c.jpg' }], destinations: [source.id] })
    expect(refused.status).toBe(422)
    expect(refused.body.error.code).toBe('source_protected')
    const escape = await h.post(`/v1/projects/${projectId}/deletions`, { items: [{ sourceId: source.id, path: '../../principal/Fotos/c.jpg' }] })
    expect(escape.status).toBe(400)
    expect(escape.body.error.code).toBe('invalid_path')
  })
})
