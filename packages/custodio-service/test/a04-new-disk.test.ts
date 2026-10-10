import { afterEach, describe, expect, it } from 'vitest'
import { createHarness, type Harness } from './support/harness.js'

let h: Harness
afterEach(async () => h?.close())

describe('discos nuevos', () => {
  it('A4 un disco nuevo aparece sin asignar y emite disk.detected', async () => {
    h = await createHarness()
    const disk = await h.addDisk('nuevo')
    await h.scan()
    const { body } = await h.get('/v1/disks')
    expect(body.disks).toHaveLength(1)
    expect(body.disks[0]).toMatchObject({ state: 'unassigned', assignments: [], connected: true, mountPath: disk.mountPath })
    const detected = h.events('disk.detected')
    expect(detected).toHaveLength(1)
    expect(detected[0]?.payload).toMatchObject({ diskId: body.disks[0].id, serial: 'SN-NUEVO' })
  })

  it('A4 nunca se asigna solo, aunque ya exista un proyecto y se vuelva a escanear', async () => {
    h = await createHarness()
    const fotos = await h.addDisk('fotos')
    await h.scan()
    await h.project('Familia', [{ disk: fotos, folder: 'Fotos', role: 'storage' }])

    const extra = await h.addDisk('extra')
    await h.scan()
    await h.scan()
    const disk = (await h.get(`/v1/disks/${h.diskId(extra)}`)).body
    expect(disk.state).toBe('unassigned')
    expect(h.s.core.store.assignments.byDisk(disk.id)).toHaveLength(0)
    const overview = (await h.get('/v1/overview')).body
    expect(overview.disks.unassigned).toBe(1)
  })
})
