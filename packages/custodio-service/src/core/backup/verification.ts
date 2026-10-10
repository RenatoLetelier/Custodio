import { join } from 'node:path'
import type { Core } from '../shared/context.js'
import { sha256Of } from '../shared/files.js'
import { assignmentRoot, copyRoot } from '../shared/layout.js'
import type { ManifestEntry, Policy } from '../shared/model.js'
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

  async verify(policy: Policy, jobId: string, samplePercent: number, signal?: AbortSignal): Promise<VerificationSummary> {
    const { store, fs } = this.core
    const summary: VerificationSummary = { checked: 0, corrupted: [], skippedDestinations: [] }

    for (const destinationId of policy.destinations) {
      const destination = store.assignments.get(destinationId)
      const disk = destination ? store.disks.get(destination.diskId) : null
      if (!destination || !disk?.connected || !disk.mountPath) {
        summary.skippedDestinations.push(destinationId)
        continue
      }
      const base = assignmentRoot(disk.mountPath, destination)
      const entries = store.manifest.list(destinationId).filter((e): e is ManifestEntry & { sha256: string } => e.sha256 !== null && policy.sources.includes(e.sourceId))
      const count = entries.length === 0 ? 0 : Math.max(1, Math.ceil((entries.length * samplePercent) / 100))

      for (const entry of sample(entries, count, this.core.random)) {
        signal?.throwIfAborted()
        const source = store.assignments.get(entry.sourceId)
        if (!source) continue
        const path = join(copyRoot(base, source), ...relativeSegments(entry.relPath))
        const info = await fs.stat(path)
        const actual = info?.isFile ? await sha256Of(fs, path) : null
        summary.checked++
        if (actual === entry.sha256) continue
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
