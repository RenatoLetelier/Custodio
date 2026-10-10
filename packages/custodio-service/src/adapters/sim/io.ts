import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import type { Clock, Copier, CopyRequest, CopyResult, FileSystemPort, Meter, WriteHandle } from '../../core/ports/system.js'

// Scriptable copier for tests that care about scheduling, not about bytes: can block or fail on demand
export class SimCopier implements Copier {
  readonly calls: CopyRequest[] = []
  gate: Promise<void> | null = null
  failWhen: ((request: CopyRequest) => Error | null) | null = null

  constructor(private readonly fs: FileSystemPort) {}

  async copy(request: CopyRequest): Promise<CopyResult> {
    this.calls.push(request)
    if (this.gate) await this.gate
    request.signal?.throwIfAborted()
    const failure = this.failWhen?.(request)
    if (failure) throw failure

    await this.fs.mkdirp(dirname(request.destinationPath))
    await request.beforeCommit?.()
    const out = await this.fs.openWrite(request.destinationPath)
    const hash = createHash('sha256')
    let bytes = 0
    for await (const chunk of this.fs.openRead(request.sourcePath)) {
      hash.update(chunk)
      await out.write(chunk)
      bytes += chunk.byteLength
      await request.onChunk?.(chunk.byteLength)
    }
    await out.close()
    if (request.mtimeMs !== undefined) await this.fs.setMtime(request.destinationPath, request.mtimeMs)
    return { bytes, sha256: hash.digest('hex') }
  }
}

export class SimMeter implements Meter {
  readonly samples: { atMs: number; bytes: number }[] = []

  constructor(private readonly clock: Clock) {}

  record(bytes: number): void {
    this.samples.push({ atMs: this.clock.now().getTime(), bytes })
  }

  // Highest number of bytes recorded inside any window of the given length
  peakBytes(windowMs: number): number {
    let peak = 0
    for (const start of this.samples) {
      const total = this.samples.filter((s) => s.atMs >= start.atMs && s.atMs < start.atMs + windowMs).reduce((sum, s) => sum + s.bytes, 0)
      peak = Math.max(peak, total)
    }
    return peak
  }

  get totalBytes(): number {
    return this.samples.reduce((sum, s) => sum + s.bytes, 0)
  }
}

export class SimulatedPowerLoss extends Error {
  constructor() {
    super('Simulated power loss')
    this.name = 'SimulatedPowerLoss'
  }
}

// Wraps a real filesystem and "cuts the power" after N bytes have been written: from then on every call fails
export class FaultyFileSystem implements FileSystemPort {
  private written = 0
  dead = false

  constructor(
    private readonly inner: FileSystemPort,
    private readonly failAfterBytes: number
  ) {}

  private alive(): void {
    if (this.dead) throw new SimulatedPowerLoss()
  }

  walk(root: string, skipDir?: (relPath: string) => boolean) {
    this.alive()
    return this.inner.walk(root, skipDir)
  }
  async stat(path: string) {
    this.alive()
    return this.inner.stat(path)
  }
  async mkdirp(path: string) {
    this.alive()
    return this.inner.mkdirp(path)
  }
  async readDir(path: string) {
    this.alive()
    return this.inner.readDir(path)
  }
  openRead(path: string) {
    this.alive()
    return this.inner.openRead(path)
  }
  async openWrite(path: string): Promise<WriteHandle> {
    this.alive()
    const handle = await this.inner.openWrite(path)
    return {
      write: async (chunk) => {
        this.alive()
        const room = this.failAfterBytes - this.written
        if (chunk.byteLength >= room) {
          await handle.write(chunk.subarray(0, Math.max(0, room)))
          await handle.close()
          this.dead = true
          throw new SimulatedPowerLoss()
        }
        this.written += chunk.byteLength
        await handle.write(chunk)
      },
      sync: async () => {
        this.alive()
        await handle.sync()
      },
      close: async () => {
        this.alive()
        await handle.close()
      }
    }
  }
  async rename(from: string, to: string) {
    this.alive()
    return this.inner.rename(from, to)
  }
  async removeFile(path: string) {
    this.alive()
    return this.inner.removeFile(path)
  }
  async removeTree(path: string) {
    this.alive()
    return this.inner.removeTree(path)
  }
  async setMtime(path: string, mtimeMs: number) {
    this.alive()
    return this.inner.setMtime(path, mtimeMs)
  }
  async readText(path: string) {
    this.alive()
    return this.inner.readText(path)
  }
  async writeTextAtomic(path: string, text: string) {
    this.alive()
    return this.inner.writeTextAtomic(path, text)
  }
}
