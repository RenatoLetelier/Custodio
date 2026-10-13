import { Badge, EmptyState, Semaphore } from '../components/ui'
import { cn, modifier } from '../lib/dom'
import { t, type MessageKey } from '../i18n'
import { formatBytes, formatDateTime, formatRelative } from '../i18n/format'
import { suggestions, type Suggestion } from '../lib/disks'
import { useFirstRun, useNavigate, type SectionId } from '../navigation'
import { useAppState } from '../state/AppState'
import { FirstRun, unfinishedSetup } from './FirstRun'

const SUGGESTION_TARGET: Record<Suggestion, SectionId> = {
  configure: 'overview',
  repairDisk: 'disks',
  reconnect: 'disks',
  freeSpace: 'disks',
  checkBackups: 'backups',
  unassigned: 'disks'
}

const STATUS_TONE = { succeeded: 'ok', failed: 'error' } as const

export function Overview() {
  const { overview, projects } = useAppState()
  const navigate = useNavigate()
  const { postponed, setPostponed } = useFirstRun()

  if ((projects.length === 0 || unfinishedSetup(projects)) && !postponed) return <FirstRun onLater={() => setPostponed(true)} />
  if (!overview) return null

  if (projects.length === 0) {
    return (
      <EmptyState
        title={t('overview.empty.title')}
        body={t('overview.empty.body')}
        action={
          <button type="button" className="btn btn--primary" onClick={() => setPostponed(false)}>
            {t('overview.empty.action')}
          </button>
        }
      />
    )
  }

  const todo = suggestions(overview)
  const last = overview.lastBackup

  return (
    <div className="stack">
      <section className={cn('card', 'status-hero', modifier('status-hero', overview.status))} data-testid="overview-status" data-status={overview.status} aria-labelledby="status-title">
        <Semaphore status={overview.status} size="lg" />
        <div>
          <h2 id="status-title" className="status-hero__title">
            {t(`overview.status.${overview.status}`)}
          </h2>
          <p className="status-hero__hint">{t(`overview.statusHint.${overview.status}`)}</p>
        </div>
      </section>

      <section aria-labelledby="todo-title">
        <h2 id="todo-title" className="section-title">
          {t('overview.todo.title')}
        </h2>
        {todo.length === 0 ? (
          <p className="card muted" data-testid="todo-empty">
            {t('overview.todo.nothing')}
          </p>
        ) : (
          <ul className="todo-list">
            {todo.map((item) => (
              <li key={item} className="card card--row todo">
                <span>{t(`overview.todo.${item}` as MessageKey)}</span>
                <button type="button" className="btn btn--sm" onClick={() => navigate(SUGGESTION_TARGET[item])}>
                  {t(`overview.todo.${item}Action` as MessageKey)}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="stats" aria-label={t('overview.stats.label')}>
        <div className="card stat" data-testid="stat-total">
          <p className="stat__label">{t('overview.stats.total')}</p>
          <p className="stat__value">{formatBytes(overview.space.totalBytes)}</p>
        </div>
        <div className="card stat" data-testid="stat-free">
          <p className="stat__label">{t('overview.stats.free')}</p>
          <p className="stat__value">{formatBytes(overview.space.freeBytes)}</p>
        </div>
        <div className="card stat" data-testid="stat-last">
          <p className="stat__label">{t('overview.stats.last')}</p>
          {last?.finishedAt ? (
            <>
              <p className="stat__value">{formatRelative(last.finishedAt)}</p>
              <p className="stat__note">
                <Badge tone={STATUS_TONE[last.status as keyof typeof STATUS_TONE] ?? 'muted'}>{t(`jobs.status.${last.status}` as MessageKey)}</Badge>
              </p>
            </>
          ) : (
            <p className="stat__value stat__value--empty">{t('overview.stats.never')}</p>
          )}
        </div>
        <div className="card stat" data-testid="stat-next">
          <p className="stat__label">{t('overview.stats.next')}</p>
          {overview.nextBackup ? (
            <>
              <p className="stat__value">{formatRelative(overview.nextBackup.at)}</p>
              <p className="stat__note">{formatDateTime(overview.nextBackup.at)}</p>
            </>
          ) : (
            <p className="stat__value stat__value--empty">{t('overview.stats.none')}</p>
          )}
        </div>
      </section>
    </div>
  )
}
