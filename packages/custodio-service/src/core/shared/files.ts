import { createHash, randomBytes } from 'node:crypto'
import type { FileSystemPort } from '../ports/system.js'

export const META_DIR = '.diskmanager'

// Copier temp files live next to their destination, hidden and recognisable: ".name.custodio-<hex>.tmp"
const TEMP_PATTERN = /^\..+\.custodio-[0-9a-f]{12}\.tmp$/

export const copierTempName = (finalName: string): string => `.${finalName}.custodio-${randomBytes(6).toString('hex')}.tmp`
export const isCopierTemp = (name: string): boolean => TEMP_PATTERN.test(name)

// Files still being written by other programs are never copied
const INCOMPLETE_SUFFIXES = ['.part', '.partial', '.crdownload', '.download', '.opdownload']
export const QUIET_WINDOW_MS = 10 * 60 * 1000

export function isIncompleteName(name: string): boolean {
  const lower = name.toLowerCase()
  return INCOMPLETE_SUFFIXES.some((suffix) => lower.endsWith(suffix)) || name.startsWith('~$')
}

export const baseName = (relPath: string): string => relPath.slice(relPath.lastIndexOf('/') + 1)

export async function sha256Of(fs: FileSystemPort, path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of fs.openRead(path)) hash.update(chunk)
  return hash.digest('hex')
}
