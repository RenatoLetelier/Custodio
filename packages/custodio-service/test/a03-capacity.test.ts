import { afterEach, describe, expect, it } from 'vitest'
import { GB, TB } from '../src/adapters/sim/devices.js'
import { daysUntilFull, summarizeCapacity } from '../src/core/inventory-health/capacity.js'
import { createHarness, DAY, type Harness } from './support/harness.js'

let h: Harness
afterEach(async () => h?.close())

const reading = (day: number, usedBytes: number, totalBytes = TB) => ({ diskId: 'd', at: new Date(Date.UTC(2026, 9, 1) + day * DAY).toISOString(), totalBytes, usedBytes })

describe('capacidad', () => {
  it('A3 calcula usado, libre y días hasta llenarse con una tendencia lineal', () => {
    const readings = Array.from({ length: 10 }, (_, day) => reading(day, 410 * GB + day * 10 * GB))
    const summary = summarizeCapacity(readings)
    expect(summary).toEqual({ totalBytes: TB, usedBytes: 500 * GB, freeBytes: 500 * GB, freePercent: 50, daysUntilFull: 50 })
  })

  it('A3 la tendencia tolera ruido y sin crecimiento no hay fecha de llenado', () => {
    const noisy = [reading(0, 100 * GB), reading(1, 112 * GB), reading(2, 118 * GB), reading(3, 131 * GB), reading(4, 139 * GB)]
    expect(daysUntilFull(noisy)).toBeGreaterThan(80)
    expect(daysUntilFull(noisy)).toBeLessThan(100)
    expect(daysUntilFull([reading(0, 300 * GB), reading(5, 300 * GB)])).toBeNull()
    expect(daysUntilFull([reading(0, 300 * GB), reading(5, 250 * GB)])).toBeNull()
    expect(daysUntilFull([reading(0, 300 * GB)])).toBeNull()
  })

  it('A3 el inventario guarda lecturas históricas y la API muestra usado, libre y días hasta llenarse', async () => {
    h = await createHarness()
    const disk = await h.addDisk('datos', { totalBytes: TB, freeBytes: TB - 400 * GB })
    for (let day = 0; day < 6; day++) {
      h.volumes.set(disk.mountPath, { totalBytes: TB, freeBytes: TB - (400 + day * 20) * GB })
      await h.scan()
      h.clock.advance(DAY)
    }
    const capacity = (await h.get(`/v1/disks/${h.diskId(disk)}`)).body.capacity
    expect(capacity).toEqual({ totalBytes: TB, usedBytes: 500 * GB, freeBytes: 500 * GB, freePercent: 50, daysUntilFull: 25 })
  })

  it('A3 avisa con capacity.low cuando queda menos del 10 % y no repite hasta recuperarse', async () => {
    h = await createHarness()
    const disk = await h.addDisk('lleno', { totalBytes: TB, freeBytes: 300 * GB })
    await h.scan()
    h.volumes.set(disk.mountPath, { totalBytes: TB, freeBytes: 80 * GB })
    h.clock.advance(DAY)
    await h.scan()
    h.clock.advance(DAY)
    await h.scan()
    const low = h.events('capacity.low')
    expect(low).toHaveLength(1)
    expect(low[0]?.payload).toMatchObject({ diskId: h.diskId(disk), freeBytes: 80 * GB, freePercent: 8 })
    expect((await h.get(`/v1/disks/${h.diskId(disk)}`)).body.capacityLow).toBe(true)
  })
})
