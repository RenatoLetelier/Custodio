import type {
  DiskProbe,
  PhysicalDiskInfo,
  SmartReader,
  SmartReading,
  VolumeReader,
  VolumeUsage
} from '../../core/ports/system.js'

export class SimDiskProbe implements DiskProbe {
  private readonly disks = new Map<string, PhysicalDiskInfo>()

  add(info: PhysicalDiskInfo): void {
    this.disks.set(info.devicePath, { ...info })
  }

  update(devicePath: string, patch: Partial<PhysicalDiskInfo>): void {
    const current = this.disks.get(devicePath)
    if (!current) throw new Error(`Unknown simulated disk ${devicePath}`)
    this.disks.set(devicePath, { ...current, ...patch })
  }

  remove(devicePath: string): void {
    this.disks.delete(devicePath)
  }

  listDisks(): Promise<PhysicalDiskInfo[]> {
    return Promise.resolve([...this.disks.values()].map((d) => ({ ...d })))
  }
}

export const healthySmart = (overrides: Partial<SmartReading> = {}): SmartReading => ({
  supported: true,
  passed: true,
  attributes: { '5': 0, '197': 0, '198': 0, '199': 0 },
  temperatureC: 35,
  powerOnHours: 1200,
  ...overrides
})

export class SimSmartReader implements SmartReader {
  private readonly readings = new Map<string, SmartReading | null>()

  set(devicePath: string, reading: SmartReading | null): void {
    this.readings.set(devicePath, reading)
  }

  read(devicePath: string): Promise<SmartReading | null> {
    return Promise.resolve(this.readings.has(devicePath) ? (this.readings.get(devicePath) ?? null) : healthySmart())
  }
}

export const TB = 1_000_000_000_000
export const GB = 1_000_000_000

export class SimVolumeReader implements VolumeReader {
  private readonly usages = new Map<string, VolumeUsage>()

  constructor(private readonly fallback: VolumeUsage = { totalBytes: 2 * TB, freeBytes: 2 * TB - 100 * GB }) {}

  set(mountPath: string, usage: VolumeUsage): void {
    this.usages.set(mountPath, usage)
  }

  usage(mountPath: string): Promise<VolumeUsage | null> {
    return Promise.resolve(this.usages.get(mountPath) ?? this.fallback)
  }
}
