/**
 * Updates: the installed app finds, downloads and installs its next release —
 * from this repository's GitHub Releases, through `electron-updater`.
 *
 * Releases are made by `.github/workflows/release.yml`: a `v*` tag builds the
 * installer on Windows and publishes it with `latest.yml` and the blockmap,
 * which is all this reads. The repository is public, so nothing here holds a
 * token — a private one would have meant shipping a credential in every copy.
 *
 * - **Checked at launch and every few hours**, and downloaded in the
 *   background: a release is a hundred-odd megabytes, and the blockmap means
 *   only the parts that changed come down.
 * - **Never a restart the reader did not ask for.** A downloaded update is
 *   offered ("Restart to update", in the window), and otherwise installed when
 *   the app is next quit. A run in progress — a chapter being read, cleaned or
 *   translated — is never cut short by an update.
 * - **The work is safe across it.** Quitting takes a backup of the database
 *   (`database.ts`, on `will-quit`, which an update's quit also fires), and the
 *   new version backs up again before it applies any migration.
 * - **Off where it would be wrong**: in development, and on a test profile
 *   (`KEMOLATE_PROFILE`) — a test run must never replace the reader's install.
 *
 * Unsigned for now. On Windows that costs nothing here: the updater downloads
 * the installer itself, so it carries no "downloaded from the internet" mark
 * and SmartScreen does not stop it. Only a first install from the website is
 * warned about. macOS would need signing and notarisation before this works.
 */

import { app, BrowserWindow, ipcMain } from 'electron'
import updater from 'electron-updater'

import type { UpdateState } from './preload'

const { autoUpdater } = updater

/** How often a running app looks again. */
const EVERY = 4 * 60 * 60 * 1000

/** How long after launch the first look waits, so it is not competing with opening a chapter. */
const FIRST = 15 * 1000

let state: UpdateState = { status: 'off', version: app.getVersion() }

function set (next: Partial<UpdateState>) {
  state = { ...state, ...next, version: app.getVersion() }

  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('updates:changed', state)
}

/** Whether this copy of the app updates itself at all — see the header. */
export const updates = () => app.isPackaged && !process.env.KEMOLATE_PROFILE

async function check () {
  if (!updates() || state.status === 'checking' || state.status === 'downloading' || state.status === 'ready') return

  try {
    await autoUpdater.checkForUpdates()
  } catch (error) {
    set({ status: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}

export function serveUpdates (trusted: (event: Electron.IpcMainInvokeEvent) => boolean) {
  const only = <A extends unknown[], R>(handler: (...args: A) => R) => (event: Electron.IpcMainInvokeEvent, ...args: A) => {
    if (!trusted(event)) throw new Error('Not the app.')

    return handler(...args)
  }

  ipcMain.handle('updates:state', only(() => state))
  ipcMain.handle('updates:check', only(async () => {
    await check()

    return state
  }))
  // Only once one is downloaded; the window offers it only then.
  ipcMain.handle('updates:install', only(() => {
    if (state.status === 'ready') autoUpdater.quitAndInstall()
  }))

  if (!updates()) return

  set({ status: 'idle' })

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  // Its own logging goes to the console; the window hears the outcomes.
  autoUpdater.logger = console

  autoUpdater.on('checking-for-update', () => set({ status: 'checking', message: undefined }))
  autoUpdater.on('update-not-available', () => set({ status: 'none', next: undefined, percent: undefined }))
  autoUpdater.on('update-available', (info) => set({ status: 'downloading', next: info.version, percent: 0 }))
  autoUpdater.on('download-progress', (progress) => set({ status: 'downloading', percent: Math.round(progress.percent) }))
  autoUpdater.on('update-downloaded', (info) => set({ status: 'ready', next: info.version, percent: 100 }))
  autoUpdater.on('error', (error) => set({ status: 'error', message: error?.message ?? String(error) }))

  setTimeout(() => { check() }, FIRST).unref()
  setInterval(() => { check() }, EVERY).unref()
}
