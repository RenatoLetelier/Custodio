import { foldersOverlap } from '../shared/paths.js'
import type { Assignment, Disk } from '../shared/model.js'
import { receives } from '../shared/layout.js'
import { readableBytes } from '../shared/units.js'

export type TopologyCode =
  | 'empty_policy'
  | 'unknown_assignment'
  | 'source_not_storage'
  | 'destination_not_backup'
  | 'same_disk'
  | 'insufficient_capacity'
  | 'chain'
  | 'cycle'
  | 'overlapping_folders'
  | 'no_source'
  | 'no_backup'

export interface Violation {
  code: TopologyCode
  message: string
  policyId?: string
  assignmentId?: string
}

export interface TopologyPolicy {
  id: string
  name: string
  sources: string[]
  destinations: string[]
}

export interface TopologySizes {
  // Bytes currently stored in each source folder
  sourceBytes: Map<string, number>
  // Bytes a destination can hold: free space plus what its folder already uses
  destinationCapacity: Map<string, number>
  // What each destination folder already uses (part of its capacity)
  destinationUsed?: Map<string, number>
}

export interface TopologyInput {
  assignments: Assignment[]
  policies: TopologyPolicy[]
  disks: Pick<Disk, 'id' | 'model'>[]
  sizes?: TopologySizes
}

export interface TopologyResult {
  valid: boolean
  errors: Violation[]
  warnings: Violation[]
}

export function validateTopology({ assignments, policies, disks, sizes }: TopologyInput): TopologyResult {
  const errors: Violation[] = []
  const warnings: Violation[] = []
  const byId = new Map(assignments.map((a) => [a.id, a]))
  const diskName = (id: string): string => disks.find((d) => d.id === id)?.model ?? id
  const asSource = new Set<string>()
  const asDestination = new Set<string>()
  const edges = new Map<string, Set<string>>()

  for (const policy of policies) {
    if (policy.sources.length === 0 || policy.destinations.length === 0) {
      errors.push({ code: 'empty_policy', policyId: policy.id, message: `"${policy.name}" necesita al menos un origen y un destino.` })
    }
    for (const id of [...policy.sources, ...policy.destinations]) {
      if (!byId.has(id)) errors.push({ code: 'unknown_assignment', policyId: policy.id, assignmentId: id, message: `"${policy.name}" usa una carpeta que no existe.` })
    }
    const sources = policy.sources.map((id) => byId.get(id)).filter((a): a is Assignment => a !== undefined)
    const destinations = policy.destinations.map((id) => byId.get(id)).filter((a): a is Assignment => a !== undefined)

    for (const source of sources) {
      asSource.add(source.id)
      if (source.role !== 'storage') {
        errors.push({ code: 'source_not_storage', policyId: policy.id, assignmentId: source.id, message: `"${source.label}" no guarda archivos, así que no puede ser el origen de una copia.` })
      }
      const targets = edges.get(source.id) ?? new Set<string>()
      for (const destination of destinations) if (receives(destination, source)) targets.add(destination.id)
      edges.set(source.id, targets)
    }
    for (const destination of destinations) {
      asDestination.add(destination.id)
      if (destination.role !== 'backup') {
        errors.push({ code: 'destination_not_backup', policyId: policy.id, assignmentId: destination.id, message: `"${destination.label}" no está marcado para copias de seguridad.` })
      }
      for (const source of sources) {
        if (receives(destination, source) && source.diskId === destination.diskId) {
          errors.push({
            code: 'same_disk',
            policyId: policy.id,
            assignmentId: destination.id,
            message: `"${source.label}" y su copia "${destination.label}" están en el mismo disco (${diskName(source.diskId)}). Si ese disco falla, se pierden los dos.`
          })
        }
      }
    }
  }

  // A copy of a copy: something that receives data and also sends it on
  for (const id of asDestination) {
    if (asSource.has(id)) {
      errors.push({ code: 'chain', assignmentId: id, message: `"${byId.get(id)?.label ?? id}" recibe una copia y a la vez es origen de otra: no se permiten copias en cadena.` })
    }
  }

  for (const cycle of findCycles(edges)) {
    errors.push({ code: 'cycle', assignmentId: cycle[0], message: `Las copias forman un círculo: ${cycle.map((id) => byId.get(id)?.label ?? id).join(' → ')}.` })
  }

  for (let i = 0; i < assignments.length; i++) {
    for (let j = i + 1; j < assignments.length; j++) {
      const a = assignments[i]!
      const b = assignments[j]!
      if (a.diskId === b.diskId && foldersOverlap(a.folder, b.folder)) {
        errors.push({ code: 'overlapping_folders', assignmentId: b.id, message: `"${a.label}" y "${b.label}" se pisan en el mismo disco: una está dentro de la otra.` })
      }
    }
  }

  if (sizes) {
    // Destination folders on the same disk share its free space
    const byDisk = new Map<string, string[]>()
    for (const id of asDestination) {
      const diskId = byId.get(id)?.diskId
      if (diskId === undefined || !sizes.destinationCapacity.has(id)) continue
      byDisk.set(diskId, [...(byDisk.get(diskId) ?? []), id])
    }
    const used = (id: string): number => sizes.destinationUsed?.get(id) ?? 0
    const needs = (id: string): number =>
      [...edges.entries()].filter(([, targets]) => targets.has(id)).reduce((sum, [source]) => sum + (sizes.sourceBytes.get(source) ?? 0), 0)
    for (const ids of byDisk.values()) {
      const free = Math.min(...ids.map((id) => sizes.destinationCapacity.get(id)! - used(id)))
      const capacity = free + ids.reduce((sum, id) => sum + used(id), 0)
      const needed = ids.reduce((sum, id) => sum + needs(id), 0)
      if (needed <= capacity) continue
      const labels = ids.map((id) => `"${byId.get(id)?.label ?? id}"`)
      const amounts = `hacen falta ${readableBytes(needed)} y hay ${readableBytes(capacity)} disponibles.`
      errors.push({
        code: 'insufficient_capacity',
        assignmentId: ids[0],
        message:
          labels.length === 1
            ? `${labels[0]} no tiene espacio para todo lo que debe copiar: ${amounts}`
            : `${labels.slice(0, -1).join(', ')} y ${labels.at(-1)} están en el mismo disco y no caben juntas: ${amounts}`
      })
    }
  }

  for (const assignment of assignments) {
    if (assignment.role === 'backup' && !asDestination.has(assignment.id)) {
      warnings.push({ code: 'no_source', assignmentId: assignment.id, message: 'sin origen' })
    }
    if (assignment.role === 'storage' && !asSource.has(assignment.id)) {
      warnings.push({ code: 'no_backup', assignmentId: assignment.id, message: 'sin copia de seguridad' })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}

function findCycles(edges: Map<string, Set<string>>): string[][] {
  const cycles: string[][] = []
  const state = new Map<string, 'visiting' | 'done'>()
  const stack: string[] = []

  const visit = (node: string): void => {
    state.set(node, 'visiting')
    stack.push(node)
    for (const next of edges.get(node) ?? []) {
      if (state.get(next) === 'visiting') cycles.push([...stack.slice(stack.indexOf(next)), next])
      else if (!state.has(next)) visit(next)
    }
    stack.pop()
    state.set(node, 'done')
  }

  for (const node of edges.keys()) if (!state.has(node)) visit(node)
  return cycles
}
