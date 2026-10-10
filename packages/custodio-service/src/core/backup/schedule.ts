import { Cron } from 'croner'
import { DomainError } from '../shared/errors.js'
import type { TimeWindow } from '../shared/model.js'

export function isValidTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone })
    return true
  } catch {
    return false
  }
}

function cronFor(cron: string, timezone: string): Cron {
  if (!isValidTimeZone(timezone)) throw new DomainError('validation_failed', `"${timezone}" no es una zona horaria válida.`)
  if (cron.trim().split(/\s+/).length !== 5) {
    throw new DomainError('validation_failed', `"${cron}" no es una programación válida: usa minuto, hora, día, mes y día de la semana.`)
  }
  try {
    return new Cron(cron, { timezone, paused: true })
  } catch {
    throw new DomainError('validation_failed', `"${cron}" no es una programación válida.`)
  }
}

export function validateSchedule(cron: string, timezone: string): void {
  if (!cronFor(cron, timezone).nextRun(new Date())) throw new DomainError('validation_failed', `"${cron}" nunca se ejecuta.`)
}

export function nextRun(cron: string, timezone: string, after: Date): Date | null {
  return cronFor(cron, timezone).nextRun(after)
}

// Latest slot in (after, now] and how many slots were due; a long downtime collapses into one catch-up run
export function dueSlots(cron: string, timezone: string, after: Date, now: Date, max = 10_000): { latest: Date | null; count: number } {
  const schedule = cronFor(cron, timezone)
  let latest: Date | null = null
  let count = 0
  let cursor = after
  while (count < max) {
    const next = schedule.nextRun(cursor)
    if (!next || next.getTime() > now.getTime()) break
    latest = next
    count++
    cursor = next
  }
  return { latest, count }
}

export function expectedIntervalMs(cron: string, timezone: string, from: Date): number {
  const [first, second] = cronFor(cron, timezone).nextRuns(2, from)
  if (!first || !second) return 24 * 60 * 60 * 1000
  return second.getTime() - first.getTime()
}

function minutesOfDay(at: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at)
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0)
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0)
  return hour * 60 + minute
}

const parseHourMinute = (value: string): number => {
  const [h, m] = value.split(':').map(Number)
  return (h ?? 0) * 60 + (m ?? 0)
}

// Windows may wrap midnight ("22:00"–"06:00"); start is inclusive, end exclusive
export function isWindowOpen(window: TimeWindow | null, timezone: string, at: Date): boolean {
  if (!window) return true
  const now = minutesOfDay(at, timezone)
  const start = parseHourMinute(window.start)
  const end = parseHourMinute(window.end)
  if (start === end) return true
  return start < end ? now >= start && now < end : now >= start || now < end
}
