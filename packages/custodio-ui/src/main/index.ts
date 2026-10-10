import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, normalize, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BrowserWindow, app, ipcMain, nativeTheme, net, protocol } from 'electron'
import { t } from '../ui/i18n'
import { modes, windowSize } from '../ui/theme/tokens'
import { createElectronShell } from './shell'
import { StatusMonitor, type ServiceAddress } from './status'

// The renderer is served from app://custodio, the only browser origin the service accepts
const RENDERER_DIR = join(__dirname, '../renderer')
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }])

// The service runs on its own; the interface only needs its loopback address and token
function serviceAddress(): ServiceAddress | null {
  const dataDir = process.env.CUSTODIO_DATA_DIR ?? (process.platform === 'win32' ? join(process.env.ProgramData ?? 'C:\\ProgramData', 'Custodio') : join(homedir(), '.custodio'))
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

app.setName(t('app.name'))

void app.whenReady().then(() => {
  protocol.handle('app', (request) => {
    const path = normalize(join(RENDERER_DIR, decodeURIComponent(new URL(request.url).pathname)))
    if (!path.startsWith(RENDERER_DIR + sep)) return new Response(null, { status: 404 })
    return net.fetch(pathToFileURL(path).toString())
  })

  const address = serviceAddress()
  ipcMain.on('custodio:bridge', (event) => {
    event.returnValue = { platform: process.platform, service: address }
  })

  const shell = createElectronShell(showWindow, () => app.quit())
  if (address) void new StatusMonitor(address, shell).start()
  showWindow()
})

// Closing the window keeps the tray; quitting the interface never stops the service or its schedule
app.on('window-all-closed', () => undefined)
