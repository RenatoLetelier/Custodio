import { randomUUID } from 'node:crypto'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import type { Helper, HelperResponse } from './helper.js'

export const DEFAULT_PIPE = '\\\\.\\pipe\\custodio-helper'
const MAX_LINE = 64 * 1024

// One JSON object per line in each direction
function onLines(socket: Socket, handle: (line: string) => void): void {
  let buffer = ''
  socket.setEncoding('utf8')
  socket.on('data', (chunk: string) => {
    buffer += chunk
    if (buffer.length > MAX_LINE * 4) socket.destroy()
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.trim() !== '') handle(line)
      newline = buffer.indexOf('\n')
    }
  })
}

// shared: the pipe accepts every local user (the elevated helper serves the unprivileged service)
export function serveHelper(helper: Helper, path: string, options: { shared?: boolean } = {}): Promise<Server> {
  const server = createServer((socket) => {
    onLines(socket, (line) => {
      let request: unknown
      try {
        request = JSON.parse(line)
      } catch {
        socket.write(`${JSON.stringify({ id: '?', ok: false, error: { code: 'bad_request', message: 'Invalid JSON' } })}\n`)
        return
      }
      void helper.handle(request).then((response) => socket.write(`${JSON.stringify(response)}\n`))
    })
    socket.on('error', () => socket.destroy())
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({ path, readableAll: options.shared === true, writableAll: options.shared === true }, () => resolve(server))
  })
}

export class HelperUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HelperUnavailableError'
  }
}

// Used by the unprivileged service to ask the helper for elevated reads
export class HelperClient {
  constructor(
    private readonly path: string,
    private readonly secret: string,
    private readonly timeoutMs = 120_000
  ) {}

  call(op: string, args: unknown, confirmation?: string, timeoutMs = this.timeoutMs): Promise<HelperResponse> {
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.path)
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new HelperUnavailableError(`custodio-helper did not answer ${op} in time`))
      }, timeoutMs)
      socket.on('error', (error) => {
        clearTimeout(timer)
        reject(new HelperUnavailableError(`custodio-helper is not reachable: ${error.message}`))
      })
      onLines(socket, (line) => {
        const response = JSON.parse(line) as HelperResponse
        if (response.id !== id) return
        clearTimeout(timer)
        socket.end()
        resolve(response)
      })
      socket.write(`${JSON.stringify({ id, secret: this.secret, op, args, confirmation })}\n`)
    })
  }
}
