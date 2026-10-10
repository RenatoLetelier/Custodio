import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { AtomicCopier } from '../../src/adapters/node/atomic-copier.js'
import { NodeFileSystem } from '../../src/adapters/node/filesystem.js'
import { SimClock } from '../../src/adapters/sim/clock.js'
import { SimDiskProbe, SimSmartReader, SimVolumeReader, TB, GB } from '../../src/adapters/sim/devices.js'
import { SimMeter } from '../../src/adapters/sim/io.js'
import { createService, type CustodioService } from '../../src/app.js'
import type { Services } from '../../src/core/services.js'
import type { Copier, FileSystemPort, PhysicalDiskInfo } from '../../src/core/ports/system.js'
import type { Assignment, Job, Policy, Role } from '../../src/core/shared/model.js'
import type { PolicyConfigInput } from '../../src/core/shared/policy.js'
import { eventsContract, openApi } from './contract.js'

export const TOKEN = 'test-token-0123456789abcdef0123456789abcdef'
export const ACTOR = 'tester'
export const START = '2026-10-01T12:00:00.000Z'
export const MINUTE = 60 * 1000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

export interface ApiResponse<T = any> {
  status: number
  body: T
  headers: Record<string, string | string[] | number | undefined>
}

export interface HarnessOptions {
  start?: string
  clockMode?: 'manual' | 'instant'
  root?: string
  fs?: (inner: FileSystemPort) => FileSystemPort
  copier?: (fs: FileSystemPort) => Copier
  random?: () => number
  extraTokens?: { name: string; token: string }[]
}

export interface SimDiskOptions {
  serial?: string | null
  wwn?: string | null
  model?: string
  sizeBytes?: number
  bus?: PhysicalDiskInfo['bus']
  totalBytes?: number
  freeBytes?: number
}

export interface SimDisk {
  name: string
  devicePath: string
  mountPath: string
  serial: string | null
}

export class Harness {
  readonly clock: SimClock
  readonly disks = new SimDiskProbe()
  readonly smart = new SimSmartReader()
  readonly volumes = new SimVolumeReader({ totalBytes: 2 * TB, freeBytes: 2 * TB - 100 * GB })
  readonly realFs = new NodeFileSystem()
  readonly fs: FileSystemPort
  readonly meter: SimMeter
  service!: CustodioService
  private diskCount = 0
  private closed = false

  constructor(
    readonly root: string,
    private readonly options: HarnessOptions
  ) {
    this.clock = new SimClock(options.start ?? START, options.clockMode ?? 'manual')
    this.fs = options.fs ? options.fs(this.realFs) : this.realFs
    this.meter = new SimMeter(this.clock)
    this.boot()
  }

  get dataDir(): string {
    return join(this.root, 'data')
  }

  get s(): Services {
    return this.service.services
  }

  boot(): void {
    this.service = createService(
      { dataDir: this.dataDir, tokens: [{ name: ACTOR, token: TOKEN }, ...(this.options.extraTokens ?? [])] },
      {
        clock: this.clock,
        disks: this.disks,
        smart: this.smart,
        volumes: this.volumes,
        fs: this.fs,
        copier: this.options.copier ? this.options.copier(this.fs) : new AtomicCopier(this.fs),
        meter: this.meter,
        random: this.options.random
      },
      { runScheduler: false }
    )
  }

  // A restart: same database and disks, a brand new service instance
  async restart(): Promise<void> {
    await this.s.runner.idle()
    await this.service.app.close()
    this.service.store.close()
    this.boot()
    this.s.runner.recover()
  }

  // Loses the database entirely; the disks and their files stay
  async resetDatabase(): Promise<void> {
    await this.s.runner.idle()
    await this.service.app.close()
    this.service.store.close()
    await rm(this.dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    this.boot()
  }

  async addDisk(name: string, options: SimDiskOptions = {}): Promise<SimDisk> {
    this.diskCount++
    const mountPath = join(this.root, 'disks', name)
    await mkdir(mountPath, { recursive: true })
    const devicePath = `/dev/sim${this.diskCount}`
    const serial = options.serial === undefined ? `SN-${name.toUpperCase()}` : options.serial
    this.disks.add({
      serial,
      wwn: options.wwn ?? null,
      model: options.model ?? `Disco ${name}`,
      sizeBytes: options.sizeBytes ?? 2 * TB,
      bus: options.bus ?? 'usb',
      devicePath,
      mountPath
    })
    if (options.totalBytes !== undefined || options.freeBytes !== undefined) {
      const totalBytes = options.totalBytes ?? 2 * TB
      this.volumes.set(mountPath, { totalBytes, freeBytes: options.freeBytes ?? totalBytes })
    }
    return { name, devicePath, mountPath, serial }
  }

  async scan() {
    const job = this.s.runner.startScan({ actor: ACTOR })
    return (await this.s.runner.settled(job.id)).result as Record<string, string[]>
  }

  diskId(disk: SimDisk): string {
    const found = this.s.core.store.disks.list().find((d) => d.devicePath === disk.devicePath)
    if (!found) throw new Error(`Disk ${disk.name} was not scanned`)
    return found.id
  }

  // Files are written "an hour ago" by default so they are past the quiet window
  async writeFile(disk: SimDisk, relPath: string, content: string | Buffer, ageMs = HOUR): Promise<string> {
    const path = join(disk.mountPath, ...relPath.split('/'))
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
    const time = new Date(this.clock.now().getTime() - ageMs)
    await utimes(path, time, time)
    return path
  }

  path(disk: SimDisk, relPath: string): string {
    return join(disk.mountPath, ...relPath.split('/'))
  }

  async project(name: string, layout: { disk: SimDisk; folder: string; role: Role; label?: string }[]): Promise<{ projectId: string; assignments: Assignment[] }> {
    const project = this.s.projects.create(name, ACTOR)
    const actions = layout.map((l) => ({ type: 'add_assignment' as const, diskId: this.diskId(l.disk), folder: l.folder, role: l.role, label: l.label }))
    const { plan } = this.s.plans.proposeAssignments(project.id, actions, ACTOR)
    await this.s.plans.confirm(plan.id, ACTOR, true)
    return { projectId: project.id, assignments: this.s.core.store.assignments.byProject(project.id) }
  }

  async policy(projectId: string, input: Omit<PolicyConfigInput, 'name' | 'cron' | 'timezone'> & Partial<PolicyConfigInput>): Promise<Policy> {
    return this.s.policies.create(projectId, { name: 'Copia diaria', cron: '0 3 * * *', timezone: 'America/Santiago', ...input }, ACTOR)
  }

  async run(policyId: string, options: { dryRun?: boolean; mirrorDryRunJobId?: string } = {}): Promise<Job> {
    const job = this.s.runner.startBackup(policyId, { actor: ACTOR, ...options })
    return this.s.runner.settled(job.id)
  }

  async request<T = any>(method: 'GET' | 'POST' | 'PATCH', url: string, body?: unknown, headers: Record<string, string> = {}): Promise<ApiResponse<T>> {
    const response = await this.service.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      payload: body === undefined ? undefined : JSON.stringify(body)
    })
    const parsed = response.body === '' ? null : (JSON.parse(response.body) as T)
    const problems = openApi.check(method, url, response.statusCode, parsed, String(response.headers['content-type'] ?? 'application/json'))
    if (problems.length > 0) throw new Error(`Response breaks openapi.yaml:\n${problems.join('\n')}\n${response.body.slice(0, 2000)}`)
    return { status: response.statusCode, body: parsed as T, headers: response.headers }
  }

  get = <T = any>(url: string, headers?: Record<string, string>) => this.request<T>('GET', url, undefined, headers)
  post = <T = any>(url: string, body: unknown = {}, headers?: Record<string, string>) => this.request<T>('POST', url, body, headers)
  patch = <T = any>(url: string, body: unknown, headers?: Record<string, string>) => this.request<T>('PATCH', url, body, headers)

  events(type?: string) {
    return this.s.core.store.outbox.after(0, 100_000).filter((e) => !type || e.type === type)
  }

  // Every event the test produced must match docs/EVENTS.md
  checkEvents(): void {
    const problems = this.events().flatMap((event) => eventsContract.check(event))
    if (problems.length > 0) throw new Error(`Events break docs/EVENTS.md:\n${problems.join('\n')}`)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    try {
      this.checkEvents()
    } finally {
      await this.s.runner.idle()
      await this.service.app.close()
      this.service.store.close()
      await rm(this.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const root = options.root ?? (await mkdtemp(join(tmpdir(), 'custodio-test-')))
  return new Harness(root, options)
}
