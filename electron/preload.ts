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

/** The app's own CUDA environment — see `cudaSetup.ts`. */
export interface CudaManaged {
  /** Whether this machine is one the setup is for (Windows on x64). */
  supported: boolean
  /** The NVIDIA card here, by name, or null where there is none. */
  gpu: string | null
  /** Whether the app's own Python is set up. */
  installed: boolean
  /** What the folder takes on disk. */
  bytes: number
  /** That Python's path, for the advanced field. */
  python: string
}

/** One line of the setup's progress. `done`/`total` where there is a count of bytes. */
export interface CudaProgress {
  step: 'uv' | 'python' | 'packages' | 'test' | 'done'
  message: string
  done?: number
  total?: number
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

/** A request for workspace data, as the window's `$fetch` sends it — see `data.ts`. */
export interface DataRequest {
  method: string
  path: string
  query?: Record<string, unknown>
  /** JSON-shaped, or bytes for a repair. */
  body?: unknown
}

export type DataAnswer =
  | { ok: unknown }
  | { bytes: Uint8Array }
  | { error: { status: number, message: string, data?: unknown } }

/** One backup of the workspace database — see `database.ts`. */
export interface Backup {
  name: string
  /** Epoch milliseconds, from the name — what the reader is shown. */
  at: number
  bytes: number
}

/**
 * Where the app's own update stands — see `updates.ts`. `off` in development
 * and on a test profile; `ready` once a downloaded release waits for a restart.
 */
export interface UpdateState {
  status: 'off' | 'idle' | 'checking' | 'none' | 'downloading' | 'ready' | 'error'
  /** The version running now. */
  version: string
  /** The release on its way, or waiting. */
  next?: string
  /** How much of it has come down, 0–100. */
  percent?: number
  message?: string
}

/** The MCP server, as Settings shows it — see `mcp.ts`. */
export interface McpStatus {
  enabled: boolean
  port: number
  /** Whether it is actually listening — false while off, or when the port was taken. */
  listening: boolean
  /** Why it is not listening when it should be. */
  error: string | null
  /** The address a client is given. */
  url: string
  /** Whether this copy carries the Claude Desktop bundle (`kemolate.mcpb`). */
  bundle: boolean
}

/** What happened while opening, for the window to say. */
export interface DataNotice {
  /** The damaged file, moved aside. */
  quarantined?: string
  /** The backup put in its place — or the one the reader chose. */
  restoredFrom?: string
  /** The reader asked for this restore (`restoreAtLaunch`). */
  chosen?: boolean
  /** Damaged, and no backup could replace it: a new, empty database was started. */
  startedEmpty?: boolean
}

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
   * The workspace database, in the main process — see `data.ts` and
   * `database.ts`. `call` is what the window's `$fetch` sends: the web build's
   * method and path, answered by the same services. The rest are the backups,
   * for Settings → Your data; `restore` relaunches the app.
   */
  /**
   * The app's own updates — see `updates.ts`. `install` restarts into the
   * downloaded release; `onChanged` hears every step. Returns the unsubscribe.
   */
  updates: {
    state: (): Promise<UpdateState> => ipcRenderer.invoke('updates:state'),
    check: (): Promise<UpdateState> => ipcRenderer.invoke('updates:check'),
    install: (): Promise<void> => ipcRenderer.invoke('updates:install'),
    onChanged: (listener: (state: UpdateState) => void) => {
      const forward = (_event: IpcRendererEvent, state: UpdateState) => listener(state)
      ipcRenderer.on('updates:changed', forward)
      return () => {
        ipcRenderer.off('updates:changed', forward)
      }
    },
  },
  data: {
    call: (request: DataRequest): Promise<DataAnswer> => ipcRenderer.invoke('data:call', request),
    /** What opening the database found — a damaged file moved aside, a backup restored. */
    notice: (): Promise<DataNotice> => ipcRenderer.invoke('data:notice'),
    about: (): Promise<{ file: string, folder: string, backups: Backup[] }> => ipcRenderer.invoke('data:about'),
    backup: (): Promise<Backup> => ipcRenderer.invoke('data:backup'),
    openBackups: (): Promise<void> => ipcRenderer.invoke('data:open-backups'),
    restore: (name: string): Promise<void> => ipcRenderer.invoke('data:restore', name),
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
    /** The app's own CUDA environment: whether there is a card for it, and whether it is set up — see `cudaSetup.ts`. */
    managed: (): Promise<CudaManaged> => ipcRenderer.invoke('cuda:managed'),
    /** Set it up, start to finish, and answer with the Test it ends on. */
    setup: (): Promise<CudaHello> => ipcRenderer.invoke('cuda:setup'),
    cancel: (): Promise<void> => ipcRenderer.invoke('cuda:cancel'),
    remove: (): Promise<void> => ipcRenderer.invoke('cuda:remove'),
    /** Each step of a setup as it goes. Returns the unsubscribe. */
    onProgress: (listener: (progress: CudaProgress) => void) => {
      const forward = (_event: IpcRendererEvent, progress: CudaProgress) => listener(progress)
      ipcRenderer.on('cuda:progress', forward)
      return () => {
        ipcRenderer.off('cuda:progress', forward)
      }
    },
  },
  /**
   * The MCP server, for an agent on this machine — see `mcp.ts`. `status`,
   * `set`, `addToClaude` and `showBundle` are Settings'; `have` is the workspace page saying which scans it holds and which page
   * is on screen, and
   * `onFrame` hears an agent's ask for one — a frame of the web build's swarm
   * protocol, with the workspace it was asked under. Returns the unsubscribe.
   */
  mcp: {
    status: (): Promise<McpStatus> => ipcRenderer.invoke('mcp:status'),
    set: (patch: { enabled?: boolean, port?: number }): Promise<McpStatus> => ipcRenderer.invoke('mcp:set', patch),
    /** Opens the bundle in Claude Desktop; answers why not, or null. */
    addToClaude: (): Promise<string | null> => ipcRenderer.invoke('mcp:add-to-claude'),
    showBundle: (): Promise<void> => ipcRenderer.invoke('mcp:show-bundle'),
    have: (workspace: string | null, hashes: string[], pageId: number | null = null): Promise<void> => ipcRenderer.invoke('mcp:have', { workspace, hashes, pageId }),
    onFrame: (listener: (workspace: string, frame: string) => void) => {
      const forward = (_event: IpcRendererEvent, workspace: string, frame: string) => listener(workspace, frame)
      ipcRenderer.on('mcp:frame', forward)
      return () => {
        ipcRenderer.off('mcp:frame', forward)
      }
    },
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
