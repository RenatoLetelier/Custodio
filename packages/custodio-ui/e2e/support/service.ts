import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { Readable } from 'node:stream'

export const SERVICE_DIR = resolve(__dirname, '../../../custodio-service')
export const RENDERER_ORIGIN = 'http://127.0.0.1:5290'
const TOKEN = 'ui-e2e-token-0123456789abcdef0123456789abcdef'
const GB = 1_000_000_000

export interface SmartSpec {
  supported: boolean
  passed: boolean | null
  attributes: Record<string, number>
  temperatureC: number | null
  powerOnHours: number | null
}

export interface DiskSpec {
  name: string
  model?: string
  serial?: string
  sizeGB?: number
  // Relative path → text, or a number of bytes to fill
  files?: Record<string, string | number>
  smart?: SmartSpec | null
  usage?: { totalBytes: number; freeBytes: number }
  connected?: boolean
}

export const healthy = (attributes: Record<string, number> = {}, extra: Partial<SmartSpec> = {}): SmartSpec => ({
  supported: true,
  passed: true,
  attributes: { '5': 0, '197': 0, '198': 0, '199': 0, ...attributes },
  temperatureC: 36,
  powerOnHours: 1500,
  ...extra
})

export class ServiceHandle {
  constructor(
    readonly root: string,
    readonly baseUrl: string,
    readonly token: string,
    private readonly child: ChildProcessByStdio<null, Readable, Readable>,
    readonly log: () => string
  ) {}

  diskPath(name: string): string {
    return join(this.root, 'disks', name)
  }

  device(name: string): string {
    return `/dev/sim-${name}`
  }

  async api<T = any>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${text}`)
    return (text === '' ? null : JSON.parse(text)) as T
  }

  sim<T = any>(path: string, body: unknown): Promise<T> {
    return this.api<T>('POST', `/_sim${path}`, body)
  }

  async waitForJob(jobId: string, timeoutMs = 20_000): Promise<any> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const job = await this.api('GET', `/v1/jobs/${jobId}`)
      if (job.status !== 'running' && job.status !== 'queued') return job
      if (Date.now() > deadline) throw new Error(`Job ${jobId} still ${job.status}`)
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  async diskId(name: string): Promise<string> {
    const disks = (await this.api('GET', '/v1/disks')).disks as { id: string; devicePath: string }[]
    const disk = disks.find((d) => d.devicePath === this.device(name))
    if (!disk) throw new Error(`Disk ${name} not found`)
    return disk.id
  }

  // Project through the same plan + confirmation the interface uses
  async project(name: string, layout: { disk: string; folder: string; role: 'storage' | 'backup'; label?: string }[]): Promise<{ projectId: string; assignments: any[] }> {
    const created = await this.api('POST', '/v1/projects', { name })
    const actions = []
    for (const l of layout) actions.push({ type: 'add_assignment', diskId: await this.diskId(l.disk), folder: l.folder, role: l.role, label: l.label })
    const { plan } = await this.api('POST', `/v1/projects/${created.project.id}/plans`, { actions })
    await this.api('POST', `/v1/plans/${plan.id}/confirm`, { confirm: true })
    const view = await this.api('GET', `/v1/projects/${created.project.id}`)
    return { projectId: created.project.id, assignments: view.assignments }
  }

  async policy(projectId: string, body: Record<string, unknown>): Promise<any> {
    return this.api('POST', `/v1/projects/${projectId}/policies`, { name: 'Copia diaria', cron: '0 3 * * *', timezone: 'America/Santiago', ...body })
  }

  // The usual setup: one disk with files, one disk for copies, a daily copy
  async standardProject(): Promise<{ projectId: string; policyId: string; storage: any; backup: any }> {
    const { projectId, assignments } = await this.project('Familia', [
      { disk: 'principal', folder: 'Fotos', role: 'storage', label: 'Fotos' },
      { disk: 'copia', folder: 'Copias', role: 'backup', label: 'Copia en disco externo' }
    ])
    const storage = assignments.find((a) => a.role === 'storage')
    const backup = assignments.find((a) => a.role === 'backup')
    const policy = await this.policy(projectId, { sources: [storage.id], destinations: [backup.id] })
    return { projectId, policyId: policy.id, storage, backup }
  }

  async runPolicy(policyId: string): Promise<any> {
    const { job } = await this.api('POST', `/v1/policies/${policyId}/runs`, {})
    return this.waitForJob(job.id)
  }

  async stop(): Promise<void> {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      const exited = new Promise((r) => this.child.once('exit', r))
      this.child.kill()
      await exited
    }
    await rm(this.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }

  async kill(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return
    const exited = new Promise((r) => this.child.once('exit', r))
    this.child.kill()
    await exited
  }
}

export const DEFAULT_DISKS: DiskSpec[] = [
  { name: 'principal', model: 'WD Elements 2 TB', serial: 'WD-PRINCIPAL', sizeGB: 2000, files: { 'Fotos/viaje/playa.jpg': 'playa', 'Fotos/viaje/cerro.jpg': 'cerro', 'Fotos/cumple.jpg': 'cumpleaños' }, usage: { totalBytes: 2000 * GB, freeBytes: 1200 * GB } },
  { name: 'copia', model: 'Seagate Backup 4 TB', serial: 'SG-COPIA', sizeGB: 4000, usage: { totalBytes: 4000 * GB, freeBytes: 3500 * GB } }
]

export async function startService(disks: DiskSpec[] = DEFAULT_DISKS, env: Record<string, string> = {}): Promise<ServiceHandle> {
  const root = await mkdtemp(join(tmpdir(), 'custodio-ui-'))
  const old = new Date(Date.now() - 60 * 60 * 1000)
  const scenario = []
  for (const disk of disks) {
    const mountPath = join(root, 'disks', disk.name)
    await mkdir(mountPath, { recursive: true })
    for (const [rel, content] of Object.entries(disk.files ?? {})) {
      const file = join(mountPath, ...rel.split('/'))
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, typeof content === 'number' ? Buffer.alloc(content, 'x') : content)
      await utimes(file, old, old)
    }
    if (disk.connected === false) continue
    scenario.push({
      serial: disk.serial ?? `SN-${disk.name.toUpperCase()}`,
      model: disk.model ?? `Disco ${disk.name}`,
      sizeBytes: (disk.sizeGB ?? 1000) * GB,
      devicePath: `/dev/sim-${disk.name}`,
      mountPath,
      ...(disk.smart !== undefined ? { smart: disk.smart } : {}),
      ...(disk.usage ? { usage: disk.usage } : {})
    })
  }
  await writeFile(join(root, 'scenario.json'), JSON.stringify({ disks: scenario }))

  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'src/main.ts'], {
    cwd: SERVICE_DIR,
    env: {
      ...process.env,
      CUSTODIO_DATA_DIR: join(root, 'data'),
      CUSTODIO_TOKEN: TOKEN,
      CUSTODIO_PORT: '0',
      CUSTODIO_ADAPTERS: 'sim',
      CUSTODIO_SIM_SCENARIO: join(root, 'scenario.json'),
      CUSTODIO_CORS_ORIGINS: RENDERER_ORIGIN,
      CUSTODIO_TICK_MS: '300',
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let log = ''
  child.stdout.on('data', (chunk: Buffer) => (log += chunk.toString()))
  child.stderr.on('data', (chunk: Buffer) => (log += chunk.toString()))
  const baseUrl = await new Promise<string>((resolveUrl, reject) => {
    const timer = setTimeout(() => reject(new Error(`Service did not start:\n${log}`)), 30_000)
    child.stdout.on('data', () => {
      for (const line of log.split('\n')) {
        try {
          const entry = JSON.parse(line) as { msg?: string; address?: string }
          if (entry.msg === 'custodio listening' && entry.address) {
            clearTimeout(timer)
            resolveUrl(entry.address)
          }
        } catch {
          // not a log line
        }
      }
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`Service exited with ${code}:\n${log}`))
    })
  })
  return new ServiceHandle(root, baseUrl, TOKEN, child, () => log)
}
