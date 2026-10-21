/**
 * The main process: one window with no title bar, and the IPC behind the one
 * the page draws itself (`app/components/TitleBar.vue`).
 *
 * `titleBarStyle: 'hidden'` rather than `frame: false`. Both remove the title
 * bar, but a hidden one keeps the native frame around it — resize borders, the
 * shadow, Windows 11's rounded corners and Aero Snap — and on macOS keeps the
 * traffic lights, which the page leaves room for. With `frame: false` all of
 * that would have to be rebuilt by hand, and snapping cannot be. The page's
 * drag region (`-webkit-app-region: drag`) then behaves as a caption: drag to
 * move, double-click to maximise, drag to an edge to snap.
 *
 * In development `KEMOLATE_DEV_URL` points at Vite (see `vite.config.ts`); built,
 * the page is served from `dist/` at `https://app.kemolate.invalid/` — see `protocol.ts` for why
 * not from files.
 */

import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { app, BrowserWindow, ipcMain, nativeTheme, session, shell } from 'electron'

import { serveCuda } from './cuda'
import { serveCudaSetup } from './cudaSetup'
import { askWhereToSave } from './downloads'
import { serveKeys } from './keys'
import { opened, projectsIn, serveOpening } from './opening'
import { APP_ORIGIN, serveApp } from './protocol'
import { keepWindowPlace, windowPlace } from './windowState'

import type { WindowState } from './preload'

const here = path.dirname(fileURLToPath(import.meta.url))
const devUrl = process.env.KEMOLATE_DEV_URL

/*
 * The profile, by a name that does not change with the build. Electron names
 * it after the product, and the installer calls the product "Kemolate" where
 * `pnpm dev` and `electron .` call it "kemolate-desktop" — two folders, so an
 * installed app would open with none of the workspaces, keys, models or window
 * place a development run had kept, and the reverse. Everything the app keeps
 * lives in here (IndexedDB and OPFS are the page's storage inside it), so it is
 * set before anything reads it.
 */
app.setPath('userData', path.join(app.getPath('appData'), 'kemolate-desktop'))

/**
 * `--smoke=<file.png>`: open the window, save a capture of it and quit. A way to
 * see the real window — title bar included — without anyone looking at it.
 */
const smoke = process.argv.find((a) => a.startsWith('--smoke='))?.slice('--smoke='.length)

function stateOf (win: BrowserWindow | null): WindowState {
  return {
    maximized: win?.isMaximized() ?? false,
    fullScreen: win?.isFullScreen() ?? false,
    focused: win?.isFocused() ?? false,
  }
}

function createWindow () {
  // Where it was last time, or 1920 × 1080 the first time — see `windowState.ts`.
  const place = windowPlace()

  const win = new BrowserWindow({
    ...place.bounds,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: 'Kemolate',
    // Painted before the page is, so opening never flashes the wrong colour.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0a0a' : '#ffffff',
    titleBarStyle: 'hidden',
    // Centred in the 56px header the page draws (`TitleBar`), at the left where macOS keeps them.
    trafficLightPosition: { x: 18, y: 21 },
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })

  const send = () => win.webContents.send('window:state', stateOf(win))
  for (const event of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'focus', 'blur'] as const) {
    win.on(event as 'maximize', send)
  }

  // Links leave the app for the browser; the app never opens a second window by accident.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  // Set again rather than trusted to the constructor: with a hidden title bar
  // on Windows the constructor's size and `getNormalBounds()` disagree by the
  // invisible resize border, so a size read back and given to the next window
  // grew it a few pixels every launch. `setBounds` is the read's own inverse.
  win.setBounds(place.bounds)

  keepWindowPlace(win, place.bounds)

  win.once('ready-to-show', () => {
    // Maximised before it is shown, so it does not open small and then jump.
    if (place.maximized) win.maximize()
    if (place.fullScreen) win.setFullScreen(true)
    win.show()
    if (smoke) {
      setTimeout(async () => {
        const image = await win.webContents.capturePage()
        writeFileSync(smoke, image.toPNG())
        app.quit()
      }, 800)
    }
  })

  if (devUrl) win.loadURL(devUrl)
  else win.loadURL(`${APP_ORIGIN}/index.html`)
}

const owner = (sender: Electron.WebContents) => BrowserWindow.fromWebContents(sender)

ipcMain.handle('window:state', (event) => stateOf(owner(event.sender)))
ipcMain.on('window:minimize', (event) => owner(event.sender)?.minimize())
ipcMain.on('window:toggle-maximize', (event) => {
  const win = owner(event.sender)
  if (!win) return
  if (win.isMaximized()) win.unmaximize()
  else win.maximize()
})
ipcMain.on('window:close', (event) => owner(event.sender)?.close())

/**
 * Whether a call came from the app's own page — the origin it is served from,
 * or Vite's in development — and not from anything else a frame might load.
 * Asked by the handlers that hand back something secret (`keys.ts`).
 */
const appOrigin = devUrl ? new URL(devUrl).origin : APP_ORIGIN

function trusted (event: Electron.IpcMainInvokeEvent) {
  const url = event.senderFrame?.url

  return Boolean(url) && new URL(url!).origin === appOrigin
}

serveKeys(trusted)

// Models on an NVIDIA GPU, opt-in — see `cuda.ts`. The same store the model route serves.
serveCuda(trusted, () => path.join(app.getPath('userData'), 'models'))
serveCudaSetup(trusted)

// Checked, because it arrives from the page: anything but the three names is ignored.
ipcMain.on('theme:set', (_event, source: unknown) => {
  if (source === 'system' || source === 'light' || source === 'dark') nativeTheme.themeSource = source
})

/**
 * Whether the page may keep reading a folder it was given, across launches.
 *
 * A chapter opened from a folder is kept as a File System Access handle, and a
 * browser forgets what a handle may do when the tab closes: the next visit
 * finds the handle and is told "prompt", and the chapter waits behind a Reopen
 * button until somebody clicks it. In a browser that is the right caution —
 * any site could be holding a handle onto your folders. Here there is one
 * page, the app's own, and the reader chose the folder in a native dialog; a
 * desktop program that asked for it again on every launch would be asking a
 * question with only one answer.
 *
 * So a *check* for read access, from the app's own origin, is answered yes —
 * which is all it takes for the remembered handle to read the folder again.
 * Writing is still asked for (nothing here writes into the reader's folders),
 * and nothing else changes: every other permission is answered as Electron
 * would without a handler, which is yes, for the app's own page and no other.
 */
function keepFolderAccess () {
  session.defaultSession.setPermissionCheckHandler((_contents, permission, origin, details) => {
    const from = URL.canParse(origin) ? new URL(origin).origin : origin

    if (from !== appOrigin) return false

    if (permission === 'fileSystem') return (details as { fileAccessType?: string }).fileAccessType !== 'writable'

    return true
  })
}

/*
 * Project files from the operating system — see `opening.ts`.
 *
 * One app at a time, built: a second launch (a `.kemolate` double-clicked while
 * the app is open) hands its command line to this one and quits, rather than
 * opening a second window onto the same storage. Not in development, where the
 * dev plugin restarts Electron on every edit to the main process and a new
 * process can start before the old one has let go of the lock.
 */
if (!devUrl && !app.requestSingleInstanceLock()) app.quit()

app.on('second-instance', (_event, argv) => {
  for (const file of projectsIn(argv)) opened(file)

  const win = mainWindow()

  if (win?.isMinimized()) win.restore()
  win?.focus()
})

// macOS hands files over by event, and may do so before the app is ready.
app.on('open-file', (event, file) => {
  event.preventDefault()
  opened(file)
})

for (const file of projectsIn(process.argv)) opened(file)

const mainWindow = () => BrowserWindow.getAllWindows()[0] ?? null

serveOpening(trusted, mainWindow)

app.whenReady().then(() => {
  keepFolderAccess()
  askWhereToSave()

  // Models live with the app's profile — per user, outside the install, so an
  // update does not cost the downloads. Registered in development too, though
  // the page is Vite's there: the app's own host also serves the project files
  // the OS hands over (`/opened/…`), which the dev page fetches cross-origin.
  serveApp(path.join(here, '../dist'), path.join(app.getPath('userData'), 'models'))
  createWindow()
  // macOS keeps the app alive with no windows; clicking the dock icon opens one.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
