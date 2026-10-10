import { afterEach, describe, expect, it } from 'vitest'
import { identityKeyOf } from '../src/core/inventory-health/inventory.js'
import { createHarness, type Harness } from './support/harness.js'

let h: Harness
afterEach(async () => h?.close())

describe('identidad de discos', () => {
  it('A1 un disco conserva su id aunque cambie la letra de unidad entre lecturas', async () => {
    h = await createHarness()
    const disk = await h.addDisk('fotos', { serial: 'WD-ABC123' })
    await h.scan()
    const before = await h.get('/v1/disks')
    expect(before.body.disks).toHaveLength(1)
    const id = before.body.disks[0].id as string

    h.disks.update(disk.devicePath, { mountPath: 'F:\\', devicePath: '/dev/sim99' })
    await h.scan()
    const after = await h.get(`/v1/disks/${id}`)
    expect(after.status).toBe(200)
    expect(after.body.id).toBe(id)
    expect(after.body.mountPath).toBe('F:\\')
    expect((await h.get('/v1/disks')).body.disks).toHaveLength(1)
    expect(h.events('disk.detected')).toHaveLength(1)
  })

  it('A1 la identidad sale del WWN y, si no hay, del número de serie; nunca de la letra', () => {
    expect(identityKeyOf({ wwn: '0x5000C500A1B2C3D4', serial: 'X', devicePath: '/dev/pd1' })).toBe('wwn:5000c500a1b2c3d4')
    expect(identityKeyOf({ wwn: null, serial: '  wd-abc123 ', devicePath: '/dev/pd1' })).toBe('serial:WD-ABC123')
    expect(identityKeyOf({ wwn: '0000000000000000', serial: 'S1', devicePath: '/dev/pd2' })).toBe('serial:S1')
  })

  it('A1 reconoce el mismo disco por WWN aunque llegue por otro adaptador USB y otra letra', async () => {
    h = await createHarness()
    const disk = await h.addDisk('copias', { serial: 'BRIDGE-1', wwn: '5000c500a1b2c3d4' })
    await h.scan()
    const id = h.diskId(disk)
    h.disks.update(disk.devicePath, { serial: 'OTHER-BRIDGE', mountPath: 'G:\\' })
    await h.scan()
    const disks = (await h.get('/v1/disks')).body.disks
    expect(disks).toHaveLength(1)
    expect(disks[0].id).toBe(id)
    expect(disks[0].mountPath).toBe('G:\\')
  })
})
