/**
 * The whole of what the page can ask of Electron, exposed as `window.kemolate`.
 *
 * The page runs sandboxed with context isolation, so this bridge is the only
 * door, and it stays narrow: named actions, no raw `ipcRenderer`. Anything the
 * page needs from the machine — files, models, the database — gets its own
 * method here rather than a general channel.
 */
import type { IpcRendererEvent } from 'electron'

import { contextBridge, ipcRenderer } from 'electron'

export interface WindowState {
  maximized: boolean
  fullScreen: boolean
  focused: boolean
}

export type ThemeSource = 'system' | 'light' | 'dark'

const api = {
  platform: process.platform,
  theme: {
    /** The page's colour-scheme choice, for the parts of the window Electron draws itself. */
    set: (source: ThemeSource) => ipcRenderer.send('theme:set', source),
  },
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
    close: () => ipcRenderer.send('window:close'),
    state: (): Promise<WindowState> => ipcRenderer.invoke('window:state'),
    /** Called whenever the window is maximised, restored, focused or blurred. Returns the unsubscribe. */
    onState: (listener: (state: WindowState) => void) => {
      const forward = (_event: IpcRendererEvent, state: WindowState) => listener(state)
      ipcRenderer.on('window:state', forward)
      return () => {
        ipcRenderer.off('window:state', forward)
      }
    },
  },
}

export type KemolateApi = typeof api

contextBridge.exposeInMainWorld('kemolate', api)
