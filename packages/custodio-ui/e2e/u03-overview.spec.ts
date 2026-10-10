import es from '../src/ui/i18n/es.json'
import { captureEvidence } from './evidence'
import { expect, openApp, test } from './support/fixtures'
import { healthy } from './support/service'

test('U3 el resumen muestra en una sola vista el estado global, el espacio total y libre, el último y el próximo respaldo', async ({ page, service }) => {
  const { policyId } = await service.standardProject()
  await service.runPolicy(policyId)
  await openApp(page, service)

  const overview = await service.api('GET', '/v1/overview')
  const status = page.getByTestId('overview-status')
  await expect(status).toHaveAttribute('data-status', overview.status)
  await expect(status.getByRole('heading')).toHaveText(es.overview.status.green)
  await expect(status.getByRole('img', { name: es.health.label.green })).toBeVisible()

  // 2 TB + 4 TB in decimal units; free 1,2 TB + 3,5 TB
  expect(overview.space).toEqual({ totalBytes: 6e12, freeBytes: 4.7e12 })
  await expect(page.getByTestId('stat-total')).toContainText('6 TB')
  await expect(page.getByTestId('stat-free')).toContainText('4,7 TB')
  await expect(page.getByTestId('stat-last')).toContainText(es.jobs.status.succeeded)
  await expect(page.getByTestId('stat-next')).toContainText(/dentro de|mañana|hoy/)
  await expect(page.getByTestId('todo-empty')).toHaveText(es.overview.todo.nothing)

  // Everything fits in one view, no scrolling
  const fits = await page.evaluate(() => {
    const panel = document.querySelector('.panel') as HTMLElement
    return panel.scrollHeight <= panel.clientHeight
  })
  expect(fits).toBe(true)
  await captureEvidence(page, 'U3-resumen')

  // When something goes wrong the same view says it and what to do
  await service.sim('/disks/update', { devicePath: service.device('copia'), smart: healthy({ '198': 3 }) })
  await expect(status).toHaveAttribute('data-status', 'red')
  await expect(status.getByRole('heading')).toHaveText(es.overview.status.red)
  await expect(page.getByText(es.overview.todo.repairDisk)).toBeVisible()
  await captureEvidence(page, 'U3-resumen-problema')
})
