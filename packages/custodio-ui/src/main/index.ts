import { BrowserWindow, app, nativeTheme } from 'electron'
import { join } from 'node:path'
import { t } from '../ui/i18n'
import { modes, windowSize } from '../ui/theme/tokens'

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    ...windowSize,
    title: t('app.name'),
    show: false,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? modes.dark.panelBg : modes.light.panelBg,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.on('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) void win.loadURL(devUrl)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
  return win
}

app.setName(t('app.name'))

void app.whenReady().then(() => {
  createMainWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
