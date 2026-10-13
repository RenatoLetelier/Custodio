import { describe, expect, it } from 'vitest'
import type { Job } from '../src/ui/api/types'
import { canStop, describeProgress, hintOf, isIndeterminate, isStopping, resultOf } from '../src/ui/lib/jobs'

const job = (changes: Partial<Job> = {}, progress: Partial<Job['progress']> = {}): Job => ({
  id: 'j',
  kind: 'backup',
  status: 'running',
  trigger: 'manual',
  policyId: 'p',
  projectId: 'x',
  diskId: null,
  dryRun: false,
  progress: { filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0, ...progress },
  result: null,
  error: null,
  createdAt: '2026-10-13T23:00:00.000Z',
  startedAt: '2026-10-13T23:00:00.000Z',
  finishedAt: null,
  cancelRequestedAt: null,
  ...changes
})

describe('avance de un trabajo', () => {
  it('dice qué hace la copia en cada momento: preparar, revisar, comparar y copiar', () => {
    expect(describeProgress(job())).toBe('Preparando la copia…')
    const scanning = job({}, { filesDone: 12345, phase: 'scanning' })
    expect(isIndeterminate(scanning)).toBe(true)
    expect(describeProgress(scanning)).toBe('Revisando qué falta copiar… Archivos revisados: 12.345')
    const checking = job({}, { filesDone: 1, filesTotal: 4, bytesDone: 250, bytesTotal: 1000, phase: 'checking' })
    expect(describeProgress(checking)).toBe('Comparando con el original lo que ya estaba en la copia… 25 %')
    expect(hintOf(checking)).toContain('puede tardar horas')
    expect(describeProgress(job({}, { filesDone: 3, filesTotal: 4, bytesDone: 400, bytesTotal: 1000, phase: 'copying' }))).toBe('Copiando… 40 %')
  })

  it('al pedir detenerla dice que se está deteniendo y por qué tarda un momento', () => {
    const stopping = job({ cancelRequestedAt: '2026-10-13T23:05:00.000Z' }, { bytesDone: 400, bytesTotal: 1000, phase: 'copying' })
    expect(isStopping(stopping)).toBe(true)
    expect(describeProgress(stopping)).toBe('Deteniendo…')
    expect(hintOf(stopping)).toBe('Termina el archivo en curso y se detiene. Lo ya copiado queda guardado.')
  })

  it('una revisión de disco o una búsqueda de discos no se pueden detener y no tienen porcentaje', () => {
    const repair = job({ kind: 'repair', policyId: null, diskId: 'd' })
    expect(canStop(repair)).toBe(false)
    expect(isIndeterminate(repair)).toBe(true)
    expect(describeProgress(repair)).toBe('Revisando y reparando el disco…')
    expect(describeProgress(job({ kind: 'inventory_scan', policyId: null }))).toBe('Buscando discos…')
    expect(describeProgress(job({ kind: 'verification' }, { bytesDone: 10, bytesTotal: 20, phase: 'verifying' }))).toBe('Revisando que las copias estén bien… 50 %')
  })

  it('cuenta cómo terminó: qué copió, por qué falló o que se detuvo a pedido', () => {
    const ended = { status: 'succeeded' as const, finishedAt: '2026-10-13T23:10:00.000Z' }
    expect(resultOf(job({ ...ended, result: { filesCopied: 3, bytesCopied: 1_200_000_000, filesUpToDate: 10 } }))).toBe('Archivos copiados: 3 (1,2 GB). Ya estaban al día: 10.')
    expect(resultOf(job({ ...ended, result: { filesCopied: 0, filesUpToDate: 10 } }))).toBe('No había nada nuevo que copiar. Archivos al día: 10.')
    expect(resultOf(job({ status: 'failed', error: { code: 'preflight_failed', message: 'El disco de "Copia" no está conectado.' } }))).toBe('El disco de "Copia" no está conectado.')
    expect(resultOf(job({ status: 'failed', error: { code: 'unexpected', message: "EPERM: operation not permitted, mkdir 'C:\\'" } }))).toContain('registro de Custodio')
    expect(resultOf(job({ status: 'cancelled' }))).toContain('Lo ya copiado queda guardado')
    expect(resultOf(job())).toBeNull()
  })
})
