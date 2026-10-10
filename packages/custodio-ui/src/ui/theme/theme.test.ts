import { describe, expect, it } from 'vitest'
import { modes, semaphore, themeCss } from '.'

describe('tema', () => {
  it('genera las variables del tema claro y las redefine para el oscuro', () => {
    const css = themeCss()
    expect(css).toContain('--panel-bg: #f5f6f8;')
    expect(css).toContain('--sidebar-fg-muted: #8b93a1;')
    expect(css).toContain('--semaphore-red: #dc2626;')
    expect(css).toMatch(/@media \(prefers-color-scheme: dark\) \{\s+:root \{[^}]*--panel-bg: #14171c;/)
  })

  it('el claro y el oscuro definen los mismos tokens', () => {
    expect(Object.keys(modes.dark).sort()).toEqual(Object.keys(modes.light).sort())
  })

  it('el estado desconocido nunca usa el color de disco sano', () => {
    expect(semaphore.unknown).not.toBe(semaphore.green)
  })
})
