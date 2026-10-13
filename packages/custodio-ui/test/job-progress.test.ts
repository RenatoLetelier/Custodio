import { describe, expect, it } from 'vitest'
import type { Job } from '../src/ui/api/types'
import { describeProgress, isScanning } from '../src/ui/lib/jobs'

const job = (progress: Job['progress']): Job => ({
  id: 'j',
  kind: 'backup',
  status: 'running',
  trigger: 'manual',
  policyId: 'p',
  projectId: 'x',
  dryRun: false,
  progress,
  result: null,
  error: null,
  createdAt: '2026-10-13T23:00:00.000Z',
  startedAt: '2026-10-13T23:00:00.000Z',
  finishedAt: null
})

describe('avance de una copia', () => {
  it('dice qué hace la copia antes de copiar: revisar, comparar lo que ya estaba y copiar', () => {
    const scanning = job({ filesDone: 12345, filesTotal: 0, bytesDone: 0, bytesTotal: 0, phase: 'scanning' })
    expect(isScanning(scanning)).toBe(true)
    expect(describeProgress(scanning)).toBe('Revisando qué falta copiar… Archivos revisados: 12.345')
    expect(describeProgress(job({ filesDone: 1, filesTotal: 4, bytesDone: 250, bytesTotal: 1000, phase: 'checking' }))).toBe(
      'Comparando con el original lo que ya estaba en la copia… 25 %'
    )
    expect(describeProgress(job({ filesDone: 3, filesTotal: 4, bytesDone: 400, bytesTotal: 1000, phase: 'copying' }))).toBe('Copiando… 40 %')
    // A service without phases is copying
    expect(describeProgress(job({ filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0 }))).toBe('Copiando… 0 %')
  })
})
