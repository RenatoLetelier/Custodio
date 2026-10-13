import { isAbsolute, join, relative, resolve } from 'node:path'
import type { FileEntry } from '../ports/system.js'
import type { Core } from '../shared/context.js'
import { DomainError } from '../shared/errors.js'
import { baseName, isCopierTemp, isIncompleteName, isSkippedDir } from '../shared/files.js'
import { assignmentRoot, copyRoot } from '../shared/layout.js'
import type { Assignment } from '../shared/model.js'
import { hasControlChars, isInside, relativeSegments } from '../shared/paths.js'

export interface DestinationStatus {
  assignmentId: string
  diskId: string
  label: string
  connected: boolean
  filesBackedUp: number
  complete: boolean
  lastCopiedAt: string | null
}

export interface BackupStatus {
  path: string
  source: { assignmentId: string; projectId: string; diskId: string; label: string } | null
  files: number
  bytes: number
  backedUp: boolean
  destinations: DestinationStatus[]
}

// Whether every file under a source path has a verified copy, current with the source, in some destination.
// Lets another program on this machine wait for the backup before it removes what only that copy could restore
export class BackupStatusService {
  constructor(private readonly core: Core) {}

  async of(path: string): Promise<BackupStatus> {
    if (!isAbsolute(path) || hasControlChars(path)) throw new DomainError('invalid_path', `La ruta "${path}" debe ser absoluta.`)
    const target = resolve(path)
    const found = this.sourceOf(target)
    if (!found) return { path, source: null, files: 0, bytes: 0, backedUp: false, destinations: [] }

    const { assignment, root } = found
    const files = await this.filesUnder(target, relative(root, target).split(/[\\/]+/).filter(Boolean).join('/'))
    const destinations: DestinationStatus[] = []
    for (const id of this.destinationsOf(assignment)) {
      const status = await this.destinationStatus(id, assignment, files)
      if (status) destinations.push(status)
    }
    return {
      path,
      source: { assignmentId: assignment.id, projectId: assignment.projectId, diskId: assignment.diskId, label: assignment.label },
      files: files.length,
      bytes: files.reduce((sum, f) => sum + f.size, 0),
      backedUp: destinations.some((d) => d.complete),
      destinations
    }
  }

  // The storage folder that contains the path; the innermost one if several do
  private sourceOf(target: string): { assignment: Assignment; root: string } | null {
    const { store } = this.core
    let best: { assignment: Assignment; root: string } | null = null
    for (const assignment of store.assignments.list()) {
      if (assignment.role !== 'storage') continue
      const disk = store.disks.get(assignment.diskId)
      if (!disk?.connected || !disk.mountPath) continue
      const root = assignmentRoot(disk.mountPath, assignment)
      if (isInside(root, target) && (!best || root.length > best.root.length)) best = { assignment, root }
    }
    return best
  }

  // What a backup would copy from the path: the same files the engine looks at, relative to the storage folder
  private async filesUnder(target: string, prefix: string): Promise<FileEntry[]> {
    const { fs } = this.core
    const copyable = (relPath: string): boolean => !isCopierTemp(baseName(relPath)) && !isIncompleteName(baseName(relPath))
    const info = await fs.stat(target)
    if (!info) return []
    if (info.isFile) return copyable(prefix) ? [{ relPath: prefix, size: info.size, mtimeMs: info.mtimeMs }] : []
    const files: FileEntry[] = []
    for await (const entry of fs.walk(target, isSkippedDir)) {
      const relPath = prefix ? `${prefix}/${entry.relPath}` : entry.relPath
      if (copyable(relPath)) files.push({ ...entry, relPath })
    }
    return files
  }

  private destinationsOf(source: Assignment): Set<string> {
    return new Set(
      this.core.store.policies
        .list()
        .filter((p) => p.sources.includes(source.id))
        .flatMap((p) => p.destinations)
    )
  }

  // A file counts when the manifest holds a hash-verified copy of its current size and date and, with the disk at hand, the copy is there
  private async destinationStatus(id: string, source: Assignment, files: FileEntry[]): Promise<DestinationStatus | null> {
    const { store, fs } = this.core
    const destination = store.assignments.get(id)
    if (!destination) return null
    const disk = store.disks.get(destination.diskId)
    const base = disk?.connected && disk.mountPath ? copyRoot(assignmentRoot(disk.mountPath, destination), source) : null

    let filesBackedUp = 0
    let lastCopiedAt: string | null = null
    for (const file of files) {
      const entry = store.manifest.get(id, source.id, file.relPath)
      if (!entry?.sha256 || entry.size !== file.size || entry.mtimeMs !== file.mtimeMs) continue
      if (base) {
        const copy = await fs.stat(join(base, ...relativeSegments(file.relPath)))
        if (!copy?.isFile || copy.size !== file.size) continue
      }
      filesBackedUp++
      if (!lastCopiedAt || entry.copiedAt > lastCopiedAt) lastCopiedAt = entry.copiedAt
    }
    return {
      assignmentId: id,
      diskId: destination.diskId,
      label: destination.label,
      connected: base !== null,
      filesBackedUp,
      complete: base !== null && files.length > 0 && filesBackedUp === files.length,
      lastCopiedAt
    }
  }
}
