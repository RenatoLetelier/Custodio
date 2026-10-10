import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Page } from '@playwright/test'

export const EVIDENCE_DIR = resolve(__dirname, '../../../docs/ui-evidence')

// Saves docs/ui-evidence/<name>.png; name it after the criterion, e.g. "U3-resumen-oscuro"
export async function captureEvidence(page: Page, name: string): Promise<string> {
  if (!/^[\w-]+$/.test(name)) throw new Error(`Invalid evidence name "${name}"`)
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  const file = resolve(EVIDENCE_DIR, `${name}.png`)
  await page.screenshot({ path: file, fullPage: true })
  return file
}
