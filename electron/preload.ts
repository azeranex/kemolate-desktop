/**
 * The whole of what the page can ask of Electron, exposed as `window.kemolate`.
 *
 * The page runs sandboxed with context isolation, so this bridge is the only
 * door, and it stays narrow: named actions, no raw `ipcRenderer`. Anything the
 * page needs from the machine — files, models, the database — gets its own
 * method here rather than a general channel.
 */
import { contextBridge, ipcRenderer } from 'electron'

import type { Provider } from '../shared/utils/providers'
import type { IpcRendererEvent } from 'electron'

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

/** The CUDA process's settings, and what it says about itself — see `cuda.ts`. Here for the reason `KeyStatus` is. */
export interface CudaSettings {
  enabled: boolean
  /** The Python that runs it — the reader's own, with `onnxruntime-gpu` in it. */
  python: string
}

export interface CudaHello {
  ready: boolean
  python?: string
  onnxruntime?: string
  providers?: string[]
  device?: string
  error?: string
}

/** A tensor in a CUDA frame: its type and shape, and where its bytes sit in the body. */
export interface TensorSpec {
  dtype: string
  dims: number[]
  offset: number
  length: number
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
  /**
   * Project files the operating system handed the app — see `opening.ts`.
   * `pending` takes what is waiting (each fetched from the app's origin at
   * `/opened/<token>`); `onOpened` says when more arrives. Returns the unsubscribe.
   */
  files: {
    pending: (): Promise<{ token: string, name: string }[]> => ipcRenderer.invoke('files:pending'),
    onOpened: (listener: () => void) => {
      const forward = () => listener()
      ipcRenderer.on('files:opened', forward)
      return () => {
        ipcRenderer.off('files:opened', forward)
      }
    },
  },
  /**
   * Models on an NVIDIA GPU, through the reader's own Python — opt-in; see
   * `cuda.ts`. `open` names a model by its store path and answers with the
   * file it opened; `run` is one pass of it; `read` is Kemolate OCR's whole
   * reading of a batch (`kemolate_cuda.py`). Every one rejects when CUDA is off
   * or will not start, which the caller takes as "use WebGPU".
   */
  cuda: {
    settings: (): Promise<CudaSettings> => ipcRenderer.invoke('cuda:settings'),
    configure: (patch: Partial<CudaSettings>): Promise<CudaSettings> => ipcRenderer.invoke('cuda:configure', patch),
    test: (): Promise<CudaHello> => ipcRenderer.invoke('cuda:test'),
    open: (model: string): Promise<{ path: string, inputs: string[], outputs: string[] }> => ipcRenderer.invoke('cuda:open', model),
    run: (file: string, feeds: Record<string, TensorSpec>, body: Uint8Array): Promise<{ outputs: Record<string, TensorSpec>, body: Uint8Array }> =>
      ipcRenderer.invoke('cuda:run', file, feeds, body),
    read: (request: { encoder: string, decoder: string, count: number, edge: number, start: number, end: number, limit: number }, body: Uint8Array): Promise<number[][]> =>
      ipcRenderer.invoke('cuda:read', request, body),
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
