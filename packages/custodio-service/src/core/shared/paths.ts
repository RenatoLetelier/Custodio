import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { DomainError } from './errors.js'

// Names Windows refuses or treats specially; also blocks control characters
const FORBIDDEN_CHARS = /[<>:"|?*]/
export const hasControlChars = (value: string): boolean => [...value].some((c) => c.charCodeAt(0) < 32)
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i

// Validates a relative path ("Fotos/2024/a.jpg") and returns its normalised segments
export function relativeSegments(relPath: string): string[] {
  if (relPath === '') return []
  if (isAbsolute(relPath) || /^[a-zA-Z]:/.test(relPath) || relPath.startsWith('\\\\')) {
    throw new DomainError('invalid_path', `La ruta "${relPath}" debe ser relativa.`)
  }
  const segments = relPath.split(/[\\/]+/).filter((s) => s !== '' && s !== '.')
  for (const segment of segments) {
    if (segment === '..') throw new DomainError('invalid_path', `La ruta "${relPath}" sale de la carpeta asignada.`)
    if (FORBIDDEN_CHARS.test(segment) || hasControlChars(segment) || RESERVED.test(segment) || /[. ]$/.test(segment)) {
      throw new DomainError('invalid_path', `La ruta "${relPath}" contiene un nombre no permitido.`)
    }
  }
  return segments
}

export function normalizeRelative(relPath: string): string {
  return relativeSegments(relPath).join('/')
}

// Resolves relPath under root and guarantees the result stays inside root
export function resolveInside(root: string, relPath: string): string {
  const base = resolve(root)
  const target = resolve(join(base, ...relativeSegments(relPath)))
  if (!isInside(base, target)) throw new DomainError('invalid_path', `La ruta "${relPath}" sale de la carpeta asignada.`)
  return target
}

export function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

// Folder relations between two relative folders on the same volume
export function foldersOverlap(a: string, b: string): boolean {
  const x = normalizeRelative(a)
  const y = normalizeRelative(b)
  return x === y || x === '' || y === '' || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)
}
