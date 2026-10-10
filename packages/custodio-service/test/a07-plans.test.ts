import { readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createHarness, type Harness, type SimDisk } from './support/harness.js'

let h: Harness
afterEach(async () => h?.close())

// Every file under a disk, without Custodio's own metadata
async function userFiles(disk: SimDisk): Promise<string[]> {
  const entries = await readdir(disk.mountPath, { recursive: true, withFileTypes: true })
  return entries
    .filter((e) => e.isFile())
    .map((e) => `/${relative(disk.mountPath, join(e.parentPath, e.name)).split(sep).join('/')}`)
    .filter((path) => !path.includes('/.diskmanager/'))
    .sort()
}

describe('planes con confirmación', () => {
  it('A7 cambiar un rol devuelve un plan y no cambia nada hasta confirmarlo', async () => {
    h = await createHarness()
    const disk = await h.addDisk('principal')
    await h.scan()
    await h.writeFile(disk, 'Datos/informe.pdf', 'contenido')
    const { projectId, assignments } = await h.project('Trabajo', [{ disk, folder: 'Datos', role: 'storage' }])
    const before = (await h.get(`/v1/projects/${projectId}`)).body

    const proposal = await h.post(`/v1/projects/${projectId}/plans`, { actions: [{ type: 'change_role', assignmentId: assignments[0]?.id, role: 'backup' }] })
    expect(proposal.status).toBe(201)
    const plan = proposal.body.plan
    expect(plan.status).toBe('pending')
    expect(plan.preview).toMatchObject({ movesData: false, deletesData: false, bytesToCopy: 0, filesToDelete: 0 })
    expect(plan.preview.lines).toContain('"Datos" pasará a recibir copias de seguridad.')
    expect((await h.get(`/v1/projects/${projectId}`)).body).toEqual(before)

    const applied = await h.post(`/v1/plans/${plan.id}/confirm`, { confirm: true })
    expect(applied.status).toBe(200)
    expect(applied.body.plan).toMatchObject({ status: 'confirmed', decidedBy: 'tester' })
    expect((await h.get(`/v1/projects/${projectId}`)).body.assignments[0].role).toBe('backup')
    expect(await userFiles(disk)).toEqual(['/Datos/informe.pdf'])
  })

  it('A7 agregar un disco no mueve datos: ni al proponer ni al confirmar', async () => {
    h = await createHarness()
    const main = await h.addDisk('principal')
    const extra = await h.addDisk('extra')
    await h.scan()
    await h.writeFile(main, 'Fotos/a.jpg', 'a')
    await h.writeFile(main, 'Fotos/b.jpg', 'b')
    const { projectId } = await h.project('Fotos', [{ disk: main, folder: 'Fotos', role: 'storage' }])
    const mainBefore = await userFiles(main)

    const proposal = await h.post(`/v1/projects/${projectId}/plans`, {
      actions: [{ type: 'add_assignment', diskId: h.diskId(extra), folder: 'Copia', role: 'backup' }]
    })
    expect(proposal.body.plan.preview.movesData).toBe(false)
    expect(proposal.body.topology.warnings).toContainEqual(expect.objectContaining({ code: 'no_source', message: 'sin origen' }))
    await h.post(`/v1/plans/${proposal.body.plan.id}/confirm`, { confirm: true })

    expect(await userFiles(main)).toEqual(mainBefore)
    expect(await userFiles(extra)).toEqual([])
    expect(h.s.core.store.jobs.list({ kind: 'backup' })).toEqual([])
  })

  it('A7 confirmar exige confirm: true y un plan vigente', async () => {
    h = await createHarness()
    const disk = await h.addDisk('principal')
    await h.scan()
    const project = await h.post('/v1/projects', { name: 'Uno' })
    const proposal = await h.post(`/v1/projects/${project.body.project.id}/plans`, {
      actions: [{ type: 'add_assignment', diskId: h.diskId(disk), folder: 'A', role: 'storage' }]
    })
    const planId = proposal.body.plan.id

    const refused = await h.post(`/v1/plans/${planId}/confirm`, { confirm: false })
    expect(refused.status).toBe(422)
    expect(refused.body.error.code).toBe('confirmation_required')
    expect((await h.get(`/v1/plans/${planId}`)).body.status).toBe('pending')

    h.clock.advance(31 * 60 * 1000)
    const late = await h.post(`/v1/plans/${planId}/confirm`, { confirm: true })
    expect(late.status).toBe(409)
    expect(late.body.error.code).toBe('plan_not_pending')
    expect((await h.get(`/v1/plans/${planId}`)).body.status).toBe('expired')
    expect((await h.get(`/v1/projects/${project.body.project.id}`)).body.assignments).toEqual([])
  })
})
