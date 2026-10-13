import { indexPath, parseIndex } from '../allocation/descriptor.js'
import type { PhysicalDiskInfo, VolumeUsage } from '../ports/system.js'
import { SYSTEM_ACTOR, type Core } from '../shared/context.js'
import type { Disk } from '../shared/model.js'
import { LOW_FREE_PERCENT, RECOVERED_FREE_PERCENT, daysUntilFull, trendSince } from './capacity.js'
import { evaluateHealth, type HealthEvaluation } from './health.js'

const READING_INTERVAL_MS = 60 * 60 * 1000

export const normalizeWwn = (wwn: string | null): string | null => {
  const value = wwn?.toLowerCase().replace(/^0x/, '').replace(/[^0-9a-f]/g, '') ?? ''
  return value === '' || /^0+$/.test(value) ? null : value
}

export const normalizeSerial = (serial: string | null): string | null => {
  const value = serial?.trim().replace(/\s+/g, ' ').toUpperCase() ?? ''
  return value === '' ? null : value
}

// A disk is the same disk when its WWN or serial match, whatever drive letter it shows up with
export function identityKeyOf(info: Pick<PhysicalDiskInfo, 'wwn' | 'serial' | 'devicePath'>): string {
  const wwn = normalizeWwn(info.wwn)
  if (wwn) return `wwn:${wwn}`
  const serial = normalizeSerial(info.serial)
  if (serial) return `serial:${serial}`
  return `device:${info.devicePath}`
}

export function sameDisk(a: Pick<PhysicalDiskInfo, 'wwn' | 'serial'>, b: Pick<PhysicalDiskInfo, 'wwn' | 'serial'>): boolean {
  const wa = normalizeWwn(a.wwn)
  const wb = normalizeWwn(b.wwn)
  if (wa && wb) return wa === wb
  const sa = normalizeSerial(a.serial)
  const sb = normalizeSerial(b.serial)
  return sa !== null && sa === sb
}

export interface ScanResult {
  detected: string[]
  updated: string[]
  disconnected: string[]
  healthChanged: string[]
}

export class InventoryService {
  constructor(private readonly core: Core) {}

  async scan(): Promise<ScanResult> {
    const infos = await this.core.disks.listDisks()
    const result: ScanResult = { detected: [], updated: [], disconnected: [], healthChanged: [] }
    const seen = new Set<string>()
    const keys = new Set<string>()
    const shared = new Set(infos.map(identityKeyOf).filter((key, i, all) => all.indexOf(key) !== i))

    for (const info of infos) {
      const base = identityKeyOf(info)
      // Cheap USB bridges sometimes report the same serial for every disk: the position tells them apart,
      // and the index Custodio keeps at the root of each disk does even when the box numbers them anew
      const key = keys.has(base) ? `${base}@${info.devicePath}` : base
      keys.add(key)
      const hint = shared.has(base) ? await this.diskFromIndex(info, seen) : null
      const reading = await this.core.smart.read(info.devicePath).catch(() => null)
      const usage = info.mountPath ? await this.core.volumes.usage(info.mountPath).catch(() => null) : null
      const evaluation = evaluateHealth(reading)
      seen.add(this.core.store.transaction(() => this.upsert(info, key, evaluation, usage, result, seen, hint)))
    }

    const now = this.core.clock.now().toISOString()
    this.core.store.transaction(() => {
      for (const disk of this.core.store.disks.list()) {
        if (seen.has(disk.id) || !disk.connected) continue
        this.core.store.disks.update({ ...disk, connected: false, mountPath: null, lastSeenAt: now })
        result.disconnected.push(disk.id)
      }
    })
    this.core.logger.info('inventory scan', { ...result, actor: SYSTEM_ACTOR })
    return result
  }

  // The disk whose folders are listed in .diskmanager/index.json at this mount, if it is one of the known disks
  private async diskFromIndex(info: PhysicalDiskInfo, seen: Set<string>): Promise<Disk | null> {
    if (!info.mountPath) return null
    const index = parseIndex(await this.core.fs.readText(indexPath(info.mountPath)).catch(() => null))
    for (const folder of index?.folders ?? []) {
      const diskId = this.core.store.assignments.get(folder.assignmentId)?.diskId
      const disk = diskId ? this.core.store.disks.get(diskId) : null
      if (disk && !seen.has(disk.id) && sameDisk(disk, info)) return disk
    }
    return null
  }

  // A disk already matched in this scan is never matched again: two disks of one USB box can share a serial
  private findExisting(info: PhysicalDiskInfo, key: string, seen: Set<string>): Disk | null {
    const byKey = this.core.store.disks.findByIdentity(key)
    if (byKey && !seen.has(byKey.id)) return byKey
    return this.core.store.disks.list().find((d) => !seen.has(d.id) && !d.identityKey.startsWith('device:') && sameDisk(d, info)) ?? null
  }

  private upsert(info: PhysicalDiskInfo, key: string, evaluation: HealthEvaluation, usage: VolumeUsage | null, result: ScanResult, seen: Set<string>, hint: Disk | null): string {
    const { store, events } = this.core
    const now = this.core.clock.now()
    const nowIso = now.toISOString()
    const existing = hint ?? this.findExisting(info, key, seen)

    let disk: Disk
    if (!existing) {
      disk = {
        id: this.core.newId(),
        identityKey: key,
        serial: normalizeSerial(info.serial),
        wwn: normalizeWwn(info.wwn),
        model: info.model,
        sizeBytes: info.sizeBytes,
        bus: info.bus,
        devicePath: info.devicePath,
        mountPath: info.mountPath,
        connected: true,
        health: evaluation.health,
        healthReasons: evaluation.reasons,
        advisories: evaluation.advisories,
        smart: evaluation.smart,
        capacityLow: false,
        firstSeenAt: nowIso,
        lastSeenAt: nowIso
      }
      store.disks.insert(disk)
      result.detected.push(disk.id)
      events.publish('disk.detected', {
        diskId: disk.id,
        serial: disk.serial,
        wwn: disk.wwn,
        model: disk.model,
        sizeBytes: disk.sizeBytes,
        mountPath: disk.mountPath
      })
    } else {
      if (existing.health !== evaluation.health) {
        result.healthChanged.push(existing.id)
        events.publish('disk.health_changed', {
          diskId: existing.id,
          previous: existing.health,
          current: evaluation.health,
          reasons: evaluation.reasons.map((r) => r.code)
        })
      }
      disk = {
        ...existing,
        serial: normalizeSerial(info.serial) ?? existing.serial,
        wwn: normalizeWwn(info.wwn) ?? existing.wwn,
        model: info.model,
        sizeBytes: info.sizeBytes,
        bus: info.bus,
        devicePath: info.devicePath,
        mountPath: info.mountPath,
        connected: true,
        health: evaluation.health,
        healthReasons: evaluation.reasons,
        advisories: evaluation.advisories,
        smart: evaluation.smart,
        lastSeenAt: nowIso
      }
      result.updated.push(disk.id)
    }

    if (usage && usage.totalBytes > 0) disk = this.recordCapacity(disk, usage, now)
    store.disks.update(disk)
    return disk.id
  }

  private recordCapacity(disk: Disk, usage: VolumeUsage, now: Date): Disk {
    const { store, events } = this.core
    const recent = store.disks.readings(disk.id, new Date(now.getTime() - READING_INTERVAL_MS + 1).toISOString())
    if (recent.length === 0) {
      store.disks.addReading({ diskId: disk.id, at: now.toISOString(), totalBytes: usage.totalBytes, usedBytes: usage.totalBytes - usage.freeBytes })
    }
    const freePercent = Math.round((usage.freeBytes / usage.totalBytes) * 1000) / 10
    if (!disk.capacityLow && freePercent < LOW_FREE_PERCENT) {
      events.publish('capacity.low', {
        diskId: disk.id,
        totalBytes: usage.totalBytes,
        freeBytes: usage.freeBytes,
        freePercent,
        daysUntilFull: daysUntilFull(store.disks.readings(disk.id, trendSince(now)))
      })
      return { ...disk, capacityLow: true }
    }
    if (disk.capacityLow && freePercent >= RECOVERED_FREE_PERCENT) return { ...disk, capacityLow: false }
    return disk
  }
}
