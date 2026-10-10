import { descriptorPath, parseDescriptor } from '../allocation/descriptor.js'
import { identityKeyOf, sameDisk } from '../inventory-health/inventory.js'
import type { Core } from '../shared/context.js'
import type { Assignment, Disk } from '../shared/model.js'

export type PreflightCode = 'disk_disconnected' | 'disk_unhealthy' | 'serial_mismatch' | 'descriptor_missing' | 'insufficient_space'

export interface PreflightIssue {
  code: PreflightCode
  assignmentId: string
  message: string
}

export interface Endpoint {
  assignment: Assignment
  disk: Disk
  mountPath: string
}

// Refuses to touch a folder unless the right, healthy disk is there and it carries its volume.json
export async function checkEndpoints(core: Core, assignments: Assignment[]): Promise<{ issues: PreflightIssue[]; endpoints: Map<string, Endpoint> }> {
  const issues: PreflightIssue[] = []
  const endpoints = new Map<string, Endpoint>()
  const live = await core.disks.listDisks()

  for (const assignment of assignments) {
    const disk = core.store.disks.get(assignment.diskId)
    if (!disk?.connected || !disk.mountPath) {
      issues.push({ code: 'disk_disconnected', assignmentId: assignment.id, message: `El disco de "${assignment.label}" no está conectado.` })
      continue
    }
    if (disk.health === 'red') {
      issues.push({ code: 'disk_unhealthy', assignmentId: assignment.id, message: `El disco de "${assignment.label}" está fallando: no se usará hasta revisarlo.` })
    }

    const present = live.find((info) => info.mountPath === disk.mountPath)
    if (!present || identityKeyOf(present) !== disk.identityKey && !sameDisk(present, disk)) {
      issues.push({
        code: 'serial_mismatch',
        assignmentId: assignment.id,
        message: `En ${disk.mountPath} ya no está el disco de "${assignment.label}" (número de serie distinto).`
      })
      continue
    }

    const descriptor = parseDescriptor(await core.fs.readText(descriptorPath(disk.mountPath, assignment.folder)))
    if (!descriptor) {
      issues.push({
        code: 'descriptor_missing',
        assignmentId: assignment.id,
        message: `Falta .diskmanager/volume.json en "${assignment.label}": no se reconoce la carpeta.`
      })
      continue
    }
    if (descriptor.assignment.id !== assignment.id || !sameDisk(descriptor.disk, disk)) {
      issues.push({
        code: 'serial_mismatch',
        assignmentId: assignment.id,
        message: `La carpeta "${assignment.label}" pertenece a otro disco (número de serie distinto).`
      })
      continue
    }
    endpoints.set(assignment.id, { assignment, disk, mountPath: disk.mountPath })
  }
  return { issues, endpoints }
}
