import type { BusType } from '../../core/shared/model.js'
import type { PhysicalDiskInfo, SmartReading, VolumeUsage } from '../../core/ports/system.js'

type Json = Record<string, unknown>

const asArray = (value: unknown): Json[] => (Array.isArray(value) ? (value as Json[]) : value && typeof value === 'object' ? [value as Json] : [])
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)

// smartctl --json output (ATA and NVMe) → SmartReading
export function parseSmartctl(text: string): SmartReading | null {
  let json: Json
  try {
    json = JSON.parse(text) as Json
  } catch {
    return null
  }
  const attributes: Record<string, number> = {}
  const table = asArray((json.ata_smart_attributes as Json | undefined)?.table)
  for (const row of table) {
    const id = num(row.id)
    const raw = num((row.raw as Json | undefined)?.value)
    if (id !== null && raw !== null) attributes[String(id)] = raw
  }
  const nvme = json.nvme_smart_health_information_log as Json | undefined
  if (nvme) {
    const mediaErrors = num(nvme.media_errors)
    if (mediaErrors !== null) attributes['198'] = mediaErrors
  }
  const status = json.smart_status as Json | undefined
  const supported = (json.smart_support as Json | undefined)?.available !== false && (status !== undefined || table.length > 0 || nvme !== undefined)
  return {
    supported,
    passed: typeof status?.passed === 'boolean' ? status.passed : null,
    attributes,
    temperatureC: num((json.temperature as Json | undefined)?.current),
    powerOnHours: num((json.power_on_time as Json | undefined)?.hours)
  }
}

const BUS: Record<string, BusType> = { USB: 'usb', SATA: 'sata', NVMe: 'nvme', SAS: 'sas', RAID: 'other', SCSI: 'other', ATA: 'sata' }

// Get-Disk + Get-Partition JSON (see helper/operations.ts) → PhysicalDiskInfo
export function parseDisks(text: string): PhysicalDiskInfo[] {
  if (text.trim() === '') return []
  return asArray(JSON.parse(text)).flatMap((d) => {
    const number = num(d.Number)
    if (number === null) return []
    const uniqueId = str(d.UniqueId)
    const letter = str(d.DriveLetter)
    return [
      {
        serial: str(d.SerialNumber),
        wwn: uniqueId && /^[0-9A-F]{16}$/i.test(uniqueId) ? uniqueId.toLowerCase() : null,
        model: str(d.FriendlyName) ?? `Disco ${number}`,
        sizeBytes: num(d.Size) ?? 0,
        bus: BUS[str(d.BusType) ?? ''] ?? 'other',
        devicePath: `/dev/pd${number}`,
        mountPath: letter ? `${letter.toUpperCase()}:\\` : null
      }
    ]
  })
}

// Get-Volume JSON → usage by drive root ("E:\")
export function parseVolumes(text: string): Map<string, VolumeUsage> {
  const map = new Map<string, VolumeUsage>()
  if (text.trim() === '') return map
  for (const v of asArray(JSON.parse(text))) {
    const letter = str(v.DriveLetter)
    const size = num(v.Size)
    const free = num(v.SizeRemaining)
    if (letter && size !== null && free !== null) map.set(`${letter.toUpperCase()}:\\`, { totalBytes: size, freeBytes: free })
  }
  return map
}
