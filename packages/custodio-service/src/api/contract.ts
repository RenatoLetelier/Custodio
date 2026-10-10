import { z } from 'zod'
import { DeletionRequestSchema } from '../core/allocation/deletions.js'
import { AssignmentActionSchema } from '../core/allocation/plans.js'
import { EVENT_PAYLOADS, EVENT_TYPES, type EventType } from '../core/shared/events.js'
import { BackupModeSchema, PolicyConfigSchema, PolicyPatchSchema, RoleSchema, TimeWindowSchema } from '../core/shared/policy.js'

// Contract-first: every /v1 operation is declared here; openapi.yaml is generated from this file

const Id = z.string().min(1)
const Timestamp = z.iso.datetime()
const Bytes = z.number().int().nonnegative()
const HealthSchema = z.enum(['green', 'yellow', 'red', 'unknown'])

export const ApiErrorSchema = z
  .object({
    error: z.object({
      code: z.string().describe('Código estable en inglés, para programas'),
      message: z.string().describe('Explicación en español, para personas'),
      details: z.unknown().optional()
    })
  })
  .meta({ id: 'ApiError', description: 'Error uniforme de toda la API' })

export const HealthResponse = z.object({ status: z.literal('ok'), version: z.string(), startedAt: Timestamp }).meta({ id: 'Health' })

const NoticeSchema = z
  .object({ code: z.string(), message: z.string(), attribute: z.number().int().optional(), value: z.number().optional() })
  .meta({ id: 'Notice' })

const SmartSchema = z
  .object({
    passed: z.boolean().nullable(),
    attributes: z.record(z.string(), z.number()),
    temperatureC: z.number().nullable(),
    powerOnHours: z.number().nullable()
  })
  .meta({ id: 'SmartSnapshot' })

const CapacitySchema = z
  .object({ totalBytes: Bytes, usedBytes: Bytes, freeBytes: Bytes, freePercent: z.number(), daysUntilFull: z.number().nullable() })
  .meta({ id: 'Capacity' })

export const DiskSchema = z
  .object({
    id: Id,
    serial: z.string().nullable(),
    wwn: z.string().nullable(),
    model: z.string(),
    sizeBytes: Bytes,
    bus: z.enum(['usb', 'sata', 'nvme', 'sas', 'other']),
    devicePath: z.string(),
    mountPath: z.string().nullable(),
    connected: z.boolean(),
    state: z.enum(['unassigned', 'assigned']),
    health: HealthSchema,
    healthReasons: z.array(NoticeSchema),
    advisories: z.array(NoticeSchema),
    smart: SmartSchema.nullable(),
    capacity: CapacitySchema.nullable(),
    capacityLow: z.boolean(),
    assignments: z.array(z.object({ assignmentId: Id, projectId: Id, folder: z.string(), role: RoleSchema, label: z.string() })),
    firstSeenAt: Timestamp,
    lastSeenAt: Timestamp
  })
  .meta({ id: 'Disk' })

export const OverviewSchema = z
  .object({
    status: HealthSchema,
    reasons: z.array(z.string()),
    disks: z.object({ total: z.number().int(), connected: z.number().int(), unassigned: z.number().int() }),
    space: z.object({ totalBytes: Bytes, freeBytes: Bytes }),
    lastBackup: z.object({ id: Id, policyId: z.string().nullable(), status: z.string(), finishedAt: Timestamp.nullable() }).nullable(),
    nextBackup: z.object({ policyId: Id, at: Timestamp }).nullable()
  })
  .meta({ id: 'Overview' })

const ProjectSchema = z.object({ id: Id, name: z.string(), createdAt: Timestamp, revision: z.number().int() }).meta({ id: 'Project' })

const AssignmentSchema = z
  .object({ id: Id, projectId: Id, diskId: Id, folder: z.string(), role: RoleSchema, label: z.string(), createdAt: Timestamp })
  .meta({ id: 'Assignment' })

export const PolicySchema = z
  .object({
    id: Id,
    projectId: Id,
    name: z.string(),
    sources: z.array(Id),
    destinations: z.array(Id),
    cron: z.string(),
    timezone: z.string(),
    mode: BackupModeSchema,
    retentionDays: z.number().int(),
    maxDeletePercent: z.number(),
    mirrorConfirmed: z.boolean(),
    maxMegabytesPerSecond: z.number().nullable(),
    window: TimeWindowSchema.nullable(),
    verifySamplePercent: z.number(),
    verifyEveryHours: z.number().int(),
    paused: z.boolean(),
    createdAt: Timestamp,
    lastScheduledFor: Timestamp.nullable(),
    lastSuccessAt: Timestamp.nullable(),
    lastVerifiedAt: Timestamp.nullable(),
    overdueSince: Timestamp.nullable(),
    nextRunAt: Timestamp.nullable()
  })
  .meta({ id: 'Policy' })

const ViolationSchema = z
  .object({ code: z.string(), message: z.string(), policyId: z.string().optional(), assignmentId: z.string().optional() })
  .meta({ id: 'Violation' })

export const TopologySchema = z
  .object({ valid: z.boolean(), errors: z.array(ViolationSchema), warnings: z.array(ViolationSchema) })
  .meta({ id: 'Topology' })

export const ProjectViewSchema = z
  .object({ project: ProjectSchema, assignments: z.array(AssignmentSchema), policies: z.array(PolicySchema), topology: TopologySchema })
  .meta({ id: 'ProjectView' })

const PlanPreviewSchema = z
  .object({
    summary: z.string(),
    lines: z.array(z.string()),
    movesData: z.boolean(),
    deletesData: z.boolean(),
    bytesToCopy: Bytes,
    filesToDelete: z.number().int().nonnegative()
  })
  .meta({ id: 'PlanPreview' })

export const PlanSchema = z
  .object({
    id: Id,
    kind: z.enum(['assignments', 'deletion', 'repair']),
    projectId: z.string().nullable(),
    status: z.enum(['pending', 'confirmed', 'expired']),
    payload: z.record(z.string(), z.unknown()),
    preview: PlanPreviewSchema,
    createdAt: Timestamp,
    expiresAt: Timestamp,
    decidedAt: Timestamp.nullable(),
    decidedBy: z.string().nullable(),
    createdBy: z.string()
  })
  .meta({ id: 'Plan' })

const JobProgressSchema = z
  .object({ filesDone: z.number().int(), filesTotal: z.number().int(), bytesDone: Bytes, bytesTotal: Bytes })
  .meta({ id: 'JobProgress' })

export const JobSchema = z
  .object({
    id: Id,
    kind: z.enum(['backup', 'verification', 'inventory_scan', 'deletion', 'repair']),
    status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted', 'skipped']),
    trigger: z.enum(['manual', 'schedule', 'catch_up']),
    policyId: z.string().nullable(),
    projectId: z.string().nullable(),
    scheduledFor: Timestamp.nullable(),
    dryRun: z.boolean(),
    progress: JobProgressSchema,
    result: z.record(z.string(), z.unknown()).nullable(),
    error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }).nullable(),
    requestedBy: z.string(),
    createdAt: Timestamp,
    startedAt: Timestamp.nullable(),
    finishedAt: Timestamp.nullable()
  })
  .meta({ id: 'Job' })

const JobAcceptedSchema = z.object({ job: JobSchema }).meta({ id: 'JobAccepted' })

export const EventSchema = z
  .discriminatedUnion(
    'type',
    EVENT_TYPES.map((type: EventType) =>
      z.object({ seq: z.number().int().positive(), id: Id, type: z.literal(type), occurredAt: Timestamp, payload: EVENT_PAYLOADS[type] })
    ) as unknown as [z.ZodObject, ...z.ZodObject[]]
  )
  .meta({ id: 'Event' })

const EventPageSchema = z.object({ events: z.array(EventSchema), nextCursor: z.number().int().nonnegative() }).meta({ id: 'EventPage' })

const AuditEntrySchema = z
  .object({ seq: z.number().int(), id: Id, at: Timestamp, actor: z.string(), action: z.string(), target: z.string(), details: z.record(z.string(), z.unknown()) })
  .meta({ id: 'AuditEntry' })

const DeletionOrderSchema = z
  .object({
    id: Id,
    projectId: Id,
    items: z.array(z.object({ sourceId: Id, path: z.string() })),
    createdAt: Timestamp,
    requestedBy: z.string(),
    status: z.enum(['pending', 'completed']),
    targets: z.array(
      z.object({
        orderId: Id,
        destinationId: Id,
        status: z.enum(['pending', 'done']),
        attempts: z.number().int(),
        lastError: z.string().nullable(),
        doneAt: Timestamp.nullable()
      })
    )
  })
  .meta({ id: 'DeletionOrder' })

const DiskIdentitySchema = z.object({ serial: z.string().nullable(), wwn: z.string().nullable(), model: z.string() })

const ReconstructedProjectSchema = z
  .object({
    id: Id,
    name: z.string(),
    createdAt: z.string(),
    revision: z.number().int(),
    assignments: z.array(z.object({ id: Id, folder: z.string(), role: RoleSchema, label: z.string(), disk: DiskIdentitySchema })),
    policies: z.array(PolicySchema.omit({ projectId: true, lastScheduledFor: true, lastSuccessAt: true, lastVerifiedAt: true, overdueSince: true, nextRunAt: true })),
    foundOn: z.array(z.object({ mountPath: z.string(), folder: z.string(), revision: z.number().int() }))
  })
  .meta({ id: 'ReconstructedProject' })

const DiskParams = z.object({ diskId: Id })
const ProjectParams = z.object({ projectId: Id })
const PolicyParams = z.object({ policyId: Id })
const PlanParams = z.object({ planId: Id })
const JobParams = z.object({ jobId: Id })
const Cursor = z.coerce.number().int().min(0).default(0)
const Limit = z.coerce.number().int().min(1).max(500).default(100)

export interface ResponseDef {
  description: string
  schema?: z.ZodType
  contentType?: string
}

export interface RouteDef {
  method: 'GET' | 'POST' | 'PATCH'
  path: string
  summary: string
  tag: string
  params?: z.ZodObject
  query?: z.ZodObject
  body?: z.ZodType
  responses: Record<number, ResponseDef>
}

const accepted: ResponseDef = { description: 'Aceptado: el trabajo corre en segundo plano', schema: JobAcceptedSchema }

export const ROUTES = {
  getHealth: { method: 'GET', path: '/v1/health', tag: 'Servicio', summary: 'Estado del servicio', responses: { 200: { description: 'En marcha', schema: HealthResponse } } },
  getOpenApi: {
    method: 'GET',
    path: '/v1/openapi.json',
    tag: 'Servicio',
    summary: 'Este contrato, en JSON',
    responses: { 200: { description: 'Documento OpenAPI', schema: z.record(z.string(), z.unknown()) } }
  },
  getOverview: { method: 'GET', path: '/v1/overview', tag: 'Servicio', summary: 'Cómo está todo de un vistazo', responses: { 200: { description: 'Resumen', schema: OverviewSchema } } },

  listDisks: {
    method: 'GET',
    path: '/v1/disks',
    tag: 'Discos',
    summary: 'Discos conocidos, conectados o no',
    responses: { 200: { description: 'Discos', schema: z.object({ disks: z.array(DiskSchema) }) } }
  },
  getDisk: { method: 'GET', path: '/v1/disks/{diskId}', tag: 'Discos', summary: 'Un disco', params: DiskParams, responses: { 200: { description: 'Disco', schema: DiskSchema } } },
  scanDisks: { method: 'POST', path: '/v1/disks/scan', tag: 'Discos', summary: 'Vuelve a leer discos, salud y espacio', responses: { 202: accepted } },
  requestRepair: {
    method: 'POST',
    path: '/v1/disks/{diskId}/repairs',
    tag: 'Discos',
    summary: 'Prepara la revisión y reparación del disco. Requiere confirmar el plan',
    params: DiskParams,
    responses: { 201: { description: 'Plan de reparación pendiente', schema: PlanSchema } }
  },

  listProjects: {
    method: 'GET',
    path: '/v1/projects',
    tag: 'Proyectos',
    summary: 'Proyectos',
    responses: { 200: { description: 'Proyectos', schema: z.object({ projects: z.array(ProjectViewSchema) }) } }
  },
  createProject: {
    method: 'POST',
    path: '/v1/projects',
    tag: 'Proyectos',
    summary: 'Crea un proyecto vacío',
    body: z.object({ name: z.string().trim().min(1).max(120) }).meta({ id: 'CreateProjectRequest' }),
    responses: { 201: { description: 'Creado', schema: ProjectViewSchema } }
  },
  getProject: { method: 'GET', path: '/v1/projects/{projectId}', tag: 'Proyectos', summary: 'Un proyecto', params: ProjectParams, responses: { 200: { description: 'Proyecto', schema: ProjectViewSchema } } },
  getTopology: {
    method: 'GET',
    path: '/v1/projects/{projectId}/topology',
    tag: 'Proyectos',
    summary: 'Valida orígenes, destinos y espacio',
    params: ProjectParams,
    responses: { 200: { description: 'Validación', schema: TopologySchema } }
  },
  proposeAssignments: {
    method: 'POST',
    path: '/v1/projects/{projectId}/plans',
    tag: 'Proyectos',
    summary: 'Propone asignar carpetas, cambiar roles o retirar discos. No aplica nada hasta confirmar',
    params: ProjectParams,
    body: z.object({ actions: z.array(AssignmentActionSchema).min(1) }).meta({ id: 'ProposeAssignmentsRequest' }),
    responses: { 201: { description: 'Plan pendiente de confirmación', schema: z.object({ plan: PlanSchema, topology: TopologySchema }).meta({ id: 'PlanProposal' }) } }
  },
  createPolicy: {
    method: 'POST',
    path: '/v1/projects/{projectId}/policies',
    tag: 'Respaldos',
    summary: 'Crea una copia programada',
    params: ProjectParams,
    body: PolicyConfigSchema.meta({ id: 'PolicyInput' }),
    responses: { 201: { description: 'Creada', schema: PolicySchema } }
  },
  previewDeletion: {
    method: 'POST',
    path: '/v1/projects/{projectId}/deletions',
    tag: 'Proyectos',
    summary: 'Prepara el borrado de archivos en las copias (nunca en el origen). Requiere confirmar el plan',
    params: ProjectParams,
    body: DeletionRequestSchema.meta({ id: 'DeletionRequest' }),
    responses: { 201: { description: 'Plan de borrado pendiente', schema: PlanSchema } }
  },
  listDeletions: {
    method: 'GET',
    path: '/v1/projects/{projectId}/deletions',
    tag: 'Proyectos',
    summary: 'Órdenes de borrado y su avance por disco',
    params: ProjectParams,
    responses: { 200: { description: 'Órdenes', schema: z.object({ orders: z.array(DeletionOrderSchema) }) } }
  },

  reconstructProjects: {
    method: 'POST',
    path: '/v1/recovery/scan',
    tag: 'Recuperación',
    summary: 'Lee volume.json en los discos conectados y reconstruye los proyectos',
    responses: { 200: { description: 'Proyectos encontrados', schema: z.object({ projects: z.array(ReconstructedProjectSchema) }) } }
  },
  importProject: {
    method: 'POST',
    path: '/v1/recovery/import',
    tag: 'Recuperación',
    summary: 'Recupera un proyecto encontrado en los discos',
    body: z.object({ projectId: Id }).meta({ id: 'ImportProjectRequest' }),
    responses: { 201: { description: 'Proyecto recuperado', schema: ProjectViewSchema } }
  },

  getPlan: { method: 'GET', path: '/v1/plans/{planId}', tag: 'Planes', summary: 'Un plan', params: PlanParams, responses: { 200: { description: 'Plan', schema: PlanSchema } } },
  confirmPlan: {
    method: 'POST',
    path: '/v1/plans/{planId}/confirm',
    tag: 'Planes',
    summary: 'Aplica un plan. Exige confirm: true',
    params: PlanParams,
    body: z.object({ confirm: z.boolean() }).meta({ id: 'ConfirmPlanRequest' }),
    responses: { 200: { description: 'Aplicado', schema: z.object({ plan: PlanSchema, result: z.record(z.string(), z.unknown()) }).meta({ id: 'PlanConfirmed' }) } }
  },

  getPolicy: { method: 'GET', path: '/v1/policies/{policyId}', tag: 'Respaldos', summary: 'Una copia programada', params: PolicyParams, responses: { 200: { description: 'Copia', schema: PolicySchema } } },
  updatePolicy: {
    method: 'PATCH',
    path: '/v1/policies/{policyId}',
    tag: 'Respaldos',
    summary: 'Cambia horario, modo, límites o la pausa',
    params: PolicyParams,
    body: PolicyPatchSchema.meta({ id: 'PolicyPatch' }),
    responses: { 200: { description: 'Actualizada', schema: PolicySchema } }
  },
  runPolicy: {
    method: 'POST',
    path: '/v1/policies/{policyId}/runs',
    tag: 'Respaldos',
    summary: 'Ejecuta la copia ahora (o la simula con dryRun)',
    params: PolicyParams,
    body: z.object({ dryRun: z.boolean().optional(), mirrorDryRunJobId: Id.optional() }).meta({ id: 'RunPolicyRequest' }),
    responses: { 202: accepted }
  },
  verifyPolicy: {
    method: 'POST',
    path: '/v1/policies/{policyId}/verifications',
    tag: 'Respaldos',
    summary: 'Revisa por hash una muestra de las copias',
    params: PolicyParams,
    body: z.object({ samplePercent: z.number().min(0).max(100).optional() }).meta({ id: 'VerifyPolicyRequest' }),
    responses: { 202: accepted }
  },

  listJobs: {
    method: 'GET',
    path: '/v1/jobs',
    tag: 'Trabajos',
    summary: 'Trabajos recientes',
    query: z.object({
      policyId: Id.optional(),
      kind: JobSchema.shape.kind.optional(),
      status: z.string().optional().describe('Estados separados por coma'),
      limit: Limit
    }),
    responses: { 200: { description: 'Trabajos', schema: z.object({ jobs: z.array(JobSchema) }) } }
  },
  getJob: { method: 'GET', path: '/v1/jobs/{jobId}', tag: 'Trabajos', summary: 'Un trabajo', params: JobParams, responses: { 200: { description: 'Trabajo', schema: JobSchema } } },
  cancelJob: {
    method: 'POST',
    path: '/v1/jobs/{jobId}/cancel',
    tag: 'Trabajos',
    summary: 'Cancela un trabajo en curso',
    params: JobParams,
    responses: { 202: { description: 'Cancelación pedida', schema: JobAcceptedSchema } }
  },

  listEvents: {
    method: 'GET',
    path: '/v1/events',
    tag: 'Eventos',
    summary: 'Eventos después de un cursor (entrega al menos una vez)',
    query: z.object({ after: Cursor, limit: Limit, types: z.string().optional().describe('Tipos separados por coma') }),
    responses: { 200: { description: 'Página de eventos', schema: EventPageSchema } }
  },
  streamEvents: {
    method: 'GET',
    path: '/v1/events/stream',
    tag: 'Eventos',
    summary: 'Eventos en vivo (Server-Sent Events). Acepta Last-Event-ID o ?after=',
    query: z.object({ after: Cursor }),
    responses: { 200: { description: 'Flujo text/event-stream', contentType: 'text/event-stream' } }
  },

  listAudit: {
    method: 'GET',
    path: '/v1/audit',
    tag: 'Auditoría',
    summary: 'Quién pidió qué',
    query: z.object({ after: Cursor, limit: Limit }),
    responses: { 200: { description: 'Entradas', schema: z.object({ entries: z.array(AuditEntrySchema), nextCursor: z.number().int().nonnegative() }).meta({ id: 'AuditPage' }) } }
  }
} satisfies Record<string, RouteDef>

export type OperationId = keyof typeof ROUTES
