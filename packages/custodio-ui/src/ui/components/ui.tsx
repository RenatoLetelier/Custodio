import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { Health } from '../api/types'
import { t, type MessageKey } from '../i18n'
import { friendlyError } from '../lib/errors'

// Line icons drawn with the text colour, 24×24 viewBox (same style as LocalProcessor-Photos)
const PATHS = {
  chevronDown: 'M6 9l6 6 6-6',
  chevronRight: 'M9 6l6 6-6 6',
  close: 'M6 6l12 12M18 6L6 18',
  check: 'M5 12l5 5L20 7',
  alert: 'M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  disk: 'M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM8 16h.01M12 16h4',
  refresh: 'M23 4v6h-6M1 20v-6h6M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15'
} as const

export type IconName = keyof typeof PATHS

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  )
}

export function Semaphore({ status, size = 'md' }: { status: Health; size?: 'md' | 'lg' }) {
  return <span className={`semaphore semaphore--${status} semaphore--${size}`} role="img" aria-label={t(`health.label.${status}`)} data-status={status} />
}

export function Badge({ tone, children }: { tone: 'ok' | 'warn' | 'error' | 'accent' | 'muted'; children: ReactNode }) {
  return <span className={`badge badge--${tone}`}>{children}</span>
}

export function EmptyState({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="empty" data-testid="empty-state">
      <p className="empty__title">{title}</p>
      {body && <p className="empty__body">{body}</p>}
      {action !== undefined && <div className="empty__action">{action}</div>}
    </div>
  )
}

export function ProgressBar({ percent, label }: { percent: number; label: string }) {
  const value = Math.max(0, Math.min(100, percent))
  return (
    <div className="progress" role="progressbar" aria-label={label} aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={100}>
      <div className="progress__fill" style={{ width: `${value}%` }} />
    </div>
  )
}

export function ErrorNotice({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const friendly = friendlyError(error)
  return (
    <div className="alert alert--error" role="alert" data-testid="error-notice">
      <p className="alert__title">{friendly.title}</p>
      {friendly.detail && <p>{friendly.detail}</p>}
      <p>{friendly.hint}</p>
      {onRetry && (
        <button type="button" className="btn btn--sm" onClick={onRetry}>
          {t('common.retry')}
        </button>
      )}
    </div>
  )
}

// "Detalles técnicos" / "Avanzado": folded by default, technical words live only in here
export function Disclosure({ label, children }: { label: MessageKey; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <div className="disclosure">
      <button type="button" className="disclosure__toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={16} />
        {t(label)}
      </button>
      <div id={id} className="disclosure__body" hidden={!open}>
        {open && children}
      </div>
    </div>
  )
}

export function Modal({ title, onClose, children, footer, wide = false }: { title: string; onClose: () => void; children: ReactNode; footer: ReactNode; wide?: boolean }) {
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  useEffect(() => {
    closeRef.current = onClose
  })

  // Focus moves into the dialog once, and returns to whatever opened it when it closes
  useEffect(() => {
    const opener = document.activeElement
    const root = dialogRef.current
    ;(root?.querySelector<HTMLElement>('[data-autofocus]') ?? root?.querySelector<HTMLElement>('button, input, select, textarea'))?.focus()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      if (opener instanceof HTMLElement) opener.focus()
    }
  }, [])

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialogRef} className={`modal${wide ? ' modal--wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId} className="modal__title">
          {title}
        </h2>
        <div className="modal__body">{children}</div>
        <div className="modal__footer">{footer}</div>
      </div>
    </div>
  )
}

export interface PreviewProps {
  title: string
  summary: string
  lines: string[]
  confirmLabel: string
  danger?: boolean
  // Risky actions that delete something also need a tick before the button unlocks
  acknowledge?: string
  onConfirm: () => Promise<void>
  onClose: () => void
}

// Every risky action: first a plain-language preview, then an explicit confirmation
export function PreviewDialog({ title, summary, lines, confirmLabel, danger = false, acknowledge, onConfirm, onClose }: PreviewProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [checked, setChecked] = useState(!acknowledge)

  const confirm = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await onConfirm()
      onClose()
    } catch (e) {
      setError(e)
      setBusy(false)
    }
  }

  return (
    <Modal
      title={title}
      wide
      onClose={() => !busy && onClose()}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy} data-autofocus>
            {t('common.cancel')}
          </button>
          <button type="button" className={`btn ${danger ? 'btn--danger' : 'btn--primary'}`} onClick={() => void confirm()} disabled={busy || !checked}>
            {confirmLabel}
          </button>
        </>
      }
    >
      <div data-testid="preview">
        <p className="preview__summary">{summary}</p>
        <ul className="preview__lines">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        {acknowledge && (
          <label className="check">
            <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
            <span>{acknowledge}</span>
          </label>
        )}
        {error !== null && <ErrorNotice error={error} />}
      </div>
    </Modal>
  )
}
