import type { Disk, Health, Overview } from '../api/types'
import { t } from '../i18n'
import { formatFolder } from '../i18n/format'

// Two disks of one USB box usually share a model name: the drive letter tells them apart
export function diskName(disk: Pick<Disk, 'model' | 'mountPath'>): string {
  const drive = /^([a-z]):\\?$/i.exec(disk.mountPath ?? '')?.[1]
  return drive ? t('disks.nameWithDrive', { model: disk.model, drive: `${drive.toUpperCase()}:` }) : disk.model
}

export type DiskAction = 'use' | 'repair' | 'reconnect' | 'freeSpace' | 'checkCable' | 'none'

// The one thing worth doing next with a disk, in order of urgency
export function suggestedAction(disk: Disk): DiskAction {
  if (!disk.connected) return 'reconnect'
  if (disk.health === 'red' || disk.health === 'yellow') return 'repair'
  if (disk.capacityLow) return 'freeSpace'
  if (disk.advisories.some((a) => a.code === 'cable')) return 'checkCable'
  if (disk.state === 'unassigned') return 'use'
  return 'none'
}

export function diskStatus(disk: Disk): Health {
  return disk.connected ? disk.health : 'unknown'
}

export type Suggestion = 'configure' | 'repairDisk' | 'reconnect' | 'freeSpace' | 'checkBackups' | 'unassigned'

const REASON_TO_SUGGESTION: Record<string, Suggestion> = {
  not_configured: 'configure',
  disk_failing: 'repairDisk',
  disk_attention: 'repairDisk',
  disk_health_unknown: 'repairDisk',
  disk_disconnected: 'reconnect',
  capacity_low: 'freeSpace',
  backup_overdue: 'checkBackups',
  backup_failed: 'checkBackups'
}

export function suggestions(overview: Overview): Suggestion[] {
  const list = overview.reasons.map((r) => REASON_TO_SUGGESTION[r]).filter((s): s is Suggestion => s !== undefined)
  if (overview.disks.unassigned > 0 && !overview.reasons.includes('not_configured')) list.push('unassigned')
  return [...new Set(list)]
}

// Where a folder lives, for people: "D:\lc\prod" with the disk at hand, the disk's name otherwise
export function folderPath(disk: Pick<Disk, 'model' | 'mountPath'> | undefined, folder: string): string {
  if (disk?.mountPath) return formatFolder(disk.mountPath, folder)
  const inside = folder.split(/[\\/]+/).filter(Boolean).join('\\')
  return t('disks.offlineFolder', { disk: disk ? diskName(disk) : t('common.unknownDisk'), folder: inside === '' ? t('disks.wholeDisk') : inside })
}
