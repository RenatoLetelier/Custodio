import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CORE_IDS,
  ROOT,
  UI_IDS,
  checkAcceptance,
  criterionOf,
  evaluate,
  formatReport,
  parsePlaywrightReport,
  parseScope,
  parseVitestReport,
  readAcceptanceIds,
  type TestCase
} from './acceptance'

const passing = (title: string, fullTitle = title): TestCase => ({ title, fullTitle, outcome: 'passed', report: 'x.json' })
const allIds = [...CORE_IDS, ...UI_IDS]

describe('conteo de criterios de aceptación', () => {
  it('reconoce el id al inicio del nombre o del describe externo', () => {
    expect(criterionOf(passing('A9 reanuda una copia cortada'))).toBe('A9')
    expect(criterionOf(passing('copia solo lo faltante', 'A9 respaldo incremental copia solo lo faltante'))).toBe('A9')
    expect(criterionOf(passing('U12: workflow de release'))).toBe('U12')
  })

  it('no confunde A1 con A10 ni acepta ids en medio del nombre', () => {
    expect(criterionOf(passing('A10 preflight'))).toBe('A10')
    expect(criterionOf(passing('A1x no es un id'))).toBeNull()
    expect(criterionOf(passing('backup', 'módulo backup A9 algo'))).toBeNull()
  })

  it('exige al menos una prueba por criterio', () => {
    const [a1, a2] = evaluate(['A1', 'A2'], [passing('A1 conserva el id')])
    expect(a1?.status).toBe('pass')
    expect(a2?.status).toBe('missing')
  })

  it('una prueba que falla u omitida deja el criterio pendiente', () => {
    const tests: TestCase[] = [
      passing('A3 calcula días hasta llenarse'),
      { ...passing('A3 sin lecturas'), outcome: 'failed' },
      passing('A4 disco nuevo sin asignar'),
      { ...passing('A4 todo'), outcome: 'skipped' }
    ]
    const [a3, a4] = evaluate(['A3', 'A4'], tests)
    expect(a3).toMatchObject({ status: 'failed', failed: 1, total: 2 })
    expect(a4).toMatchObject({ status: 'skipped', skipped: 1, total: 2 })
  })

  it('lee el reporte JSON de vitest', () => {
    const tests = parseVitestReport(
      {
        testResults: [
          {
            assertionResults: [
              { title: 'A1 conserva el id', ancestorTitles: ['inventario'], status: 'passed' },
              { title: 'A2 sin SMART', ancestorTitles: [], status: 'failed' },
              { title: 'A3 pendiente', ancestorTitles: [], status: 'todo' }
            ]
          }
        ]
      },
      'vitest.json'
    )
    expect(tests.map((t) => [t.title, t.fullTitle, t.outcome])).toEqual([
      ['A1 conserva el id', 'inventario A1 conserva el id', 'passed'],
      ['A2 sin SMART', 'A2 sin SMART', 'failed'],
      ['A3 pendiente', 'A3 pendiente', 'skipped']
    ])
  })

  it('lee el reporte JSON de Playwright sin contar flaky ni test.fail como aprobadas', () => {
    const tests = parsePlaywrightReport(
      {
        suites: [
          {
            title: 'layout.spec.ts',
            specs: [{ title: 'U1 sidebar y panel', tests: [{ status: 'expected', expectedStatus: 'passed' }] }],
            suites: [
              {
                title: 'U7 tiempo real',
                specs: [
                  { title: 'muestra progreso', tests: [{ status: 'flaky' }] },
                  { title: 'marca fallo esperado', tests: [{ status: 'expected', expectedStatus: 'failed' }] },
                  { title: 'omitida', tests: [{ status: 'skipped' }] }
                ]
              }
            ]
          }
        ]
      },
      'playwright.json'
    )
    expect(tests.map((t) => [criterionOf(t), t.outcome])).toEqual([
      ['U1', 'passed'],
      ['U7', 'failed'],
      ['U7', 'failed'],
      ['U7', 'skipped']
    ])
  })

  it('imprime las dos líneas y falla solo por el paquete evaluado', () => {
    const tests = CORE_IDS.map((id) => passing(`${id} cubierto`))
    const core = checkAcceptance({ tests, acceptanceIds: allIds, scope: 'core' })
    const ui = checkAcceptance({ tests, acceptanceIds: allIds, scope: 'ui' })
    expect(core.lines).toEqual(['ACCEPTANCE CORE 20/20 PASS', 'ACCEPTANCE UI 0/12 PASS'])
    expect(core.ok).toBe(true)
    expect(ui.ok).toBe(false)
    expect(formatReport(ui, 'ui').split('\n').slice(-2)).toEqual(core.lines)
  })

  it('falla si ACCEPTANCE.md pierde un criterio o una prueba usa un id desconocido', () => {
    const tests = [...allIds.map((id) => passing(`${id} ok`)), passing('A21 no existe')]
    const result = checkAcceptance({ tests, acceptanceIds: allIds.filter((id) => id !== 'A5'), scope: 'all' })
    expect(result.ok).toBe(false)
    expect(result.problems).toHaveLength(2)
  })

  it('docs/ACCEPTANCE.md define exactamente A1–A20 y U1–U12', () => {
    const ids = readAcceptanceIds(readFileSync(join(ROOT, 'docs/ACCEPTANCE.md'), 'utf8'))
    expect(ids).toEqual(allIds)
  })

  it('valida el argumento --scope', () => {
    expect(parseScope([])).toBe('all')
    expect(parseScope(['--scope=core'])).toBe('core')
    expect(() => parseScope(['--scope=otro'])).toThrow()
  })
})
