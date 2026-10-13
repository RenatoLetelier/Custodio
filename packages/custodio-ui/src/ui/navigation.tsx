import { createContext, use } from 'react'
import type { MessageKey } from './i18n'

export type SectionId = 'overview' | 'disks' | 'projects' | 'backups' | 'activity' | 'settings'

export const SECTIONS: { id: SectionId; label: MessageKey; description: MessageKey }[] = [
  { id: 'overview', label: 'nav.overview', description: 'sections.overview.description' },
  { id: 'disks', label: 'nav.disks', description: 'sections.disks.description' },
  { id: 'projects', label: 'nav.projects', description: 'sections.projects.description' },
  { id: 'backups', label: 'nav.backups', description: 'sections.backups.description' },
  { id: 'activity', label: 'nav.activity', description: 'sections.activity.description' },
  { id: 'settings', label: 'nav.settings', description: 'sections.settings.description' }
]

// What a section should open when another one sends you there: a project to edit, or a new one
export type Intent = { kind: 'editProject'; projectId: string } | { kind: 'newProject'; diskId?: string }

export const NavigationContext = createContext<(section: SectionId, intent?: Intent) => void>(() => undefined)

export const useNavigate = (): ((section: SectionId, intent?: Intent) => void) => use(NavigationContext)

export const IntentContext = createContext<{ intent: Intent | null; clear: () => void }>({ intent: null, clear: () => undefined })

export const useIntent = () => use(IntentContext)

// "Lo haré más tarde" holds while the window stays open
export const FirstRunContext = createContext<{ postponed: boolean; setPostponed: (value: boolean) => void }>({ postponed: false, setPostponed: () => undefined })

export const useFirstRun = () => use(FirstRunContext)
