import { z } from 'zod'
import { ApiErrorSchema, ROUTES, type ResponseDef, type RouteDef } from './contract.js'

type Json = Record<string, unknown>

export const API_VERSION = '1.0.0'

const ERROR_RESPONSES: Record<number, string> = {
  400: 'Petición inválida (validation_failed, invalid_path)',
  401: 'Falta el token del servicio o no es válido (unauthorized)',
  404: 'No existe (not_found)',
  409: 'Conflicto con el estado actual (conflict, plan_not_pending, idempotency_conflict)',
  422: 'No se puede aplicar (topology_invalid, confirmation_required, mirror_not_allowed, source_protected)',
  500: 'Error interno (internal)'
}

const MAX_SAFE = Number.MAX_SAFE_INTEGER

// Drops zod's noise (huge ISO regexes, safe-integer bounds) so the YAML stays readable
export function tidy(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(tidy)
  if (!node || typeof node !== 'object') return node
  const out: Json = {}
  for (const [key, value] of Object.entries(node as Json)) {
    if (key === '$schema' || key === '$id') continue
    if (key === 'pattern' && (node as Json).format === 'date-time') continue
    if ((key === 'minimum' && value === -MAX_SAFE) || (key === 'maximum' && value === MAX_SAFE)) continue
    out[key] = tidy(value)
  }
  return out
}

function rewriteRefs(node: unknown, rename: Map<string, string>): unknown {
  if (Array.isArray(node)) return node.map((n) => rewriteRefs(n, rename))
  if (!node || typeof node !== 'object') return node
  const out: Json = {}
  for (const [key, value] of Object.entries(node as Json)) {
    if (key === '$ref' && typeof value === 'string' && value.startsWith('#/$defs/')) {
      const name = value.slice('#/$defs/'.length)
      out[key] = `#/components/schemas/${rename.get(name) ?? name}`
    } else {
      out[key] = rewriteRefs(value, rename)
    }
  }
  return out
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

class SchemaCollector {
  readonly components: Record<string, unknown> = {}

  convert(schema: z.ZodType, io: 'input' | 'output'): unknown {
    const raw = z.toJSONSchema(schema, { target: 'draft-2020-12', io, unrepresentable: 'any' }) as Json
    const defs = (raw.$defs ?? {}) as Record<string, unknown>
    delete raw.$defs

    // Input and output shapes of the same schema may differ (defaults): the input variant gets its own name
    const tidyDefs = Object.entries(defs).map(([name, body]) => [name, tidy(body)] as const)
    const rename = new Map(tidyDefs.map(([name]) => [name, name]))
    for (let pass = 0; pass < tidyDefs.length + 1; pass++) {
      let changed = false
      for (const [name, body] of tidyDefs) {
        const target = rename.get(name) as string
        const existing = this.components[target]
        if (existing !== undefined && !same(existing, rewriteRefs(body, rename)) && !target.endsWith('Input')) {
          rename.set(name, `${name}Input`)
          changed = true
        }
      }
      if (!changed) break
    }
    for (const [name, body] of tidyDefs) this.components[rename.get(name) as string] = rewriteRefs(body, rename)

    // Schemas with an id come back as a bare $ref to their own definition
    return rewriteRefs(tidy(raw), rename)
  }
}

const toOpenApiPath = (path: string): string => path

function parametersOf(route: RouteDef, collector: SchemaCollector): Json[] {
  const parameters: Json[] = []
  for (const [location, schema] of [
    ['path', route.params],
    ['query', route.query]
  ] as const) {
    if (!schema) continue
    for (const [name, field] of Object.entries(schema.shape)) {
      const fieldSchema = collector.convert(field as z.ZodType, 'input') as Json
      const optional = (field as z.ZodType).safeParse(undefined).success
      const parameter: Json = { name, in: location, required: location === 'path' || !optional, schema: fieldSchema }
      if (typeof fieldSchema.description === 'string') parameter.description = fieldSchema.description
      parameters.push(parameter)
    }
  }
  return parameters
}

function responsesOf(route: RouteDef, collector: SchemaCollector): Json {
  const responses: Json = {}
  for (const [status, def] of Object.entries<ResponseDef>(route.responses)) {
    const content = def.schema
      ? { [def.contentType ?? 'application/json']: { schema: collector.convert(def.schema, 'output') } }
      : { [def.contentType ?? 'application/json']: { schema: { type: 'string' } } }
    responses[status] = { description: def.description, content }
  }
  const errorSchema = collector.convert(ApiErrorSchema, 'output')
  const statuses = [400, 401, 500]
  if (route.params) statuses.push(404)
  if (route.method !== 'GET') statuses.push(409, 422)
  for (const status of statuses.sort()) {
    responses[String(status)] = { description: ERROR_RESPONSES[status], content: { 'application/json': { schema: errorSchema } } }
  }
  return responses
}

export function buildOpenApi(): Json {
  const collector = new SchemaCollector()
  const paths: Record<string, Json> = {}

  for (const [operationId, route] of Object.entries(ROUTES) as [string, RouteDef][]) {
    const operation: Json = { operationId, summary: route.summary, tags: [route.tag], security: [{ serviceToken: [] }] }
    const parameters = parametersOf(route, collector)
    if (route.method === 'POST') {
      parameters.push({
        name: 'Idempotency-Key',
        in: 'header',
        required: false,
        description: 'Repetir la misma petición con la misma clave devuelve la misma respuesta sin repetir el efecto',
        schema: { type: 'string', minLength: 1, maxLength: 200 }
      })
    }
    if (parameters.length > 0) operation.parameters = parameters
    if (route.body) {
      operation.requestBody = { required: true, content: { 'application/json': { schema: collector.convert(route.body, 'input') } } }
    }
    operation.responses = responsesOf(route, collector)
    const path = toOpenApiPath(route.path)
    paths[path] = { ...(paths[path] ?? {}), [route.method.toLowerCase()]: operation }
  }

  const schemas = Object.fromEntries(Object.entries(collector.components).sort(([a], [b]) => a.localeCompare(b)))
  return {
    openapi: '3.1.0',
    info: {
      title: 'Custodio API',
      version: API_VERSION,
      description:
        'API local del servicio de Custodio. Solo escucha en 127.0.0.1 y exige el token del servicio. Las operaciones largas responden 202 con un trabajo que se consulta y se cancela en /v1/jobs. Todos los errores usan el mismo formato ApiError.'
    },
    servers: [{ url: 'http://127.0.0.1:47600' }],
    security: [{ serviceToken: [] }],
    tags: [...new Set(Object.values(ROUTES).map((r) => r.tag))].map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: { serviceToken: { type: 'http', scheme: 'bearer', description: 'Token del servicio (Authorization: Bearer <token>)' } },
      schemas
    }
  }
}
