import { join } from 'node:path'
import { z } from 'zod'
import type { Core } from '../shared/context.js'
import { notFound } from '../shared/errors.js'
import { META_DIR } from '../shared/files.js'
import { assignmentRoot } from '../shared/layout.js'
import type { Assignment, Disk, Policy } from '../shared/model.js'
import { PolicyStoredSchema, RoleSchema } from '../shared/policy.js'

export const DESCRIPTOR_FILE = 'volume.json'
export const INDEX_FILE = 'index.json'

export const DiskIdentitySchema = z.object({
  serial: z.string().nullable(),
  wwn: z.string().nullable(),
  model: z.string()
})

const AssignmentInfoSchema = z.object({
  id: z.string(),
  folder: z.string(),
  role: RoleSchema,
  label: z.string()
})

export const DescribedAssignmentSchema = AssignmentInfoSchema.extend({ disk: DiskIdentitySchema })
export const DescribedPolicySchema = PolicyStoredSchema.extend({ id: z.string(), createdAt: z.string() })

// .diskmanager/volume.json: enough for any single disk to rebuild its whole project
export const VolumeDescriptorSchema = z.object({
  format: z.literal('custodio.volume/1'),
  writtenAt: z.string(),
  disk: DiskIdentitySchema,
  assignment: AssignmentInfoSchema,
  project: z.object({
    id: z.string(),
    name: z.string(),
    createdAt: z.string(),
    revision: z.number().int(),
    assignments: z.array(DescribedAssignmentSchema),
    policies: z.array(DescribedPolicySchema)
  })
})

export const VolumeIndexSchema = z.object({
  format: z.literal('custodio.index/1'),
  folders: z.array(z.object({ folder: z.string(), projectId: z.string(), assignmentId: z.string() }))
})

export type VolumeDescriptor = z.infer<typeof VolumeDescriptorSchema>
export type DescribedAssignment = z.infer<typeof DescribedAssignmentSchema>
export type DescribedPolicy = z.infer<typeof DescribedPolicySchema>
type VolumeIndex = z.infer<typeof VolumeIndexSchema>

export const descriptorPath = (mountPath: string, folder: string): string => join(assignmentRoot(mountPath, { folder }), META_DIR, DESCRIPTOR_FILE)
export const indexPath = (mountPath: string): string => join(mountPath, META_DIR, INDEX_FILE)

const identity = (disk: Disk | undefined) => ({ serial: disk?.serial ?? null, wwn: disk?.wwn ?? null, model: disk?.model ?? '' })

export const describePolicy = (p: Policy): DescribedPolicy => ({
  id: p.id,
  createdAt: p.createdAt,
  name: p.name,
  sources: p.sources,
  destinations: p.destinations,
  cron: p.cron,
  timezone: p.timezone,
  mode: p.mode,
  retentionDays: p.retentionDays,
  maxDeletePercent: p.maxDeletePercent,
  mirrorConfirmed: p.mirrorConfirmed,
  maxMegabytesPerSecond: p.maxMegabytesPerSecond,
  window: p.window,
  verifySamplePercent: p.verifySamplePercent,
  verifyEveryHours: p.verifyEveryHours,
  paused: p.paused
})

export function parseDescriptor(text: string | null): VolumeDescriptor | null {
  if (text === null) return null
  try {
    const parsed = VolumeDescriptorSchema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function parseIndex(text: string | null): VolumeIndex | null {
  if (text === null) return null
  try {
    const parsed = VolumeIndexSchema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export class DescriptorService {
  constructor(private readonly core: Core) {}

  build(projectId: string, assignment: Assignment): VolumeDescriptor {
    const { store } = this.core
    const project = store.projects.get(projectId)
    if (!project) throw notFound('el proyecto', projectId)
    const disks = new Map(store.disks.list().map((d) => [d.id, d]))
    return {
      format: 'custodio.volume/1',
      writtenAt: this.core.clock.now().toISOString(),
      disk: identity(disks.get(assignment.diskId)),
      assignment: { id: assignment.id, folder: assignment.folder, role: assignment.role, label: assignment.label },
      project: {
        id: project.id,
        name: project.name,
        createdAt: project.createdAt,
        revision: project.revision,
        assignments: store.assignments.byProject(projectId).map((a) => ({
          id: a.id,
          folder: a.folder,
          role: a.role,
          label: a.label,
          disk: identity(disks.get(a.diskId))
        })),
        policies: store.policies.byProject(projectId).map(describePolicy)
      }
    }
  }

  async read(mountPath: string, folder: string): Promise<VolumeDescriptor | null> {
    return parseDescriptor(await this.core.fs.readText(descriptorPath(mountPath, folder)))
  }

  // Writes volume.json into every connected folder of the project; disconnected ones catch up on reconnect
  async writeProject(projectId: string): Promise<{ written: string[]; skipped: string[] }> {
    const written: string[] = []
    const skipped: string[] = []
    for (const assignment of this.core.store.assignments.byProject(projectId)) {
      const disk = this.core.store.disks.get(assignment.diskId)
      if (!disk?.connected || !disk.mountPath) {
        skipped.push(assignment.id)
        continue
      }
      await this.writeOne(disk.mountPath, this.build(projectId, assignment))
      written.push(assignment.id)
    }
    return { written, skipped }
  }

  async syncConnected(): Promise<string[]> {
    const refreshed: string[] = []
    for (const project of this.core.store.projects.list()) {
      for (const assignment of this.core.store.assignments.byProject(project.id)) {
        const disk = this.core.store.disks.get(assignment.diskId)
        if (!disk?.connected || !disk.mountPath) continue
        const current = await this.read(disk.mountPath, assignment.folder)
        if (current && current.project.revision >= project.revision && current.assignment.role === assignment.role) continue
        await this.writeOne(disk.mountPath, this.build(project.id, assignment))
        refreshed.push(assignment.id)
      }
    }
    return refreshed
  }

  async forget(mountPath: string, assignment: Pick<Assignment, 'id' | 'folder'>): Promise<void> {
    const { fs } = this.core
    await fs.removeFile(descriptorPath(mountPath, assignment.folder))
    const index = parseIndex(await fs.readText(indexPath(mountPath)))
    if (!index) return
    await fs.writeTextAtomic(indexPath(mountPath), json({ ...index, folders: index.folders.filter((f) => f.assignmentId !== assignment.id) }))
  }

  private async writeOne(mountPath: string, descriptor: VolumeDescriptor): Promise<void> {
    const { fs } = this.core
    await fs.mkdirp(assignmentRoot(mountPath, descriptor.assignment))
    await fs.writeTextAtomic(descriptorPath(mountPath, descriptor.assignment.folder), json(descriptor))
    const index = parseIndex(await fs.readText(indexPath(mountPath))) ?? { format: 'custodio.index/1', folders: [] }
    const folders = index.folders.filter((f) => f.assignmentId !== descriptor.assignment.id && f.folder !== descriptor.assignment.folder)
    folders.push({ folder: descriptor.assignment.folder, projectId: descriptor.project.id, assignmentId: descriptor.assignment.id })
    await fs.writeTextAtomic(indexPath(mountPath), json({ format: 'custodio.index/1', folders }))
  }
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`
