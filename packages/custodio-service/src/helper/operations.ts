import { z } from 'zod'

// smartctl device names on Windows (/dev/pdN, /dev/sdX, /dev/nvmeN, /dev/csmiN,M)
export const DevicePathSchema = z.string().regex(/^\/dev\/(pd\d{1,3}|sd[a-z]{1,2}|nvme\d{1,2}|csmi\d{1,2},\d{1,2})$/)
export const DriveSchema = z.string().regex(/^[A-Z]:$/)

const POWERSHELL = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command']

// Fixed scripts: nothing from a request is ever interpolated into them
const DISKS_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'Get-Disk | ForEach-Object {',
  '  $disk = $_',
  '  $mount = Get-Partition -DiskNumber $disk.Number -ErrorAction SilentlyContinue | Where-Object DriveLetter | Select-Object -First 1',
  '  [pscustomobject]@{ Number = $disk.Number; SerialNumber = $disk.SerialNumber; UniqueId = $disk.UniqueId; FriendlyName = $disk.FriendlyName;',
  '    Size = $disk.Size; BusType = "$($disk.BusType)"; DriveLetter = if ($mount) { "$($mount.DriveLetter)" } else { $null } }',
  '} | ConvertTo-Json -Compress'
].join('\n')

const VOLUMES_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'Get-Volume | Where-Object DriveLetter | Select-Object @{n="DriveLetter";e={"$($_.DriveLetter)"}}, FileSystemLabel, FileSystem, Size, SizeRemaining | ConvertTo-Json -Compress'
].join('\n')

export interface Operation<A extends z.ZodType = z.ZodType> {
  args: A
  command: (args: z.output<A>) => { file: string; args: string[] }
  requiresConfirmation: boolean
  // Reads answer in seconds; checking a big disk can take hours
  timeoutMs?: number
}

export const REPAIR_TIMEOUT_MS = 12 * 60 * 60 * 1000

const operation = <A extends z.ZodType>(op: Operation<A>): Operation<A> => op

export const OPERATIONS = {
  // USB enclosures usually answer SMART only through SAT pass-through ("-d sat")
  'smart.read': operation({
    args: z.object({ device: DevicePathSchema, type: z.literal('sat').optional() }).strict(),
    command: (a) => ({ file: 'smartctl.exe', args: ['--json=c', '--all', ...(a.type ? ['-d', a.type] : []), a.device] }),
    requiresConfirmation: false
  }),
  'disks.list': operation({
    args: z.object({}).strict(),
    command: () => ({ file: 'powershell.exe', args: [...POWERSHELL, DISKS_SCRIPT] }),
    requiresConfirmation: false
  }),
  'volumes.list': operation({
    args: z.object({}).strict(),
    command: () => ({ file: 'powershell.exe', args: [...POWERSHELL, VOLUMES_SCRIPT] }),
    requiresConfirmation: false
  }),
  'chkdsk.scan': operation({
    args: z.object({ drive: DriveSchema }).strict(),
    command: (a) => ({ file: 'chkdsk.exe', args: [a.drive, '/scan'] }),
    requiresConfirmation: false,
    timeoutMs: REPAIR_TIMEOUT_MS
  }),
  'chkdsk.fix': operation({
    args: z.object({ drive: DriveSchema }).strict(),
    command: (a) => ({ file: 'chkdsk.exe', args: [a.drive, '/f'] }),
    requiresConfirmation: true,
    timeoutMs: REPAIR_TIMEOUT_MS
  })
} as const

export type OperationName = keyof typeof OPERATIONS

// What the service may ask for a disk repair: the repair itself and the one-time confirmation it needs
export const REPAIR_OPERATION: OperationName = 'chkdsk.fix'
export const CONFIRMATION_OPERATION = 'confirmation.issue'
export const OPERATION_NAMES = Object.keys(OPERATIONS) as OperationName[]
