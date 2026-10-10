import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { REPORTS_DIR, ROOT, formatReport, parseScope, runAcceptance, type Scope } from './acceptance'

const STEPS: Record<Scope, string[]> = {
  core: ['typecheck', 'lint', 'test', 'e2e'],
  ui: ['typecheck', 'lint', 'test', 'e2e:ui'],
  all: ['typecheck', 'lint', 'test', 'e2e', 'e2e:ui']
}

// Each step rewrites its own report, so stale results never count
const REPORT_OF: Record<string, string> = {
  test: 'vitest-unit.json',
  e2e: 'vitest-e2e.json',
  'e2e:ui': 'playwright.json'
}

function runScript(script: string): number {
  const npmCli = process.env.npm_execpath
  const result =
    npmCli && /\.c?js$/.test(npmCli)
      ? spawnSync(process.execPath, [npmCli, 'run', script], { cwd: ROOT, stdio: 'inherit' })
      : spawnSync(`npm run ${script}`, { cwd: ROOT, stdio: 'inherit', shell: true })
  return result.status ?? 1
}

const scope = parseScope(process.argv.slice(2))
const outcomes: { step: string; code: number }[] = []

for (const step of STEPS[scope]) {
  const report = REPORT_OF[step]
  if (report) rmSync(join(REPORTS_DIR, report), { force: true })
  console.log(`\n▶ npm run ${step}`)
  outcomes.push({ step, code: runScript(step) })
}

console.log(`\nverify (${scope})`)
for (const { step, code } of outcomes) console.log(`  ${code === 0 ? '✔' : '✘'} ${step}${code === 0 ? '' : ` (exit ${code})`}`)

const acceptance = runAcceptance(scope)
console.log(`\n${formatReport(acceptance, scope)}`)

process.exitCode = outcomes.every((o) => o.code === 0) && acceptance.ok ? 0 : 1
