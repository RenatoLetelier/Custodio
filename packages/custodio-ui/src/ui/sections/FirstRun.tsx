import { useMemo, useState } from 'react'
import { cn, domId } from '../lib/dom'
import { api } from '../api/client'
import type { Disk, Plan, ProjectView, Role } from '../api/types'
import { EmptyState, ErrorNotice, Semaphore } from '../components/ui'
import { t, type MessageKey } from '../i18n'
import { formatBytes, formatList } from '../i18n/format'
import { diskName } from '../lib/disks'
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

// The project an attempt left half done (it stopped before its copy existed): the assistant resumes it
export function unfinishedSetup(projects: ProjectView[]): ProjectView | null {
  const own = projects.find((p) => p.project.name === t('wizard.projectName'))
  return projects.length === 1 && own && own.policies.length === 0 ? own : null
}

export function FirstRun({ onLater }: { onLater: () => void }) {
  const { disks, projects, refresh } = useAppState()
  const left = unfinishedSetup(projects)
  const usable = useMemo(() => disks.filter((d) => d.connected && (d.state === 'unassigned' || left?.assignments.some((a) => a.diskId === d.id))), [disks, left])
  const [step, setStep] = useState<Step>('welcome')
  const [preset, setPreset] = useState<Preset>('oneCopy')
  const [choices, setChoices] = useState<Record<string, Choice>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  const choiceOf = (disk: Disk): Choice => choices[disk.id] ?? left?.assignments.find((a) => a.diskId === disk.id)?.role ?? presetChoices(preset, usable)[disk.id] ?? 'none'
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
      // Every step can be repeated: a project or disks left by an earlier attempt are reused, never doubled
      const current = unfinishedSetup((await api<{ projects: ProjectView[] }>('GET', '/v1/projects')).projects)
      const projectId = current?.project.id ?? (await api<ProjectView>('POST', '/v1/projects', { name: t('wizard.projectName') })).project.id
      const kept = (current?.assignments ?? []).filter((a) => usable.some((d) => d.id === a.diskId))
      const actions = [
        ...kept.filter((a) => choiceOf(usable.find((d) => d.id === a.diskId)!) !== a.role).map((a) => ({ type: 'remove_assignment', assignmentId: a.id })),
        ...usable
          .filter((d) => choiceOf(d) !== 'none' && !kept.some((a) => a.diskId === d.id && a.role === choiceOf(d)))
          .map((d) => ({ type: 'add_assignment', diskId: d.id, folder: choiceOf(d) === 'storage' ? '' : t('wizard.backupFolder'), role: choiceOf(d) }))
      ]
      if (actions.length > 0) {
        const { plan } = await api<{ plan: Plan }>('POST', `/v1/projects/${projectId}/plans`, { actions })
        await api('POST', `/v1/plans/${plan.id}/confirm`, { confirm: true })
      }
      const view = await api<ProjectView>('GET', `/v1/projects/${projectId}`)
      if (view.policies.length === 0) {
        await api('POST', `/v1/projects/${projectId}/policies`, {
          name: t('wizard.policyName'),
          sources: view.assignments.filter((a) => a.role === 'storage').map((a) => a.id),
          destinations: view.assignments.filter((a) => a.role === 'backup').map((a) => a.id),
          cron: toCron(DEFAULT_SCHEDULE),
          timezone: systemTimeZone()
        })
      }
      await refresh()
    } catch (e) {
      setError(e)
      setBusy(false)
    }
  }

  const names = (list: Disk[]) => formatList(list.map(diskName))
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
                <label key={option} className={cn('choice', preset === option && 'choice--selected')}>
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
                  if (Object.keys(choices).length === 0) setChoices(Object.fromEntries(usable.map((d) => [d.id, choiceOf(d)])))
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
                  <div key={disk.id} className="disk-choice" role="group" aria-labelledby={domId('choice', disk.id)} data-testid="disk-choice" data-disk={disk.id}>
                    <div id={domId('choice', disk.id)} className="disk-choice__name">
                      <Semaphore status={disk.health} />
                      <span className="disk-choice__text">
                        <span>{diskName(disk)}</span>
                        <span className="disk-choice__size">{formatBytes(disk.sizeBytes)}</span>
                      </span>
                    </div>
                    <div className="segmented" role="radiogroup" aria-label={t('wizard.disks.roleFor', { disk: diskName(disk) })}>
                      {CHOICES.map((choice) => (
                        <label key={choice} className={cn('segmented__item', choiceOf(disk) === choice && 'segmented__item--active')}>
                          <input
                            type="radio"
                            className="visually-hidden"
                            name={domId('role', disk.id)}
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
