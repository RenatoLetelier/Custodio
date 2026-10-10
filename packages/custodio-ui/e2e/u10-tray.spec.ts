import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { StatusMonitor, type ShellPort } from '../src/main/status'
import { circlePng } from '../src/main/tray-icon'
import es from '../src/ui/i18n/es.json'
import { semaphore, type Health } from '../src/ui/theme/tokens'
import { EVIDENCE_DIR, captureEvidence } from './evidence'
import { expect, openApp, test } from './support/fixtures'
import { healthy } from './support/service'

// Stand-in for Electron's Tray and Notification: records what the real shell would show
class MockShell implements ShellPort {
  readonly tray: { status: Health; tooltip: string }[] = []
  readonly notifications: { title: string; body: string }[] = []
  setTray(status: Health, tooltip: string): void {
    this.tray.push({ status, tooltip })
  }
  notify(title: string, body: string): void {
    this.notifications.push({ title, body })
  }
  get status(): Health | undefined {
    return this.tray.at(-1)?.status
  }
}

// Colour of the centre pixel of the generated tray icon
function centreColour(png: Buffer): string {
  const size = png.readUInt32BE(16)
  const idat = png.indexOf('IDAT')
  const length = png.readUInt32BE(idat - 4)
  const pixels = inflateSync(png.subarray(idat + 4, idat + 4 + length))
  const row = Math.floor(size / 2) * (1 + size * 4)
  const offset = row + 1 + Math.floor(size / 2) * 4
  return `#${[0, 1, 2].map((i) => (pixels[offset + i] as number).toString(16).padStart(2, '0')).join('')}`
}

test('U10 el icono de bandeja toma el color del semáforo global y hay notificación nativa cuando un disco cambia de estado o falla un respaldo', async ({ page, service }) => {
  const { policyId } = await service.standardProject()
  await service.runPolicy(policyId)
  const shell = new MockShell()
  const monitor = new StatusMonitor({ baseUrl: service.baseUrl, token: service.token }, shell)
  await monitor.start()
  try {
    expect(shell.tray.at(-1)).toEqual({ status: 'green', tooltip: es.tray.tooltip.green })
    expect(shell.notifications).toEqual([])

    // A disk starts to wear out
    await service.sim('/disks/update', { devicePath: service.device('copia'), smart: healthy({ '197': 2 }) })
    await expect.poll(() => shell.notifications.map((n) => n.title)).toContain(es.tray.notify.health.yellow.replace('{disk}', 'Seagate Backup 4 TB'))
    await expect.poll(() => shell.status).toBe('yellow')
    expect(shell.tray.at(-1)?.tooltip).toBe(es.tray.tooltip.yellow)

    // The copy disk goes away and the next backup fails
    await service.sim('/disks/remove', { devicePath: service.device('copia') })
    const { job } = await service.api('POST', `/v1/policies/${policyId}/runs`, {})
    expect((await service.waitForJob(job.id)).status).toBe('failed')
    await expect.poll(() => shell.notifications.map((n) => n.title)).toContain(es.tray.notify.backupFailed.title)
    await expect.poll(() => shell.status).toBe('red')
    expect(shell.notifications.find((n) => n.title === es.tray.notify.backupFailed.title)?.body).toBe(es.tray.notify.backupFailed.body)
    expect((await service.api('GET', '/v1/overview')).status).toBe('red')
  } finally {
    monitor.stop()
  }

  // The icon itself is painted in the semaphore colour
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  for (const status of ['green', 'yellow', 'red', 'unknown'] as const) {
    const png = circlePng(semaphore[status], 64)
    expect(centreColour(png)).toBe(semaphore[status])
    writeFileSync(join(EVIDENCE_DIR, `U10-bandeja-${status}.png`), png)
  }

  // The window shows the same global colour as the tray
  await openApp(page, service)
  await expect(page.getByTestId('global-status').getByRole('img')).toHaveAttribute('data-status', 'red')
  await captureEvidence(page, 'U10-estado-global')
})
