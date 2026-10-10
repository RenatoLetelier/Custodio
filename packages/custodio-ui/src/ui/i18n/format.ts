import { record, t, type MessageKey } from '.'

const LOCALE = 'es-CL'
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const

export function formatNumber(value: number, digits = 1): string {
  return record(new Intl.NumberFormat(LOCALE, { maximumFractionDigits: digits }).format(value))
}

// Decimal units, as disk makers count them: "1,2 TB"
export function formatBytes(bytes: number): string {
  let value = Math.max(0, bytes)
  let unit = 0
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000
    unit++
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1
  const amount = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: digits }).format(value)
  return t('units.bytes', { value: amount, unit: t(`units.${UNITS[unit]}` as MessageKey) })
}

export function formatPercent(value: number): string {
  return t('common.percent', { value: Math.round(value) })
}

export function formatDateTime(iso: string): string {
  return record(new Intl.DateTimeFormat(LOCALE, { dateStyle: 'long', timeStyle: 'short' }).format(new Date(iso)))
}

const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['second', 60],
  ['minute', 60],
  ['hour', 24],
  ['day', 30],
  ['month', 12],
  ['year', Number.POSITIVE_INFINITY]
]

// "hace 5 minutos", "en 3 horas", "mañana"
export function formatRelative(iso: string, now = Date.now()): string {
  let value = (Date.parse(iso) - now) / 1000
  for (const [unit, size] of STEPS) {
    if (Math.abs(value) < size || unit === 'year') {
      const rounded = unit === 'second' ? Math.round(value / 10) * 10 : Math.round(value)
      return record(new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto' }).format(rounded, unit))
    }
    value /= size
  }
  return record(iso)
}

export function formatList(items: string[]): string {
  return record(new Intl.ListFormat('es', { style: 'long', type: 'conjunction' }).format(items))
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return t('common.seconds', { count: seconds })
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return t('common.minutes', { count: minutes })
  return t('common.hours', { count: formatNumber(minutes / 60) })
}
