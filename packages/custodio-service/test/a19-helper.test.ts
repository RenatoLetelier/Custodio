import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CommandResult } from '../src/adapters/node/exec.js'
import { ConfirmationBook, Helper, executablePath, type CommandRunner } from '../src/helper/helper.js'
import { HelperClient, serveHelper } from '../src/helper/transport.js'

const SECRET = 'helper-secret-0123456789abcdef'
const SRC = resolve(import.meta.dirname, '../src')

class RecordingRunner implements CommandRunner {
  readonly calls: { file: string; args: string[] }[] = []
  run(file: string, args: string[]): Promise<CommandResult> {
    this.calls.push({ file, args })
    return Promise.resolve({ stdout: '{}', stderr: '', exitCode: 0 })
  }
}

const request = (op: string, args: unknown, extra: Record<string, unknown> = {}) => ({ id: randomBytes(4).toString('hex'), secret: SECRET, op, args, ...extra })

describe('privilegios mínimos', () => {
  it('A19 el servicio no requiere privilegios de administrador: solo custodio-helper ejecuta lo elevado', async () => {
    const files = (await readdir(SRC, { recursive: true, withFileTypes: true })).filter((e) => e.isFile() && e.name.endsWith('.ts')).map((e) => join(e.parentPath, e.name))
    const outsideHelper = files.filter((f) => !f.startsWith(join(SRC, 'helper') + sep))
    const offenders: string[] = []
    for (const file of outsideHelper) {
      const text = await readFile(file, 'utf8')
      const rel = relative(SRC, file).split(sep).join('/')
      if (/smartctl\.exe|chkdsk|powershell|runas|Start-Process/i.test(text)) offenders.push(`${rel}: comando elevado`)
      if (/child_process/.test(text) && rel !== 'adapters/node/exec.ts') offenders.push(`${rel}: lanza procesos`)
      if (/\brunFile\(/.test(text) && rel !== 'adapters/node/exec.ts') offenders.push(`${rel}: ejecuta comandos`)
    }
    expect(offenders).toEqual([])
    // The real Windows adapters only talk to the helper
    const adapters = await readFile(join(SRC, 'adapters', 'windows', 'adapters.ts'), 'utf8')
    for (const op of ['disks.list', 'smart.read', 'volumes.list']) expect(adapters).toContain(`stdoutOf(this.helper, '${op}'`)
    expect(adapters).not.toMatch(/node:child_process|runFile/)
  })

  it('A19 el helper rechaza operaciones fuera de la lista blanca y peticiones sin su secreto', async () => {
    const runner = new RecordingRunner()
    const helper = new Helper(runner, SECRET)
    for (const op of ['format.volume', 'diskpart', 'cmd', '__proto__', 'constructor', 'confirmation.issue.extra']) {
      expect((await helper.handle(request(op, {}))) as unknown).toMatchObject({ ok: false, error: { code: 'unknown_operation' } })
    }
    expect(await helper.handle({ ...request('volumes.list', {}), secret: 'otro' })).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
    expect(await helper.handle({ nada: true })).toMatchObject({ ok: false, error: { code: 'bad_request' } })
    expect(runner.calls).toEqual([])
  })

  it('A19 el helper valida los argumentos de cada operación', async () => {
    const runner = new RecordingRunner()
    const helper = new Helper(runner, SECRET)
    const invalid = [
      ['smart.read', { device: '/dev/sda; rm -rf /' }],
      ['smart.read', { device: '\\\\.\\PhysicalDrive0' }],
      ['smart.read', { device: '/dev/pd0', extra: '--set=standby,now' }],
      ['chkdsk.scan', { drive: 'C: /f' }],
      ['chkdsk.scan', { drive: 'C:\\' }],
      ['chkdsk.scan', { drive: 'c:' }],
      ['volumes.list', { filtro: '*' }]
    ] as const
    for (const [op, args] of invalid) expect(await helper.handle(request(op, args)), `${op} ${JSON.stringify(args)}`).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } })
    expect(runner.calls).toEqual([])

    expect(await helper.handle(request('smart.read', { device: '/dev/pd1' }))).toMatchObject({ ok: true })
    expect(await helper.handle(request('chkdsk.scan', { drive: 'E:' }))).toMatchObject({ ok: true })
    expect(runner.calls).toEqual([
      { file: 'smartctl.exe', args: ['--json=c', '--all', '/dev/pd1'] },
      { file: 'chkdsk.exe', args: ['E:', '/scan'] }
    ])
  })

  it('A19 chkdsk /f exige una confirmación de un solo uso', async () => {
    let now = Date.parse('2026-10-01T00:00:00Z')
    const runner = new RecordingRunner()
    const helper = new Helper(runner, SECRET, new ConfirmationBook(() => now, 60_000))
    const issue = async (drive: string) => {
      const response = await helper.handle(request('confirmation.issue', { op: 'chkdsk.fix', args: { drive } }))
      if (!response.ok || !('token' in response.result)) throw new Error('no token')
      return response.result.token
    }

    expect(await helper.handle(request('chkdsk.fix', { drive: 'E:' }))).toMatchObject({ ok: false, error: { code: 'confirmation_required' } })
    expect(await helper.handle(request('confirmation.issue', { op: 'smart.read', args: { device: '/dev/pd0' } }))).toMatchObject({ ok: false })

    const forE = await issue('E:')
    expect(await helper.handle(request('chkdsk.fix', { drive: 'F:' }, { confirmation: forE }))).toMatchObject({ ok: false, error: { code: 'confirmation_invalid' } })
    // A token spent on the wrong drive is gone too
    expect(await helper.handle(request('chkdsk.fix', { drive: 'E:' }, { confirmation: forE }))).toMatchObject({ ok: false, error: { code: 'confirmation_invalid' } })

    const fresh = await issue('E:')
    expect(await helper.handle(request('chkdsk.fix', { drive: 'E:' }, { confirmation: fresh }))).toMatchObject({ ok: true })
    expect(await helper.handle(request('chkdsk.fix', { drive: 'E:' }, { confirmation: fresh }))).toMatchObject({ ok: false, error: { code: 'confirmation_invalid' } })

    const late = await issue('E:')
    now += 61_000
    expect(await helper.handle(request('chkdsk.fix', { drive: 'E:' }, { confirmation: late }))).toMatchObject({ ok: false, error: { code: 'confirmation_invalid' } })
    expect(runner.calls).toEqual([{ file: 'chkdsk.exe', args: ['E:', '/f'] }])
  })

  it('A19 el servicio llega al helper por un canal local y el helper exige su secreto', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'custodio-helper-'))
    const path = process.platform === 'win32' ? `\\\\.\\pipe\\custodio-test-${randomBytes(6).toString('hex')}` : join(dir, 'helper.sock')
    const runner = new RecordingRunner()
    const server = await serveHelper(new Helper(runner, SECRET), path)
    try {
      expect(await new HelperClient(path, SECRET).call('chkdsk.scan', { drive: 'D:' })).toMatchObject({ ok: true, result: { exitCode: 0 } })
      expect(await new HelperClient(path, 'secreto-falso').call('chkdsk.scan', { drive: 'D:' })).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
      expect(await new HelperClient(path, SECRET).call('format', { drive: 'D:' })).toMatchObject({ ok: false, error: { code: 'unknown_operation' } })
      expect(runner.calls).toEqual([{ file: 'chkdsk.exe', args: ['D:', '/scan'] }])
    } finally {
      await new Promise((resolve) => server.close(resolve))
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('A19 el canal compartido del helper (el que usa el servicio instalado) sigue exigiendo el secreto', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'custodio-helper-'))
    const path = process.platform === 'win32' ? `\\\\.\\pipe\\custodio-test-${randomBytes(6).toString('hex')}` : join(dir, 'helper.sock')
    const runner = new RecordingRunner()
    const server = await serveHelper(new Helper(runner, SECRET), path, { shared: true })
    try {
      expect(await new HelperClient(path, 'secreto-falso').call('chkdsk.scan', { drive: 'D:' })).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
      expect(await new HelperClient(path, SECRET).call('chkdsk.scan', { drive: 'D:' })).toMatchObject({ ok: true })
      expect(runner.calls).toEqual([{ file: 'chkdsk.exe', args: ['D:', '/scan'] }])
    } finally {
      await new Promise((resolve) => server.close(resolve))
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('A19 la lectura SMART de un disco USB puede pedir el modo SAT, y ningún otro tipo de dispositivo', async () => {
    const runner = new RecordingRunner()
    const helper = new Helper(runner, SECRET)
    expect(await helper.handle(request('smart.read', { device: '/dev/pd2', type: 'sat' }))).toMatchObject({ ok: true })
    for (const type of ['scsi', 'sat,12', 'sat -s on', 'auto']) {
      expect(await helper.handle(request('smart.read', { device: '/dev/pd2', type })), type).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } })
    }
    expect(runner.calls).toEqual([{ file: 'smartctl.exe', args: ['--json=c', '--all', '-d', 'sat', '/dev/pd2'] }])
  })

  it('A19 el helper no busca en PATH las herramientas del sistema', () => {
    const env = { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' }
    expect(executablePath('powershell.exe', env)).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(executablePath('chkdsk.exe', env)).toBe('C:\\Windows\\System32\\chkdsk.exe')
    expect(executablePath('smartctl.exe', env, () => true)).toBe('C:\\Program Files\\smartmontools\\bin\\smartctl.exe')
    expect(() => executablePath('format.com', env)).toThrow()
  })
})
