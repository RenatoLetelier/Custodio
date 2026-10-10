import type { SmartReading } from '../ports/system.js'
import type { Health, Notice, SmartSnapshot } from '../shared/model.js'

export const HEALTH_LIMITS = {
  reallocatedWarn: 1,
  reallocatedFail: 50,
  pendingWarn: 1,
  pendingFail: 10,
  uncorrectableFail: 1,
  temperatureWarn: 50,
  temperatureFail: 60,
  powerOnHoursWarn: 35_000
}

export interface HealthEvaluation {
  health: Health
  reasons: Notice[]
  advisories: Notice[]
  smart: SmartSnapshot | null
}

const RANK: Record<Health, number> = { unknown: 0, green: 1, yellow: 2, red: 3 }

const attribute = (reading: SmartReading, id: number): number | null => {
  const value = reading.attributes[String(id)]
  return value === undefined ? null : value
}

const hasData = (reading: SmartReading): boolean =>
  reading.passed !== null || Object.keys(reading.attributes).length > 0 || reading.temperatureC !== null || reading.powerOnHours !== null

// Traffic light from SMART: 5, 197, 198, temperature and hours decide; 199 only points at the cable
export function evaluateHealth(reading: SmartReading | null): HealthEvaluation {
  if (!reading || !reading.supported || !hasData(reading)) {
    return {
      health: 'unknown',
      reasons: [{ code: 'no_smart', message: 'Este disco no entrega información de salud.' }],
      advisories: [],
      smart: null
    }
  }

  const reasons: Notice[] = []
  const advisories: Notice[] = []
  let health: Health = 'green'
  const raise = (level: Health, notice: Notice): void => {
    reasons.push(notice)
    if (RANK[level] > RANK[health]) health = level
  }

  if (reading.passed === false) raise('red', { code: 'smart_failed', message: 'El disco anuncia que va a fallar.' })

  const reallocated = attribute(reading, 5)
  if (reallocated !== null && reallocated >= HEALTH_LIMITS.reallocatedWarn) {
    const level = reallocated >= HEALTH_LIMITS.reallocatedFail ? 'red' : 'yellow'
    raise(level, { code: 'reallocated_sectors', message: 'El disco ha tenido que reemplazar zonas dañadas.', attribute: 5, value: reallocated })
  }

  const pending = attribute(reading, 197)
  if (pending !== null && pending >= HEALTH_LIMITS.pendingWarn) {
    const level = pending >= HEALTH_LIMITS.pendingFail ? 'red' : 'yellow'
    raise(level, { code: 'pending_sectors', message: 'Hay zonas del disco que no se pueden leer bien.', attribute: 197, value: pending })
  }

  const uncorrectable = attribute(reading, 198)
  if (uncorrectable !== null && uncorrectable >= HEALTH_LIMITS.uncorrectableFail) {
    raise('red', { code: 'uncorrectable_sectors', message: 'El disco tiene datos que ya no puede recuperar.', attribute: 198, value: uncorrectable })
  }

  const temperature = reading.temperatureC ?? attribute(reading, 194) ?? attribute(reading, 190)
  if (temperature !== null && temperature >= HEALTH_LIMITS.temperatureWarn) {
    const level = temperature >= HEALTH_LIMITS.temperatureFail ? 'red' : 'yellow'
    raise(level, { code: 'temperature', message: 'El disco está demasiado caliente.', value: temperature })
  }

  const hours = reading.powerOnHours ?? attribute(reading, 9)
  if (hours !== null && hours >= HEALTH_LIMITS.powerOnHoursWarn) {
    raise('yellow', { code: 'power_on_hours', message: 'El disco ya tiene muchos años de uso.', value: hours })
  }

  const crc = attribute(reading, 199)
  if (crc !== null && crc > 0) {
    advisories.push({ code: 'cable', message: 'Revisa el cable o el adaptador USB: hubo errores de conexión.', attribute: 199, value: crc })
  }

  return {
    health,
    reasons,
    advisories,
    smart: { passed: reading.passed, attributes: { ...reading.attributes }, temperatureC: temperature, powerOnHours: hours }
  }
}
