import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { Assignment } from '../../src/core/shared/model.js'
import type { Harness, SimDisk } from './harness.js'

export const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')

export async function hashFile(path: string): Promise<string> {
  return sha256(await readFile(path))
}

// Files under a folder, relative and with forward slashes; ".diskmanager" can be left out
export async function listFiles(root: string, options: { meta?: boolean } = {}): Promise<string[]> {
  let entries
  try {
    entries = await readdir(root, { recursive: true, withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isFile())
    .map((e) => relative(root, join(e.parentPath, e.name)).split(sep).join('/'))
    .filter((path) => options.meta || !path.split('/').includes('.diskmanager'))
    .sort()
}

export async function hashTree(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const file of await listFiles(root)) out[file] = await hashFile(join(root, ...file.split('/')))
  return out
}

export interface SimpleSetup {
  source: SimDisk
  destination: SimDisk
  projectId: string
  storage: Assignment
  backup: Assignment
  sourceRoot: string
  copyRoot: string
}

// One storage folder "Fotos" on one disk copied into "Copias" on another disk
export async function simpleSetup(h: Harness, files: Record<string, string | Buffer> = {}): Promise<SimpleSetup> {
  const source = await h.addDisk('origen')
  const destination = await h.addDisk('destino')
  await h.scan()
  for (const [path, content] of Object.entries(files)) await h.writeFile(source, `Fotos/${path}`, content)
  const { projectId, assignments } = await h.project('Familia', [
    { disk: source, folder: 'Fotos', role: 'storage' },
    { disk: destination, folder: 'Copias', role: 'backup' }
  ])
  const storage = assignments.find((a) => a.role === 'storage') as Assignment
  const backup = assignments.find((a) => a.role === 'backup') as Assignment
  return {
    source,
    destination,
    projectId,
    storage,
    backup,
    sourceRoot: join(source.mountPath, 'Fotos'),
    copyRoot: join(destination.mountPath, 'Copias', storage.label)
  }
}
