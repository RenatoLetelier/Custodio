import { t } from '../i18n'
import { cn, modifier } from '../lib/dom'
import { SECTIONS, type SectionId } from '../navigation'
import { useAppState } from '../state/AppState'
import { Semaphore } from './ui'

export function Sidebar({ active, onSelect }: { active: SectionId; onSelect: (id: SectionId) => void }) {
  const { jobs, connection, overview } = useAppState()
  const running = jobs.filter((j) => j.status === 'running' && j.kind !== 'inventory_scan').length

  return (
    <aside className="sidebar" data-testid="sidebar">
      <div className="sidebar__brand">
        <span className="brand-mark" aria-hidden="true">
          {t('app.mark')}
        </span>
        <h2 className="sidebar__title">{t('app.name')}</h2>
      </div>

      <nav className="sidebar__nav" aria-label={t('nav.label')}>
        {SECTIONS.map((section) => (
          <button
            key={section.id}
            type="button"
            className={cn('sidebar__item', section.id === active && 'sidebar__item--active')}
            aria-current={section.id === active ? 'page' : undefined}
            onClick={() => onSelect(section.id)}
            data-section={section.id}
          >
            <span>{t(section.label)}</span>
            {section.id === 'activity' && running > 0 && (
              <span className="sidebar__count" aria-label={t('nav.runningCount', { count: running })}>
                {running}
              </span>
            )}
          </button>
        ))}
      </nav>

      <footer className="sidebar__footer">
        {overview && connection === 'online' && (
          <div className="sidebar__status" data-testid="global-status">
            <Semaphore status={overview.status} />
            <span>{t(`overview.status.${overview.status}`)}</span>
          </div>
        )}
        <div className={cn('connection', modifier('connection', connection))} data-testid="connection">
          <span className="connection__dot" aria-hidden="true" />
          <span>{t(`connection.${connection}`)}</span>
        </div>
      </footer>
    </aside>
  )
}
