import type { CapacityReading } from '../shared/model.js'

const DAY_MS = 24 * 60 * 60 * 1000
export const TREND_WINDOW_DAYS = 30
export const LOW_FREE_PERCENT = 10
// Hysteresis: the low-space warning clears only once free space recovers past this
export const RECOVERED_FREE_PERCENT = 15

export interface CapacitySummary {
  totalBytes: number
  usedBytes: number
  freeBytes: number
  freePercent: number
  daysUntilFull: number | null
}

// Least-squares line over used bytes; null when usage is flat or shrinking
export function daysUntilFull(readings: CapacityReading[]): number | null {
  if (readings.length < 2) return null
  const sorted = [...readings].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  const t0 = Date.parse(sorted[0]!.at)
  const xs = sorted.map((r) => (Date.parse(r.at) - t0) / DAY_MS)
  const ys = sorted.map((r) => r.usedBytes)
  const n = xs.length
  const meanX = xs.reduce((a, b) => a + b, 0) / n
  const meanY = ys.reduce((a, b) => a + b, 0) / n
  let covariance = 0
  let variance = 0
  for (let i = 0; i < n; i++) {
    covariance += (xs[i]! - meanX) * (ys[i]! - meanY)
    variance += (xs[i]! - meanX) ** 2
  }
  if (variance === 0) return null
  const slope = covariance / variance
  if (slope <= 0) return null
  const intercept = meanY - slope * meanX
  const latest = sorted[n - 1]!
  const fullAt = (latest.totalBytes - intercept) / slope
  return Math.max(0, Math.round((fullAt - xs[n - 1]!) * 10) / 10)
}

export function summarizeCapacity(readings: CapacityReading[]): CapacitySummary | null {
  const latest = [...readings].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).at(-1)
  if (!latest) return null
  const freeBytes = Math.max(0, latest.totalBytes - latest.usedBytes)
  return {
    totalBytes: latest.totalBytes,
    usedBytes: latest.usedBytes,
    freeBytes,
    freePercent: latest.totalBytes === 0 ? 0 : Math.round((freeBytes / latest.totalBytes) * 1000) / 10,
    daysUntilFull: daysUntilFull(readings)
  }
}

export const trendSince = (now: Date): string => new Date(now.getTime() - TREND_WINDOW_DAYS * DAY_MS).toISOString()
