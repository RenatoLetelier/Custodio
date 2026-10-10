import AxeBuilder from '@axe-core/playwright'
import { test as base, expect, type Page } from '@playwright/test'
import { DEFAULT_DISKS, startService, type DiskSpec, type ServiceHandle } from './service'

export interface Scenario {
  disks: DiskSpec[]
}

export const test = base.extend<{ scenario: Scenario; service: ServiceHandle }>({
  scenario: [{ disks: DEFAULT_DISKS }, { option: true }],
  service: async ({ scenario }, use) => {
    const service = await startService(scenario.disks)
    await use(service)
    await service.stop()
  }
})

export { expect }

// What the Electron preload provides, injected before the renderer starts; also turns on the text trace
export async function openApp(page: Page, service: ServiceHandle): Promise<void> {
  await page.addInitScript(
    ({ baseUrl, token }) => {
      ;(window as unknown as { custodio: unknown }).custodio = { platform: 'win32', service: { baseUrl, token } }
      ;(window as unknown as { __custodioTrace: Set<string> }).__custodioTrace = new Set()
    },
    { baseUrl: service.baseUrl, token: service.token }
  )
  await page.goto('/')
  await expect(page.getByTestId('app-ready')).toBeVisible({ timeout: 15_000 })
}

export async function goTo(page: Page, section: string): Promise<void> {
  await page.getByRole('navigation').getByRole('button', { name: section, exact: true }).click()
  await expect(page.getByRole('heading', { level: 1, name: section })).toBeVisible()
}

// Serious and critical accessibility problems fail the test
export async function expectAccessible(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(serious.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`)).toEqual([])
}

// Every visible text must come from es.json, a formatter or the service's data; anything else is hardcoded
export async function expectTextsFromCatalog(page: Page): Promise<void> {
  const stray = await page.evaluate(() => {
    const trace = (window as unknown as { __custodioTrace: Set<string> }).__custodioTrace
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    const found: string[] = []
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.trim() ?? ''
      const parent = node.parentElement
      if (!text || !parent || parent.closest('script, style') || parent.getClientRects().length === 0) continue
      if (/^[\d\s.,:;%/·()+\-–—]*$/.test(text)) continue
      if (!trace.has(text)) found.push(text)
    }
    return found
  })
  expect(stray).toEqual([])
}

export const FORBIDDEN_TERMS = /\b(SMART|cron|serial|WWN|UUID|\/dev\/|sha256|hash)\b/i
