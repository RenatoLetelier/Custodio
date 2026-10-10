import { formatList } from '../i18n/format'
import { t, type MessageKey } from '../i18n'

// People choose "every day at 3:00" or "some days of the week"; the cron expression never reaches the screen
export interface Schedule {
  kind: 'daily' | 'weekly'
  // 0 = Sunday … 6 = Saturday, as in cron
  days: number[]
  time: string
}

export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]
export const DEFAULT_SCHEDULE: Schedule = { kind: 'daily', days: [], time: '03:00' }

export function toCron(schedule: Schedule): string {
  const [hour, minute] = schedule.time.split(':').map(Number)
  const days = schedule.kind === 'daily' ? '*' : [...new Set(schedule.days)].sort((a, b) => a - b).join(',')
  return `${minute ?? 0} ${hour ?? 0} * * ${days}`
}

export function fromCron(cron: string): Schedule | null {
  const match = /^(\d{1,2}) (\d{1,2}) \* \* (\*|[0-6](?:,[0-6])*)$/.exec(cron.trim())
  if (!match) return null
  const time = `${match[2]?.padStart(2, '0')}:${match[1]?.padStart(2, '0')}`
  if (match[3] === '*') return { kind: 'daily', days: [], time }
  return { kind: 'weekly', days: (match[3] as string).split(',').map(Number), time }
}

export const dayName = (day: number): string => t(`schedule.days.${day}` as MessageKey)

// "Cada día a las 03:00", "Los lunes, miércoles y viernes a las 03:00"
export function describeSchedule(cron: string): string {
  const schedule = fromCron(cron)
  if (!schedule) return t('schedule.custom')
  if (schedule.kind === 'daily' || schedule.days.length === 7) return t('schedule.daily', { time: schedule.time })
  const days = WEEK_ORDER.filter((d) => schedule.days.includes(d)).map((d) => t(`schedule.plural.${d}` as MessageKey))
  return t('schedule.weekly', { days: formatList(days), time: schedule.time })
}

export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}
