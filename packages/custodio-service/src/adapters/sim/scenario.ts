import { readFileSync } from 'node:fs'
import { z } from 'zod'
import type { Adapters } from '../../app.js'
import { AtomicCopier } from '../node/atomic-copier.js'
import { NodeFileSystem } from '../node/filesystem.js'
import { SystemClock } from '../node/system-clock.js'
import { SimDiskProbe, SimSmartReader, SimVolumeReader } from './devices.js'

const SmartReadingSchema = z.object({
  supported: z.boolean(),
  passed: z.boolean().nullable(),
  attributes: z.record(z.string(), z.number()),
  temperatureC: z.number().nullable(),
  powerOnHours: z.number().nullable()
})

// Simulated hardware for development and end-to-end tests: each "disk" is a plain directory
export const ScenarioSchema = z.object({
  disks: z.array(
    z.object({
      serial: z.string().nullable(),
      wwn: z.string().nullable().default(null),
      model: z.string(),
      sizeBytes: z.number().int().positive(),
      bus: z.enum(['usb', 'sata', 'nvme', 'sas', 'other']).default('usb'),
      devicePath: z.string(),
      mountPath: z.string().nullable(),
      smart: SmartReadingSchema.nullable().optional(),
      usage: z.object({ totalBytes: z.number().int().positive(), freeBytes: z.number().int().nonnegative() }).optional()
    })
  )
})

export type Scenario = z.input<typeof ScenarioSchema>

export interface SimAdapters extends Adapters {
  disks: SimDiskProbe
  smart: SimSmartReader
  volumes: SimVolumeReader
}

export function createSimAdapters(scenario: Scenario = { disks: [] }): SimAdapters {
  const parsed = ScenarioSchema.parse(scenario)
  const disks = new SimDiskProbe()
  const smart = new SimSmartReader()
  const volumes = new SimVolumeReader()
  for (const disk of parsed.disks) {
    disks.add({ serial: disk.serial, wwn: disk.wwn, model: disk.model, sizeBytes: disk.sizeBytes, bus: disk.bus, devicePath: disk.devicePath, mountPath: disk.mountPath })
    if (disk.smart !== undefined) smart.set(disk.devicePath, disk.smart)
    if (disk.usage && disk.mountPath) volumes.set(disk.mountPath, disk.usage)
  }
  const fs = new NodeFileSystem()
  return { clock: new SystemClock(), disks, smart, volumes, fs, copier: new AtomicCopier(fs) }
}

export const loadScenario = (file: string): Scenario => JSON.parse(readFileSync(file, 'utf8')) as Scenario
