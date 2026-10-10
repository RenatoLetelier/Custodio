import { createHash } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import type { Copier, CopyRequest, CopyResult, FileSystemPort } from '../../core/ports/system.js'
import { CopyError } from '../../core/shared/errors.js'
import { copierTempName, sha256Of } from '../../core/shared/files.js'

// ADR-001: write to a temp file next to the destination, verify the hash, rename atomically, never overwrite in place
export class AtomicCopier implements Copier {
  constructor(private readonly fs: FileSystemPort) {}

  async copy(request: CopyRequest): Promise<CopyResult> {
    const { sourcePath, destinationPath, signal } = request
    const before = await this.fs.stat(sourcePath)
    if (!before?.isFile) throw new CopyError('source_missing', `No se encontró ${sourcePath}.`)

    await this.fs.mkdirp(dirname(destinationPath))
    const temp = join(dirname(destinationPath), copierTempName(basename(destinationPath)))
    const out = await this.fs.openWrite(temp)
    const hash = createHash('sha256')
    let bytes = 0
    let open = true

    try {
      for await (const chunk of this.fs.openRead(sourcePath)) {
        signal?.throwIfAborted()
        hash.update(chunk)
        await out.write(chunk)
        bytes += chunk.byteLength
        await request.onChunk?.(chunk.byteLength)
      }
      await out.sync()
      await out.close()
      open = false

      const sha256 = hash.digest('hex')
      const after = await this.fs.stat(sourcePath)
      if (!after || after.size !== before.size || after.mtimeMs !== before.mtimeMs || bytes !== before.size) {
        throw new CopyError('source_changed', `${sourcePath} cambió mientras se copiaba.`)
      }
      if ((await sha256Of(this.fs, temp)) !== sha256) {
        throw new CopyError('hash_mismatch', `La copia de ${sourcePath} no coincide con el original.`)
      }
      if (request.mtimeMs !== undefined) await this.fs.setMtime(temp, request.mtimeMs)

      await request.beforeCommit?.()
      if (await this.fs.stat(destinationPath)) {
        throw new CopyError('destination_exists', `${destinationPath} ya existe y no se sobrescribe.`)
      }
      await this.fs.rename(temp, destinationPath)
      return { bytes, sha256 }
    } catch (error) {
      if (open) await out.close().catch(() => undefined)
      await this.fs.removeFile(temp).catch(() => undefined)
      throw error
    }
  }
}
