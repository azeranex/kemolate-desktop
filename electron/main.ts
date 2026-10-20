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
 * the page is served from `dist/` at `app://kemolate/` — see `protocol.ts` for why
 * not from files.
 */
import type { WindowState } from './preload'

import { app, BrowserWindow, ipcMain, nativeTheme, shell } from 'electron'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { APP_ORIGIN, registerAppScheme, serveApp } from './protocol'

const here = path.dirname(fileURLToPath(import.meta.url))
const devUrl = process.env.KEMOLATE_DEV_URL

registerAppScheme()

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
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
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
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  win.once('ready-to-show', () => {
    win.show()
    if (smoke) {
      setTimeout(async () => {
        const image = await win.webContents.capturePage()
        writeFileSync(smoke, image.toPNG())
        app.quit()
      }, 800)
    }
  })

  if (devUrl) void win.loadURL(devUrl)
  else void win.loadURL(`${APP_ORIGIN}/index.html`)
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

// Checked, because it arrives from the page: anything but the three names is ignored.
ipcMain.on('theme:set', (_event, source: unknown) => {
  if (source === 'system' || source === 'light' || source === 'dark') nativeTheme.themeSource = source
})

void app.whenReady().then(() => {
  if (!devUrl) serveApp(path.join(here, '../dist'))
  createWindow()
  // macOS keeps the app alive with no windows; clicking the dock icon opens one.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
