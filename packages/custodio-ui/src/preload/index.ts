import { contextBridge, ipcRenderer } from 'electron'

// Only the service's loopback address and token reach the renderer; it has no other way out
contextBridge.exposeInMainWorld('custodio', ipcRenderer.sendSync('custodio:bridge') as unknown)
