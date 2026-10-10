import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stringify } from 'yaml'
import { z } from 'zod'
import { EVENT_PAYLOADS, EVENT_TYPES } from '../core/shared/events.js'
import { buildOpenApi, tidy } from './openapi.js'

export const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..')
export const OPENAPI_FILE = join(REPO_ROOT, 'openapi.yaml')
export const EVENTS_FILE = join(REPO_ROOT, 'docs', 'EVENTS.md')

const START = '<!-- schemas:start -->'
const END = '<!-- schemas:end -->'

export const openApiYaml = (): string =>
  `# Generado por "npm run contracts" desde packages/custodio-service/src/api/contract.ts. No editar a mano.\n${stringify(buildOpenApi(), { lineWidth: 0 })}`

export function eventSchemas(): Record<string, unknown> {
  return Object.fromEntries(
    EVENT_TYPES.map((type) => {
      return [type, tidy(z.toJSONSchema(EVENT_PAYLOADS[type], { target: 'draft-2020-12' }))]
    })
  )
}

export function eventsMarkdown(current: string): string {
  const start = current.indexOf(START)
  const end = current.indexOf(END)
  if (start < 0 || end < start) throw new Error('docs/EVENTS.md is missing the schema markers')
  const sections = Object.entries(eventSchemas()).map(([type, schema]) => `### ${type}\n\n\`\`\`json\n${JSON.stringify(schema, null, 2)}\n\`\`\``)
  return `${current.slice(0, start + START.length)}\n\n${sections.join('\n\n')}\n\n${current.slice(end)}`
}

// Reads the payload schemas back from docs/EVENTS.md
export function parseEventsMarkdown(markdown: string): Record<string, unknown> {
  const section = markdown.slice(markdown.indexOf(START), markdown.indexOf(END))
  const schemas: Record<string, unknown> = {}
  for (const match of section.matchAll(/### ([\w.]+)\s+```json\n([\s\S]*?)\n```/g)) {
    schemas[match[1] as string] = JSON.parse(match[2] as string)
  }
  return schemas
}
