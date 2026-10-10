import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AtomicCopier } from '../src/adapters/node/atomic-copier.js'
import { NodeFileSystem } from '../src/adapters/node/filesystem.js'
import { FaultyFileSystem, SimulatedPowerLoss } from '../src/adapters/sim/io.js'
import type { FileSystemPort } from '../src/core/ports/system.js'
import { CopyError } from '../src/core/shared/errors.js'
import { isCopierTemp } from '../src/core/shared/files.js'
import { hashTree, listFiles, sha256, simpleSetup } from './support/backup.js'
import { createHarness, MINUTE, type Harness } from './support/harness.js'

let h: Harness
afterEach(async () => h?.close())

const big = (seed: string, size: number) => Buffer.alloc(size, seed)

describe('respaldo incremental', () => {
  it('A9 copia solo lo faltante o modificado y lo verifica por hash', async () => {
    h = await createHarness()
    const setup = await simpleSetup(h, { 'a.jpg': 'uno', 'viaje/b.jpg': 'dos', 'viaje/c.jpg': 'tres' })
    const policy = await h.policy(setup.projectId, { sources: [setup.storage.id], destinations: [setup.backup.id] })

    const first = await h.run(policy.id)
    expect(first.status).toBe('succeeded')
    expect(first.result).toMatchObject({ filesCopied: 3, filesUpToDate: 0 })
    expect(await hashTree(setup.copyRoot)).toEqual(await hashTree(setup.sourceRoot))
    const manifest = h.s.core.store.manifest.list(setup.backup.id)
    expect(manifest.map((m) => [m.relPath, m.sha256])).toEqual([
      ['a.jpg', sha256('uno')],
      ['viaje/b.jpg', sha256('dos')],
      ['viaje/c.jpg', sha256('tres')]
    ])

    const second = await h.run(policy.id)
    expect(second.result).toMatchObject({ filesCopied: 0, filesUpToDate: 3 })

    h.clock.advance(2 * 60 * MINUTE)
    await h.writeFile(setup.source, 'Fotos/viaje/b.jpg', 'dos, editado')
    await h.writeFile(setup.source, 'Fotos/nuevo.jpg', 'cuatro')
    const third = await h.run(policy.id)
    expect(third.result).toMatchObject({ filesCopied: 2, filesUpToDate: 2, bytesCopied: 'dos, editado'.length + 'cuatro'.length })
    expect(await hashTree(setup.copyRoot)).toEqual(await hashTree(setup.sourceRoot))
    expect(h.events('backup.completed')).toHaveLength(3)
  })

  it('A9 es append-only: no borra nada en el destino y guarda la versión anterior de lo modificado', async () => {
    h = await createHarness()
    const setup = await simpleSetup(h, { 'a.txt': 'original', 'b.txt': 'se borrará' })
    const policy = await h.policy(setup.projectId, { sources: [setup.storage.id], destinations: [setup.backup.id] })
    await h.run(policy.id)

    h.clock.advance(2 * 60 * MINUTE)
    await h.writeFile(setup.source, 'Fotos/a.txt', 'cambiado')
    await (await import('node:fs/promises')).rm(join(setup.sourceRoot, 'b.txt'))
    const run = await h.run(policy.id)
    expect(run.result).toMatchObject({ filesCopied: 1, filesDeleted: 0 })

    expect(await readFile(join(setup.copyRoot, 'a.txt'), 'utf8')).toBe('cambiado')
    expect(await readFile(join(setup.copyRoot, 'b.txt'), 'utf8')).toBe('se borrará')
    const versions = join(setup.destination.mountPath, 'Copias', '.diskmanager', 'versions')
    const kept = await listFiles(versions, { meta: true })
    expect(kept).toHaveLength(1)
    expect(kept[0]).toMatch(/^[\dT-]+Z\/Fotos\/a\.txt$/)
    expect(await readFile(join(versions, ...(kept[0] as string).split('/')), 'utf8')).toBe('original')
  })

  it('A9 omite archivos incompletos: temporales .part y los modificados hace menos de 10 minutos', async () => {
    h = await createHarness()
    const setup = await simpleSetup(h, { 'listo.jpg': 'ok' })
    await h.writeFile(setup.source, 'Fotos/video.mp4.part', 'descargando', 2 * 60 * MINUTE)
    await h.writeFile(setup.source, 'Fotos/~$informe.docx', 'bloqueo de Word', 2 * 60 * MINUTE)
    await h.writeFile(setup.source, 'Fotos/recien.jpg', 'escribiéndose', 3 * MINUTE)
    const policy = await h.policy(setup.projectId, { sources: [setup.storage.id], destinations: [setup.backup.id] })

    const run = await h.run(policy.id)
    expect(run.result?.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'video.mp4.part', reason: 'incomplete' }),
        expect.objectContaining({ path: '~$informe.docx', reason: 'incomplete' }),
        expect.objectContaining({ path: 'recien.jpg', reason: 'not_quiet' })
      ])
    )
    expect(await listFiles(setup.copyRoot)).toEqual(['listo.jpg'])

    h.clock.advance(10 * MINUTE)
    await h.run(policy.id)
    expect(await listFiles(setup.copyRoot)).toEqual(['listo.jpg', 'recien.jpg'])
  })

  it('A9 copia a un temporal, verifica el hash y renombra de forma atómica; nunca sobrescribe en el sitio', async () => {
    h = await createHarness()
    const calls: string[] = []
    const inner = new NodeFileSystem()
    const spy = new Proxy(inner, {
      get(target, prop: keyof FileSystemPort) {
        const value = target[prop]
        if (typeof value !== 'function') return value
        return (...args: unknown[]) => {
          calls.push(`${String(prop)} ${args.filter((a) => typeof a === 'string').map((a) => (a as string).split(/[\\/]/).pop()).join(' -> ')}`)
          return (value as (...a: unknown[]) => unknown).apply(target, args)
        }
      }
    })
    const dir = join(h.root, 'copier')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'fuente.bin'), big('x', 300_000))
    const copier = new AtomicCopier(spy)

    const result = await copier.copy({ sourcePath: join(dir, 'fuente.bin'), destinationPath: join(dir, 'final.bin') })
    expect(result.sha256).toBe(sha256(big('x', 300_000)))
    const write = calls.find((c) => c.startsWith('openWrite'))
    const rename = calls.find((c) => c.startsWith('rename'))
    expect(write).toMatch(/^openWrite \.final\.bin\.custodio-[0-9a-f]{12}\.tmp$/)
    expect(rename).toMatch(/^rename \.final\.bin\.custodio-[0-9a-f]{12}\.tmp -> final\.bin$/)
    expect(calls.indexOf(rename as string)).toBeGreaterThan(calls.findIndex((c) => c.startsWith('openRead .final.bin')))

    await writeFile(join(dir, 'otra.bin'), 'nueva')
    await expect(copier.copy({ sourcePath: join(dir, 'otra.bin'), destinationPath: join(dir, 'final.bin') })).rejects.toMatchObject({ code: 'destination_exists' })
    expect(await readFile(join(dir, 'final.bin'))).toEqual(big('x', 300_000))
    expect((await readdir(dir)).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })

  it('A9 un hash que no coincide nunca llega al nombre final', async () => {
    h = await createHarness()
    const dir = join(h.root, 'copier')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'fuente.bin'), 'contenido')
    const inner = new NodeFileSystem()
    // Disk that silently corrupts what it stores
    const corrupting: FileSystemPort = Object.assign(Object.create(inner) as NodeFileSystem, {
      openWrite: async (path: string) => {
        const handle = await inner.openWrite(path)
        return { ...handle, write: (chunk: Uint8Array) => handle.write(Buffer.from(chunk).map((b) => b ^ 1)) }
      }
    })
    await expect(new AtomicCopier(corrupting).copy({ sourcePath: join(dir, 'fuente.bin'), destinationPath: join(dir, 'final.bin') })).rejects.toBeInstanceOf(CopyError)
    expect(await readdir(dir)).toEqual(['fuente.bin'])
  })

  it('A9 inyección de fallos: un corte a mitad de copia nunca deja un archivo corrupto visible y al reintentar los hashes coinciden', async () => {
    const files = { 'a.bin': big('a', 400_000), 'b.bin': big('b', 900_000), 'c.bin': big('c', 300_000) }
    let faulty!: FaultyFileSystem
    h = await createHarness({ fs: (inner) => (faulty = new FaultyFileSystem(inner)) })
    const setup = await simpleSetup(h, files)
    const policy = await h.policy(setup.projectId, { sources: [setup.storage.id], destinations: [setup.backup.id] })

    // The power goes out halfway through b.bin
    faulty.cutPowerAfter(400_000 + 450_000)
    const crashed = await h.run(policy.id)
    expect(crashed.status).toBe('failed')
    expect(crashed.error?.message).toBe(new SimulatedPowerLoss().message)

    // Only final names count as visible; the hidden copier temp is never mistaken for the file
    const visible = (await listFiles(setup.copyRoot)).filter((name) => !isCopierTemp(name))
    expect(visible).toEqual(['a.bin'])
    for (const name of visible) expect(await readFile(join(setup.copyRoot, name))).toEqual(files[name as keyof typeof files])
    const leftovers = (await readdir(setup.copyRoot)).filter((n) => n.endsWith('.tmp'))
    expect(leftovers).toHaveLength(1)
    expect(leftovers[0]).toMatch(/^\.b\.bin\.custodio-[0-9a-f]{12}\.tmp$/)
    expect((await readFile(join(setup.copyRoot, leftovers[0] as string))).length).toBe(450_000)

    // Power is back and the service starts again over the same disks
    faulty.restorePower()
    await h.restart()
    const retried = await h.run(policy.id)
    expect(retried.status).toBe('succeeded')
    expect(retried.result).toMatchObject({ filesCopied: 2, filesUpToDate: 1 })
    expect(await hashTree(setup.copyRoot)).toEqual(await hashTree(setup.sourceRoot))
    expect((await readdir(setup.copyRoot)).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })

  it('A9 es reanudable: una copia cancelada a la mitad sigue donde quedó y termina con los mismos hashes', async () => {
    let jobId = ''
    let copies = 0
    h = await createHarness({
      copier: (fs) => {
        const real = new AtomicCopier(fs)
        return {
          copy: async (request) => {
            const result = await real.copy(request)
            if (++copies === 3) h.s.runner.cancel(jobId, 'tester')
            return result
          }
        }
      }
    })
    const files = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`f${i}.bin`, big(String(i), 200_000)]))
    const setup = await simpleSetup(h, files)
    const policy = await h.policy(setup.projectId, { sources: [setup.storage.id], destinations: [setup.backup.id] })

    jobId = h.s.runner.startBackup(policy.id, { actor: 'tester' }).id
    const cancelled = await h.s.runner.settled(jobId)
    expect(cancelled.status).toBe('cancelled')
    expect(await listFiles(setup.copyRoot)).toEqual(['f0.bin', 'f1.bin', 'f2.bin'])

    const resumed = await h.run(policy.id)
    expect(resumed.status).toBe('succeeded')
    expect(resumed.result).toMatchObject({ filesUpToDate: 3, filesCopied: 3 })
    expect(await hashTree(setup.copyRoot)).toEqual(await hashTree(setup.sourceRoot))
  })
})
