import type { IdempotencyRecord, IdempotencyStore } from '../api/idempotency.js'
import { num, parse, str, type SqliteStore } from './store.js'

export class SqliteIdempotencyStore implements IdempotencyStore {
  constructor(private readonly store: SqliteStore) {}

  get(actor: string, key: string): IdempotencyRecord | null {
    const row = this.store.get('SELECT * FROM idempotency WHERE actor = :actor AND key = :key', { actor, key })
    if (!row) return null
    return {
      actor: str(row.actor),
      key: str(row.key),
      method: str(row.method),
      path: str(row.path),
      requestHash: str(row.request_hash),
      response: { status: num(row.status_code), ...parse<{ body: unknown; headers?: Record<string, string> }>(row.response) },
      createdAt: str(row.created_at)
    }
  }

  put(record: IdempotencyRecord): void {
    this.store.run(
      `INSERT OR IGNORE INTO idempotency VALUES (:actor, :key, :method, :path, :request_hash, :status_code, :response, :created_at)`,
      {
        actor: record.actor,
        key: record.key,
        method: record.method,
        path: record.path,
        request_hash: record.requestHash,
        status_code: record.response.status,
        response: JSON.stringify({ body: record.response.body, headers: record.response.headers }),
        created_at: record.createdAt
      }
    )
  }
}
