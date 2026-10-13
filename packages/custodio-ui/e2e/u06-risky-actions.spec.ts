import { existsSync } from 'node:fs'
import { join } from 'node:path'
import es from '../src/ui/i18n/es.json'
import { captureEvidence } from './evidence'
import { expect, goTo, openApp, test } from './support/fixtures'
import { DEFAULT_DISKS, healthy } from './support/service'

const GB = 1_000_000_000

test.use({
  scenario: {
    disks: [
      ...DEFAULT_DISKS,
      { name: 'viejo', model: 'Disco viejo 1 TB', serial: 'SN-VIEJO', smart: healthy({ '5': 7 }), usage: { totalBytes: 1000 * GB, freeBytes: 800 * GB } }
    ]
  }
})

const dialog = (page: import('@playwright/test').Page) => page.getByRole('dialog')

test('U6 retirar un disco muestra antes qué pasará y exige confirmación', async ({ page, service }) => {
  await service.standardProject()
  const { assignments } = await service.project('Archivo', [{ disk: 'viejo', folder: 'Archivo', role: 'backup', label: 'Archivo viejo' }])
  await openApp(page, service)
  await goTo(page, es.nav.disks)
  const card = page.getByTestId('disk-card').filter({ has: page.getByRole('heading', { name: 'Disco viejo 1 TB' }) })

  // Kept behind Editar, so it is never pressed by accident
  await expect(card.getByRole('button', { name: es.disks.action.retire })).toHaveCount(0)
  await card.getByRole('button', { name: es.disks.action.edit }).click()
  await card.getByRole('button', { name: es.disks.action.retire }).click()
  await expect(dialog(page)).toContainText(es.disks.retire.summary.replace('{disk}', 'Disco viejo 1 TB'))
  await expect(dialog(page)).toContainText('Sus archivos se quedan en el disco.')
  await captureEvidence(page, 'U6-retirar')
  await dialog(page).getByRole('button', { name: es.common.cancel }).click()
  await expect(dialog(page)).toHaveCount(0)
  expect((await service.api('GET', `/v1/projects/${assignments[0].projectId}`)).assignments).toHaveLength(1)

  await card.getByRole('button', { name: es.disks.action.retire }).click()
  await dialog(page).getByRole('button', { name: es.disks.retire.confirm }).click()
  await expect(dialog(page)).toHaveCount(0)
  await expect(card.getByText(es.disks.state.unassigned)).toBeVisible()
  expect((await service.api('GET', `/v1/projects/${assignments[0].projectId}`)).assignments).toEqual([])
})

test('U6 reparar un disco muestra antes qué pasará y exige confirmación', async ({ page, service }) => {
  await openApp(page, service)
  await goTo(page, es.nav.disks)
  const card = page.getByTestId('disk-card').filter({ has: page.getByRole('heading', { name: 'Disco viejo 1 TB' }) })

  await card.getByRole('button', { name: es.disks.action.repair }).click()
  await expect(dialog(page).getByRole('heading')).toHaveText(es.disks.repair.title.replace('{disk}', 'Disco viejo 1 TB'))
  await expect(dialog(page)).toContainText('No se borra ningún archivo tuyo')
  await captureEvidence(page, 'U6-reparar')
  await dialog(page).getByRole('button', { name: es.common.cancel }).click()
  expect((await service.api('GET', '/v1/jobs?kind=repair')).jobs).toEqual([])

  await card.getByRole('button', { name: es.disks.action.repair }).click()
  await dialog(page).getByRole('button', { name: es.disks.repair.confirm }).click()
  await expect(dialog(page)).toHaveCount(0)
  await expect.poll(async () => (await service.api('GET', '/v1/jobs?kind=repair')).jobs.map((j: any) => j.status)).toEqual(['succeeded'])
  expect((await service.api('GET', '/v1/audit')).entries.map((e: any) => e.action)).toContain('disk.repair_requested')
  // The card itself tells how the repair went, without opening Actividad
  await expect(card.getByTestId('last-run')).toContainText(es.jobs.result.repaired)
})

test('U6 activar el modo espejo muestra antes qué pasará y exige confirmación explícita', async ({ page, service }) => {
  const { policyId } = await service.standardProject()
  await openApp(page, service)
  await goTo(page, es.nav.projects)
  await page.getByTestId('project-card').getByRole('button', { name: es.projects.card.edit }).click()
  const form = page.getByTestId('project-editor')
  await form.getByRole('button', { name: es.backups.form.advanced }).click()
  await form.getByRole('radio', { name: es.backups.form.deletedMode.mirror }).check()

  await form.getByRole('button', { name: es.projects.editor.review }).click()
  await expect(dialog(page)).toContainText(es.backups.mirror.line1)
  const confirm = dialog(page).getByRole('button', { name: es.backups.mirror.confirm })
  await expect(confirm).toBeDisabled()
  await captureEvidence(page, 'U6-espejo')
  await dialog(page).getByRole('button', { name: es.common.cancel }).click()
  expect((await service.api('GET', `/v1/policies/${policyId}`)).mode).toBe('append')

  await form.getByRole('button', { name: es.projects.editor.review }).click()
  await dialog(page).getByRole('checkbox', { name: es.backups.mirror.acknowledge }).check()
  await confirm.click()
  await expect(dialog(page)).toHaveCount(0)
  await goTo(page, es.nav.backups)
  await expect(page.getByTestId('policy-card').getByText(es.backups.mode.mirror)).toBeVisible()
  expect(await service.api('GET', `/v1/policies/${policyId}`)).toMatchObject({ mode: 'mirror', mirrorConfirmed: true })
})

test('U6 borrar de las copias muestra antes qué se borrará y exige confirmación; el original no se toca', async ({ page, service }) => {
  const { policyId } = await service.standardProject()
  await service.runPolicy(policyId)
  const copy = join(service.diskPath('copia'), 'Copias', 'Fotos', 'cumple.jpg')
  const original = join(service.diskPath('principal'), 'Fotos', 'cumple.jpg')
  expect(existsSync(copy)).toBe(true)
  await openApp(page, service)
  await goTo(page, es.nav.projects)
  // In the project's danger zone, apart from its everyday buttons
  await expect(page.getByRole('button', { name: es.projects.delete.button })).toHaveCount(0)
  await page.getByTestId('project-card').getByRole('button', { name: es.projects.card.edit }).click()
  await expect(page.getByTestId('danger-zone')).toBeVisible()

  await page.getByRole('button', { name: es.projects.delete.button }).click()
  await dialog(page).getByRole('textbox', { name: es.projects.delete.path }).fill('cumple.jpg')
  await dialog(page).getByRole('button', { name: es.projects.delete.review }).click()
  await expect(dialog(page).getByRole('heading')).toHaveText(es.projects.delete.previewTitle)
  await expect(dialog(page)).toContainText('Los archivos originales no se tocan.')
  const confirm = dialog(page).getByRole('button', { name: es.projects.delete.confirm })
  await expect(confirm).toBeDisabled()
  await captureEvidence(page, 'U6-borrar')
  await dialog(page).getByRole('button', { name: es.common.cancel }).click()
  expect(existsSync(copy)).toBe(true)

  await page.getByRole('button', { name: es.projects.delete.button }).click()
  await dialog(page).getByRole('textbox', { name: es.projects.delete.path }).fill('cumple.jpg')
  await dialog(page).getByRole('button', { name: es.projects.delete.review }).click()
  await dialog(page).getByRole('checkbox', { name: es.projects.delete.acknowledge }).check()
  await dialog(page).getByRole('button', { name: es.projects.delete.confirm }).click()
  await expect(dialog(page)).toHaveCount(0)
  await expect.poll(() => existsSync(copy)).toBe(false)
  expect(existsSync(original)).toBe(true)
})
