import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { t } from './i18n'
import { installTheme } from './theme'
import './styles/base.css'

installTheme(document)
document.title = t('app.name')

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root element')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
)
