import es from './es.json'

type Leaves<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${Prefix}${K}` : Leaves<T[K], `${Prefix}${K}.`>
}[keyof T & string]

export type MessageKey = Leaves<typeof es>

export const catalog = es

export function t(key: MessageKey, params: Record<string, string | number> = {}): string {
  const value = key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], es)
  if (typeof value !== 'string') throw new Error(`Missing message "${key}" in es.json`)
  return value.replace(/\{(\w+)\}/g, (match, name: string) => String(params[name] ?? match))
}
