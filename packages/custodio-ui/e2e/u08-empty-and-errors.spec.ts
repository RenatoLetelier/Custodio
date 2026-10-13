import es from '../src/ui/i18n/es.json'
import { captureEvidence } from './evidence'
import { expect, goTo, openApp, test } from './support/fixtures'

const RAW = /topology_invalid|same_disk|unreachable|ECONNREFUSED|Failed to fetch|TypeError|NetworkError|\bHTTP\b|\b(400|401|404|409|422|500)\b/

test.describe('sin discos', () => {
  test.use({ scenario: { disks: [] } })

  test('U8 cada pantalla tiene un estado vacío que sugiere la siguiente acción', async ({ page, service }) => {
    await openApp(page, service)

    // Resumen: the assistant is the next step; postponing it leaves a way back
    await expect(page.getByTestId('wizard')).toBeVisible()
    await page.getByRole('button', { name: es.wizard.later }).click()
    const empty = page.getByTestId('empty-state')
    await expect(empty).toContainText(es.overview.empty.title)
    await expect(empty.getByRole('button', { name: es.overview.empty.action })).toBeVisible()
    await captureEvidence(page, 'U8-resumen-vacio')

    await goTo(page, es.nav.disks)
    await expect(empty).toContainText(es.disks.empty.title)
    await expect(empty.getByRole('button', { name: es.disks.scan })).toBeVisible()
    await captureEvidence(page, 'U8-discos-vacio')

    await goTo(page, es.nav.projects)
    await expect(empty).toContainText(es.projects.empty.title)
    await expect(empty.getByRole('button', { name: es.projects.empty.action })).toBeVisible()

    await goTo(page, es.nav.backups)
    await expect(empty).toContainText(es.backups.empty.title)
    await expect(empty).toContainText(es.backups.empty.noProjects)
    await expect(empty.getByRole('button')).toBeVisible()

    await goTo(page, es.nav.activity)
    await expect(empty).toHaveCount(3)
    await expect(empty.nth(0)).toContainText(es.activity.empty.runningHint)
    await expect(empty.nth(1)).toContainText(es.activity.empty.queueHint)
    await expect(empty.nth(2)).toContainText(es.activity.empty.historyHint)
    await captureEvidence(page, 'U8-actividad-vacia')

    await goTo(page, es.nav.settings)
    await page.getByRole('button', { name: es.settings.recovery.search }).click()
    await expect(empty).toContainText(es.settings.recovery.none)
    await expect(empty).toContainText(es.settings.recovery.noneHint)

    // The assistant itself, with no disks, says what to do
    await goTo(page, es.nav.overview)
    await page.getByRole('button', { name: es.overview.empty.action }).click()
    await page.getByRole('button', { name: es.wizard.welcome.start }).click()
    await page.getByRole('button', { name: es.common.next }).click()
    await expect(empty).toContainText(es.wizard.noDisks.title)
    await expect(empty.getByRole('button', { name: es.disks.scan })).toBeVisible()
    await captureEvidence(page, 'U8-asistente-sin-discos')
  })
})

test('U8 los errores dicen qué pasó y qué hacer, sin códigos crudos', async ({ page, service }) => {
  // Storage and backup on the same disk: the service refuses the copy
  await service.project('Mismo disco', [
    { disk: 'principal', folder: 'Fotos', role: 'storage', label: 'Fotos' },
    { disk: 'principal', folder: 'Copia', role: 'backup', label: 'Copia en el mismo disco' }
  ])
  await openApp(page, service)
  await goTo(page, es.nav.backups)
  await page.getByRole('button', { name: es.backups.empty.action }).click()
  await page.getByRole('button', { name: es.projects.editor.review }).click()
  const notice = page.getByTestId('error-notice')
  await expect(notice).toContainText(es.errors.topology_invalid.title)
  await expect(notice).toContainText(es.errors.topology_invalid.hint)
  expect(await notice.innerText()).not.toMatch(RAW)
  await captureEvidence(page, 'U8-error-copia')

  // The service goes away: the interface explains it and offers to retry
  await service.kill()
  await expect(page.getByText(es.connection.lost)).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('connection')).toContainText(es.connection.offline)
  await page.reload()
  const offline = page.getByTestId('error-notice')
  await expect(offline).toContainText(es.errors.unreachable.title)
  await expect(offline).toContainText(es.errors.unreachable.hint)
  await expect(offline.getByRole('button', { name: es.common.retry })).toBeVisible()
  expect(await page.locator('body').innerText()).not.toMatch(RAW)
  await captureEvidence(page, 'U8-sin-servicio')
})
