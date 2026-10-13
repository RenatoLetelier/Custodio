import { join } from 'node:path'
import type { Core } from '../shared/context.js'
import { sha256Of } from '../shared/files.js'
import { assignmentRoot, copyRoot } from '../shared/layout.js'
import type { Assignment, Disk, JobProgress, ManifestEntry, Policy } from '../shared/model.js'
import { relativeSegments } from '../shared/paths.js'

export interface VerificationSummary extends Record<string, unknown> {
  checked: number
  corrupted: { destinationId: string; sourceId: string; path: string; expectedSha256: string; actualSha256: string | null }[]
  skippedDestinations: string[]
}

// Picks k distinct entries; with a seeded random the sample is reproducible
function sample<T>(items: T[], k: number, random: () => number): T[] {
  const pool = [...items]
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j] as T, pool[i] as T]
  }
  return pool.slice(0, k)
}

// Re-reads a random share of the copies and compares them with the hash recorded when they were made
export class VerificationService {
  constructor(private readonly core: Core) {}

  async verify(policy: Policy, jobId: string, samplePercent: number, signal?: AbortSignal, onProgress?: (progress: JobProgress) => void): Promise<VerificationSummary> {
    const { store, fs } = this.core
    const summary: VerificationSummary = { checked: 0, corrupted: [], skippedDestinations: [] }

    // The sample is drawn first, so the progress knows how much it will read
    const work: { destinationId: string; destination: Assignment; disk: Disk; entries: (ManifestEntry & { sha256: string })[] }[] = []
    for (const destinationId of policy.destinations) {
      const destination = store.assignments.get(destinationId)
      const disk = destination ? store.disks.get(destination.diskId) : null
      if (!destination || !disk?.connected || !disk.mountPath) {
        summary.skippedDestinations.push(destinationId)
        continue
      }
      const entries = store.manifest.list(destinationId).filter((e): e is ManifestEntry & { sha256: string } => e.sha256 !== null && policy.sources.includes(e.sourceId))
      const count = entries.length === 0 ? 0 : Math.max(1, Math.ceil((entries.length * samplePercent) / 100))
      work.push({ destinationId, destination, disk, entries: sample(entries, count, this.core.random) })
    }
    const all = work.flatMap((w) => w.entries)
    const progress: JobProgress = { filesDone: 0, filesTotal: all.length, bytesDone: 0, bytesTotal: all.reduce((sum, e) => sum + e.size, 0), phase: 'verifying' }
    onProgress?.({ ...progress })

    for (const { destinationId, destination, disk, entries } of work) {
      const base = assignmentRoot(disk.mountPath as string, destination)
      for (const entry of entries) {
        signal?.throwIfAborted()
        const source = store.assignments.get(entry.sourceId)
        if (!source) continue
        const path = join(copyRoot(base, source, destination), ...relativeSegments(entry.relPath))
        const info = await fs.stat(path)
        const actual = info?.isFile
          ? await sha256Of(fs, path, signal, (bytes) => {
              progress.bytesDone += bytes
              onProgress?.({ ...progress })
            })
          : null
        summary.checked++
        progress.filesDone++
        onProgress?.({ ...progress })
        if (actual === entry.sha256) continue
        // Without its verified hash the entry no longer counts as backed up, and the next run copies the file again
        store.manifest.upsert({ ...entry, sha256: null })
        summary.corrupted.push({ destinationId, sourceId: entry.sourceId, path: entry.relPath, expectedSha256: entry.sha256, actualSha256: actual })
        this.core.events.publish('backup.corruption_detected', {
          jobId,
          policyId: policy.id,
          projectId: policy.projectId,
          destinationId,
          diskId: disk.id,
          path: entry.relPath,
          expectedSha256: entry.sha256,
          actualSha256: actual
        })
      }
    }

    const current = store.policies.get(policy.id)
    if (current) store.policies.update({ ...current, lastVerifiedAt: this.core.clock.now().toISOString() })
    return summary
  }
}
