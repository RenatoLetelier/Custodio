import { describe, expect, it } from 'vitest'
import { catalog, t, type MessageKey } from '.'

const leaves = (node: unknown, prefix = ''): [string, unknown][] =>
  typeof node === 'object' && node !== null
    ? Object.entries(node).flatMap(([key, value]) => leaves(value, `${prefix}${key}.`))
    : [[prefix.slice(0, -1), node]]

describe('catálogo i18n', () => {
  it('resuelve claves anidadas', () => {
    expect(t('app.name')).toBe('Custodio')
    expect(t('nav.settings')).toBe('Configuración')
  })

  it('todas las entradas de es.json son textos no vacíos', () => {
    for (const [key, value] of leaves(catalog)) {
      expect(typeof value, key).toBe('string')
      expect(String(value).trim(), key).not.toBe('')
    }
  })

  it('falla con una clave inexistente', () => {
    expect(() => t('app.nope' as MessageKey)).toThrow(/app\.nope/)
  })
})
