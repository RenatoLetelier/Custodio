import { ApiError } from '../api/client'
import { hasMessage, t, type MessageKey } from '../i18n'

export interface FriendlyError {
  title: string
  hint: string
  // Explanation the service wrote in Spanish for this case (already plain language), if any
  detail: string | null
}

// What happened and what to do, never a raw code
export function friendlyError(error: unknown): FriendlyError {
  const code = error instanceof ApiError ? error.code : 'unknown'
  const known = hasMessage(`errors.${code}.title`) ? code : error instanceof ApiError && error.status >= 500 ? 'internal' : 'unknown'
  const detail = error instanceof ApiError && error.status >= 400 && error.status < 500 && error.message.trim() !== '' ? error.message : null
  return {
    title: t(`errors.${known}.title` as MessageKey),
    hint: t(`errors.${known}.hint` as MessageKey),
    detail
  }
}
