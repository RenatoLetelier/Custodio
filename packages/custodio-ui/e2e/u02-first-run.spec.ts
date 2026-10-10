import es from '../src/ui/i18n/es.json'
import { captureEvidence } from './evidence'
import { FORBIDDEN_TERMS, expect, openApp, test } from './support/fixtures'
import { DEFAULT_DISKS } from './support/service'

const GB = 1_000_000_000

test.use({
  scenario: {
    disks: [...DEFAULT_DISKS, { name: 'tercero', model: 'Toshiba Canvio 1 TB', serial: 'TS-TERCERO', sizeGB: 1000, usage: { totalBytes: 1000 * GB, freeBytes: 900 * GB } }]
  }
})

test('U2 asistente de primer uso: detecta los discos, elige su uso con presets y termina con resumen y confirmación', async ({ page, service }) => {
  await openApp(page, service)
  const wizard = page.getByTestId('wizard')
  await expect(wizard).toHaveAttribute('data-step', 'welcome')
  await expect(wizard.getByRole('heading')).toHaveText(es.wizard.welcome.title)
  await captureEvidence(page, 'U2-1-bienvenida')
  await page.getByRole('button', { name: es.wizard.welcome.start }).click()

  // Topology presets
  for (const preset of ['oneCopy', 'twoCopies', 'custom'] as const) await expect(page.getByRole('radio', { name: new RegExp(es.wizard.preset[preset].title) })).toBeVisible()
  await expect(page.getByRole('radio', { name: new RegExp(es.wizard.preset.oneCopy.title) })).toBeChecked()
  await page.getByRole('radio', { name: new RegExp(es.wizard.preset.twoCopies.title) }).check()
  await captureEvidence(page, 'U2-2-copias')
  await page.getByRole('button', { name: es.common.next }).click()

  // Every detected disk, each with the three plain choices; "two copies" prefilled
  const choices = page.getByTestId('disk-choice')
  await expect(choices).toHaveCount(3)
  const roleOf = (model: string) => page.getByRole('radiogroup', { name: es.wizard.disks.roleFor.replace('{disk}', model) })
  for (const model of ['WD Elements 2 TB', 'Seagate Backup 4 TB', 'Toshiba Canvio 1 TB']) {
    for (const choice of [es.wizard.choice.storage, es.wizard.choice.backup, es.wizard.choice.none]) await expect(roleOf(model).getByText(choice, { exact: true })).toBeVisible()
  }
  await expect(roleOf('WD Elements 2 TB').getByRole('radio', { name: es.wizard.choice.storage })).toBeChecked()
  await expect(roleOf('Seagate Backup 4 TB').getByRole('radio', { name: es.wizard.choice.backup })).toBeChecked()
  await expect(roleOf('Toshiba Canvio 1 TB').getByRole('radio', { name: es.wizard.choice.backup })).toBeChecked()

  // Personal choice: the third disk stays out
  await roleOf('Toshiba Canvio 1 TB').getByText(es.wizard.choice.none, { exact: true }).click()
  await expect(roleOf('Toshiba Canvio 1 TB').getByRole('radio', { name: es.wizard.choice.none })).toBeChecked()
  await captureEvidence(page, 'U2-3-discos')

  // Without a copy the assistant does not let you continue
  await roleOf('Seagate Backup 4 TB').getByText(es.wizard.choice.none, { exact: true }).click()
  await expect(page.getByText(es.wizard.disks.needBoth)).toBeVisible()
  await expect(page.getByRole('button', { name: es.common.next })).toBeDisabled()
  await roleOf('Seagate Backup 4 TB').getByText(es.wizard.choice.backup, { exact: true }).click()
  await page.getByRole('button', { name: es.common.next }).click()

  // Summary in plain words, then explicit confirmation
  const summary = page.getByTestId('wizard-summary')
  await expect(summary).toContainText('WD Elements 2 TB')
  await expect(summary).toContainText(es.wizard.summary.backup.replace('{disks}', 'Seagate Backup 4 TB').replace('{time}', '03:00'))
  await expect(summary).toContainText(es.wizard.summary.unused.replace('{disks}', 'Toshiba Canvio 1 TB'))
  await expect(summary).toContainText(es.wizard.summary.safe)
  await captureEvidence(page, 'U2-4-resumen')
  expect((await service.api('GET', '/v1/projects')).projects).toEqual([])

  for (const text of await page.locator('body').allInnerTexts()) expect(text).not.toMatch(FORBIDDEN_TERMS)
  await page.getByRole('button', { name: es.wizard.summary.confirm }).click()
  await expect(page.getByTestId('overview-status')).toBeVisible()

  const [project] = (await service.api('GET', '/v1/projects')).projects
  expect(project.project.name).toBe(es.wizard.projectName)
  const disks = (await service.api('GET', '/v1/disks')).disks
  const roleByModel = Object.fromEntries(project.assignments.map((a: any) => [disks.find((d: any) => d.id === a.diskId).model, a.role]))
  expect(roleByModel).toEqual({ 'WD Elements 2 TB': 'storage', 'Seagate Backup 4 TB': 'backup' })
  expect(project.policies).toHaveLength(1)
  expect(project.policies[0]).toMatchObject({ cron: '0 3 * * *', paused: false })
  expect(disks.find((d: any) => d.model === 'Toshiba Canvio 1 TB').state).toBe('unassigned')
  await captureEvidence(page, 'U2-5-listo')
})
