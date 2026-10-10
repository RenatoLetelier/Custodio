import { record } from '../i18n'

export interface ServiceBridge {
  baseUrl: string
  token: string
}

declare global {
  interface Window {
    custodio?: { platform: string; service?: ServiceBridge | null }
  }
}

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

// The only way the interface reaches the service: its /v1 API on loopback, with the service token
export function serviceBridge(): ServiceBridge | null {
  return window.custodio?.service ?? null
}

// Values that come from the service are data, not interface text: the test trace accepts them
function traceValues(value: unknown): void {
  if (typeof value === 'string') record(value)
  else if (typeof value === 'number') record(String(value))
  else if (Array.isArray(value)) value.forEach(traceValues)
  else if (value && typeof value === 'object') Object.values(value).forEach(traceValues)
}

export async function api<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> {
  const bridge = serviceBridge()
  if (!bridge) throw new ApiError(0, 'no_service', 'No service bridge')
  let response: Response
  try {
    response = await fetch(`${bridge.baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${bridge.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
  } catch {
    throw new ApiError(0, 'unreachable', 'The service did not answer')
  }
  const text = await response.text()
  const json: unknown = text === '' ? null : JSON.parse(text)
  traceValues(json)
  if (!response.ok) {
    const error = (json as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error
    throw new ApiError(response.status, error?.code ?? 'internal', error?.message ?? '', error?.details)
  }
  return json as T
}

export interface StreamMessage {
  event: string
  id?: string
  data: unknown
}

// Server-Sent Events over fetch, so the token travels in the Authorization header
export async function* streamEvents(signal: AbortSignal, after = 0): AsyncGenerator<StreamMessage> {
  const bridge = serviceBridge()
  if (!bridge) throw new ApiError(0, 'no_service', 'No service bridge')
  let response: Response
  try {
    response = await fetch(`${bridge.baseUrl}/v1/events/stream?after=${after}`, {
      headers: { authorization: `Bearer ${bridge.token}`, accept: 'text/event-stream' },
      signal
    })
  } catch {
    throw new ApiError(0, 'unreachable', 'The service did not answer')
  }
  if (!response.ok || !response.body) throw new ApiError(response.status, 'unreachable', 'Event stream unavailable')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read().catch(() => {
      throw new ApiError(0, 'unreachable', 'The service stopped answering')
    })
    if (done) return
    buffer += decoder.decode(value, { stream: true })
    let split = buffer.indexOf('\n\n')
    while (split >= 0) {
      const block = buffer.slice(0, split)
      buffer = buffer.slice(split + 2)
      const message: StreamMessage = { event: '', data: null }
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) message.event = line.slice(7)
        else if (line.startsWith('id: ')) message.id = line.slice(4)
        else if (line.startsWith('data: ')) message.data = JSON.parse(line.slice(6))
      }
      if (message.event) {
        traceValues(message.data)
        yield message
      }
      split = buffer.indexOf('\n\n')
    }
  }
}
