import { afterEach, describe, expect, it } from 'vitest'
import { GB } from '../src/adapters/sim/devices.js'
import { validateTopology, type TopologyPolicy } from '../src/core/allocation/topology.js'
import type { Assignment, Role } from '../src/core/shared/model.js'
import { createHarness, type Harness } from './support/harness.js'

let h: Harness
afterEach(async () => h?.close())

const at = '2026-10-01T00:00:00.000Z'
const assignment = (id: string, diskId: string, role: Role, folder = id): Assignment => ({ id, projectId: 'p', diskId, folder, role, label: id, createdAt: at })
const policy = (id: string, sources: string[], destinations: string[]): TopologyPolicy => ({ id, name: id, sources, destinations })
const disks = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6'].map((id) => ({ id, model: id }))
const codes = (result: ReturnType<typeof validateTopology>) => result.errors.map((e) => e.code)

describe('topologías', () => {
  it('A6 acepta 1→1, 1→2, 1→3, 2→2 y N→M', () => {
    const s = (n: number) => assignment(`s${n}`, `d${n}`, 'storage')
    const b = (n: number) => assignment(`b${n}`, `d${n + 3}`, 'backup')
    const cases: [string, Assignment[], TopologyPolicy[]][] = [
      ['1→1', [s(1), b(1)], [policy('p', ['s1'], ['b1'])]],
      ['1→2', [s(1), b(1), b(2)], [policy('p', ['s1'], ['b1', 'b2'])]],
      ['1→3', [s(1), b(1), b(2), b(3)], [policy('p', ['s1'], ['b1', 'b2', 'b3'])]],
      ['2→2', [s(1), s(2), b(1), b(2)], [policy('p', ['s1', 's2'], ['b1', 'b2'])]],
      ['N→M', [s(1), s(2), s(3), b(1), b(2)], [policy('p', ['s1', 's2', 's3'], ['b1', 'b2']), policy('q', ['s1'], ['b2'])]]
    ]
    for (const [name, assignments, policies] of cases) {
      const result = validateTopology({ assignments, policies, disks })
      expect(result.errors, name).toEqual([])
      expect(result.valid, name).toBe(true)
    }
  })

  it('A6 rechaza origen y destino en el mismo disco físico', () => {
    const result = validateTopology({
      assignments: [assignment('fotos', 'd1', 'storage', 'Fotos'), assignment('copia', 'd1', 'backup', 'Copia')],
      policies: [policy('p', ['fotos'], ['copia'])],
      disks
    })
    expect(codes(result)).toEqual(['same_disk'])
  })

  it('A6 rechaza un destino sin capacidad para la suma de sus orígenes', () => {
    const assignments = [assignment('a', 'd1', 'storage'), assignment('b', 'd2', 'storage'), assignment('c', 'd3', 'backup')]
    const sizes = {
      sourceBytes: new Map([
        ['a', 300 * GB],
        ['b', 300 * GB]
      ]),
      destinationCapacity: new Map([['c', 500 * GB]])
    }
    expect(codes(validateTopology({ assignments, policies: [policy('p', ['a', 'b'], ['c'])], disks, sizes }))).toEqual(['insufficient_capacity'])
    expect(validateTopology({ assignments, policies: [policy('p', ['a'], ['c'])], disks, sizes }).valid).toBe(true)
  })

  it('A6 rechaza un origen sin rol almacenamiento y un destino sin rol respaldo', () => {
    const result = validateTopology({
      assignments: [assignment('x', 'd1', 'backup'), assignment('y', 'd2', 'storage')],
      policies: [policy('p', ['x'], ['y'])],
      disks
    })
    expect(codes(result)).toEqual(expect.arrayContaining(['source_not_storage', 'destination_not_backup']))
  })

  it('A6 rechaza cadenas (copia de una copia) y ciclos', () => {
    const chain = validateTopology({
      assignments: [assignment('a', 'd1', 'storage'), assignment('b', 'd2', 'backup'), assignment('c', 'd3', 'backup')],
      policies: [policy('p1', ['a'], ['b']), policy('p2', ['b'], ['c'])],
      disks
    })
    expect(codes(chain)).toContain('chain')
    expect(codes(chain)).not.toContain('cycle')

    const cycle = validateTopology({
      assignments: [assignment('a', 'd1', 'storage'), assignment('b', 'd2', 'backup')],
      policies: [policy('p1', ['a'], ['b']), policy('p2', ['b'], ['a'])],
      disks
    })
    expect(codes(cycle)).toEqual(expect.arrayContaining(['chain', 'cycle']))
    expect(cycle.errors.find((e) => e.code === 'cycle')?.message).toContain('a → b → a')
  })

  it('A6 un disco con rol respaldo y sin política muestra el aviso "sin origen"', () => {
    const result = validateTopology({
      assignments: [assignment('a', 'd1', 'storage'), assignment('b', 'd2', 'backup'), assignment('huerfano', 'd3', 'backup')],
      policies: [policy('p', ['a'], ['b'])],
      disks
    })
    expect(result.valid).toBe(true)
    expect(result.warnings).toEqual([{ code: 'no_source', assignmentId: 'huerfano', message: 'sin origen' }])
  })

  it('A6 la API rechaza copias inválidas con 422 y muestra "sin origen" en el proyecto', async () => {
    h = await createHarness()
    const one = await h.addDisk('uno')
    const two = await h.addDisk('dos', { totalBytes: 2 * GB, freeBytes: GB })
    await h.scan()
    await h.writeFile(one, 'Fotos/grande.bin', Buffer.alloc(2048))
    const { projectId, assignments } = await h.project('Familia', [
      { disk: one, folder: 'Fotos', role: 'storage' },
      { disk: one, folder: 'Copia local', role: 'backup' },
      { disk: two, folder: 'Copia', role: 'backup' }
    ])
    const id = (label: string) => assignments.find((a) => a.label === label)?.id as string

    const view = (await h.get(`/v1/projects/${projectId}`)).body
    expect(view.topology.warnings.filter((w: any) => w.code === 'no_source').map((w: any) => w.message)).toEqual(['sin origen', 'sin origen'])

    const sameDisk = await h.post(`/v1/projects/${projectId}/policies`, { name: 'Mal', sources: [id('Fotos')], destinations: [id('Copia local')], cron: '0 3 * * *', timezone: 'UTC' })
    expect(sameDisk.status).toBe(422)
    expect(sameDisk.body.error.code).toBe('topology_invalid')
    expect(sameDisk.body.error.details.errors.map((e: any) => e.code)).toEqual(['same_disk'])

    h.volumes.set(two.mountPath, { totalBytes: 2 * GB, freeBytes: 1000 })
    const tooSmall = await h.post(`/v1/projects/${projectId}/policies`, { name: 'Chica', sources: [id('Fotos')], destinations: [id('Copia')], cron: '0 3 * * *', timezone: 'UTC' })
    expect(tooSmall.status).toBe(422)
    expect(tooSmall.body.error.details.errors.map((e: any) => e.code)).toEqual(['insufficient_capacity'])

    h.volumes.set(two.mountPath, { totalBytes: 2 * GB, freeBytes: GB })
    const good = await h.post(`/v1/projects/${projectId}/policies`, { name: 'Bien', sources: [id('Fotos')], destinations: [id('Copia')], cron: '0 3 * * *', timezone: 'UTC' })
    expect(good.status).toBe(201)
    const topology = (await h.get(`/v1/projects/${projectId}/topology`)).body
    expect(topology.valid).toBe(true)
    expect(topology.warnings).toEqual([{ code: 'no_source', assignmentId: id('Copia local'), message: 'sin origen' }])
  })
})
