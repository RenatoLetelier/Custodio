import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export type Scope = 'core' | 'ui' | 'all'
export type Outcome = 'passed' | 'failed' | 'skipped'

export interface TestCase {
  title: string
  fullTitle: string
  outcome: Outcome
  report: string
}

export type CriterionStatus = 'pass' | 'missing' | 'failed' | 'skipped'

export interface CriterionResult {
  id: string
  status: CriterionStatus
  total: number
  failed: number
  skipped: number
}

export interface AcceptanceResult {
  ok: boolean
  core: CriterionResult[]
  ui: CriterionResult[]
  problems: string[]
  lines: [string, string]
}

const range = (prefix: string, count: number): string[] => Array.from({ length: count }, (_, i) => `${prefix}${i + 1}`)

export const CORE_IDS = range('A', 20)
export const UI_IDS = range('U', 12)

const ID_PATTERN = /^([AU]\d+)(?!\w)/

// A test belongs to a criterion when its own name, or the name of its outermost describe, starts with the id
export function criterionOf(test: Pick<TestCase, 'title' | 'fullTitle'>): string | null {
  return ID_PATTERN.exec(test.title)?.[1] ?? ID_PATTERN.exec(test.fullTitle)?.[1] ?? null
}

interface VitestAssertion {
  title: string
  ancestorTitles?: string[]
  status: string
}

interface VitestReport {
  testResults: { assertionResults?: VitestAssertion[] }[]
}

interface PlaywrightTest {
  status: string
  expectedStatus?: string
}

interface PlaywrightSpec {
  title: string
  tests?: PlaywrightTest[]
}

interface PlaywrightSuite {
  title: string
  specs?: PlaywrightSpec[]
  suites?: PlaywrightSuite[]
}

interface PlaywrightReport {
  suites: PlaywrightSuite[]
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

export function isVitestReport(json: unknown): json is VitestReport {
  return isObject(json) && Array.isArray(json.testResults)
}

export function isPlaywrightReport(json: unknown): json is PlaywrightReport {
  return isObject(json) && Array.isArray(json.suites) && isObject(json.config)
}

export function parseVitestReport(json: VitestReport, report: string): TestCase[] {
  return json.testResults.flatMap((file) =>
    (file.assertionResults ?? []).map((a) => ({
      title: a.title,
      fullTitle: [...(a.ancestorTitles ?? []), a.title].join(' '),
      outcome: a.status === 'passed' ? 'passed' : a.status === 'failed' ? 'failed' : 'skipped',
      report
    }))
  )
}

function playwrightOutcome(test: PlaywrightTest): Outcome {
  if (test.status === 'skipped') return 'skipped'
  // test.fail() and flaky retries never count as a pass
  return test.status === 'expected' && (test.expectedStatus ?? 'passed') === 'passed' ? 'passed' : 'failed'
}

export function parsePlaywrightReport(json: PlaywrightReport, report: string): TestCase[] {
  const cases: TestCase[] = []
  const walk = (suite: PlaywrightSuite, describes: string[]): void => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        cases.push({ title: spec.title, fullTitle: [...describes, spec.title].join(' '), outcome: playwrightOutcome(test), report })
      }
    }
    for (const child of suite.suites ?? []) walk(child, [...describes, child.title])
  }
  // Top-level suites are files; their titles are not part of the test name
  for (const file of json.suites) walk(file, [])
  return cases
}

export function loadReports(dir: string): { tests: TestCase[]; problems: string[] } {
  const tests: TestCase[] = []
  const problems: string[] = []
  if (!existsSync(dir)) return { tests, problems }

  for (const name of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    let json: unknown
    try {
      json = JSON.parse(readFileSync(join(dir, name), 'utf8'))
    } catch {
      problems.push(`El reporte ${name} no es JSON válido.`)
      continue
    }
    if (isVitestReport(json)) tests.push(...parseVitestReport(json, name))
    else if (isPlaywrightReport(json)) tests.push(...parsePlaywrightReport(json, name))
    else problems.push(`El reporte ${name} no es de vitest ni de Playwright.`)
  }
  return { tests, problems }
}

export function evaluate(ids: string[], tests: TestCase[]): CriterionResult[] {
  return ids.map((id) => {
    const own = tests.filter((t) => criterionOf(t) === id)
    const failed = own.filter((t) => t.outcome === 'failed').length
    const skipped = own.filter((t) => t.outcome === 'skipped').length
    const status: CriterionStatus = own.length === 0 ? 'missing' : failed > 0 ? 'failed' : skipped > 0 ? 'skipped' : 'pass'
    return { id, status, total: own.length, failed, skipped }
  })
}

export function readAcceptanceIds(markdown: string): string[] {
  return [...markdown.matchAll(/^\s*-\s+\*\*([AU]\d+)\*\*/gm)].map((m) => m[1] as string)
}

const passed = (results: CriterionResult[]): number => results.filter((r) => r.status === 'pass').length

export function summaryLines(core: CriterionResult[], ui: CriterionResult[]): [string, string] {
  return [`ACCEPTANCE CORE ${passed(core)}/${CORE_IDS.length} PASS`, `ACCEPTANCE UI ${passed(ui)}/${UI_IDS.length} PASS`]
}

export function checkAcceptance(options: { tests: TestCase[]; acceptanceIds: string[]; scope: Scope; problems?: string[] }): AcceptanceResult {
  const { tests, acceptanceIds, scope } = options
  const problems = [...(options.problems ?? [])]

  const expected = [...CORE_IDS, ...UI_IDS]
  const missingInDoc = expected.filter((id) => !acceptanceIds.includes(id))
  const extraInDoc = acceptanceIds.filter((id) => !expected.includes(id))
  if (missingInDoc.length > 0) problems.push(`docs/ACCEPTANCE.md no define: ${missingInDoc.join(', ')}.`)
  if (extraInDoc.length > 0) problems.push(`docs/ACCEPTANCE.md define ids desconocidos: ${extraInDoc.join(', ')}.`)

  const unknown = [...new Set(tests.map(criterionOf).filter((id): id is string => id !== null && !expected.includes(id)))]
  if (unknown.length > 0) problems.push(`Hay pruebas con ids que no existen en docs/ACCEPTANCE.md: ${unknown.join(', ')}.`)

  const core = evaluate(CORE_IDS, tests)
  const ui = evaluate(UI_IDS, tests)
  const coreOk = passed(core) === CORE_IDS.length
  const uiOk = passed(ui) === UI_IDS.length
  const scopeOk = scope === 'core' ? coreOk : scope === 'ui' ? uiOk : coreOk && uiOk

  return { ok: scopeOk && problems.length === 0, core, ui, problems, lines: summaryLines(core, ui) }
}

const STATUS_TEXT: Record<Exclude<CriterionStatus, 'pass'>, (r: CriterionResult) => string> = {
  missing: () => 'sin pruebas',
  failed: (r) => `${r.failed} de ${r.total} pruebas fallan`,
  skipped: (r) => `${r.skipped} de ${r.total} pruebas omitidas`
}

export function formatReport(result: AcceptanceResult, scope: Scope): string {
  const out: string[] = []
  const pending = (label: string, results: CriterionResult[]): void => {
    const open = results.filter((r) => r.status !== 'pass')
    if (open.length === 0) return
    out.push(`Criterios pendientes (${label}):`)
    for (const r of open) out.push(`  ${r.id.padEnd(4)}${STATUS_TEXT[r.status as Exclude<CriterionStatus, 'pass'>](r)}`)
  }
  if (scope !== 'ui') pending('CORE', result.core)
  if (scope !== 'core') pending('UI', result.ui)
  for (const problem of result.problems) out.push(`Problema: ${problem}`)
  out.push(...result.lines)
  return out.join('\n')
}

export function parseScope(argv: string[]): Scope {
  const arg = argv.find((a) => a.startsWith('--scope='))
  const value = arg?.slice('--scope='.length) ?? 'all'
  if (value === 'core' || value === 'ui' || value === 'all') return value
  throw new Error(`Unknown scope "${value}" (expected core, ui or all)`)
}

export const ROOT = resolve(fileURLToPath(import.meta.url), '../..')
export const REPORTS_DIR = join(ROOT, 'reports')

export function runAcceptance(scope: Scope): AcceptanceResult {
  const { tests, problems } = loadReports(REPORTS_DIR)
  const acceptanceIds = readAcceptanceIds(readFileSync(join(ROOT, 'docs/ACCEPTANCE.md'), 'utf8'))
  return checkAcceptance({ tests, acceptanceIds, scope, problems })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const scope = parseScope(process.argv.slice(2))
  const result = runAcceptance(scope)
  console.log(formatReport(result, scope))
  process.exitCode = result.ok ? 0 : 1
}
