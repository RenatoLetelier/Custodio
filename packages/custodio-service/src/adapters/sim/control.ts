import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Services } from '../../core/services.js'
import type { ShiftableClock } from './clock.js'
import type { SimDiskProbe, SimSmartReader, SimVolumeReader } from './devices.js'
import type { SimRepairer } from './repairer.js'

export interface SimControlTarget {
  disks: SimDiskProbe
  smart: SimSmartReader
  volumes: SimVolumeReader
  clock: ShiftableClock
  repairer: SimRepairer
}

const SmartSchema = z.object({
  supported: z.boolean(),
  passed: z.boolean().nullable(),
  attributes: z.record(z.string(), z.number()),
  temperatureC: z.number().nullable(),
  powerOnHours: z.number().nullable()
})

const DiskSchema = z.object({
  serial: z.string().nullable(),
  wwn: z.string().nullable().default(null),
  model: z.string(),
  sizeBytes: z.number().int().positive(),
  bus: z.enum(['usb', 'sata', 'nvme', 'sas', 'other']).default('usb'),
  devicePath: z.string(),
  mountPath: z.string().nullable()
})

const UsageSchema = z.object({ totalBytes: z.number().int().positive(), freeBytes: z.number().int().nonnegative() })

// Only registered when the service runs on simulated hardware (development and UI tests); never with real disks.
// Lives outside /v1 and still requires the service token.
export function registerSimControl(app: FastifyInstance, target: SimControlTarget, services: Services): void {
  const scan = async () => services.runner.settled(services.runner.startScan({ actor: 'simulador' }).id)

  app.post('/_sim/disks', async (request) => {
    const body = z.object({ disk: DiskSchema, smart: SmartSchema.nullable().optional(), usage: UsageSchema.optional() }).parse(request.body)
    target.disks.add(body.disk)
    if (body.smart !== undefined) target.smart.set(body.disk.devicePath, body.smart)
    if (body.usage && body.disk.mountPath) target.volumes.set(body.disk.mountPath, body.usage)
    return { job: await scan() }
  })

  app.post('/_sim/disks/update', async (request) => {
    const body = z
      .object({ devicePath: z.string(), disk: DiskSchema.partial().optional(), smart: SmartSchema.nullable().optional(), usage: UsageSchema.optional(), mountPath: z.string().optional() })
      .parse(request.body)
    if (body.disk) target.disks.update(body.devicePath, body.disk)
    if (body.smart !== undefined) target.smart.set(body.devicePath, body.smart)
    if (body.usage && body.mountPath) target.volumes.set(body.mountPath, body.usage)
    return { job: await scan() }
  })

  app.post('/_sim/disks/remove', async (request) => {
    const body = z.object({ devicePath: z.string() }).parse(request.body)
    target.disks.remove(body.devicePath)
    return { job: await scan() }
  })

  app.post('/_sim/clock/advance', (request) => {
    const body = z.object({ ms: z.number().int().positive() }).parse(request.body)
    target.clock.advance(body.ms)
    return Promise.resolve({ now: target.clock.now().toISOString() })
  })
}
