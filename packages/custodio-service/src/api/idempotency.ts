import { createHash } from 'node:crypto'
import { ApiError } from './errors.js'

export interface StoredResponse {
  status: number
  body: unknown
  headers?: Record<string, string>
}

export interface IdempotencyRecord {
  actor: string
  key: string
  method: string
  path: string
  requestHash: string
  response: StoredResponse
  createdAt: string
}

export interface IdempotencyStore {
  get(actor: string, key: string): IdempotencyRecord | null
  put(record: IdempotencyRecord): void
}

const hashRequest = (method: string, path: string, body: unknown): string =>
  createHash('sha256')
    .update(`${method} ${path}\n${JSON.stringify(body ?? null)}`)
    .digest('hex')

// Same key + same request = same answer without repeating the effect; same key + different request = 409
export class Idempotency {
  private readonly inflight = new Map<string, Promise<StoredResponse>>()

  constructor(
    private readonly store: IdempotencyStore,
    private readonly now: () => Date
  ) {}

  async run(actor: string, key: string, method: string, path: string, body: unknown, exec: () => Promise<StoredResponse>): Promise<StoredResponse & { replayed: boolean }> {
    if (key.length === 0 || key.length > 200) throw new ApiError(400, 'validation_failed', 'Idempotency-Key debe tener entre 1 y 200 caracteres.')
    const requestHash = hashRequest(method, path, body)
    const slot = `${actor}\u0000${key}`

    const pending = this.inflight.get(slot)
    if (pending) {
      await pending.catch(() => undefined)
    }
    const stored = this.store.get(actor, key)
    if (stored) {
      if (stored.requestHash !== requestHash) {
        throw new ApiError(409, 'idempotency_conflict', 'Esa Idempotency-Key ya se usó con otra petición distinta.')
      }
      return { ...stored.response, replayed: true }
    }

    const promise = exec()
    this.inflight.set(slot, promise)
    try {
      const response = await promise
      if (response.status < 400) {
        this.store.put({ actor, key, method, path, requestHash, response, createdAt: this.now().toISOString() })
      }
      return { ...response, replayed: false }
    } finally {
      this.inflight.delete(slot)
    }
  }
}
