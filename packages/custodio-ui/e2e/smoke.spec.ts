import { expect, test } from '@playwright/test'
import es from '../src/ui/i18n/es.json'
import { modes } from '../src/ui/theme/tokens'
import { captureEvidence } from './evidence'

const background = (page: import('@playwright/test').Page): Promise<string> =>
  page.evaluate(() => getComputedStyle(document.body).backgroundColor)

const rgb = (hex: string): string => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  return `rgb(${r}, ${g}, ${b})`
}

test.describe('smoke del renderer', () => {
  test('carga con el nombre del producto desde es.json', async ({ page }) => {
    await page.goto('/')
    await expect(page).toHaveTitle(es.app.name)
    await expect(page.getByRole('heading', { name: es.app.name })).toBeVisible()
    expect(await background(page)).toBe(rgb(modes.light.panelBg))
    await captureEvidence(page, 'smoke-claro')
  })

  test('sigue el tema oscuro del sistema', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.goto('/')
    await expect(page.getByRole('heading', { name: es.app.name })).toBeVisible()
    expect(await background(page)).toBe(rgb(modes.dark.panelBg))
    await captureEvidence(page, 'smoke-oscuro')
  })
})
