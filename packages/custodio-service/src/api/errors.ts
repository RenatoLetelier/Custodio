import { ZodError } from 'zod'
import { DomainError } from '../core/shared/errors.js'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

const DOMAIN_STATUS: Record<string, number> = {
  not_found: 404,
  validation_failed: 400,
  invalid_path: 400,
  conflict: 409,
  plan_not_pending: 409,
  unprocessable: 422,
  confirmation_required: 422,
  topology_invalid: 422,
  mirror_not_allowed: 422,
  source_protected: 422
}

export interface ErrorBody {
  error: { code: string; message: string; details?: unknown }
}

export function toErrorResponse(error: unknown): { status: number; body: ErrorBody; unexpected: boolean } {
  const body = (code: string, message: string, details?: unknown): ErrorBody => ({ error: details === undefined ? { code, message } : { code, message, details } })

  if (error instanceof ApiError) return { status: error.status, body: body(error.code, error.message, error.details), unexpected: false }
  if (error instanceof DomainError) return { status: DOMAIN_STATUS[error.code] ?? 400, body: body(error.code, error.message, error.details), unexpected: false }
  if (error instanceof ZodError) {
    const issues = error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
    return { status: 400, body: body('validation_failed', 'La petición tiene datos inválidos.', { issues }), unexpected: false }
  }
  const status = (error as { statusCode?: number }).statusCode
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return { status: 400, body: body('validation_failed', 'La petición no se pudo leer. Revisa que el cuerpo sea JSON válido.'), unexpected: false }
  }
  return { status: 500, body: body('internal', 'Ocurrió un error inesperado en el servicio.'), unexpected: true }
}
