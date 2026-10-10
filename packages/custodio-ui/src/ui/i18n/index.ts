import es from './es.json'

type Leaves<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${Prefix}${K}` : Leaves<T[K], `${Prefix}${K}.`>
}[keyof T & string]

export type MessageKey = Leaves<typeof es>
export type Params = Record<string, string | number>

export const catalog = es

// Test hook: when present, every text the interface produces is recorded, so tests can prove nothing is hardcoded
export function record<T extends string>(text: T): T {
  ;(globalThis as { __custodioTrace?: Set<string> }).__custodioTrace?.add(text)
  return text
}

function lookup(key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], es)
}

export function hasMessage(key: string): key is MessageKey {
  return typeof lookup(key) === 'string'
}

export function t(key: MessageKey, params: Params = {}): string {
  const value = lookup(key)
  if (typeof value !== 'string') throw new Error(`Missing message "${key}" in es.json`)
  return record(value.replace(/\{(\w+)\}/g, (match, name: string) => String(params[name] ?? match)))
}

// Plurals in Spanish only need "one" and "other"
export function tn(one: MessageKey, other: MessageKey, count: number, params: Params = {}): string {
  return t(count === 1 ? one : other, { count, ...params })
}
