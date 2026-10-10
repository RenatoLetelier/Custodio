import { randomUUID } from 'node:crypto'
import type { Store } from '../ports/store.js'
import type { Clock, Copier, DiskProbe, FileSystemPort, Logger, Meter, SmartReader, VolumeReader } from '../ports/system.js'
import type { DomainEvent, EventPayload, EventPublisher, EventType } from './events.js'

export interface CoreDeps {
  store: Store
  clock: Clock
  disks: DiskProbe
  smart: SmartReader
  volumes: VolumeReader
  fs: FileSystemPort
  copier: Copier
  meter?: Meter
  logger: Logger
  newId?: () => string
  random?: () => number
}

export type Listener = (event: DomainEvent) => void

// Outbox pattern: the event is stored in the same transaction as the change and announced after commit
export class OutboxPublisher implements EventPublisher {
  private readonly listeners = new Set<Listener>()

  constructor(
    private readonly store: Store,
    private readonly clock: Clock,
    private readonly newId: () => string = randomUUID
  ) {}

  publish<T extends EventType>(type: T, payload: EventPayload<T>): void {
    const event = this.store.outbox.append({ id: this.newId(), type, occurredAt: this.clock.now().toISOString(), payload })
    this.store.afterCommit(() => {
      for (const listener of this.listeners) listener(event)
    })
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

export interface AuditInput {
  actor: string
  action: string
  target: string
  details?: Record<string, unknown>
}

export class AuditLog {
  constructor(
    private readonly store: Store,
    private readonly clock: Clock,
    private readonly newId: () => string = randomUUID
  ) {}

  record({ actor, action, target, details = {} }: AuditInput): void {
    this.store.audit.append({ id: this.newId(), at: this.clock.now().toISOString(), actor, action, target, details })
  }
}

export interface Core extends CoreDeps {
  events: OutboxPublisher
  audit: AuditLog
  newId: () => string
  random: () => number
}

export function createCore(deps: CoreDeps): Core {
  const newId = deps.newId ?? randomUUID
  return {
    ...deps,
    newId,
    random: deps.random ?? Math.random,
    events: new OutboxPublisher(deps.store, deps.clock, newId),
    audit: new AuditLog(deps.store, deps.clock, newId)
  }
}

export const SYSTEM_ACTOR = 'custodio'
