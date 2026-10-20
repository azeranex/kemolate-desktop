/**
 * The whole of what the page can ask of Electron, exposed as `window.kemolate`.
 *
 * The page runs sandboxed with context isolation, so this bridge is the only
 * door, and it stays narrow: named actions, no raw `ipcRenderer`. Anything the
 * page needs from the machine — files, models, the database — gets its own
 * method here rather than a general channel.
 */
import type { IpcRendererEvent } from 'electron'

import type { Provider } from '../shared/utils/providers'

import { contextBridge, ipcRenderer } from 'electron'

/**
 * What the settings page is told about the keys (`keys.ts`): which are stored,
 * by what each ends in, and whether any can be. Here rather than in `keys.ts`
 * because the renderer's types reach this file, and that one is main-process
 * code.
 */
export interface KeyStatus {
  /** False where the OS offers no real encryption — nothing can be saved, and the page says why. */
  available: boolean
  /** Why not, when `available` is false. */
  reason: string | null
  keys: { provider: Provider, hint: string }[]
}

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
  /**
   * The reader's provider keys, kept encrypted by the OS — see `keys.ts`.
   * `status` says what is stored by what each key ends in; `get` hands one key
   * back for a run to spend; `save` takes the web build's patch (absent: left
   * alone, empty: removed) and answers with the new status.
   */
  keys: {
    status: (): Promise<KeyStatus> => ipcRenderer.invoke('keys:status'),
    get: (provider: Provider): Promise<string | null> => ipcRenderer.invoke('keys:get', provider),
    save: (patch: Partial<Record<Provider, string>>): Promise<KeyStatus> => ipcRenderer.invoke('keys:save', patch),
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
