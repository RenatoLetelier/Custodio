import { join } from 'node:path'
import { META_DIR } from './files.js'
import type { Assignment } from './model.js'
import { resolveInside } from './paths.js'

// Where things live on a destination folder:
//   <destino>/<origen>/<ruta>                        current copy
//   <destino>/.diskmanager/volume.json               self-description
//   <destino>/.diskmanager/versions/<fecha>/<origen>/<ruta>   previous versions of changed files
//   <destino>/.diskmanager/trash/<fecha>/<origen>/<ruta>      files deleted at the source (retention mode)

export const VERSIONS_DIR = 'versions'
export const TRASH_DIR = 'trash'

export function sourceDirName(label: string): string {
  const cleaned = [...label]
    .map((c) => (c.charCodeAt(0) < 32 ? '_' : c))
    .join('')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/[. ]+$/, '')
    .trim()
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? '_' : cleaned
}

export function assignmentRoot(mountPath: string, assignment: Pick<Assignment, 'folder'>): string {
  return resolveInside(mountPath, assignment.folder)
}

export function copyRoot(destinationRoot: string, source: Pick<Assignment, 'label'>): string {
  return join(destinationRoot, sourceDirName(source.label))
}

export const metaDir = (assignmentRootPath: string): string => join(assignmentRootPath, META_DIR)

// Folder names under versions/ and trash/: UTC stamps that sort and parse
export const stampOf = (date: Date): string => date.toISOString().replace(/[:.]/g, '-')

export function parseStamp(name: string): Date | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(name)
  if (!match) return null
  const date = new Date(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`)
  return Number.isNaN(date.getTime()) ? null : date
}
