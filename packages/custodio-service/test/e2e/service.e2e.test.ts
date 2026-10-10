import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { OPENAPI_FILE } from '../../src/api/contracts-files.js'
import { eventsContract, openApi } from '../support/contract.js'

const SERVICE_DIR = resolve(import.meta.dirname, '../..')
const TOKEN = 'e2e-token-0123456789abcdef0123456789abcdef'

interface Running {
  child: ChildProcessByStdio<null, Readable, Readable>
  address: string
  output: () => string
}

let root: string
const running: Running[] = []

async function startService(env: Record<string, string> = {}): Promise<Running> {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'src/main.ts'], {
    cwd: SERVICE_DIR,
    env: {
      ...process.env,
      CUSTODIO_DATA_DIR: join(root, 'data'),
      CUSTODIO_TOKEN: TOKEN,
      CUSTODIO_PORT: '0',
      CUSTODIO_ADAPTERS: 'sim',
      CUSTODIO_SIM_SCENARIO: join(root, 'scenario.json'),
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let log = ''
  child.stdout.on('data', (chunk: Buffer) => (log += chunk.toString()))
  child.stderr.on('data', (chunk: Buffer) => (log += chunk.toString()))
  const address = await new Promise<string>((resolveAddress, reject) => {
    const timer = setTimeout(() => reject(new Error(`El servicio no arrancó:\n${log}`)), 25_000)
    const check = () => {
      for (const line of log.split('\n')) {
        try {
          const entry = JSON.parse(line) as { msg?: string; address?: string }
          if (entry.msg === 'custodio listening' && entry.address) {
            clearTimeout(timer)
            resolveAddress(entry.address)
          }
        } catch {
          // not a JSON log line
        }
      }
    }
    child.stdout.on('data', check)
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`El servicio terminó con código ${code}:\n${log}`))
    })
  })
  const service = { child, address, output: () => log }
  running.push(service)
  return service
}

async function stopService(service: Running): Promise<void> {
  if (service.child.exitCode !== null || service.child.signalCode !== null) return
  const exited = new Promise((resolveExit) => service.child.once('exit', resolveExit))
  service.child.kill()
  await exited
}

async function api(service: Running, method: string, path: string, body?: unknown, token: string | null = TOKEN) {
  const response = await fetch(`${service.address}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const json = (await response.json()) as any
  const problems = openApi.check(method, path, response.status, json)
  if (problems.length > 0) throw new Error(problems.join('\n'))
  return { status: response.status, body: json }
}

interface SseMessage {
  id?: string
  event?: string
  data: any
}

// Reads Server-Sent Events until the predicate is satisfied
async function readSse(service: Running, until: (messages: SseMessage[]) => boolean, headers: Record<string, string> = {}, path = '/v1/events/stream'): Promise<SseMessage[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20_000)
  const response = await fetch(`${service.address}${path}`, { headers: { authorization: `Bearer ${TOKEN}`, ...headers }, signal: controller.signal })
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toContain('text/event-stream')
  const reader = (response.body as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  const messages: SseMessage[] = []
  let buffer = ''
  try {
    while (!until(messages)) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let split = buffer.indexOf('\n\n')
      while (split >= 0) {
        const block = buffer.slice(0, split)
        buffer = buffer.slice(split + 2)
        const message: SseMessage = { data: null }
        for (const line of block.split('\n')) {
          if (line.startsWith('id: ')) message.id = line.slice(4)
          else if (line.startsWith('event: ')) message.event = line.slice(7)
          else if (line.startsWith('data: ')) message.data = JSON.parse(line.slice(6))
        }
        if (message.event) messages.push(message)
        split = buffer.indexOf('\n\n')
      }
    }
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
  return messages
}

async function setUpDisks(): Promise<void> {
  const main = join(root, 'disks', 'principal')
  const copy = join(root, 'disks', 'copia')
  await mkdir(join(main, 'Fotos'), { recursive: true })
  await mkdir(copy, { recursive: true })
  const old = new Date(Date.now() - 60 * 60 * 1000)
  for (const name of ['a.jpg', 'b.jpg']) {
    const file = join(main, 'Fotos', name)
    await writeFile(file, `contenido ${name}`)
    await utimes(file, old, old)
  }
  await writeFile(
    join(root, 'scenario.json'),
    JSON.stringify({
      disks: [
        { serial: 'E2E-MAIN', model: 'Disco principal', sizeBytes: 2e12, devicePath: '/dev/e2e1', mountPath: main },
        { serial: 'E2E-COPY', model: 'Disco de copias', sizeBytes: 2e12, devicePath: '/dev/e2e2', mountPath: copy }
      ]
    })
  )
}

async function createProject(service: Running) {
  const disks = (await api(service, 'GET', '/v1/disks')).body.disks
  const main = disks.find((d: any) => d.serial === 'E2E-MAIN')
  const copy = disks.find((d: any) => d.serial === 'E2E-COPY')
  const project = (await api(service, 'POST', '/v1/projects', { name: 'Familia' })).body.project
  const plan = (
    await api(service, 'POST', `/v1/projects/${project.id}/plans`, {
      actions: [
        { type: 'add_assignment', diskId: main.id, folder: 'Fotos', role: 'storage' },
        { type: 'add_assignment', diskId: copy.id, folder: 'Copias', role: 'backup' }
      ]
    })
  ).body.plan
  await api(service, 'POST', `/v1/plans/${plan.id}/confirm`, { confirm: true })
  const view = (await api(service, 'GET', `/v1/projects/${project.id}`)).body
  const storage = view.assignments.find((a: any) => a.role === 'storage')
  const backup = view.assignments.find((a: any) => a.role === 'backup')
  const policy = (await api(service, 'POST', `/v1/projects/${project.id}/policies`, { name: 'Cada noche', sources: [storage.id], destinations: [backup.id], cron: '0 3 * * *', timezone: 'America/Santiago' })).body
  return { projectId: project.id as string, policyId: policy.id as string }
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'custodio-e2e-'))
  await setUpDisks()
})

afterAll(async () => {
  for (const service of running) await stopService(service)
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

describe('servicio en marcha', () => {
  it('A15 el proceso escucha solo en 127.0.0.1, exige token y se niega a abrirse a la red', async () => {
    const service = await startService()
    expect(service.address).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    const anonymous = await api(service, 'GET', '/v1/disks', undefined, null)
    expect(anonymous.status).toBe(401)
    expect(anonymous.body.error.code).toBe('unauthorized')
    await stopService(service)

    await expect(startService({ CUSTODIO_HOST: '0.0.0.0' })).rejects.toThrow(/terminó con código/)
  })

  it('A14 el servicio en marcha publica el mismo contrato que openapi.yaml', async () => {
    const service = await startService()
    const served = await api(service, 'GET', '/v1/openapi.json')
    expect(served.body).toEqual(parse(await readFile(OPENAPI_FILE, 'utf8')))
    await stopService(service)
  })

  it('A5 el proyecto persiste tras reiniciar el proceso del servicio', async () => {
    const first = await startService()
    const { projectId } = await createProject(first)
    const before = (await api(first, 'GET', `/v1/projects/${projectId}`)).body
    await stopService(first)

    const second = await startService()
    const after = (await api(second, 'GET', `/v1/projects/${projectId}`)).body
    expect(after.project).toEqual(before.project)
    expect(after.assignments).toEqual(before.assignments)
    expect(after.policies.map((p: any) => p.id)).toEqual(before.policies.map((p: any) => p.id))
    await stopService(second)
  })

  it('A13 el stream SSE entrega eventos en vivo a la UI y retoma con Last-Event-ID', async () => {
    const service = await startService()
    const backlog = await readSse(service, (m) => m.filter((x) => x.event === 'disk.detected').length >= 2)
    const detected = backlog.filter((m) => m.event === 'disk.detected')
    expect(detected.map((m) => m.data.payload.serial).sort()).toEqual(['E2E-COPY', 'E2E-MAIN'])
    for (const message of detected) {
      expect(message.id).toBe(String(message.data.seq))
      expect(eventsContract.check(message.data)).toEqual([])
    }

    const policyId = (await api(service, 'GET', '/v1/projects')).body.projects[0].policies[0].id
    const live = readSse(service, (m) => m.some((x) => x.event === 'backup.completed'), { 'last-event-id': detected.at(-1)?.id as string })
    await new Promise((r) => setTimeout(r, 200))
    const run = await api(service, 'POST', `/v1/policies/${policyId}/runs`, {})
    expect(run.status).toBe(202)
    const messages = await live
    expect(messages.some((m) => m.event === 'disk.detected')).toBe(false)
    expect(messages.filter((m) => m.event === 'job.updated' && m.data.id === run.body.job.id).length).toBeGreaterThan(0)
    const completed = messages.find((m) => m.event === 'backup.completed')
    expect(completed?.data.payload).toMatchObject({ jobId: run.body.job.id, filesCopied: 2 })
    expect(eventsContract.check(completed?.data)).toEqual([])

    const resumed = await readSse(service, (m) => m.some((x) => x.event === 'backup.completed'), {}, `/v1/events/stream?after=${detected[0]?.id}`)
    expect(resumed.filter((m) => m.id).map((m) => m.event)).toEqual(expect.arrayContaining(['disk.detected', 'backup.completed']))
    expect(resumed.some((m) => m.id === detected[0]?.id)).toBe(false)
    await stopService(service)
  })
})
