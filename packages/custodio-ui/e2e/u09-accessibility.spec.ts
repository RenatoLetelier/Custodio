import es from '../src/ui/i18n/es.json'
import { modes } from '../src/ui/theme/tokens'
import { captureEvidence } from './evidence'
import { expect, expectAccessible, expectTextsFromCatalog, goTo, openApp, test } from './support/fixtures'
import { DEFAULT_DISKS, healthy } from './support/service'

const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`
const SECTIONS = ['overview', 'disks', 'projects', 'backups', 'activity', 'settings'] as const

test('U9 el tema claro u oscuro sigue al sistema', async ({ page, service }) => {
  await service.standardProject()
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await openApp(page, service)
    await expect(page.locator('body')).toHaveCSS('background-color', rgb(modes[scheme].panelBg))
    await expect(page.locator('body')).toHaveCSS('color', rgb(modes[scheme].panelFg))
    await expect(page.getByTestId('overview-status')).toHaveCSS('background-color', rgb(modes[scheme].cardBg))
    await expect(page.getByTestId('sidebar')).toHaveCSS('background-color', rgb(modes[scheme].sidebarBg))
    await captureEvidence(page, `U9-tema-${scheme === 'light' ? 'claro' : 'oscuro'}`)
  }
})

test.describe('con un disco que se puede retirar', () => {
  // The first disk is assigned but feeds no scheduled copy, so "Dejar de usar este disco" opens its preview
  test.use({ scenario: { disks: [{ name: 'archivo', model: 'Disco de archivo', sizeGB: 1000 }, ...DEFAULT_DISKS] } })

  test('U9 todo se usa con el teclado', async ({ page, service }) => {
    await service.standardProject()
    await service.project('Archivo', [{ disk: 'archivo', folder: 'Archivo', role: 'backup', label: 'Archivo' }])
    await openApp(page, service)
    await page.keyboard.press('Tab')
    await expect(page.getByRole('link', { name: es.nav.skip })).toBeFocused()
    await page.keyboard.press('Tab')
    const overview = page.getByRole('navigation').getByRole('button', { name: es.nav.overview })
    await expect(overview).toBeFocused()
    await expect(overview).not.toHaveCSS('outline-style', 'none')
    await page.keyboard.press('Tab')
    await expect(page.getByRole('navigation').getByRole('button', { name: es.nav.disks })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(es.nav.disks)

    // Into the content: the first disk's details open and close with the keyboard
    const toggle = page.getByRole('button', { name: es.disks.technical.title }).first()
    for (let i = 0; i < 15 && !(await toggle.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Tab')
    await expect(toggle).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await page.keyboard.press('Space')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')

    // A dialog takes the focus, closes with Escape and gives the focus back
    const retire = page.getByRole('button', { name: es.disks.action.retire }).first()
    await retire.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog')).toBeVisible()
    await expect(page.getByRole('dialog').getByRole('button', { name: es.common.cancel })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(retire).toBeFocused()

    // The same holds for a dialog with a confirmation checkbox (mirror mode)
    await page.getByRole('navigation').getByRole('button', { name: es.nav.backups }).focus()
    await page.keyboard.press('Enter')
    const mirror = page.getByRole('button', { name: es.backups.mirror.button })
    await mirror.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog')).toBeVisible()
    await expect(page.getByRole('dialog').getByRole('button', { name: es.common.cancel })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(mirror).toBeFocused()
    await captureEvidence(page, 'U9-teclado')
  })
})

test.describe('con discos en distintos estados', () => {
  test.use({
    scenario: {
      disks: [
        { name: 'principal', model: 'WD Elements 2 TB', files: { 'Fotos/a.jpg': 'a' }, usage: { totalBytes: 2e12, freeBytes: 1.2e12 } },
        { name: 'copia', model: 'Seagate Backup 4 TB', usage: { totalBytes: 4e12, freeBytes: 3.5e12 } },
        { name: 'cansado', model: 'Disco cansado', smart: healthy({ '197': 4, '199': 3 }) },
        { name: 'mudo', model: 'Disco mudo', smart: null }
      ]
    }
  })

  test('U9 ninguna pantalla tiene violaciones graves de accesibilidad (axe), en claro ni en oscuro', async ({ page, service }) => {
    const { policyId } = await service.standardProject()
    await service.runPolicy(policyId)
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      await openApp(page, service)
      for (const section of SECTIONS) {
        await goTo(page, es.nav[section])
        await expectAccessible(page)
      }
      await goTo(page, es.nav.disks)
      await page.getByRole('button', { name: es.disks.technical.title }).first().click()
      await expectAccessible(page)
      await page.getByRole('button', { name: es.disks.action.repair }).first().click()
      await expect(page.getByRole('dialog')).toBeVisible()
      await expectAccessible(page)
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await goTo(page, es.nav.backups)
      await page.getByRole('button', { name: es.backups.new }).click()
      await page.getByText(es.backups.form.weekly, { exact: true }).click()
      await expectAccessible(page)
    }
    await captureEvidence(page, 'U9-axe-oscuro')
  })

  test('U9 todos los textos de la interfaz salen de es.json', async ({ page, service }) => {
    // The assistant first, before anything is configured
    await openApp(page, service)
    await expectTextsFromCatalog(page)
    for (const step of [es.wizard.welcome.start, es.common.next, es.common.next]) {
      await page.getByRole('button', { name: step }).click()
      await expectTextsFromCatalog(page)
    }

    const { policyId } = await service.standardProject()
    await service.runPolicy(policyId)
    await page.reload()
    await expect(page.getByTestId('app-ready')).toBeVisible()
    for (const section of SECTIONS) {
      await goTo(page, es.nav[section])
      await expectTextsFromCatalog(page)
    }
    await goTo(page, es.nav.disks)
    for (const toggle of await page.getByRole('button', { name: es.disks.technical.title }).all()) await toggle.click()
    await expectTextsFromCatalog(page)
    await page.getByRole('button', { name: es.disks.action.repair }).first().click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await expectTextsFromCatalog(page)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await goTo(page, es.nav.backups)
    await page.getByRole('button', { name: es.backups.new }).click()
    await page.getByText(es.backups.form.weekly, { exact: true }).click()
    await page.getByRole('button', { name: es.backups.form.advanced }).click()
    await expectTextsFromCatalog(page)
    await page.getByRole('button', { name: es.common.cancel }).click()
    await page.getByRole('button', { name: es.backups.mirror.button }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await expectTextsFromCatalog(page)
    await captureEvidence(page, 'U9-textos')
  })
})
