import { t } from '../i18n'
import type { Policy } from '../api/types'

// What happens in the copy with what is deleted from the original: kept for good, kept a few days in the
// copy's trash, or deleted from the copy too (mirror)
export interface DeletedSettings {
  mode: Policy['mode']
  retentionDays: string
  maxDeletePercent: string
}

export const DEFAULT_DELETED: DeletedSettings = { mode: 'append', retentionDays: '30', maxDeletePercent: '10' }

export const deletedFrom = (policy: Policy | undefined): DeletedSettings =>
  policy ? { mode: policy.mode, retentionDays: String(policy.retentionDays), maxDeletePercent: String(policy.maxDeletePercent) } : DEFAULT_DELETED

export function deletedValid(value: DeletedSettings): boolean {
  if (value.mode === 'append') return true
  const percent = Number(value.maxDeletePercent)
  const limitOk = value.maxDeletePercent !== '' && percent >= 0 && percent <= 100
  if (value.mode === 'mirror') return limitOk
  const days = Number(value.retentionDays)
  return Number.isInteger(days) && days >= 1 && days <= 3650 && limitOk
}

export function deletedBody(value: DeletedSettings): Record<string, unknown> {
  if (value.mode === 'append') return { mode: 'append' }
  const limit = { maxDeletePercent: Number(value.maxDeletePercent) }
  if (value.mode === 'mirror') return { mode: 'mirror', mirrorConfirmed: true, ...limit }
  return { mode: 'retention', retentionDays: Number(value.retentionDays), ...limit }
}

export function DeletedFields({ value, onChange, group, allowMirror = false }: { value: DeletedSettings; onChange: (value: DeletedSettings) => void; group: string; allowMirror?: boolean }) {
  const modes: Policy['mode'][] = allowMirror ? ['append', 'retention', 'mirror'] : ['append', 'retention']
  return (
    <fieldset className="field-stack">
      <legend>{t('backups.form.deleted')}</legend>
      {modes.map((mode) => (
        <label key={mode} className="check">
          <input type="radio" name={group} checked={value.mode === mode} onChange={() => onChange({ ...value, mode })} />
          <span>{t(`backups.form.deletedMode.${mode}`)}</span>
        </label>
      ))}
      {value.mode !== 'append' && (
        <>
          <p className="muted">{t(value.mode === 'mirror' ? 'backups.form.mirrorHint' : 'backups.form.retentionHint')}</p>
          {value.mode === 'retention' && (
            <label className="field">
              <span>{t('backups.form.retentionDays')}</span>
              <input className="input input--sm" type="number" min={1} max={3650} value={value.retentionDays} onChange={(e) => onChange({ ...value, retentionDays: e.target.value })} />
            </label>
          )}
          <label className="field-stack">
            <span>{t('backups.form.maxDelete')}</span>
            <input className="input input--sm" type="number" min={0} max={100} value={value.maxDeletePercent} onChange={(e) => onChange({ ...value, maxDeletePercent: e.target.value })} />
          </label>
        </>
      )}
    </fieldset>
  )
}
