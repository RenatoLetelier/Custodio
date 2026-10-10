import es from '../src/ui/i18n/es.json'
import { modes } from '../src/ui/theme/tokens'
import { captureEvidence } from './evidence'
import { expect, openApp, test } from './support/fixtures'

const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`
const SECTIONS = ['overview', 'disks', 'projects', 'backups', 'activity', 'settings'] as const

test('U1 sidebar izquierdo con Resumen, Discos, Proyectos, Respaldos, Actividad y Configuración y panel derecho de contenido', async ({ page, service }) => {
  await service.standardProject()
  await openApp(page, service)

  const sidebar = page.getByTestId('sidebar')
  const nav = page.getByRole('navigation', { name: es.nav.label })
  await expect(nav.getByRole('button')).toHaveText(SECTIONS.map((s) => es.nav[s]))

  // Layout from docs/UI-GUIDE.md: dark sidebar 220 px on the left, panel filling the rest
  const sidebarBox = await sidebar.boundingBox()
  const panelBox = await page.getByRole('main').boundingBox()
  expect(sidebarBox).toMatchObject({ x: 0, width: 220 })
  expect(panelBox?.x).toBe(220)
  expect((panelBox?.width ?? 0) + 220).toBe(1280)
  await expect(sidebar).toHaveCSS('background-color', rgb(modes.light.sidebarBg))
  await expect(page.getByRole('main')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(page.locator('body')).toHaveCSS('background-color', rgb(modes.light.panelBg))
  await expect(page.locator('.brand-mark')).toHaveText(es.app.mark)

  for (const section of SECTIONS) {
    await nav.getByRole('button', { name: es.nav[section], exact: true }).click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(es.nav[section])
    await expect(page.locator('.panel__description')).toHaveText(es.sections[section].description)
    await expect(nav.getByRole('button', { name: es.nav[section], exact: true })).toHaveAttribute('aria-current', 'page')
    await expect(nav.getByRole('button', { name: es.nav[section], exact: true })).toHaveCSS('font-weight', '600')
  }

  await nav.getByRole('button', { name: es.nav.overview, exact: true }).click()
  await captureEvidence(page, 'U1-layout')
})
