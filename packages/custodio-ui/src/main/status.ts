import { t, type MessageKey } from '../ui/i18n'
import type { Health } from '../ui/theme/tokens'

// What the monitor needs from the desktop shell; Electron's Tray and Notification sit behind it
export interface ShellPort {
  setTray(status: Health, tooltip: string): void
  notify(title: string, body: string): void
}

export interface ServiceAddress {
  baseUrl: string
  token: string
}

interface StreamMessage {
  event: string
  data: { seq?: number; type?: string; payload?: Record<string, unknown> } | null
}

const RETRY_MS = 3000

// Keeps the tray colour in step with the global semaphore and turns important events into notifications.
// It only reads the service's /v1 API; the service keeps working whether or not this runs.
export class StatusMonitor {
  private readonly controller = new AbortController()
  private readonly models = new Map<string, string>()
  private refreshTimer: ReturnType<typeof setTimeout> | null = null
  status: Health = 'unknown'

  constructor(
    private readonly service: ServiceAddress,
    private readonly shell: ShellPort
  ) {}

  private async get<T>(path: string): Promise<T> {
    const response = await fetch(`${this.service.baseUrl}${path}`, { headers: { authorization: `Bearer ${this.service.token}` }, signal: this.controller.signal })
    if (!response.ok) throw new Error(`${path} answered ${response.status}`)
    return (await response.json()) as T
  }

  async refresh(): Promise<void> {
    const [overview, disks] = await Promise.all([
      this.get<{ status: Health }>('/v1/overview'),
      this.get<{ disks: { id: string; model: string }[] }>('/v1/disks')
    ])
    for (const disk of disks.disks) this.models.set(disk.id, disk.model)
    this.status = overview.status
    this.shell.setTray(overview.status, t(`tray.tooltip.${overview.status}`))
  }

  private refreshSoon(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.refreshTimer = setTimeout(() => void this.refresh().catch(() => undefined), 150)
  }

  private async latestSeq(): Promise<number> {
    let cursor = 0
    for (;;) {
      const page = await this.get<{ events: unknown[]; nextCursor: number }>(`/v1/events?after=${cursor}&limit=500`)
      if (page.events.length === 0) return cursor
      cursor = page.nextCursor
    }
  }

  handle(message: StreamMessage): void {
    const payload = message.data?.payload ?? {}
    if (message.event === 'disk.health_changed') {
      const current = payload.current as Health
      const disk = this.models.get(String(payload.diskId)) ?? t('common.unknownDisk')
      this.shell.notify(t(`tray.notify.health.${current}` as MessageKey, { disk }), t('tray.notify.health.body'))
    } else if (message.event === 'backup.failed') {
      this.shell.notify(t('tray.notify.backupFailed.title'), t('tray.notify.backupFailed.body'))
    }
    if (message.event !== 'job.updated') this.refreshSoon()
  }

  private async *stream(after: number): AsyncGenerator<StreamMessage> {
    const response = await fetch(`${this.service.baseUrl}/v1/events/stream?after=${after}`, {
      headers: { authorization: `Bearer ${this.service.token}` },
      signal: this.controller.signal
    })
    if (!response.ok || !response.body) throw new Error('event stream unavailable')
    const reader = (response.body as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      buffer += decoder.decode(value, { stream: true })
      let split = buffer.indexOf('\n\n')
      while (split >= 0) {
        const block = buffer.slice(0, split)
        buffer = buffer.slice(split + 2)
        const message: StreamMessage = { event: '', data: null }
        for (const line of block.split('\n')) {
          if (line.startsWith('event: ')) message.event = line.slice(7)
          else if (line.startsWith('data: ')) message.data = JSON.parse(line.slice(6)) as StreamMessage['data']
        }
        if (message.event) yield message
        split = buffer.indexOf('\n\n')
      }
    }
  }

  // Resolves once the first status is shown; keeps listening (and reconnecting) until stop()
  async start(): Promise<void> {
    let after = 0
    try {
      await this.refresh()
      after = await this.latestSeq()
    } catch {
      this.shell.setTray('unknown', t('tray.tooltip.unknown'))
    }
    void (async () => {
      while (!this.controller.signal.aborted) {
        try {
          for await (const message of this.stream(after)) {
            if (typeof message.data?.seq === 'number') after = message.data.seq
            this.handle(message)
          }
        } catch {
          if (this.controller.signal.aborted) return
          this.shell.setTray('unknown', t('tray.tooltip.unknown'))
        }
        await new Promise((resolve) => setTimeout(resolve, RETRY_MS))
        await this.refresh().catch(() => undefined)
      }
    })()
  }

  stop(): void {
    this.controller.abort()
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
  }
}
