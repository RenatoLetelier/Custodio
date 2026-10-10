import es from '../src/ui/i18n/es.json'
import { captureEvidence } from './evidence'
import { expect, goTo, openApp, test } from './support/fixtures'

const MIB = 1024 * 1024
const GB = 1_000_000_000

test.use({
  scenario: {
    disks: [
      { name: 'principal', model: 'WD Elements 2 TB', files: { 'Videos/a.mp4': 2 * MIB, 'Videos/b.mp4': 2 * MIB, 'Videos/c.mp4': 2 * MIB }, usage: { totalBytes: 2000 * GB, freeBytes: 1500 * GB } },
      { name: 'copia', model: 'Seagate Backup 4 TB', usage: { totalBytes: 4000 * GB, freeBytes: 3900 * GB } }
    ]
  }
})

test('U7 el job activo y la cola muestran el progreso sin recargar (SSE)', async ({ page, service }) => {
  const { projectId, assignments } = await service.project('Videos', [
    { disk: 'principal', folder: 'Videos', role: 'storage', label: 'Videos' },
    { disk: 'copia', folder: 'Copias', role: 'backup', label: 'Copia' }
  ])
  // 6 MiB at 2 MiB/s: about three seconds of visible progress
  const policy = await service.policy(projectId, {
    name: 'Videos de la familia',
    sources: [assignments.find((a) => a.role === 'storage').id],
    destinations: [assignments.find((a) => a.role === 'backup').id],
    maxMegabytesPerSecond: 2
  })

  const streams: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('/v1/events/stream')) streams.push(request.url())
  })
  await openApp(page, service)
  await goTo(page, es.nav.activity)
  await expect(page.getByTestId('queue')).toContainText('Videos de la familia')
  let navigations = 0
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) navigations++
  })

  // Started from outside the window: only the live stream can tell the interface
  const { job } = await service.api('POST', `/v1/policies/${policy.id}/runs`, {})
  const running = page.locator(`[data-testid=running-job][data-job="${job.id}"]`)
  await expect(running).toBeVisible()
  await expect(running).toContainText(es.activity.name.backup.replace('{name}', 'Videos de la familia'))
  await expect(page.getByRole('navigation').getByText('1', { exact: true })).toBeVisible()

  const seen = new Set<string>()
  await expect
    .poll(
      async () => {
        const text = await running.getByTestId('job-percent').textContent().catch(() => null)
        if (text) seen.add(text)
        return [...seen].filter((v) => v !== '0 %' && v !== '100 %').length
      },
      { intervals: [100], timeout: 10_000 }
    )
    .toBeGreaterThanOrEqual(2)
  const progress = running.getByRole('progressbar')
  await expect(progress).toHaveAttribute('aria-valuenow', /\d+/)
  await captureEvidence(page, 'U7-progreso')

  // When it ends it leaves "En curso" and appears in the history, still without reloading
  await expect(running).toHaveCount(0, { timeout: 15_000 })
  const row = page.getByTestId('history').locator(`[data-job="${job.id}"]`)
  await expect(row).toContainText(es.jobs.status.succeeded)
  expect(navigations).toBe(0)
  expect(streams.length).toBeGreaterThanOrEqual(1)
  await captureEvidence(page, 'U7-historial')
})
