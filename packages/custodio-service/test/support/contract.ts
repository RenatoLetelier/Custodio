import { readFileSync } from 'node:fs'
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js'
import addFormatsModule from 'ajv-formats'
import { parse } from 'yaml'
import { EVENTS_FILE, OPENAPI_FILE, parseEventsMarkdown } from '../../src/api/contracts-files.js'

type Json = Record<string, unknown>

const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => Ajv2020

function newAjv(): Ajv2020 {
  const ajv = new Ajv2020({ strict: false, allErrors: true })
  addFormats(ajv)
  return ajv
}

// Validates real responses against openapi.yaml as committed (not against the code that generates it)
export class OpenApiContract {
  readonly doc: Json
  private readonly ajv = newAjv()
  private readonly compiled = new Map<string, ValidateFunction>()
  private readonly templates: { method: string; template: string; regex: RegExp }[] = []

  constructor(file = OPENAPI_FILE) {
    this.doc = parse(readFileSync(file, 'utf8')) as Json
    for (const [template, operations] of Object.entries(this.doc.paths as Json)) {
      const regex = new RegExp(`^${template.replace(/\{\w+\}/g, '[^/]+')}$`)
      for (const method of Object.keys(operations as Json)) this.templates.push({ method: method.toUpperCase(), template, regex })
    }
  }

  operation(method: string, url: string): { template: string; operation: Json } | null {
    const path = url.split('?')[0] ?? url
    const match = this.templates.find((t) => t.method === method.toUpperCase() && t.regex.test(path))
    if (!match) return null
    return { template: match.template, operation: (this.doc.paths as Record<string, Json>)[match.template]?.[method.toLowerCase()] as Json }
  }

  // Returns a list of problems; empty when the response is exactly what the contract promises
  check(method: string, url: string, status: number, body: unknown, contentType = 'application/json'): string[] {
    const found = this.operation(method, url)
    if (!found) return [`${method} ${url} is not in openapi.yaml`]
    const responses = found.operation.responses as Record<string, Json>
    const response = responses[String(status)]
    if (!response) return [`${method} ${found.template} does not document status ${status}`]
    const content = response.content as Record<string, { schema?: Json }> | undefined
    const media = content?.[contentType.split(';')[0] ?? contentType]
    if (!media) return [`${method} ${found.template} ${status} does not document ${contentType}`]
    if (!media.schema || contentType.startsWith('text/')) return []
    const key = `${method} ${found.template} ${status}`
    let validate = this.compiled.get(key)
    if (!validate) {
      validate = this.ajv.compile({ ...media.schema, components: this.doc.components })
      this.compiled.set(key, validate)
    }
    return validate(body) ? [] : (validate.errors ?? []).map((e) => `${key}: ${e.instancePath || '/'} ${e.message ?? ''} ${JSON.stringify(e.params)}`)
  }
}

export class EventsContract {
  private readonly validators = new Map<string, ValidateFunction>()

  constructor(file = EVENTS_FILE) {
    const ajv = newAjv()
    for (const [type, schema] of Object.entries(parseEventsMarkdown(readFileSync(file, 'utf8')))) {
      this.validators.set(type, ajv.compile(schema as Json))
    }
  }

  get types(): string[] {
    return [...this.validators.keys()]
  }

  check(event: { seq: number; id: string; type: string; occurredAt: string; payload: unknown }): string[] {
    const problems: string[] = []
    if (!Number.isInteger(event.seq) || event.seq <= 0) problems.push(`seq ${event.seq} is not a positive integer`)
    if (typeof event.id !== 'string' || event.id === '') problems.push('missing id')
    if (Number.isNaN(Date.parse(event.occurredAt))) problems.push(`occurredAt ${event.occurredAt} is not a date`)
    const validate = this.validators.get(event.type)
    if (!validate) return [...problems, `event type ${event.type} is not documented in docs/EVENTS.md`]
    if (!validate(event.payload)) {
      problems.push(...(validate.errors ?? []).map((e) => `${event.type}${e.instancePath} ${e.message ?? ''}`))
    }
    return problems
  }
}

export const openApi = new OpenApiContract()
export const eventsContract = new EventsContract()
