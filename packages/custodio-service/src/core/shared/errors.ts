export type ErrorCode =
  | 'not_found'
  | 'validation_failed'
  | 'conflict'
  | 'unprocessable'
  | 'confirmation_required'
  | 'invalid_path'
  | 'topology_invalid'
  | 'plan_not_pending'
  | 'mirror_not_allowed'
  | 'source_protected'

export class DomainError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown
  ) {
    super(message)
    this.name = 'DomainError'
  }
}

export type CopyErrorCode = 'source_missing' | 'source_changed' | 'hash_mismatch' | 'destination_exists'

// Expected, per-file copy failures: the run records them and moves on
export class CopyError extends Error {
  constructor(
    readonly code: CopyErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'CopyError'
  }
}

export const isAbortError = (error: unknown): boolean => error instanceof Error && error.name === 'AbortError'

export const notFound =(what: string, id: string): DomainError => new DomainError('not_found', `No existe ${what} ${id}.`)
