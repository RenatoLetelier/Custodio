import { z } from 'zod'

const HourMinute = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Usa el formato HH:MM')

export const RoleSchema = z.enum(['storage', 'backup'])
export const BackupModeSchema = z.enum(['append', 'retention', 'mirror'])
export const TimeWindowSchema = z.object({ start: HourMinute, end: HourMinute })

const fields = {
  name: z.string().trim().min(1).max(120),
  sources: z.array(z.string().min(1)).min(1),
  destinations: z.array(z.string().min(1)).min(1),
  cron: z.string().trim().min(1),
  timezone: z.string().trim().min(1),
  mode: BackupModeSchema,
  retentionDays: z.number().int().min(1).max(3650),
  maxDeletePercent: z.number().min(0).max(100),
  mirrorConfirmed: z.boolean(),
  maxMegabytesPerSecond: z.number().positive().max(100_000).nullable(),
  window: TimeWindowSchema.nullable(),
  verifySamplePercent: z.number().min(0).max(100),
  verifyEveryHours: z.number().int().min(0).max(8760),
  paused: z.boolean()
}

export const PolicyConfigSchema = z.object({
  ...fields,
  mode: fields.mode.default('append'),
  retentionDays: fields.retentionDays.default(30),
  maxDeletePercent: fields.maxDeletePercent.default(10),
  mirrorConfirmed: fields.mirrorConfirmed.default(false),
  maxMegabytesPerSecond: fields.maxMegabytesPerSecond.default(null),
  window: fields.window.default(null),
  verifySamplePercent: fields.verifySamplePercent.default(5),
  verifyEveryHours: fields.verifyEveryHours.default(168),
  paused: fields.paused.default(false)
})

// Partial updates: no defaults, so an omitted field keeps its current value
export const PolicyPatchSchema = z.object(fields).partial()

export const PolicyStoredSchema = z.object(fields)

export type PolicyConfigInput = z.input<typeof PolicyConfigSchema>
export type PolicyPatch = z.infer<typeof PolicyPatchSchema>
