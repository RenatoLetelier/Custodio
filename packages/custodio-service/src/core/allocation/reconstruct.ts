import { join } from 'node:path'
import { sameDisk } from '../inventory-health/inventory.js'
import type { FileSystemPort } from '../ports/system.js'
import type { Core } from '../shared/context.js'
import { DomainError } from '../shared/errors.js'
import { META_DIR } from '../shared/files.js'
import type { Assignment, Policy } from '../shared/model.js'
import {
  DESCRIPTOR_FILE,
  parseDescriptor,
  parseIndex,
  indexPath,
  type DescribedAssignment,
  type DescribedPolicy,
  type VolumeDescriptor
} from './descriptor.js'

export interface MountedVolume {
  mountPath: string
}

export interface FoundDescriptor {
  mountPath: string
  folder: string
  descriptor: VolumeDescriptor
}

export interface ReconstructedProject {
  id: string
  name: string
  createdAt: string
  revision: number
  assignments: DescribedAssignment[]
  policies: DescribedPolicy[]
  foundOn: { mountPath: string; folder: string; revision: number }[]
}

const SEARCH_DEPTH = 3

async function searchDescriptors(fs: FileSystemPort, mountPath: string, rel: string, depth: number, found: string[]): Promise<void> {
  const dir = rel === '' ? mountPath : join(mountPath, ...rel.split('/'))
  const entries = await fs.readDir(dir)
  if (entries.some((e) => e.isDirectory && e.name === META_DIR) && (await fs.stat(join(dir, META_DIR, DESCRIPTOR_FILE)))?.isFile) found.push(rel)
  if (depth === 0) return
  for (const entry of entries) {
    if (!entry.isDirectory || entry.name.startsWith('.') || entry.name.startsWith('$')) continue
    await searchDescriptors(fs, mountPath, rel === '' ? entry.name : `${rel}/${entry.name}`, depth - 1, found)
  }
}

// Reads every volume.json it can find: the index first, a shallow search when the index is missing
export async function discoverDescriptors(fs: FileSystemPort, mountPath: string): Promise<FoundDescriptor[]> {
  const index = parseIndex(await fs.readText(indexPath(mountPath)))
  const folders: string[] = index ? index.folders.map((f) => f.folder) : []
  if (!index) await searchDescriptors(fs, mountPath, '', SEARCH_DEPTH, folders)

  const found: FoundDescriptor[] = []
  for (const folder of new Set(folders)) {
    const path = folder === '' ? join(mountPath, META_DIR, DESCRIPTOR_FILE) : join(mountPath, ...folder.split('/'), META_DIR, DESCRIPTOR_FILE)
    const descriptor = parseDescriptor(await fs.readText(path))
    if (descriptor) found.push({ mountPath, folder, descriptor })
  }
  return found
}

// Rebuilds project configuration from the disks alone; the newest revision seen on any disk wins
export async function reconstructProjects(fs: FileSystemPort, volumes: MountedVolume[]): Promise<ReconstructedProject[]> {
  const projects = new Map<string, ReconstructedProject>()
  for (const volume of volumes) {
    for (const found of await discoverDescriptors(fs, volume.mountPath)) {
      const p = found.descriptor.project
      const current = projects.get(p.id)
      const location = { mountPath: found.mountPath, folder: found.folder, revision: p.revision }
      if (!current || p.revision > current.revision) {
        projects.set(p.id, {
          id: p.id,
          name: p.name,
          createdAt: p.createdAt,
          revision: p.revision,
          assignments: p.assignments,
          policies: p.policies,
          foundOn: [...(current?.foundOn ?? []), location]
        })
      } else {
        current.foundOn.push(location)
      }
    }
  }
  return [...projects.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export class RecoveryService {
  constructor(private readonly core: Core) {}

  async reconstruct(): Promise<ReconstructedProject[]> {
    const volumes = this.core.store.disks
      .list()
      .filter((d) => d.connected && d.mountPath)
      .map((d) => ({ mountPath: d.mountPath as string }))
    return reconstructProjects(this.core.fs, volumes)
  }

  // Loads a reconstructed project into an empty database; disks must have been scanned first
  import(project: ReconstructedProject, actor: string): void {
    const { store } = this.core
    const disks = store.disks.list()
    store.transaction(() => {
      if (store.projects.get(project.id) || store.projects.findByName(project.name)) {
        throw new DomainError('conflict', `El proyecto "${project.name}" ya existe.`)
      }
      store.projects.insert({ id: project.id, name: project.name, createdAt: project.createdAt, revision: project.revision })
      for (const described of project.assignments) {
        const disk = disks.find((d) => sameDisk(d, described.disk))
        if (!disk) throw new DomainError('unprocessable', `Conecta el disco ${described.disk.model} (${described.disk.serial ?? 'sin serie'}) para recuperar "${project.name}".`)
        const assignment: Assignment = {
          id: described.id,
          projectId: project.id,
          diskId: disk.id,
          folder: described.folder,
          role: described.role,
          label: described.label,
          createdAt: project.createdAt
        }
        store.assignments.insert(assignment)
      }
      for (const described of project.policies) {
        const policy: Policy = {
          ...described,
          projectId: project.id,
          lastScheduledFor: null,
          lastSuccessAt: null,
          lastVerifiedAt: null,
          overdueSince: null
        }
        store.policies.insert(policy)
      }
      this.core.audit.record({ actor, action: 'project.recovered', target: project.id, details: { revision: project.revision } })
    })
  }
}
