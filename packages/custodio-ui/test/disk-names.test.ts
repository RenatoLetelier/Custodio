import { describe, expect, it } from 'vitest'
import { diskName } from '../src/ui/lib/disks'

describe('nombres de disco', () => {
  it('dos discos del mismo modelo se distinguen por su letra de unidad', () => {
    expect(diskName({ model: 'TerraMas TDAS', mountPath: 'D:\\' })).toBe('TerraMas TDAS (D:)')
    expect(diskName({ model: 'TerraMas TDAS', mountPath: 'e:' })).toBe('TerraMas TDAS (E:)')
    expect(diskName({ model: 'TerraMas TDAS', mountPath: null })).toBe('TerraMas TDAS')
    expect(diskName({ model: 'WD Elements', mountPath: 'C:\\Users\\prueba\\disco' })).toBe('WD Elements')
  })
})
