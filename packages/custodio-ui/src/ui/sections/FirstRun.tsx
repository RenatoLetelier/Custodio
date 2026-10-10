import { useMemo, useState } from 'react'
import { api } from '../api/client'
import type { Disk, Plan, ProjectView, Role } from '../api/types'
import { EmptyState, ErrorNotice, Semaphore } from '../components/ui'
import { t, type MessageKey } from '../i18n'
import { formatBytes, formatList } from '../i18n/format'
import { DEFAULT_SCHEDULE, systemTimeZone, toCron } from '../lib/schedule'
import { useAppState } from '../state/AppState'

type Choice = Role | 'none'
type Preset = 'oneCopy' | 'twoCopies' | 'custom'
type Step = 'welcome' | 'preset' | 'disks' | 'summary'

const PRESETS: Preset[] = ['oneCopy', 'twoCopies', 'custom']
const CHOICES: Choice[] = ['storage', 'backup', 'none']
const STEPS: Step[] = ['welcome', 'preset', 'disks', 'summary']

function presetChoices(preset: Preset, disks: Disk[]): Record<string, Choice> {
  const copies = preset === 'twoCopies' ? 2 : preset === 'oneCopy' ? 1 : disks.length - 1
  return Object.fromEntries(disks.map((disk, index) => [disk.id, index === 0 ? 'storage' : index <= copies ? 'backup' : 'none']))
}

export function FirstRun({ onLater }: { onLater: () => void }) {
  const { disks, refresh } = useAppState()
  const usable = useMemo(() => disks.filter((d) => d.connected && d.state === 'unassigned'), [disks])
  const [step, setStep] = useState<Step>('welcome')
  const [preset, setPreset] = useState<Preset>('oneCopy')
  const [choices, setChoices] = useState<Record<string, Choice>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  const choiceOf = (disk: Disk): Choice => choices[disk.id] ?? presetChoices(preset, usable)[disk.id] ?? 'none'
  const withRole = (role: Choice) => usable.filter((d) => choiceOf(d) === role)
  const valid = withRole('storage').length > 0 && withRole('backup').length > 0
  const risky = usable.some((d) => d.health === 'red' && choiceOf(d) !== 'none')

  const choosePreset = (next: Preset): void => {
    setPreset(next)
    setChoices(presetChoices(next, usable))
  }

  const scan = async (): Promise<void> => {
    setError(null)
    try {
      await api('POST', '/v1/disks/scan')
      await new Promise((resolve) => setTimeout(resolve, 400))
      await refresh()
    } catch (e) {
      setError(e)
    }
  }

  const confirm = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const created = await api<ProjectView>('POST', '/v1/projects', { name: t('wizard.projectName') })
      const projectId = created.project.id
      const actions = usable
        .filter((d) => choiceOf(d) !== 'none')
        .map((d) => ({ type: 'add_assignment', diskId: d.id, folder: choiceOf(d) === 'storage' ? '' : t('wizard.backupFolder'), role: choiceOf(d) }))
      const { plan } = await api<{ plan: Plan }>('POST', `/v1/projects/${projectId}/plans`, { actions })
      await api('POST', `/v1/plans/${plan.id}/confirm`, { confirm: true })
      const view = await api<ProjectView>('GET', `/v1/projects/${projectId}`)
      await api('POST', `/v1/projects/${projectId}/policies`, {
        name: t('wizard.policyName'),
        sources: view.assignments.filter((a) => a.role === 'storage').map((a) => a.id),
        destinations: view.assignments.filter((a) => a.role === 'backup').map((a) => a.id),
        cron: toCron(DEFAULT_SCHEDULE),
        timezone: systemTimeZone()
      })
      await refresh()
    } catch (e) {
      setError(e)
      setBusy(false)
    }
  }

  const names = (list: Disk[]) => formatList(list.map((d) => d.model))
  const stepNumber = STEPS.indexOf(step) + 1

  return (
    <div className="wizard" data-testid="wizard" data-step={step}>
      <div className="wizard__card card">
        <p className="wizard__step">{t('wizard.stepOf', { step: stepNumber, total: STEPS.length })}</p>

        {step === 'welcome' && (
          <>
            <h2 className="wizard__title">{t('wizard.welcome.title')}</h2>
            <p>{t('wizard.welcome.body')}</p>
            <p className="muted">{t('wizard.welcome.safe')}</p>
            <div className="actions">
              <button type="button" className="btn btn--primary" onClick={() => setStep('preset')}>
                {t('wizard.welcome.start')}
              </button>
              <button type="button" className="btn btn--link" onClick={onLater}>
                {t('wizard.later')}
              </button>
            </div>
          </>
        )}

        {step === 'preset' && (
          <>
            <h2 className="wizard__title">{t('wizard.preset.title')}</h2>
            <p className="muted">{t('wizard.preset.body')}</p>
            <div className="choice-list" role="radiogroup" aria-label={t('wizard.preset.title')}>
              {PRESETS.map((option) => (
                <label key={option} className={`choice${preset === option ? ' choice--selected' : ''}`}>
                  <input type="radio" name="preset" value={option} checked={preset === option} onChange={() => choosePreset(option)} />
                  <span className="choice__text">
                    <span className="choice__title">{t(`wizard.preset.${option}.title` as MessageKey)}</span>
                    <span className="choice__body">{t(`wizard.preset.${option}.body` as MessageKey)}</span>
                  </span>
                </label>
              ))}
            </div>
            <div className="actions">
              <button type="button" className="btn" onClick={() => setStep('welcome')}>
                {t('common.back')}
              </button>
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => {
                  if (Object.keys(choices).length === 0) setChoices(presetChoices(preset, usable))
                  setStep('disks')
                }}
              >
                {t('common.next')}
              </button>
            </div>
          </>
        )}

        {step === 'disks' && (
          <>
            <h2 className="wizard__title">{t('wizard.disks.title')}</h2>
            <p className="muted">{t('wizard.disks.body')}</p>
            {usable.length === 0 ? (
              <EmptyState
                title={t('wizard.noDisks.title')}
                body={t('wizard.noDisks.body')}
                action={
                  <button type="button" className="btn btn--primary" onClick={() => void scan()}>
                    {t('disks.scan')}
                  </button>
                }
              />
            ) : (
              <div className="disk-choices">
                {usable.map((disk) => (
                  <div key={disk.id} className="disk-choice" role="group" aria-labelledby={`choice-${disk.id}`} data-testid="disk-choice" data-disk={disk.id}>
                    <div id={`choice-${disk.id}`} className="disk-choice__name">
                      <Semaphore status={disk.health} />
                      <span className="disk-choice__text">
                        <span>{disk.model}</span>
                        <span className="disk-choice__size">{formatBytes(disk.sizeBytes)}</span>
                      </span>
                    </div>
                    <div className="segmented" role="radiogroup" aria-label={t('wizard.disks.roleFor', { disk: disk.model })}>
                      {CHOICES.map((choice) => (
                        <label key={choice} className={`segmented__item${choiceOf(disk) === choice ? ' segmented__item--active' : ''}`}>
                          <input
                            type="radio"
                            className="visually-hidden"
                            name={`role-${disk.id}`}
                            value={choice}
                            checked={choiceOf(disk) === choice}
                            onChange={() => setChoices({ ...Object.fromEntries(usable.map((d) => [d.id, choiceOf(d)])), [disk.id]: choice })}
                          />
                          <span>{t(`wizard.choice.${choice}` as MessageKey)}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {usable.length > 0 && !valid && <p className="form-hint form-hint--warn">{t('wizard.disks.needBoth')}</p>}
            {risky && <p className="form-hint form-hint--warn">{t('wizard.disks.redDisk')}</p>}
            <div className="actions">
              <button type="button" className="btn" onClick={() => setStep('preset')}>
                {t('common.back')}
              </button>
              <button type="button" className="btn btn--primary" disabled={!valid} onClick={() => setStep('summary')}>
                {t('common.next')}
              </button>
            </div>
          </>
        )}

        {step === 'summary' && (
          <>
            <h2 className="wizard__title">{t('wizard.summary.title')}</h2>
            <ul className="summary-list" data-testid="wizard-summary">
              <li>{t('wizard.summary.storage', { disks: names(withRole('storage')) })}</li>
              <li>{t('wizard.summary.backup', { disks: names(withRole('backup')), time: DEFAULT_SCHEDULE.time })}</li>
              {withRole('none').length > 0 && <li>{t('wizard.summary.unused', { disks: names(withRole('none')) })}</li>}
              <li>{t('wizard.summary.safe')}</li>
            </ul>
            {error !== null && <ErrorNotice error={error} />}
            <div className="actions">
              <button type="button" className="btn" onClick={() => setStep('disks')} disabled={busy}>
                {t('common.back')}
              </button>
              <button type="button" className="btn btn--primary" onClick={() => void confirm()} disabled={busy}>
                {t('wizard.summary.confirm')}
              </button>
            </div>
          </>
        )}
        {step !== 'summary' && error !== null && <ErrorNotice error={error} />}
      </div>
    </div>
  )
}
