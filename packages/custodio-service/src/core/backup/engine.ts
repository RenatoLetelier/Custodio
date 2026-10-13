import { dirname, join } from 'node:path'
import type { DeletionService } from '../allocation/deletions.js'
import type { FileEntry } from '../ports/system.js'
import type { Core } from '../shared/context.js'
import { CopyError, isAbortError } from '../shared/errors.js'
import { QUIET_WINDOW_MS, baseName, isCopierTemp, isIncompleteName, isSkippedDir, sha256Of } from '../shared/files.js'
import { TRASH_DIR, VERSIONS_DIR, assignmentRoot, copyRoot, metaDir, parseStamp, sourceDirName, stampOf } from '../shared/layout.js'
import type { JobProgress, Policy } from '../shared/model.js'
import { relativeSegments } from '../shared/paths.js'
import { checkEndpoints, type Endpoint, type PreflightIssue } from './preflight.js'
import { isWindowOpen } from './schedule.js'
import { MEGABYTE, Pacer } from './throttle.js'

export class BackupError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message)
    this.name = 'BackupError'
  }
}

class WindowClosed extends Error {
  constructor() {
    super('Copy window closed')
    this.name = 'WindowClosed'
  }
}

export type SkipReason = 'incomplete' | 'not_quiet' | 'deleted_by_order' | 'source_changed'

export interface PlannedDeletion {
  destinationId: string
  sourceId: string
  path: string
}

export interface RunSummary extends Record<string, unknown> {
  filesCopied: number
  bytesCopied: number
  filesUpToDate: number
  filesSkipped: number
  skipped: { sourceId: string; path: string; reason: SkipReason }[]
  filesFailed: number
  failed: { sourceId: string; path: string; code: string; message: string }[]
  filesDeleted: number
  deletionsHeld: number
  plannedCopies: number
  plannedBytes: number
  plannedDeletions: PlannedDeletion[]
  interrupted: 'outside_window' | null
  durationMs: number
}

export interface RunOptions {
  jobId: string
  dryRun: boolean
  mirrorDryRunJobId?: string | null
  signal: AbortSignal
  onProgress?: (progress: JobProgress) => void
}

interface PairPlan {
  source: Endpoint
  destination: Endpoint
  sourceRoot: string
  destinationBase: string
  copyRoot: string
  copies: { entry: FileEntry; replace: boolean }[]
  // Already identical in the destination (same size and date) but unknown to the manifest, e.g. after a recovery
  adopt: FileEntry[]
  deletions: string[]
  destinationFiles: number
  temps: string[]
}

const DRY_RUN_VALID_MS = 24 * 60 * 60 * 1000
const LIST_LIMIT = 200
const deletionKey = (d: PlannedDeletion): string => `${d.destinationId}\u0000${d.sourceId}\u0000${d.path}`
const pathOf = (root: string, relPath: string): string => join(root, ...relativeSegments(relPath))

// Incremental, append-only copy: only what is missing or changed, verified by hash, nothing removed unless the mode says so
export class BackupEngine {
  constructor(
    private readonly core: Core,
    private readonly deletions: DeletionService
  ) {}

  async run(policy: Policy, options: RunOptions): Promise<RunSummary> {
    const { clock } = this.core
    const started = clock.now()
    const summary: RunSummary = {
      filesCopied: 0,
      bytesCopied: 0,
      filesUpToDate: 0,
      filesSkipped: 0,
      skipped: [],
      filesFailed: 0,
      failed: [],
      filesDeleted: 0,
      deletionsHeld: 0,
      plannedCopies: 0,
      plannedBytes: 0,
      plannedDeletions: [],
      interrupted: null,
      durationMs: 0
    }
    const finish = (): RunSummary => ({ ...summary, durationMs: clock.now().getTime() - started.getTime() })

    if (!isWindowOpen(policy.window, policy.timezone, started)) {
      summary.interrupted = 'outside_window'
      return finish()
    }

    const assignments = [...policy.sources, ...policy.destinations].map((id) => this.core.store.assignments.get(id))
    if (assignments.some((a) => !a)) throw new BackupError('preflight_failed', 'La copia usa carpetas que ya no existen.')
    const { issues, endpoints } = await checkEndpoints(this.core, assignments as NonNullable<(typeof assignments)[number]>[])
    if (issues.length > 0) throw new BackupError('preflight_failed', issues.map((i) => i.message).join(' '), { issues })

    const pairs = await this.plan(policy, endpoints, summary)
    for (const pair of pairs) {
      summary.plannedCopies += pair.copies.length
      summary.plannedBytes += pair.copies.reduce((sum, c) => sum + c.entry.size, 0)
    }
    this.checkDeleteThreshold(policy, pairs)
    if (policy.mode !== 'append') {
      summary.plannedDeletions = pairs.flatMap((p) =>
        p.deletions.map((path) => ({ destinationId: p.destination.assignment.id, sourceId: p.source.assignment.id, path }))
      )
    }
    if (options.dryRun) return finish()

    await this.checkSpace(pairs)
    const allowMirror = policy.mode !== 'mirror' || this.mirrorAllowed(policy, options.mirrorDryRunJobId ?? null, summary.plannedDeletions)

    const progress: JobProgress = { filesDone: 0, filesTotal: summary.plannedCopies, bytesDone: 0, bytesTotal: summary.plannedBytes }
    options.onProgress?.({ ...progress })
    const pacer = policy.maxMegabytesPerSecond ? new Pacer(clock, policy.maxMegabytesPerSecond * MEGABYTE) : null
    const stamp = stampOf(started)

    try {
      for (const pair of pairs) {
        for (const temp of pair.temps) await this.core.fs.removeFile(temp)
        await this.adoptExisting(pair, summary)
        await this.copyPair(policy, pair, stamp, summary, progress, pacer, options)
      }
      for (const pair of pairs) await this.applyDeletions(policy, pair, stamp, summary, allowMirror)
      if (policy.mode !== 'append') {
        for (const base of new Set(pairs.map((p) => p.destinationBase))) await this.purge(base, policy.retentionDays)
      }
    } catch (error) {
      if (error instanceof WindowClosed) {
        summary.interrupted = 'outside_window'
        return finish()
      }
      throw error
    }
    return finish()
  }

  private async plan(policy: Policy, endpoints: Map<string, Endpoint>, summary: RunSummary): Promise<PairPlan[]> {
    const { fs, store, clock } = this.core
    const now = clock.now().getTime()
    const tombstones = this.deletions.tombstones(policy.projectId)
    const pairs: PairPlan[] = []

    for (const destinationId of policy.destinations) {
      const destination = endpoints.get(destinationId) as Endpoint
      const destinationBase = assignmentRoot(destination.mountPath, destination.assignment)
      for (const sourceId of policy.sources) {
        const source = endpoints.get(sourceId) as Endpoint
        const sourceRoot = assignmentRoot(source.mountPath, source.assignment)
        const root = copyRoot(destinationBase, source.assignment)
        const pair: PairPlan = {
          source,
          destination,
          sourceRoot,
          destinationBase,
          copyRoot: root,
          copies: [],
          adopt: [],
          deletions: [],
          destinationFiles: 0,
          temps: []
        }
        const present = new Set<string>()
        // What could not be read is reported as failed and its copies are never taken for deleted at the source
        const unreadable: string[] = []
        const onUnreadable = (relPath: string, error: Error): void => {
          unreadable.push(relPath)
          summary.filesFailed++
          if (summary.failed.length < LIST_LIMIT) summary.failed.push({ sourceId, path: relPath, code: 'unreadable', message: error.message })
        }

        for await (const entry of fs.walk(sourceRoot, isSkippedDir, onUnreadable)) {
          present.add(entry.relPath)
          const name = baseName(entry.relPath)
          if (isCopierTemp(name)) continue
          const skip = (reason: SkipReason): void => {
            summary.filesSkipped++
            if (summary.skipped.length < LIST_LIMIT) summary.skipped.push({ sourceId, path: entry.relPath, reason })
          }
          if (isIncompleteName(name)) {
            skip('incomplete')
            continue
          }
          if (now - entry.mtimeMs < QUIET_WINDOW_MS) {
            skip('not_quiet')
            continue
          }
          if (this.tombstoned(tombstones, sourceId, entry)) {
            skip('deleted_by_order')
            continue
          }
          const known = store.manifest.get(destinationId, sourceId, entry.relPath)
          const existing = await fs.stat(pathOf(root, entry.relPath))
          if (known?.sha256 && existing?.isFile && known.size === entry.size && known.mtimeMs === entry.mtimeMs && existing.size === entry.size) {
            summary.filesUpToDate++
            continue
          }
          if (!known && existing?.isFile && existing.size === entry.size && existing.mtimeMs === entry.mtimeMs) {
            pair.adopt.push(entry)
            continue
          }
          pair.copies.push({ entry, replace: existing !== null })
        }

        for await (const entry of fs.walk(root, isSkippedDir)) {
          if (isCopierTemp(baseName(entry.relPath))) {
            pair.temps.push(pathOf(root, entry.relPath))
            continue
          }
          pair.destinationFiles++
          if (!present.has(entry.relPath) && !unreadable.some((u) => entry.relPath === u || entry.relPath.startsWith(`${u}/`))) pair.deletions.push(entry.relPath)
        }
        pairs.push(pair)
      }
    }
    return pairs
  }

  private tombstoned(tombstones: Map<string, number>, sourceId: string, entry: FileEntry): boolean {
    const segments = entry.relPath.split('/')
    for (let i = segments.length; i > 0; i--) {
      const orderedAt = tombstones.get(`${sourceId}\u0000${segments.slice(0, i).join('/')}`)
      if (orderedAt !== undefined && entry.mtimeMs <= orderedAt) return true
    }
    return false
  }

  // Retention and mirror abort before touching anything if they would remove too much
  private checkDeleteThreshold(policy: Policy, pairs: PairPlan[]): void {
    if (policy.mode === 'append') return
    for (const pair of pairs) {
      const total = pair.destinationFiles
      if (total === 0 || pair.deletions.length === 0) continue
      const percent = (pair.deletions.length / total) * 100
      if (percent > policy.maxDeletePercent) {
        throw new BackupError(
          'delete_threshold_exceeded',
          `La copia borraría ${pair.deletions.length} de ${total} archivos en "${pair.destination.assignment.label}" (${Math.round(percent)} %), más del ${policy.maxDeletePercent} % permitido. No se borró nada.`,
          { destinationId: pair.destination.assignment.id, sourceId: pair.source.assignment.id, deletions: pair.deletions.length, total, percent }
        )
      }
    }
  }

  private async checkSpace(pairs: PairPlan[]): Promise<void> {
    const needed = new Map<string, { bytes: number; assignmentId: string; label: string }>()
    for (const pair of pairs) {
      const key = pair.destination.mountPath
      const current = needed.get(key) ?? { bytes: 0, assignmentId: pair.destination.assignment.id, label: pair.destination.assignment.label }
      current.bytes += pair.copies.reduce((sum, c) => sum + c.entry.size, 0)
      needed.set(key, current)
    }
    const issues: PreflightIssue[] = []
    for (const [mountPath, need] of needed) {
      if (need.bytes === 0) continue
      const usage = await this.core.volumes.usage(mountPath)
      if (usage && usage.freeBytes < need.bytes) {
        issues.push({ code: 'insufficient_space', assignmentId: need.assignmentId, message: `"${need.label}" no tiene espacio: faltan ${need.bytes - usage.freeBytes} bytes.` })
      }
    }
    if (issues.length > 0) throw new BackupError('preflight_failed', issues.map((i) => i.message).join(' '), { issues })
  }

  private mirrorAllowed(policy: Policy, dryRunJobId: string | null, planned: PlannedDeletion[]): boolean {
    if (planned.length === 0) return true
    if (!policy.mirrorConfirmed) return false
    if (!dryRunJobId) return false
    const job = this.core.store.jobs.get(dryRunJobId)
    const fresh = job?.finishedAt && this.core.clock.now().getTime() - Date.parse(job.finishedAt) <= DRY_RUN_VALID_MS
    if (!job || job.policyId !== policy.id || !job.dryRun || job.status !== 'succeeded' || !fresh) {
      throw new BackupError('mirror_dry_run_invalid', 'El espejo necesita una simulación previa de esta misma copia, hecha en las últimas 24 horas.')
    }
    const reviewed = new Set(((job.result?.plannedDeletions ?? []) as PlannedDeletion[]).map(deletionKey))
    const unexpected = planned.filter((d) => !reviewed.has(deletionKey(d)))
    if (unexpected.length > 0) {
      throw new BackupError('mirror_dry_run_outdated', `Desde la simulación aparecieron ${unexpected.length} borrados nuevos. Vuelve a simular antes de aplicar el espejo.`, {
        unexpected: unexpected.slice(0, LIST_LIMIT)
      })
    }
    return true
  }

  private async adoptExisting(pair: PairPlan, summary: RunSummary): Promise<void> {
    const { fs, store, clock } = this.core
    for (const entry of pair.adopt) {
      store.manifest.upsert({
        destinationId: pair.destination.assignment.id,
        sourceId: pair.source.assignment.id,
        relPath: entry.relPath,
        size: entry.size,
        mtimeMs: entry.mtimeMs,
        sha256: await sha256Of(fs, pathOf(pair.copyRoot, entry.relPath)),
        copiedAt: clock.now().toISOString()
      })
      summary.filesUpToDate++
    }
  }

  private async copyPair(policy: Policy, pair: PairPlan, stamp: string, summary: RunSummary, progress: JobProgress, pacer: Pacer | null, options: RunOptions): Promise<void> {
    const { fs, store, clock, copier, meter } = this.core
    const sourceId = pair.source.assignment.id
    const destinationId = pair.destination.assignment.id

    for (const { entry, replace } of pair.copies) {
      options.signal.throwIfAborted()
      if (!isWindowOpen(policy.window, policy.timezone, clock.now())) throw new WindowClosed()
      const destinationPath = pathOf(pair.copyRoot, entry.relPath)
      try {
        const result = await copier.copy({
          sourcePath: pathOf(pair.sourceRoot, entry.relPath),
          destinationPath,
          mtimeMs: entry.mtimeMs,
          signal: options.signal,
          onChunk: async (bytes) => {
            meter?.record(bytes)
            progress.bytesDone += bytes
            options.onProgress?.({ ...progress })
            if (pacer) await pacer.consume(bytes, options.signal)
            if (!isWindowOpen(policy.window, policy.timezone, clock.now())) throw new WindowClosed()
          },
          beforeCommit: replace
            ? async () => {
                if (!(await fs.stat(destinationPath))) return
                const version = join(metaDir(pair.destinationBase), VERSIONS_DIR, stamp, sourceDirName(pair.source.assignment.label), ...relativeSegments(entry.relPath))
                await fs.mkdirp(dirname(version))
                await fs.rename(destinationPath, version)
              }
            : undefined
        })
        store.manifest.upsert({
          destinationId,
          sourceId,
          relPath: entry.relPath,
          size: result.bytes,
          mtimeMs: entry.mtimeMs,
          sha256: result.sha256,
          copiedAt: clock.now().toISOString()
        })
        summary.filesCopied++
        summary.bytesCopied += result.bytes
      } catch (error) {
        if (error instanceof WindowClosed || isAbortError(error)) throw error
        if (error instanceof CopyError && (error.code === 'source_changed' || error.code === 'source_missing')) {
          summary.filesSkipped++
          if (summary.skipped.length < LIST_LIMIT) summary.skipped.push({ sourceId, path: entry.relPath, reason: 'source_changed' })
        } else if (error instanceof CopyError || ['EBUSY', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) {
          summary.filesFailed++
          if (summary.failed.length < LIST_LIMIT) {
            summary.failed.push({ sourceId, path: entry.relPath, code: error instanceof CopyError ? error.code : 'unreadable', message: (error as Error).message })
          }
        } else {
          throw error
        }
      }
      progress.filesDone++
      options.onProgress?.({ ...progress })
    }
  }

  private async applyDeletions(policy: Policy, pair: PairPlan, stamp: string, summary: RunSummary, allowMirror: boolean): Promise<void> {
    if (policy.mode === 'append' || pair.deletions.length === 0) return
    if (policy.mode === 'mirror' && !allowMirror) {
      summary.deletionsHeld += pair.deletions.length
      return
    }
    const { fs, store } = this.core
    for (const relPath of pair.deletions) {
      const path = pathOf(pair.copyRoot, relPath)
      if (policy.mode === 'retention') {
        const trashed = join(metaDir(pair.destinationBase), TRASH_DIR, stamp, sourceDirName(pair.source.assignment.label), ...relativeSegments(relPath))
        await fs.mkdirp(dirname(trashed))
        await fs.rename(path, trashed)
      } else {
        await fs.removeFile(path)
      }
      store.manifest.remove(pair.destination.assignment.id, pair.source.assignment.id, relPath)
      summary.filesDeleted++
    }
  }

  // Retention keeps old versions and deleted files for N days, then lets them go
  private async purge(destinationBase: string, retentionDays: number): Promise<void> {
    const limit = this.core.clock.now().getTime() - retentionDays * 24 * 60 * 60 * 1000
    for (const kind of [TRASH_DIR, VERSIONS_DIR]) {
      const dir = join(metaDir(destinationBase), kind)
      for (const entry of await this.core.fs.readDir(dir)) {
        const stampDate = entry.isDirectory ? parseStamp(entry.name) : null
        if (stampDate && stampDate.getTime() < limit) await this.core.fs.removeTree(join(dir, entry.name))
      }
    }
  }
}
