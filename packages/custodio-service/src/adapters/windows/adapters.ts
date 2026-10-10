import type { DiskProbe, PhysicalDiskInfo, SmartReader, SmartReading, VolumeReader, VolumeUsage } from '../../core/ports/system.js'
import type { HelperResponse } from '../../helper/helper.js'
import { assertRealAdaptersAllowed } from './guard.js'
import { parseDisks, parseSmartctl, parseVolumes } from './parsers.js'

export interface HelperCaller {
  call(op: string, args: unknown, confirmation?: string): Promise<HelperResponse>
}

async function stdoutOf(helper: HelperCaller, op: string, args: unknown): Promise<string> {
  const response = await helper.call(op, args)
  if (!response.ok) throw new Error(`custodio-helper ${op}: ${response.error.code} ${response.error.message}`)
  if (!('stdout' in response.result)) throw new Error(`custodio-helper ${op}: unexpected answer`)
  return response.result.stdout
}

// The service itself never runs elevated commands: every real read goes through custodio-helper

export class WindowsDiskProbe implements DiskProbe {
  constructor(private readonly helper: HelperCaller) {}

  async listDisks(): Promise<PhysicalDiskInfo[]> {
    assertRealAdaptersAllowed('WindowsDiskProbe')
    return parseDisks(await stdoutOf(this.helper, 'disks.list', {}))
  }
}

export class WindowsSmartReader implements SmartReader {
  constructor(private readonly helper: HelperCaller) {}

  async read(devicePath: string): Promise<SmartReading | null> {
    assertRealAdaptersAllowed('WindowsSmartReader')
    return parseSmartctl(await stdoutOf(this.helper, 'smart.read', { device: devicePath }))
  }
}

export class WindowsVolumeReader implements VolumeReader {
  constructor(private readonly helper: HelperCaller) {}

  async usage(mountPath: string): Promise<VolumeUsage | null> {
    assertRealAdaptersAllowed('WindowsVolumeReader')
    return parseVolumes(await stdoutOf(this.helper, 'volumes.list', {})).get(mountPath.toUpperCase()) ?? null
  }
}
