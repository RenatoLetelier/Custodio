import type { BusType } from '../shared/model.js'

export interface Clock {
  now(): Date
  sleep(ms: number, signal?: AbortSignal): Promise<void>
}

export interface PhysicalDiskInfo {
  serial: string | null
  wwn: string | null
  model: string
  sizeBytes: number
  bus: BusType
  devicePath: string
  mountPath: string | null
}

export interface DiskProbe {
  listDisks(): Promise<PhysicalDiskInfo[]>
}

export interface SmartReading {
  supported: boolean
  passed: boolean | null
  // Raw values keyed by SMART attribute id ("5", "197", "199"…)
  attributes: Record<string, number>
  temperatureC: number | null
  powerOnHours: number | null
}

export interface SmartReader {
  read(devicePath: string): Promise<SmartReading | null>
}

export interface VolumeUsage {
  totalBytes: number
  freeBytes: number
}

export interface VolumeReader {
  usage(mountPath: string): Promise<VolumeUsage | null>
}

export interface FileStat {
  size: number
  mtimeMs: number
  isFile: boolean
  isDirectory: boolean
}

export interface FileEntry {
  // Relative to the walked root, with forward slashes
  relPath: string
  size: number
  mtimeMs: number
}

export interface WriteHandle {
  write(chunk: Uint8Array): Promise<void>
  sync(): Promise<void>
  close(): Promise<void>
}

export interface FileSystemPort {
  walk(root: string, skipDir?: (relPath: string) => boolean): AsyncIterable<FileEntry>
  stat(path: string): Promise<FileStat | null>
  mkdirp(path: string): Promise<void>
  readDir(path: string): Promise<{ name: string; isDirectory: boolean }[]>
  openRead(path: string): AsyncIterable<Uint8Array>
  // Fails if the file already exists
  openWrite(path: string): Promise<WriteHandle>
  rename(from: string, to: string): Promise<void>
  removeFile(path: string): Promise<void>
  removeTree(path: string): Promise<void>
  setMtime(path: string, mtimeMs: number): Promise<void>
  readText(path: string): Promise<string | null>
  writeTextAtomic(path: string, text: string): Promise<void>
}

export interface CopyRequest {
  sourcePath: string
  destinationPath: string
  mtimeMs?: number
  signal?: AbortSignal
  // Called after each chunk lands; throttling and time windows hook in here
  onChunk?: (bytes: number) => Promise<void>
  // Runs after the copy is verified and right before it becomes visible (moves the previous version aside)
  beforeCommit?: () => Promise<void>
}

export interface CopyResult {
  bytes: number
  sha256: string
}

export interface Copier {
  copy(request: CopyRequest): Promise<CopyResult>
}

export interface Meter {
  record(bytes: number): void
}

export interface Logger {
  info(message: string, data?: Record<string, unknown>): void
  warn(message: string, data?: Record<string, unknown>): void
  error(message: string, data?: Record<string, unknown>): void
}

export const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} }
