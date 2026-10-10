import { t } from './i18n'

// Placeholder until the shell (sidebar + panel) is built against U1
export function App() {
  return (
    <main className="placeholder">
      <span className="brand-mark" aria-hidden="true">
        {t('app.mark')}
      </span>
      <h1 className="placeholder__title">{t('app.name')}</h1>
      <p className="muted">{t('app.tagline')}</p>
    </main>
  )
}
