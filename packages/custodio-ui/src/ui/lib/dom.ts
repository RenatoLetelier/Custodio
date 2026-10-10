// Class names and element ids assembled from parts, so no inline strings end up in JSX attributes
export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}

export function domId(...parts: string[]): string {
  return parts.join('-')
}

// BEM modifier: modifier('badge', 'ok') → "badge--ok"
export function modifier(block: string, value: string): string {
  return [block, value].join('--')
}
