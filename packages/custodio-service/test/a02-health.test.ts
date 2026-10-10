import { afterEach, describe, expect, it } from 'vitest'
import { healthySmart } from '../src/adapters/sim/devices.js'
import { evaluateHealth } from '../src/core/inventory-health/health.js'
import { createHarness, type Harness } from './support/harness.js'

let h: Harness
afterEach(async () => h?.close())

const withAttributes = (attributes: Record<string, number>, extra = {}) => healthySmart({ attributes: { '5': 0, '197': 0, '198': 0, '199': 0, ...attributes }, ...extra })

describe('salud de los discos', () => {
  it('A2 un disco sin problemas en 5, 197, 198, temperatura y horas está en verde', () => {
    const result = evaluateHealth(withAttributes({}, { temperatureC: 38, powerOnHours: 5000 }))
    expect(result.health).toBe('green')
    expect(result.reasons).toEqual([])
  })

  it('A2 sectores reasignados (5) o pendientes (197) piden atención y en exceso marcan rojo', () => {
    expect(evaluateHealth(withAttributes({ '5': 3 })).health).toBe('yellow')
    expect(evaluateHealth(withAttributes({ '5': 120 })).health).toBe('red')
    expect(evaluateHealth(withAttributes({ '197': 2 })).health).toBe('yellow')
    expect(evaluateHealth(withAttributes({ '197': 40 })).health).toBe('red')
    expect(evaluateHealth(withAttributes({ '197': 2 })).reasons[0]).toMatchObject({ code: 'pending_sectors', attribute: 197, value: 2 })
  })

  it('A2 datos irrecuperables (198), temperatura y horas de uso cuentan en el semáforo', () => {
    expect(evaluateHealth(withAttributes({ '198': 1 })).health).toBe('red')
    expect(evaluateHealth(withAttributes({}, { temperatureC: 55 })).health).toBe('yellow')
    expect(evaluateHealth(withAttributes({}, { temperatureC: 65 })).health).toBe('red')
    expect(evaluateHealth(withAttributes({}, { powerOnHours: 40_000 })).health).toBe('yellow')
    expect(evaluateHealth(healthySmart({ passed: false })).health).toBe('red')
  })

  it('A2 el atributo 199 avisa del cable o el USB y no marca el disco como fallando', () => {
    const result = evaluateHealth(withAttributes({ '199': 250 }))
    expect(result.health).toBe('green')
    expect(result.reasons).toEqual([])
    expect(result.advisories).toEqual([expect.objectContaining({ code: 'cable', attribute: 199, value: 250 })])
  })

  it('A2 sin SMART el estado es desconocido, nunca verde', () => {
    expect(evaluateHealth(null).health).toBe('unknown')
    expect(evaluateHealth({ supported: false, passed: null, attributes: {}, temperatureC: null, powerOnHours: null }).health).toBe('unknown')
    expect(evaluateHealth({ supported: true, passed: null, attributes: {}, temperatureC: null, powerOnHours: null }).health).toBe('unknown')
  })

  it('A2 la API muestra el semáforo y avisa con disk.health_changed cuando cambia', async () => {
    h = await createHarness()
    const disk = await h.addDisk('viejo')
    const usb = await h.addDisk('usb')
    h.smart.set(usb.devicePath, null)
    await h.scan()
    expect((await h.get(`/v1/disks/${h.diskId(disk)}`)).body.health).toBe('green')
    expect((await h.get(`/v1/disks/${h.diskId(usb)}`)).body).toMatchObject({ health: 'unknown', smart: null })

    h.smart.set(disk.devicePath, withAttributes({ '197': 3, '199': 9 }))
    await h.scan()
    const view = (await h.get(`/v1/disks/${h.diskId(disk)}`)).body
    expect(view.health).toBe('yellow')
    expect(view.advisories[0].code).toBe('cable')
    expect(view.smart.attributes['197']).toBe(3)
    const changes = h.events('disk.health_changed')
    expect(changes).toHaveLength(1)
    expect(changes[0]?.payload).toEqual({ diskId: view.id, previous: 'green', current: 'yellow', reasons: ['pending_sectors'] })
  })
})
