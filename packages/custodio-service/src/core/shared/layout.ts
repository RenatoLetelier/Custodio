import { join } from 'node:path'
import { META_DIR } from './files.js'
import type { Assignment, Disk } from './model.js'
import { resolveInside } from './paths.js'

// Where things live on a destination folder:
//   <destino>/<ruta>                                 current copy, when the destination mirrors one source
//   <destino>/<origen>/<ruta>                        current copy, when it is shared by several sources
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

// How people read a folder: "D:\lc\prod" with the disk at hand, its model otherwise
export function displayFolder(disk: Pick<Disk, 'model' | 'mountPath'> | null, folder: string): string {
  if (disk?.mountPath) return join(disk.mountPath, ...folder.split('/').filter(Boolean))
  const inside = folder === '' ? '(todo el disco)' : folder.split('/').join('\\')
  return `${disk?.model ?? 'disco desconocido'}: ${inside}`
}

export function assignmentRoot(mountPath: string, assignment: Pick<Assignment, 'folder'>): string {
  return resolveInside(mountPath, assignment.folder)
}

// A destination that mirrors one source keeps that source's paths; a shared one gives each source its own folder
export function copyRoot(destinationRoot: string, source: Pick<Assignment, 'id' | 'label'>, destination?: Pick<Assignment, 'mirrorOf'>): string {
  return destination?.mirrorOf === source.id ? destinationRoot : join(destinationRoot, sourceDirName(source.label))
}

// Which sources a destination receives: all of them, unless it mirrors only one
export const receives = (destination: Pick<Assignment, 'mirrorOf'>, source: Pick<Assignment, 'id'>): boolean => !destination.mirrorOf || destination.mirrorOf === source.id

export const metaDir = (assignmentRootPath: string): string => join(assignmentRootPath, META_DIR)

// Folder names under versions/ and trash/: UTC stamps that sort and parse
export const stampOf = (date: Date): string => date.toISOString().replace(/[:.]/g, '-')

export function parseStamp(name: string): Date | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(name)
  if (!match) return null
  const date = new Date(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`)
  return Number.isNaN(date.getTime()) ? null : date
}
