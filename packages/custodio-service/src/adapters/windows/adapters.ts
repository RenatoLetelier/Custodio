import type { DiskProbe, DiskRepairer, PhysicalDiskInfo, RepairOutcome, SmartReader, SmartReading, VolumeReader, VolumeUsage } from '../../core/ports/system.js'
import type { HelperResponse } from '../../helper/helper.js'
import { CONFIRMATION_OPERATION, REPAIR_OPERATION } from '../../helper/operations.js'
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

const driveOf = (mountPath: string): string => {
  const drive = /^([A-Za-z]):/.exec(mountPath)?.[1]
  if (!drive) throw new Error(`${mountPath} is not a drive letter`)
  return `${drive.toUpperCase()}:`
}

// File system repair through the helper; it only runs with a one-time confirmation issued at preview time
export class WindowsRepairer implements DiskRepairer {
  constructor(private readonly helper: HelperCaller) {}

  async authorize(mountPath: string): Promise<string | null> {
    assertRealAdaptersAllowed('WindowsRepairer')
    const response = await this.helper.call(CONFIRMATION_OPERATION, { op: REPAIR_OPERATION, args: { drive: driveOf(mountPath) } })
    if (!response.ok || !('token' in response.result)) throw new Error('custodio-helper did not issue a confirmation')
    return response.result.token
  }

  async repair(mountPath: string, confirmation: string | null): Promise<RepairOutcome> {
    assertRealAdaptersAllowed('WindowsRepairer')
    const response = await this.helper.call(REPAIR_OPERATION, { drive: driveOf(mountPath) }, confirmation ?? undefined)
    if (!response.ok) throw new Error(`custodio-helper ${REPAIR_OPERATION}: ${response.error.code}`)
    if (!('stdout' in response.result)) throw new Error(`custodio-helper ${REPAIR_OPERATION}: unexpected answer`)
    return { repaired: response.result.exitCode === 0, details: response.result.stdout.trim().split('\n').slice(-3).join('\n') }
  }
}
