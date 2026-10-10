import { timingSafeEqual } from 'node:crypto'
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify'
import type { Services } from '../core/services.js'
import { ROUTES, type OperationId, type RouteDef } from './contract.js'
import { toErrorResponse } from './errors.js'
import { HIJACKED, createHandlers, type Context, type HandlerResult } from './handlers.js'
import { Idempotency, type IdempotencyStore, type StoredResponse } from './idempotency.js'
import { buildOpenApi } from './openapi.js'

export interface ServiceToken {
  name: string
  token: string
}

export interface ServerOptions {
  services: Services
  tokens: ServiceToken[]
  idempotencyStore: IdempotencyStore
  version: string
  startedAt: string
  logger?: FastifyBaseLogger
}

declare module 'fastify' {
  interface FastifyRequest {
    actor: string
  }
}

const sameSecret = (a: string, b: string): boolean => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export function buildServer(options: ServerOptions): FastifyInstance {
  const common = { bodyLimit: 1024 * 1024, forceCloseConnections: true }
  const app = (options.logger ? Fastify({ ...common, loggerInstance: options.logger }) : Fastify({ ...common, logger: false })) as unknown as FastifyInstance
  const handlers = createHandlers({ services: options.services, version: options.version, startedAt: options.startedAt, openapi: buildOpenApi() })
  const idempotency = new Idempotency(options.idempotencyStore, () => options.services.core.clock.now())

  app.decorateRequest('actor', '')

  // Every request needs the service token; the token's name is who asked, for the audit log
  app.addHook('onRequest', async (request, reply) => {
    const header = request.headers.authorization
    const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : ''
    const match = token === '' ? undefined : options.tokens.find((t) => sameSecret(t.token, token))
    if (!match) {
      await reply.code(401).send({ error: { code: 'unauthorized', message: 'Falta el token del servicio o no es válido.' } })
      return reply
    }
    request.actor = match.name
  })

  app.setErrorHandler(async (error, request, reply) => {
    const { status, body, unexpected } = toErrorResponse(error)
    if (unexpected) request.log.error({ err: error }, 'unexpected error')
    await reply.code(status).send(body)
  })

  app.setNotFoundHandler(async (request, reply) => {
    await reply.code(404).send({ error: { code: 'not_found', message: `No existe ${request.method} ${request.url.split('?')[0] ?? ''}.` } })
  })

  for (const [operationId, route] of Object.entries(ROUTES) as [OperationId, RouteDef][]) {
    app.route({
      method: route.method,
      url: route.path.replace(/\{(\w+)\}/g, ':$1'),
      handler: async (request, reply) => {
        const input = {
          params: route.params ? route.params.parse(request.params) : {},
          query: route.query ? route.query.parse(request.query) : {},
          body: route.body ? route.body.parse(request.body ?? {}) : undefined
        }
        const ctx: Context = { actor: request.actor, request, reply }
        const handler = handlers[operationId] as (input: unknown, ctx: Context) => HandlerResult | Promise<HandlerResult>
        const exec = async (): Promise<StoredResponse> => {
          const result = await handler(input, ctx)
          if (result === HIJACKED) return { status: 0, body: null }
          return result
        }

        const key = request.headers['idempotency-key']
        let result: StoredResponse & { replayed?: boolean }
        if (route.method === 'POST' && typeof key === 'string') {
          result = await idempotency.run(request.actor, key, route.method, request.url.split('?')[0] ?? '', request.body ?? null, exec)
        } else {
          result = await exec()
        }
        if (result.status === 0) return reply

        if (result.headers) for (const [name, value] of Object.entries(result.headers)) void reply.header(name, value)
        if (result.replayed) void reply.header('idempotent-replayed', 'true')
        return reply.code(result.status).send(result.body)
      }
    })
  }

  return app
}
