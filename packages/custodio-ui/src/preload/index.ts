import { contextBridge, ipcRenderer } from 'electron'

// Only the service's loopback address and token reach the renderer, plus Windows' folder picker; it has no other way out
contextBridge.exposeInMainWorld('custodio', {
  ...(ipcRenderer.sendSync('custodio:bridge') as Record<string, unknown>),
  chooseFolder: (): Promise<string | null> => ipcRenderer.invoke('custodio:choose-folder') as Promise<string | null>,
  openLogs: (): Promise<void> => ipcRenderer.invoke('custodio:open-logs') as Promise<void>
})
