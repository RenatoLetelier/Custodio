import { z } from 'zod'

const HealthSchema = z.enum(['green', 'yellow', 'red', 'unknown'])
const Timestamp = z.iso.datetime()

export const EVENT_PAYLOADS = {
  'disk.detected': z.object({
    diskId: z.string(),
    serial: z.string().nullable(),
    wwn: z.string().nullable(),
    model: z.string(),
    sizeBytes: z.number().int().nonnegative(),
    mountPath: z.string().nullable()
  }),
  'disk.health_changed': z.object({
    diskId: z.string(),
    previous: HealthSchema,
    current: HealthSchema,
    reasons: z.array(z.string())
  }),
  'capacity.low': z.object({
    diskId: z.string(),
    totalBytes: z.number().int().nonnegative(),
    freeBytes: z.number().int().nonnegative(),
    freePercent: z.number(),
    daysUntilFull: z.number().nullable()
  }),
  'backup.completed': z.object({
    jobId: z.string(),
    policyId: z.string(),
    projectId: z.string(),
    filesCopied: z.number().int().nonnegative(),
    bytesCopied: z.number().int().nonnegative(),
    filesSkipped: z.number().int().nonnegative(),
    filesDeleted: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative()
  }),
  'backup.failed': z.object({
    jobId: z.string(),
    policyId: z.string(),
    projectId: z.string(),
    code: z.string(),
    message: z.string()
  }),
  'backup.overdue': z.object({
    policyId: z.string(),
    projectId: z.string(),
    lastSuccessAt: Timestamp.nullable(),
    expectedIntervalMs: z.number().int().positive(),
    overdueSince: Timestamp
  }),
  'backup.corruption_detected': z.object({
    jobId: z.string(),
    policyId: z.string(),
    projectId: z.string(),
    destinationId: z.string(),
    diskId: z.string(),
    path: z.string(),
    expectedSha256: z.string(),
    actualSha256: z.string().nullable()
  })
} as const

export type EventType = keyof typeof EVENT_PAYLOADS
export type EventPayload<T extends EventType> = z.infer<(typeof EVENT_PAYLOADS)[T]>

export const EVENT_TYPES = Object.keys(EVENT_PAYLOADS) as EventType[]

export interface DomainEvent<T extends EventType = EventType> {
  seq: number
  id: string
  type: T
  occurredAt: string
  payload: EventPayload<T>
}

export interface EventPublisher {
  publish<T extends EventType>(type: T, payload: EventPayload<T>): void
}
