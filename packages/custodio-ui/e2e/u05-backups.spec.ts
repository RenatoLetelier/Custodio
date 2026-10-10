import es from '../src/ui/i18n/es.json'
import { captureEvidence } from './evidence'
import { expect, goTo, openApp, test } from './support/fixtures'

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
