import { readFile, rm } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NodeFileSystem } from '../src/adapters/node/filesystem.js'
import type { FileEntry } from '../src/core/ports/system.js'
import { listFiles, simpleSetup } from './support/backup.js'
import { createHarness, DAY, HOUR, type Harness } from './support/harness.js'

let h: Harness
afterEach(async () => h?.close())

const files = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${String(i).padStart(2, '0')}.txt`, `archivo ${i}`]))

async function removeAtSource(root: string, names: string[]) {
  for (const name of names) await rm(join(root, name))
}

describe('modos con borrado', () => {
  it('A11 retención: lo borrado en el origen se conserva N días en la papelera del destino y después se libera', async () => {
    h = await createHarness()
    const setup = await simpleSetup(h, files(20))
    const policy = await h.policy(setup.projectId, { mode: 'retention', retentionDays: 7, sources: [setup.storage.id], destinations: [setup.backup.id] })
    await h.run(policy.id)

    await removeAtSource(setup.sourceRoot, ['f03.txt'])
    const run = await h.run(policy.id)
    expect(run.result).toMatchObject({ filesDeleted: 1 })
    expect(await listFiles(setup.copyRoot)).not.toContain('f03.txt')
    const trash = join(setup.destination.mountPath, 'Copias', '.diskmanager', 'trash')
    const kept = await listFiles(trash, { meta: true })
    expect(kept).toEqual([expect.stringMatching(/^[\dT-]+Z\/Fotos\/f03\.txt$/)])
    expect(await readFile(join(trash, ...(kept[0] as string).split('/')), 'utf8')).toBe('archivo 3')

    h.clock.advance(6 * DAY)
    await h.run(policy.id)
    expect(await listFiles(trash, { meta: true })).toEqual(kept)

    h.clock.advance(2 * DAY)
    await h.run(policy.id)
    expect(await listFiles(trash, { meta: true })).toEqual([])
  })

  it('A11 espejo: exige el flag explícito para activarse', async () => {
    h = await createHarness()
    const setup = await simpleSetup(h, files(3))
    const body = { name: 'Espejo', cron: '0 3 * * *', timezone: 'UTC', sources: [setup.storage.id], destinations: [setup.backup.id], mode: 'mirror' }
    const refused = await h.post(`/v1/projects/${setup.projectId}/policies`, body)
    expect(refused.status).toBe(422)
    expect(refused.body.error.code).toBe('mirror_not_allowed')
    const accepted = await h.post(`/v1/projects/${setup.projectId}/policies`, { ...body, mirrorConfirmed: true })
    expect(accepted.status).toBe(201)
    expect(accepted.body).toMatchObject({ mode: 'mirror', mirrorConfirmed: true })
  })

  it('A11 espejo: solo borra en el destino después de una simulación previa (dry-run) que lo muestre', async () => {
    h = await createHarness()
    const setup = await simpleSetup(h, files(20))
    const policy = await h.policy(setup.projectId, { mode: 'mirror', mirrorConfirmed: true, sources: [setup.storage.id], destinations: [setup.backup.id] })
    await h.run(policy.id)
    await removeAtSource(setup.sourceRoot, ['f01.txt'])

    // Without a dry run, deletions wait
    const held = await h.run(policy.id)
    expect(held.result).toMatchObject({ filesDeleted: 0, deletionsHeld: 1 })
    expect(await listFiles(setup.copyRoot)).toContain('f01.txt')

    const dry = await h.post(`/v1/policies/${policy.id}/runs`, { dryRun: true })
    expect(dry.status).toBe(202)
    const simulated = await h.s.runner.settled(dry.body.job.id)
    expect(simulated).toMatchObject({ status: 'succeeded', dryRun: true })
    expect(simulated.result?.plannedDeletions).toEqual([{ destinationId: setup.backup.id, sourceId: setup.storage.id, path: 'f01.txt' }])
    expect(await listFiles(setup.copyRoot)).toContain('f01.txt')

    // Something else disappeared after the review: the dry run no longer covers it
    await removeAtSource(setup.sourceRoot, ['f02.txt'])
    const outdated = await h.run(policy.id, { mirrorDryRunJobId: simulated.id })
    expect(outdated).toMatchObject({ status: 'failed', error: { code: 'mirror_dry_run_outdated' } })
    expect(await listFiles(setup.copyRoot)).toEqual(expect.arrayContaining(['f01.txt', 'f02.txt']))

    const second = await h.s.runner.settled(h.s.runner.startBackup(policy.id, { actor: 'tester', dryRun: true }).id)
    const applied = await h.run(policy.id, { mirrorDryRunJobId: second.id })
    expect(applied).toMatchObject({ status: 'succeeded', result: { filesDeleted: 2 } })
    expect(await listFiles(setup.copyRoot)).toEqual(await listFiles(setup.sourceRoot))

    h.clock.advance(25 * HOUR)
    await removeAtSource(setup.sourceRoot, ['f03.txt'])
    const stale = await h.run(policy.id, { mirrorDryRunJobId: second.id })
    expect(stale.error?.code).toBe('mirror_dry_run_invalid')
  })

  it('A11 retención y espejo abortan sin borrar nada si superarían el porcentaje configurado', async () => {
    h = await createHarness()
    const setup = await simpleSetup(h, files(20))
    const retention = await h.policy(setup.projectId, { name: 'Retención', mode: 'retention', maxDeletePercent: 10, sources: [setup.storage.id], destinations: [setup.backup.id] })
    await h.run(retention.id)
    await removeAtSource(setup.sourceRoot, ['f00.txt', 'f01.txt', 'f02.txt'])

    const job = await h.run(retention.id)
    expect(job).toMatchObject({ status: 'failed', error: { code: 'delete_threshold_exceeded', details: { deletions: 3, total: 20, percent: 15 } } })
    expect(await listFiles(setup.copyRoot)).toHaveLength(20)
    expect(h.events('backup.failed').at(-1)?.payload).toMatchObject({ code: 'delete_threshold_exceeded' })

    await h.patch(`/v1/policies/${retention.id}`, { mode: 'mirror', mirrorConfirmed: true })
    const dry = await h.s.runner.settled(h.s.runner.startBackup(retention.id, { actor: 'tester', dryRun: true }).id)
    expect(dry).toMatchObject({ status: 'failed', error: { code: 'delete_threshold_exceeded' } })
    const mirror = await h.run(retention.id, { mirrorDryRunJobId: dry.id })
    expect(mirror.error?.code).toBe('delete_threshold_exceeded')
    expect(await listFiles(setup.copyRoot)).toHaveLength(20)

    await h.patch(`/v1/policies/${retention.id}`, { maxDeletePercent: 20 })
    const allowedDry = await h.s.runner.settled(h.s.runner.startBackup(retention.id, { actor: 'tester', dryRun: true }).id)
    expect((await h.run(retention.id, { mirrorDryRunJobId: allowedDry.id })).result).toMatchObject({ filesDeleted: 3 })
    expect(await listFiles(setup.copyRoot)).toHaveLength(17)
  })
})

// The real file system, except one folder this account may not read
class BlindFileSystem extends NodeFileSystem {
  blind: string | null = null

  override async *walk(root: string, skipDir?: (relPath: string) => boolean, onUnreadable?: (relPath: string, error: Error) => void): AsyncGenerator<FileEntry> {
    const blind = this.blind
    const inside = blind ? relative(root, blind).split(sep).join('/') : null
    let reported = false
    for await (const entry of super.walk(root, skipDir, onUnreadable)) {
      if (inside && !inside.startsWith('..') && (entry.relPath === inside || entry.relPath.startsWith(`${inside}/`))) {
        if (!reported) {
          const denied = Object.assign(new Error(`EPERM: operation not permitted, scandir '${blind}'`), { code: 'EPERM' })
          if (!onUnreadable) throw denied
          onUnreadable(inside, denied)
          reported = true
        }
        continue
      }
      yield entry
    }
  }
}

describe('carpetas que no se pueden leer', () => {
  it('A11 una carpeta del origen que no se puede leer se informa como fallida y sus copias no se toman por borradas', async () => {
    const blindFs = new BlindFileSystem()
    h = await createHarness({ fs: () => blindFs })
    const setup = await simpleSetup(h, { 'a.txt': 'a', 'privado/b.txt': 'b', 'privado/c.txt': 'c' })
    const policy = await h.policy(setup.projectId, { mode: 'retention', retentionDays: 7, sources: [setup.storage.id], destinations: [setup.backup.id] })
    expect((await h.run(policy.id)).status).toBe('succeeded')

    blindFs.blind = join(setup.sourceRoot, 'privado')
    await h.writeFile(setup.source, 'Fotos/nuevo.txt', 'nuevo')
    const run = await h.run(policy.id)
    expect(run.status).toBe('failed')
    expect(run.result).toMatchObject({ filesCopied: 1, filesDeleted: 0, filesFailed: 1, failed: [expect.objectContaining({ path: 'privado', code: 'unreadable' })] })
    expect(await listFiles(setup.copyRoot)).toEqual(['a.txt', 'nuevo.txt', 'privado/b.txt', 'privado/c.txt'])
  })
})
