import { Menu, Notification, Tray, nativeImage } from 'electron'
import { t } from '../ui/i18n'
import { semaphore } from '../ui/theme/tokens'
import type { ShellPort } from './status'
import { circlePng } from './tray-icon'

const icon = (color: string) => nativeImage.createFromBuffer(circlePng(color), { scaleFactor: 2 })

export function createElectronShell(onOpen: () => void, onQuit: () => void): ShellPort {
  const tray = new Tray(icon(semaphore.unknown))
  tray.setToolTip(t('tray.tooltip.unknown'))
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: t('tray.open'), click: onOpen },
      { type: 'separator' },
      { label: t('tray.quit'), click: onQuit }
    ])
  )
  tray.on('click', onOpen)

  return {
    setTray: (status, tooltip) => {
      tray.setImage(icon(semaphore[status]))
      tray.setToolTip(tooltip)
    },
    notify: (title, body) => {
      if (Notification.isSupported()) new Notification({ title, body }).show()
    }
  }
}
