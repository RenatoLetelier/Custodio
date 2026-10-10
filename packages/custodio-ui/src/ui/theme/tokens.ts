// Values taken from LocalProcessor and LocalStreaming (see docs/UI-GUIDE.md)

const shared = {
  sidebarBg: '#1b2028',
  sidebarFg: '#d7dbe2',
  sidebarFgMuted: '#8b93a1',
  sidebarItemHover: 'rgba(255, 255, 255, 0.06)',
  sidebarItemActive: 'rgba(255, 255, 255, 0.12)',
  sidebarDivider: 'rgba(255, 255, 255, 0.08)',
  accent: '#3b82f6',
  accentHover: '#2f6fe0',
  accentFg: '#ffffff',
  accentSoft: 'rgba(59, 130, 246, 0.12)',
  ok: '#16a34a',
  okSoft: 'rgba(22, 163, 74, 0.12)',
  warn: '#d97706',
  warnSoft: 'rgba(217, 119, 6, 0.12)',
  error: '#dc2626',
  errorSoft: 'rgba(220, 38, 38, 0.1)',
  mutedSoft: 'rgba(92, 100, 112, 0.14)',
  backdrop: 'rgba(0, 0, 0, 0.45)',
  shadowModal: '0 20px 40px rgba(0, 0, 0, 0.3)'
}

const light = {
  ...shared,
  panelBg: '#f5f6f8',
  panelFg: '#1c2128',
  panelFgMuted: '#5c6470',
  panelBorder: '#e1e4e8',
  cardBg: '#ffffff',
  inputBg: '#ffffff',
  hoverBg: '#f0f2f5',
  shadow: '0 1px 2px rgba(0, 0, 0, 0.06)'
}

export type ModeTokens = typeof light

const dark: ModeTokens = {
  ...shared,
  panelBg: '#14171c',
  panelFg: '#e6e8eb',
  panelFgMuted: '#9aa3b0',
  panelBorder: '#262b33',
  cardBg: '#1b1f26',
  inputBg: '#14171c',
  hoverBg: '#232830',
  shadow: '0 1px 2px rgba(0, 0, 0, 0.4)'
}

export const modes = { light, dark } as const

export type Health = 'green' | 'yellow' | 'red' | 'unknown'

// Unknown is never green: it borrows the sidebar's neutral grey
export const semaphore: Record<Health, string> = {
  green: shared.ok,
  yellow: shared.warn,
  red: shared.error,
  unknown: shared.sidebarFgMuted
}

export const typography = {
  fontSans: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  fontMono: 'ui-monospace, Consolas, monospace',
  textBase: '14px',
  textSm: '12px',
  textXs: '11px',
  textCardTitle: '14px',
  textModalTitle: '16px',
  textDetailTitle: '18px',
  textPanelTitle: '20px',
  lineHeight: '1.45',
  weightBold: '600',
  weightHeavy: '700'
}

export const spacing = {
  space1: '4px',
  space2: '8px',
  space3: '12px',
  space4: '16px',
  space5: '20px',
  space6: '24px',
  space7: '28px',
  space10: '40px'
}

export const radius = {
  radiusXs: '4px',
  radiusSm: '6px',
  radiusLogo: '7px',
  radius: '8px',
  radiusModal: '10px',
  radiusPill: '999px'
}

export const layout = {
  sidebarWidth: '220px',
  logoSize: '28px'
}

export const windowSize = { width: 1280, height: 820, minWidth: 960, minHeight: 640 }
