import es from '../src/ui/i18n/es.json'
import { captureEvidence } from './evidence'
import { expect, expectAccessible, expectTextsFromCatalog, goTo, openApp, test } from './support/fixtures'

test('U5 se crea una copia programada sin escribir cron, muestra la próxima ejecución y permite ejecutar ahora y pausar', async ({ page, service }) => {
  const { projectId } = await service.project('Familia', [
    { disk: 'principal', folder: 'Fotos', role: 'storage', label: 'Fotos' },
    { disk: 'copia', folder: 'Copias', role: 'backup', label: 'Copia en disco externo' }
  ])
  await openApp(page, service)
  await goTo(page, es.nav.backups)
  await expect(page.getByTestId('empty-state')).toContainText(es.backups.empty.title)
  await page.getByRole('button', { name: es.backups.empty.action }).click()

  const form = page.getByTestId('policy-form')
  await expect(form.getByRole('checkbox', { name: 'Fotos' })).toBeChecked()
  await expect(form.getByRole('checkbox', { name: 'Copia en disco externo' })).toBeChecked()
  await expect(form.getByTestId('schedule-preview')).toHaveText(es.schedule.daily.replace('{time}', '03:00'))
  await form.getByRole('textbox', { name: es.backups.form.name }).fill('Fotos tres veces por semana')
  await form.getByText(es.backups.form.weekly, { exact: true }).click()
  for (const day of ['1', '3', '5'] as const) await form.getByRole('checkbox', { name: es.schedule.days[day] }).check()
  await form.getByLabel(es.backups.form.time).fill('03:00')
  await expect(form.getByTestId('schedule-preview')).toHaveText('Los lunes, miércoles y viernes a las 03:00')
  expect(await form.innerText()).not.toMatch(/cron|\* \*/i)
  await captureEvidence(page, 'U5-nueva-copia')
  await form.getByRole('button', { name: es.backups.form.submit }).click()

  const card = page.getByTestId('policy-card')
  await expect(card).toHaveCount(1)
  await expect(card.getByTestId('policy-schedule')).toHaveText('Los lunes, miércoles y viernes a las 03:00')
  const [policy] = (await service.api('GET', `/v1/projects/${projectId}`)).policies
  expect(policy).toMatchObject({ name: 'Fotos tres veces por semana', cron: '0 3 * * 1,3,5', timezone: expect.any(String) })
  expect(policy.nextRunAt).toEqual(expect.any(String))
  await expect(card.getByTestId('policy-next')).toContainText(new Date(policy.nextRunAt).getFullYear().toString())

  // Run now
  await card.getByRole('button', { name: es.backups.runNow }).click()
  await expect(card.getByText(es.jobs.status.succeeded)).toBeVisible({ timeout: 15_000 })
  const jobs = (await service.api('GET', `/v1/jobs?policyId=${policy.id}`)).jobs
  expect(jobs).toEqual([expect.objectContaining({ trigger: 'manual', status: 'succeeded' })])

  // Pause and resume
  await card.getByRole('button', { name: es.backups.pause }).click()
  await expect(card.getByText(es.backups.paused, { exact: true })).toBeVisible()
  await expect(card.getByTestId('policy-next')).toHaveText(es.backups.noNext)
  expect((await service.api('GET', `/v1/policies/${policy.id}`)).paused).toBe(true)
  await captureEvidence(page, 'U5-pausada')
  await card.getByRole('button', { name: es.backups.resume }).click()
  await expect(card.getByText(es.backups.paused, { exact: true })).toHaveCount(0)
  expect((await service.api('GET', `/v1/policies/${policy.id}`)).paused).toBe(false)
  await captureEvidence(page, 'U5-respaldos')
})

test('U5 en Avanzado se elige que lo borrado del original pase a la papelera de la copia unos días', async ({ page, service }) => {
  const { projectId } = await service.project('LocalCloud', [
    { disk: 'principal', folder: 'Datos', role: 'storage', label: 'Datos' },
    { disk: 'copia', folder: 'Copias', role: 'backup', label: 'Respaldo' }
  ])
  await openApp(page, service)
  await goTo(page, es.nav.backups)
  await page.getByRole('button', { name: es.backups.empty.action }).click()

  const form = page.getByTestId('policy-form')
  await form.getByRole('button', { name: es.backups.form.advanced }).click()
  await expect(form.getByRole('radio', { name: es.backups.form.deletedMode.append })).toBeChecked()
  await expect(form.getByLabel(es.backups.form.retentionDays)).toHaveCount(0)
  await form.getByRole('radio', { name: es.backups.form.deletedMode.retention }).check()
  await form.getByLabel(es.backups.form.retentionDays).fill('0')
  await expect(form.getByRole('button', { name: es.backups.form.submit })).toBeDisabled()
  await form.getByLabel(es.backups.form.retentionDays).fill('45')
  await expect(form.getByLabel(es.backups.form.maxDelete)).toHaveValue('10')
  await expectAccessible(page)
  await expectTextsFromCatalog(page)
  await captureEvidence(page, 'U5-papelera')
  await form.getByRole('button', { name: es.backups.form.submit }).click()

  const card = page.getByTestId('policy-card')
  await expect(card.getByText(es.backups.mode.retention, { exact: true })).toBeVisible()
  await expect(card.getByTestId('policy-retention')).toHaveText(es.backups.retentionNote.replace('{days}', '45'))
  const [policy] = (await service.api('GET', `/v1/projects/${projectId}`)).policies
  expect(policy).toMatchObject({ mode: 'retention', retentionDays: 45, maxDeletePercent: 10 })

  // A copy already created changes it from its card: a larger limit, and back to keeping everything
  await card.getByRole('button', { name: es.backups.deleted.button }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('radio', { name: es.backups.form.deletedMode.retention })).toBeChecked()
  await dialog.getByLabel(es.backups.form.maxDelete).fill('25')
  await expectAccessible(page)
  await expectTextsFromCatalog(page)
  await dialog.getByRole('button', { name: es.backups.deleted.save }).click()
  await expect(dialog).toHaveCount(0)
  expect(await service.api('GET', `/v1/policies/${policy.id}`)).toMatchObject({ mode: 'retention', retentionDays: 45, maxDeletePercent: 25 })

  await card.getByRole('button', { name: es.backups.deleted.button }).click()
  await page.getByRole('dialog').getByRole('radio', { name: es.backups.form.deletedMode.append }).check()
  await page.getByRole('dialog').getByRole('button', { name: es.backups.deleted.save }).click()
  await expect(card.getByText(es.backups.mode.retention, { exact: true })).toHaveCount(0)
  await expect(card.getByTestId('policy-retention')).toHaveCount(0)
  expect((await service.api('GET', `/v1/policies/${policy.id}`)).mode).toBe('append')
})
