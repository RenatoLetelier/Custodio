import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NodeFileSystem } from '../src/adapters/node/filesystem.js'
import type { FileSystemPort } from '../src/core/ports/system.js'
import { isSkippedDir } from '../src/core/shared/files.js'
import { createHarness, type Harness } from './support/harness.js'

const GB = 1_000_000_000
let h: Harness
let measured = 0
afterEach(async () => h?.close())

// Counts how many folders get measured
const counting = (inner: FileSystemPort): FileSystemPort =>
  new Proxy(inner, {
    get(target, key) {
      if (key === 'sizeOf') {
        return (root: string, skipDir?: (relPath: string) => boolean) => {
          measured++
          return target.sizeOf(root, skipDir)
        }
      }
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })

async function localcloud() {
  measured = 0
  h = await createHarness({ fs: counting })
  const datos = await h.addDisk('datos', { totalBytes: 2000 * GB, freeBytes: 800 * GB })
  const respaldo = await h.addDisk('respaldo', { totalBytes: 2000 * GB, freeBytes: 1900 * GB })
  await h.scan()
  await h.writeFile(datos, 'lc/prod/blobs/aa/bb/aabb01', 'un blob')
  await h.writeFile(datos, 'LocalProcessor-Photos/2024/foto.jpg', 'una foto')
  const body = (projectId?: string) => ({
    ...(projectId ? { projectId } : {}),
    name: 'Localcloud',
    sources: [
      { diskId: h.diskId(datos), folder: 'lc/prod' },
      { diskId: h.diskId(datos), folder: 'LocalProcessor-Photos' }
    ],
    destinations: [h.diskId(respaldo)],
    schedule: { cron: '0 3 * * *', timezone: 'America/Santiago' }
  })
  return { datos, respaldo, body }
}

describe('medir carpetas', () => {
  it('A6 medir una carpeta suma todos sus archivos, también en subcarpetas, y deja fuera lo propio de Custodio', async () => {
    const root = await mkdtemp(join(tmpdir(), 'custodio-measure-'))
    try {
      for (let i = 0; i < 40; i++) {
        await mkdir(join(root, 'blobs', `d${i % 7}`, `e${i % 3}`), { recursive: true })
        await writeFile(join(root, 'blobs', `d${i % 7}`, `e${i % 3}`, `f${i}`), 'x'.repeat(i + 1))
      }
      await mkdir(join(root, '.diskmanager', 'trash'), { recursive: true })
      await writeFile(join(root, '.diskmanager', 'trash', 'viejo'), 'no cuenta')
      await writeFile(join(root, 'raiz.txt'), '12345')
      const fs = new NodeFileSystem()
      expect(await fs.sizeOf(root, isSkippedDir)).toBe((40 * 41) / 2 + 5)
      let walked = 0
      for await (const entry of fs.walk(root, isSkippedDir)) walked += entry.size
      expect(await fs.sizeOf(root, isSkippedDir)).toBe(walked)
      expect(await fs.sizeOf(join(root, 'no-existe'))).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('A6 si el espacio libre del disco de respaldo ya alcanza para todo lo usado en el original, revisar el proyecto no mide carpetas', async () => {
    const { body } = await localcloud()
    const proposal = await h.post('/v1/setups', body())
    expect(proposal.status).toBe(201)
    expect(measured).toBe(0)
  })

  it('A6 si el espacio no alcanza a simple vista, revisar mide las carpetas una vez y confirmar no las vuelve a medir', async () => {
    const { respaldo, body } = await localcloud()
    h.volumes.set(respaldo.mountPath, { totalBytes: 2000 * GB, freeBytes: 500 * GB })
    const proposal = await h.post('/v1/setups', body())
    expect(proposal.status).toBe(201)
    // Two folders on the source and their two copies
    expect(measured).toBe(4)
    const confirmed = await h.post(`/v1/plans/${proposal.body.plan.id}/confirm`, { confirm: true })
    expect(confirmed.status).toBe(200)
    expect(measured).toBe(4)
  })

  it('A6 pausar, reanudar o cambiar el horario de una copia no vuelve a medir las carpetas', async () => {
    const { respaldo, body } = await localcloud()
    const proposal = await h.post('/v1/setups', body())
    const { projectId } = (await h.post(`/v1/plans/${proposal.body.plan.id}/confirm`, { confirm: true })).body.result
    const [policy] = (await h.get(`/v1/projects/${projectId}`)).body.policies
    h.volumes.set(respaldo.mountPath, { totalBytes: 2000 * GB, freeBytes: 500 * GB })
    measured = 0

    expect((await h.patch(`/v1/policies/${policy.id}`, { paused: true })).status).toBe(200)
    expect((await h.patch(`/v1/policies/${policy.id}`, { paused: false })).status).toBe(200)
    expect((await h.patch(`/v1/policies/${policy.id}`, { cron: '0 4 * * *' })).status).toBe(200)
    expect(measured).toBe(0)

    // Changing what is copied does measure again
    expect((await h.patch(`/v1/policies/${policy.id}`, { sources: policy.sources.slice(0, 1) })).status).toBe(200)
    expect(measured).toBeGreaterThan(0)
  })
})
