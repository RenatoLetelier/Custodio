import { afterEach, describe, expect, it } from 'vitest'
import { createHarness, type Harness } from './support/harness.js'

let h: Harness
afterEach(async () => h?.close())

describe('proyectos', () => {
  it('A5 un proyecto asigna carpeta y rol a cada disco y todo persiste tras reiniciar el servicio', async () => {
    h = await createHarness()
    const main = await h.addDisk('principal')
    const copy = await h.addDisk('copia')
    await h.scan()

    const created = await h.post('/v1/projects', { name: 'Familia' })
    expect(created.status).toBe(201)
    const projectId = created.body.project.id as string

    const proposal = await h.post(`/v1/projects/${projectId}/plans`, {
      actions: [
        { type: 'add_assignment', diskId: h.diskId(main), folder: 'Fotos', role: 'storage' },
        { type: 'add_assignment', diskId: h.diskId(copy), folder: 'Copias/Fotos', role: 'backup', label: 'Copia de fotos' }
      ]
    })
    expect(proposal.status).toBe(201)
    expect((await h.post(`/v1/plans/${proposal.body.plan.id}/confirm`, { confirm: true })).status).toBe(200)

    const view = (await h.get(`/v1/projects/${projectId}`)).body
    const storage = view.assignments.find((a: any) => a.role === 'storage')
    const backup = view.assignments.find((a: any) => a.role === 'backup')
    expect(storage).toMatchObject({ diskId: h.diskId(main), folder: 'Fotos', label: 'Fotos' })
    expect(backup).toMatchObject({ diskId: h.diskId(copy), folder: 'Copias/Fotos', label: 'Copia de fotos' })
    const policy = await h.post(`/v1/projects/${projectId}/policies`, {
      name: 'Fotos cada noche',
      sources: [storage.id],
      destinations: [backup.id],
      cron: '0 3 * * *',
      timezone: 'America/Santiago'
    })
    expect(policy.status).toBe(201)

    await h.restart()

    const again = (await h.get(`/v1/projects/${projectId}`)).body
    expect(again.project).toEqual({ ...view.project, revision: view.project.revision + 1 })
    expect(again.assignments).toEqual(view.assignments)
    expect(again.policies).toHaveLength(1)
    expect(again.policies[0]).toMatchObject({ id: policy.body.id, name: 'Fotos cada noche', cron: '0 3 * * *', timezone: 'America/Santiago' })
    expect((await h.get(`/v1/disks/${h.diskId(main)}`)).body.state).toBe('assigned')
    expect((await h.get('/v1/projects')).body.projects).toHaveLength(1)
  })

  it('A5 una carpeta de un disco no puede asignarse dos veces', async () => {
    h = await createHarness()
    const disk = await h.addDisk('principal')
    await h.scan()
    await h.project('Uno', [{ disk, folder: 'Datos', role: 'storage' }])
    const other = await h.post('/v1/projects', { name: 'Dos' })
    const clash = await h.post(`/v1/projects/${other.body.project.id}/plans`, {
      actions: [{ type: 'add_assignment', diskId: h.diskId(disk), folder: 'Datos', role: 'storage' }]
    })
    expect(clash.status).toBe(409)
    expect(clash.body.error.code).toBe('conflict')
  })
})
