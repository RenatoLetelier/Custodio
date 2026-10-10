import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NodeFileSystem } from '../src/adapters/node/filesystem.js'
import { SimClock } from '../src/adapters/sim/clock.js'
import { SimDiskProbe, SimSmartReader, SimVolumeReader, healthySmart } from '../src/adapters/sim/devices.js'
import { SimCopier } from '../src/adapters/sim/io.js'
import { WindowsDiskProbe, WindowsSmartReader, WindowsVolumeReader, type HelperCaller } from '../src/adapters/windows/adapters.js'
import { RealAdapterBlockedError } from '../src/adapters/windows/guard.js'
import { parseDisks, parseSmartctl, parseVolumes } from '../src/adapters/windows/parsers.js'
import type { Clock, Copier, DiskProbe, SmartReader, VolumeReader } from '../src/core/ports/system.js'
import { ExecFileRunner } from '../src/helper/helper.js'
import { sha256 } from './support/backup.js'

const SRC = resolve(import.meta.dirname, '../src')
const CORE = join(SRC, 'core')

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  return entries.filter((e) => e.isFile() && e.name.endsWith('.ts')).map((e) => join(e.parentPath, e.name))
}

describe('arquitectura', () => {
  it('A16 src/core no menciona localcloud, blob ni supabase (ni en comentarios)', async () => {
    const offenders: string[] = []
    for (const file of await sourceFiles(CORE)) {
      const text = await readFile(file, 'utf8')
      if (/localcloud|blob|supabase/i.test(text)) offenders.push(relative(SRC, file))
    }
    expect(offenders).toEqual([])
  })

  it('A16 src/core solo depende de sus puertos: sin fs, procesos, base de datos, API ni adaptadores', async () => {
    const forbidden = ['node:fs', 'fs', 'node:fs/promises', 'fs/promises', 'node:child_process', 'child_process', 'node:sqlite', 'fastify', 'pino']
    const offenders: string[] = []
    for (const file of await sourceFiles(CORE)) {
      const text = await readFile(file, 'utf8')
      for (const match of text.matchAll(/(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/g)) {
        const specifier = match[1] as string
        const target = specifier.startsWith('.') ? resolve(file, '..', specifier) : null
        if (forbidden.includes(specifier) || (target && !target.startsWith(CORE + sep))) offenders.push(`${relative(SRC, file)} → ${specifier}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('A16 disco, SMART, volúmenes, copiador y reloj están detrás de interfaces con implementación simulada', async () => {
    const disks: DiskProbe = new SimDiskProbe()
    const smart: SmartReader = new SimSmartReader()
    const volumes: VolumeReader = new SimVolumeReader({ totalBytes: 100, freeBytes: 40 })
    const clock: Clock = new SimClock('2026-10-01T00:00:00.000Z', 'instant')
    const dir = await mkdtemp(join(tmpdir(), 'custodio-ports-'))
    try {
      const copier: Copier = new SimCopier(new NodeFileSystem())
      ;(disks as SimDiskProbe).add({ serial: 'S1', wwn: null, model: 'Sim', sizeBytes: 1, bus: 'usb', devicePath: '/dev/sim1', mountPath: dir })
      expect(await disks.listDisks()).toEqual([expect.objectContaining({ serial: 'S1', mountPath: dir })])
      expect(await smart.read('/dev/sim1')).toEqual(healthySmart())
      expect(await volumes.usage(dir)).toEqual({ totalBytes: 100, freeBytes: 40 })
      await clock.sleep(5000)
      expect(clock.now().toISOString()).toBe('2026-10-01T00:00:05.000Z')
      await writeFile(join(dir, 'a.txt'), 'hola')
      expect(await copier.copy({ sourcePath: join(dir, 'a.txt'), destinationPath: join(dir, 'copia', 'a.txt') })).toEqual({ bytes: 4, sha256: sha256('hola') })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('A16 los adaptadores reales de Windows existen y se niegan a ejecutarse con NODE_ENV=test', async () => {
    expect(process.env.NODE_ENV).toBe('test')
    const calls: string[] = []
    const helper: HelperCaller = { call: (op) => (calls.push(op), Promise.reject(new Error('no debería llamarse'))) }
    await expect(new WindowsDiskProbe(helper).listDisks()).rejects.toBeInstanceOf(RealAdapterBlockedError)
    await expect(new WindowsSmartReader(helper).read('/dev/pd0')).rejects.toBeInstanceOf(RealAdapterBlockedError)
    await expect(new WindowsVolumeReader(helper).usage('E:\\')).rejects.toBeInstanceOf(RealAdapterBlockedError)
    await expect(new ExecFileRunner().run('chkdsk.exe', ['C:', '/scan'])).rejects.toBeInstanceOf(RealAdapterBlockedError)
    expect(calls).toEqual([])
  })

  it('A16 los adaptadores reales traducen la salida de smartctl y PowerShell', () => {
    const ata = parseSmartctl(
      JSON.stringify({
        smart_support: { available: true },
        smart_status: { passed: true },
        ata_smart_attributes: { table: [{ id: 5, raw: { value: 2 } }, { id: 197, raw: { value: 0 } }, { id: 199, raw: { value: 14 } }] },
        temperature: { current: 41 },
        power_on_time: { hours: 21_000 }
      })
    )
    expect(ata).toEqual({ supported: true, passed: true, attributes: { '5': 2, '197': 0, '199': 14 }, temperatureC: 41, powerOnHours: 21_000 })
    const nvme = parseSmartctl(JSON.stringify({ smart_status: { passed: true }, nvme_smart_health_information_log: { media_errors: 3 }, temperature: { current: 50 } }))
    expect(nvme).toMatchObject({ supported: true, attributes: { '198': 3 }, temperatureC: 50 })
    expect(parseSmartctl(JSON.stringify({ smart_support: { available: false } }))?.supported).toBe(false)
    expect(parseSmartctl('no es json')).toBeNull()

    expect(
      parseDisks(
        JSON.stringify([
          { Number: 1, SerialNumber: ' WD-123 ', UniqueId: '5000C500A1B2C3D4', FriendlyName: 'WD Elements', Size: 2e12, BusType: 'USB', DriveLetter: 'e' },
          { Number: 2, SerialNumber: null, UniqueId: 'USBSTOR\\XYZ', FriendlyName: null, Size: 64e9, BusType: 'NVMe', DriveLetter: null }
        ])
      )
    ).toEqual([
      { serial: 'WD-123', wwn: '5000c500a1b2c3d4', model: 'WD Elements', sizeBytes: 2e12, bus: 'usb', devicePath: '/dev/pd1', mountPath: 'E:\\' },
      { serial: null, wwn: null, model: 'Disco 2', sizeBytes: 64e9, bus: 'nvme', devicePath: '/dev/pd2', mountPath: null }
    ])
    expect(parseVolumes(JSON.stringify({ DriveLetter: 'E', Size: 1000, SizeRemaining: 250 })).get('E:\\')).toEqual({ totalBytes: 1000, freeBytes: 250 })
  })
})
