import { contextBridge } from 'electron'

// The renderer talks to the service over HTTP; the bridge only carries what the shell knows
contextBridge.exposeInMainWorld('custodio', { platform: process.platform })
