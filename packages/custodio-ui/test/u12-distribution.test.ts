import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const ROOT = resolve(import.meta.dirname, '../../..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

interface Step {
  name?: string
  uses?: string
  run?: string
  with?: Record<string, unknown>
}

interface Workflow {
  on: { push?: { tags?: string[] } }
  permissions?: Record<string, string>
  jobs: Record<string, { 'runs-on': string; steps: Step[] }>
}

function runNpm(script: string) {
  const npm = process.env.npm_execpath
  return npm && /\.c?js$/.test(npm)
    ? spawnSync(process.execPath, [npm, 'run', script], { cwd: ROOT, encoding: 'utf8' })
    : spawnSync(`npm run ${script}`, { cwd: ROOT, encoding: 'utf8', shell: true })
}

describe('distribución', () => {
  it('U12 release.yml se dispara con tags v*, construye el instalador de Windows con electron-builder y lo publica en GitHub Releases', () => {
    const workflow = parse(read('.github/workflows/release.yml')) as Workflow
    expect(workflow.on.push?.tags).toEqual(['v*'])
    expect(workflow.permissions?.contents).toBe('write')

    const jobs = Object.values(workflow.jobs)
    expect(jobs).toHaveLength(1)
    const [job] = jobs as [Workflow['jobs'][string]]
    expect(job['runs-on']).toBe('windows-latest')
    const uses = job.steps.map((s) => s.uses ?? '')
    const runs = job.steps.map((s) => s.run ?? '')
    expect(uses.some((u) => u.startsWith('actions/checkout@'))).toBe(true)
    expect(job.steps.find((s) => s.uses?.startsWith('actions/setup-node@'))?.with?.['node-version']).toBe(22)
    expect(runs).toContain('npm ci')

    // Build before publish, and the build is electron-builder for Windows
    const build = runs.findIndex((r) => r === 'npm run dist:win')
    const publish = job.steps.findIndex((s) => s.uses?.startsWith('softprops/action-gh-release@'))
    expect(build).toBeGreaterThan(runs.indexOf('npm ci'))
    expect(publish).toBeGreaterThan(build)
    expect(job.steps[publish]?.with?.files).toBe('packages/custodio-ui/dist/*.exe')
    const ui = JSON.parse(read('packages/custodio-ui/package.json')) as { scripts: Record<string, string> }
    expect(ui.scripts['dist:win']).toMatch(/electron-builder --win/)
    expect(read('packages/custodio-ui/electron-builder.yml')).toMatch(/target: nsis/)
    expect(read('packages/custodio-ui/electron-builder.yml')).toMatch(/perMachine: true/)
    expect(runs.join('\n')).not.toMatch(/npm publish/)
  })

  it('U12 el instalador lleva el servicio y el helper, los registra al instalar y los retira al desinstalar', () => {
    const ui = JSON.parse(read('packages/custodio-ui/package.json')) as { scripts: Record<string, string> }
    expect(ui.scripts['dist:win']).toMatch(/custodio-service\/scripts\/bundle\.ts && .*electron-builder --win/)
    const builder = parse(read('packages/custodio-ui/electron-builder.yml')) as { extraResources?: { from: string; to: string }[] }
    expect(builder.extraResources).toContainEqual({ from: '../custodio-service/dist', to: 'service' })

    const nsis = read('packages/custodio-ui/build/installer.nsh')
    const macro = (name: string) => new RegExp(`!macro ${name}\\n([\\s\\S]*?)!macroend`).exec(nsis.replace(/\r\n/g, '\n'))?.[1] ?? ''
    expect(macro('customInstall')).toMatch(/resources\\service\\install-tasks\.ps1/)
    expect(macro('customUnInstall')).toMatch(/resources\\service\\uninstall-tasks\.ps1/)

    const install = read('packages/custodio-service/deploy/windows/install-tasks.ps1')
    expect(install).toMatch(/TaskName 'custodio-helper'[\s\S]*-UserId 'SYSTEM'[\s\S]*-RunLevel Highest/)
    expect(install).toMatch(/TaskName\s*=\s*'custodio-service'/)
    // The service runs as the user without elevation, whichever way it gets registered
    expect(install.match(/-RunLevel \w+/g)).toEqual(['-RunLevel Highest', '-RunLevel Limited', '-RunLevel Limited'])
    expect(read('packages/custodio-service/deploy/windows/production.env')).toMatch(/^CUSTODIO_ADAPTERS=windows$/m)
  })

  it('U12 todos los package.json son privados', () => {
    const manifests = ['package.json', ...readdirSync(join(ROOT, 'packages')).map((p) => `packages/${p}/package.json`)]
    expect(manifests.length).toBeGreaterThanOrEqual(3)
    for (const manifest of manifests) expect((JSON.parse(read(manifest)) as { private?: boolean }).private, manifest).toBe(true)
  })

  it('U12 npm run build:ui termina con exit code 0', { timeout: 180_000 }, () => {
    const result = runNpm('build:ui')
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
  })
})
