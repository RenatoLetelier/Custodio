import { ApiError } from '../api/client'
import type { Job } from '../api/types'
import { hasMessage, t, type MessageKey } from '../i18n'
import { resultOf } from './jobs'

// A job that ended badly while someone waited for it (a disk search, a repair)
export class JobFailed extends Error {
  constructor(readonly job: Job) {
    super(job.error?.message ?? job.status)
    this.name = 'JobFailed'
  }
}

export interface FriendlyError {
  title: string
  hint: string
  // Explanation the service wrote in Spanish for this case (already plain language), if any
  detail: string | null
}

// A rejected topology lists what is wrong with it, each in a sentence written for people
function violations(details: unknown): string[] {
  const errors = (details as { errors?: unknown } | null | undefined)?.errors
  if (!Array.isArray(errors)) return []
  return errors.map((e) => (e as { message?: unknown }).message).filter((m): m is string => typeof m === 'string' && m.trim() !== '')
}

// What happened and what to do, never a raw code
export function friendlyError(error: unknown): FriendlyError {
  if (error instanceof JobFailed) return { title: t('errors.job_failed.title'), hint: t('errors.job_failed.hint'), detail: resultOf(error.job) }
  const code = error instanceof ApiError ? error.code : 'unknown'
  const known = hasMessage(`errors.${code}.title`) ? code : error instanceof ApiError && error.status >= 500 ? 'internal' : 'unknown'
  const reasons = error instanceof ApiError ? violations(error.details) : []
  const detail = error instanceof ApiError && error.status >= 400 && error.status < 500 && error.message.trim() !== '' ? [error.message, ...reasons].join(' ') : null
  return {
    title: t(`errors.${known}.title` as MessageKey),
    hint: t(`errors.${known}.hint` as MessageKey),
    detail
  }
}
