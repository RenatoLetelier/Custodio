import { layout, modes, radius, semaphore, spacing, typography } from './tokens'

export * from './tokens'

const kebab = (name: string): string => name.replace(/[A-Z0-9]+/g, (m) => `-${m.toLowerCase()}`)

const declarations = (tokens: Record<string, string>, indent: string): string =>
  Object.entries(tokens)
    .map(([name, value]) => `${indent}--${kebab(name)}: ${value};`)
    .join('\n')

const semaphoreTokens = Object.fromEntries(Object.entries(semaphore).map(([state, color]) => [`semaphore-${state}`, color]))

// Light is the default; dark follows the operating system
export function themeCss(): string {
  const base = { ...modes.light, ...semaphoreTokens, ...typography, ...spacing, ...radius, ...layout }
  return [
    `:root {\n${declarations(base, '  ')}\n  color-scheme: light dark;\n}`,
    `@media (prefers-color-scheme: dark) {\n  :root {\n${declarations(modes.dark, '    ')}\n  }\n}`
  ].join('\n\n')
}

export function installTheme(doc: Document): void {
  const style = doc.createElement('style')
  style.dataset.theme = 'custodio'
  style.textContent = themeCss()
  doc.head.prepend(style)
}
