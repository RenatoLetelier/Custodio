import type { FastifyReply, FastifyRequest } from 'fastify'
import type { JobRunner } from '../core/jobs/runner.js'
import type { Store } from '../core/ports/store.js'
import type { OutboxPublisher } from '../core/shared/context.js'
import type { DomainEvent } from '../core/shared/events.js'

const HEARTBEAT_MS = 15_000
const PAGE = 500

// Persisted events carry "id: <seq>" so EventSource can resume with Last-Event-ID; job progress is live only
export function streamEvents(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: { store: Store; publisher: OutboxPublisher; runner: JobRunner },
  after: number
): void {
  const lastEventId = Number(request.headers['last-event-id'])
  let cursor = Number.isInteger(lastEventId) && lastEventId > after ? lastEventId : after

  reply.hijack()
  const raw = reply.raw
  raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  })
  raw.write('retry: 3000\n\n')

  const send = (event: DomainEvent): void => {
    if (event.seq <= cursor) return
    cursor = event.seq
    raw.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  }

  for (let page = deps.store.outbox.after(cursor, PAGE); page.length > 0; page = deps.store.outbox.after(cursor, PAGE)) page.forEach(send)

  const unsubscribe = deps.publisher.subscribe(send)
  const unsubscribeJobs = deps.runner.onUpdate((job) => raw.write(`event: job.updated\ndata: ${JSON.stringify(job)}\n\n`))
  const heartbeat = setInterval(() => raw.write(': ping\n\n'), HEARTBEAT_MS)
  request.raw.on('close', () => {
    unsubscribe()
    unsubscribeJobs()
    clearInterval(heartbeat)
  })
}
