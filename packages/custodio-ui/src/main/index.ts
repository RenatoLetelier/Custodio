import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, normalize, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BrowserWindow, app, dialog, ipcMain, nativeTheme, net, protocol, shell as desktop } from 'electron'
import { t } from '../ui/i18n'
import { modes, windowSize } from '../ui/theme/tokens'
import { createElectronShell } from './shell'
import { StatusMonitor, type ServiceAddress } from './status'

// The renderer is served from app://custodio, the only browser origin the service accepts
const RENDERER_DIR = join(__dirname, '../renderer')
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }])

// Where the service keeps its database, token and logs
const dataDir = process.env.CUSTODIO_DATA_DIR ?? (process.platform === 'win32' ? join(process.env.ProgramData ?? 'C:\\ProgramData', 'Custodio') : join(homedir(), '.custodio'))

// The service runs on its own; the interface only needs its loopback address and token
function serviceAddress(): ServiceAddress | null {
  try {
    const token = process.env.CUSTODIO_TOKEN ?? readFileSync(join(dataDir, 'service-token'), 'utf8').trim()
    return { baseUrl: process.env.CUSTODIO_SERVICE_URL ?? 'http://127.0.0.1:47600', token }
  } catch {
    return null
  }
}

let window: BrowserWindow | null = null

function showWindow(): void {
  if (window && !window.isDestroyed()) {
    window.show()
    window.focus()
    return
  }
  window = new BrowserWindow({
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
  window.on('ready-to-show', () => window?.show())
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  void window.loadURL(process.env.ELECTRON_RENDERER_URL ?? 'app://custodio/index.html')
}

// Installed, Custodio starts with the session straight into the tray; the uninstaller removes this entry by its name
const LOGIN_ITEM = 'Custodio'
const BACKGROUND_ARG = '--background'

app.setName(t('app.name'))

// One Custodio per session: opening it again shows the window of the one already in the tray
const primary = app.requestSingleInstanceLock()
if (!primary) app.quit()
app.on('second-instance', showWindow)

void app.whenReady().then(() => {
  if (!primary) return
  protocol.handle('app', (request) => {
    const path = normalize(join(RENDERER_DIR, decodeURIComponent(new URL(request.url).pathname)))
    if (!path.startsWith(RENDERER_DIR + sep)) return new Response(null, { status: 404 })
    return net.fetch(pathToFileURL(path).toString())
  })

  const address = serviceAddress()
  ipcMain.on('custodio:bridge', (event) => {
    event.returnValue = { platform: process.platform, service: address, dataDir }
  })
  ipcMain.handle('custodio:choose-folder', async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    const options = { title: t('projects.editor.chooseFolder'), properties: ['openDirectory' as const] }
    const picked = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    return picked.canceled ? null : (picked.filePaths[0] ?? null)
  })
  // Only this one folder: the renderer cannot ask to open anything else
  ipcMain.handle('custodio:open-logs', async () => {
    await desktop.openPath(join(dataDir, 'logs'))
  })

  const shell = createElectronShell(showWindow, () => app.quit())
  if (address) void new StatusMonitor(address, shell).start()
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: true, name: LOGIN_ITEM, args: [BACKGROUND_ARG] })
  if (!process.argv.includes(BACKGROUND_ARG)) showWindow()
})

// Closing the window keeps the tray; quitting the interface never stops the service or its schedule
app.on('window-all-closed', () => undefined)
