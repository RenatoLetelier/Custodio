import { randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readFile, readdir, rename, rm, stat, unlink, utimes } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { FileEntry, FileStat, FileSystemPort, WriteHandle } from '../../core/ports/system.js'

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'
const isDenied = (error: unknown): boolean => ['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')

export class NodeFileSystem implements FileSystemPort {
  // Another program may remove files while this runs (finished uploads, temporaries): those are skipped
  async *walk(root: string, skipDir?: (relPath: string) => boolean, onUnreadable?: (relPath: string, error: Error) => void): AsyncIterable<FileEntry> {
    const pending: string[] = ['']
    while (pending.length > 0) {
      const rel = pending.pop() as string
      let entries
      try {
        entries = await readdir(join(root, ...rel.split('/').filter(Boolean)), { withFileTypes: true })
      } catch (error) {
        if (isMissing(error)) continue
        if (rel !== '' && onUnreadable && isDenied(error)) {
          onUnreadable(rel, error as Error)
          continue
        }
        throw error
      }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
        if (entry.isDirectory()) {
          if (!skipDir?.(childRel)) pending.push(childRel)
        } else if (entry.isFile()) {
          let info
          try {
            info = await stat(join(root, ...childRel.split('/')))
          } catch (error) {
            if (isMissing(error)) continue
            if (onUnreadable && isDenied(error)) {
              onUnreadable(childRel, error as Error)
              continue
            }
            throw error
          }
          yield { relPath: childRel, size: info.size, mtimeMs: Math.floor(info.mtimeMs) }
        }
      }
    }
  }

  async stat(path: string): Promise<FileStat | null> {
    try {
      const info = await stat(path)
      return { size: info.size, mtimeMs: Math.floor(info.mtimeMs), isFile: info.isFile(), isDirectory: info.isDirectory() }
    } catch (error) {
      if (isMissing(error)) return null
      throw error
    }
  }

  async mkdirp(path: string): Promise<void> {
    await mkdir(path, { recursive: true })
  }

  async readDir(path: string): Promise<{ name: string; isDirectory: boolean }[]> {
    try {
      return (await readdir(path, { withFileTypes: true })).map((e) => ({ name: e.name, isDirectory: e.isDirectory() }))
    } catch (error) {
      if (isMissing(error)) return []
      throw error
    }
  }

  async *openRead(path: string): AsyncIterable<Uint8Array> {
    for await (const chunk of createReadStream(path, { highWaterMark: 256 * 1024 })) yield chunk as Buffer
  }

  async openWrite(path: string): Promise<WriteHandle> {
    const handle = await open(path, 'wx')
    return {
      write: async (chunk) => {
        let offset = 0
        while (offset < chunk.byteLength) offset += (await handle.write(chunk, offset)).bytesWritten
      },
      sync: () => handle.sync(),
      close: () => handle.close()
    }
  }

  async rename(from: string, to: string): Promise<void> {
    await rename(from, to)
  }

  async removeFile(path: string): Promise<void> {
    try {
      await unlink(path)
    } catch (error) {
      if (!isMissing(error)) throw error
    }
  }

  async removeTree(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true })
  }

  async setMtime(path: string, mtimeMs: number): Promise<void> {
    const time = new Date(mtimeMs)
    await utimes(path, time, time)
  }

  async readText(path: string): Promise<string | null> {
    try {
      return await readFile(path, 'utf8')
    } catch (error) {
      if (isMissing(error)) return null
      throw error
    }
  }

  async writeTextAtomic(path: string, text: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    const temp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`)
    const handle = await open(temp, 'wx')
    try {
      await handle.writeFile(text, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temp, path)
  }
}
