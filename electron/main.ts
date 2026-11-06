/**
 * The main process: one window with no title bar, its tabs (`tabs.ts`), and the
 * IPC behind the title bar each tab's page draws itself
 * (`app/components/TitleBar.vue`).
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
import { release } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { app, BrowserWindow, dialog, ipcMain, nativeTheme, session, shell } from 'electron'

import { serveCuda } from './cuda'
import { serveCudaSetup } from './cudaSetup'
import { closeDatabase, openDatabase } from './database'
import { askWhereToSave } from './downloads'
import { serveKeys } from './keys'
import { serveLlama } from './llama'
import { hasWaiting, opened, projectsIn, serveOpening } from './opening'
import { APP_ORIGIN, serveApp } from './protocol'
import { closeLaunchSplash, splashAfterUpdate } from './splash'
import { serveTabs, Tabs, TRAFFIC_LIGHTS } from './tabs'
import { serveUpdates } from './updates'
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
 *
 * `KEMOLATE_PROFILE` puts a run on a profile of its own — for tests, which must
 * never open the reader's. On 2026-10-21 test runs driven against the real
 * profile, from a sandbox that kept their writes to itself but let their deletes
 * through, left its IndexedDB corrupt; Chromium answers a corrupt IndexedDB by
 * deleting it and starting empty, and a reader's workspace went with it. A test
 * that needs the reader's models can link `<profile>/models` to the real store.
 */
app.setPath('userData', process.env.KEMOLATE_PROFILE || path.join(app.getPath('appData'), 'kemolate-desktop'))

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

/**
 * What to forget when a tab's page goes — a reload, a navigation, the tab or
 * the window closing. Today the MCP server's note of which scans that tab holds
 * (`mcp.ts`): a page that is gone can show nobody anything, and an errand sent
 * to it would only wait out its timeout.
 */
const leaving: ((tab: number) => void)[] = []

/** And what to tell when another tab comes on screen — the MCP server's "open chapter". */
const focusing: ((tab: number | null) => void)[] = []

/** The window's tabs — see `tabs.ts`. Null until the window is made. */
let tabs: Tabs | null = null

/**
 * Windows 11's Mica behind the tab rail — from 22H2 (build 22621), the first
 * whose DWM takes the backdrop Electron asks for; before it the request does
 * nothing and a transparent window is just black. The window is transparent
 * under it, and so is every tab's view (`Tabs.open`); the page lets the
 * backdrop through the rail alone (`html.mica` in `tailwind.css`), told by the
 * argument below.
 */
const mica = process.platform === 'win32' && Number(release().split('.')[2] ?? 0) >= 22621

const webPreferences: Electron.WebPreferences = {
  preload: path.join(here, 'preload.cjs'),
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  additionalArguments: mica ? ['--kemolate-mica'] : [],
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
    // Painted before the page is, so opening never flashes the wrong colour —
    // or nothing, over Mica, which the window is not shown before a page paints over.
    backgroundColor: mica ? '#00000000' : nativeTheme.shouldUseDarkColors ? '#0a0a0a' : '#ffffff',
    ...(mica ? { backgroundMaterial: 'mica' as const } : {}),
    titleBarStyle: 'hidden',
    // Centred in the tab strip the page draws (`TabStrip`), at the left where macOS keeps them.
    trafficLightPosition: TRAFFIC_LIGHTS,
    webPreferences,
  })

  const send = () => {
    for (const contents of tabs?.pages() ?? []) contents.send('window:state', stateOf(win))
  }
  for (const event of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'focus', 'blur'] as const) {
    win.on(event as 'maximize', send)
  }

  tabs = new Tabs(win, {
    webPreferences,
    trusted,
    load: (contents) => {
      if (devUrl) contents.loadURL(devUrl)
      else contents.loadURL(`${APP_ORIGIN}/index.html`)
    },
    // Links leave the app for the browser; the app never opens a second window by accident.
    // A link to the app's own page is not a link out: a workspace middle-clicked
    // (or ctrl-clicked) in the list went to the browser, which cannot open it.
    // It opens in a tab, as a browser opens a link in one — behind, unless the
    // gesture asked for the foreground — and a chapter already in a tab is that tab.
    dress: (contents) => {
      contents.setWindowOpenHandler(({ url, disposition }) => {
        const own = URL.parse(url)

        if (own?.origin === appOrigin) {
          const chapter = /^\/w\/([^/]+)$/.exec(own.pathname)?.[1]

          if (chapter) tabs?.reveal(decodeURIComponent(chapter), disposition === 'foreground-tab')
        } else if (/^https?:\/\//.test(url)) {
          shell.openExternal(url)
        }

        return { action: 'deny' }
      })
    },
    leaving: (tab) => {
      for (const forget of leaving) forget(tab)
    },
    focused: (tab) => {
      for (const tell of focusing) tell(tab)
    },
  })

  // Set again rather than trusted to the constructor: with a hidden title bar
  // on Windows the constructor's size and `getNormalBounds()` disagree by the
  // invisible resize border, so a size read back and given to the next window
  // grew it a few pixels every launch. `setBounds` is the read's own inverse.
  win.setBounds(place.bounds)

  keepWindowPlace(win, place.bounds)

  win.on('closed', () => {
    tabs = null
    for (const tell of focusing) tell(null)
  })

  // The tabs that were open, and one for any project file handed over on the way in.
  tabs.begin(hasWaiting())

  // Shown once the tab on screen has loaded, so opening never flashes an empty
  // window — or after a few seconds regardless, so a page that will not load is
  // a window that says so rather than none at all.
  let shown = false
  const show = () => {
    if (shown || win.isDestroyed()) return
    shown = true
    // Maximised before it is shown, so it does not open small and then jump.
    if (place.maximized) win.maximize()
    if (place.fullScreen) win.setFullScreen(true)
    win.show()
    // The end of an update: the splash it was installed behind goes now — see `splash.ts`.
    closeLaunchSplash()
    tabs?.current()?.view.webContents.focus()
    if (smoke) {
      setTimeout(async () => {
        const image = await tabs!.current()!.view.webContents.capturePage()
        writeFileSync(smoke, image.toPNG())
        app.quit()
      }, 1500)
    }
  }

  tabs.current()?.view.webContents.once('did-finish-load', show)
  setTimeout(show, 5000)
}

/** The window a page's call is about: its own, or — for a tab, which is a view in it — the one window. */
const owner = (sender: Electron.WebContents) =>
  BrowserWindow.fromWebContents(sender) ?? (tabs?.owns(sender) ? mainWindow() : null)

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
serveLlama(trusted)

// The app's own updates, from this repository's GitHub Releases — see `updates.ts`.
serveUpdates(trusted)

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
 * One window per profile, always — and project files from the operating system
 * (see `opening.ts`).
 *
 * A second launch (a `.kemolate` double-clicked while the app is open) hands its
 * command line to this one and quits, rather than opening a second window onto
 * the same storage. Chromium's lock is per profile folder, so this is also what
 * keeps two processes off one workspace database: nothing tells one window
 * about another's edits (the swarm's change notices are a stand-in here), and
 * each would write what it last loaded back over the other's newer work.
 *
 * Development too, since 2026-10-21. It was skipped there, for fear a restart
 * would start the new process before the old one let go — but the dev plugin
 * waits for the old one to exit (`vite.config.ts`) — and skipping it let
 * `pnpm dev` and the installed app run on the same profile at once. In
 * development a refusal is retried for a moment, for whatever the last process
 * takes to let go, and then said in the terminal rather than in a dialog.
 */
async function oneWindow (): Promise<boolean> {
  if (app.requestSingleInstanceLock()) return true
  if (!devUrl) return false

  for (let tries = 0; tries < 10; tries++) {
    await new Promise((resolve) => setTimeout(resolve, 300))

    if (app.requestSingleInstanceLock()) return true
  }

  console.error(`[kemolate] Kemolate is already open on this profile (${app.getPath('userData')}) — close it, or run on another with KEMOLATE_PROFILE.`)

  return false
}

/*
 * And stop here. `app.exit` does not end this module: the rest of it can go
 * on running, and in development — ready by then, after the retries — the
 * `whenReady` below would fire at once, and a refused second process would
 * check, migrate and back up the database the first one has open (found
 * 2026-10-28, chasing a damaged database). Nothing past this line may run in it.
 */
if (!await oneWindow()) {
  app.exit(0)
  await new Promise(() => {})
}

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

// A project file handed over later opens in a tab of its own — see `opening.ts`.
serveOpening(trusted, mainWindow, () => { tabs?.open({ start: null, files: true }) })

serveTabs(() => tabs, trusted)

/**
 * The workspace database, before the window that reads it — see `database.ts`.
 * `data.ts` is imported only once the file is open and checked: it reaches the
 * services, which open the database the moment they load. A database that will
 * not open is said, not hidden; the app still starts, and a workspace then
 * answers that its record could not be read.
 */
async function startDatabase () {
  try {
    await openDatabase()

    const { serveData } = await import('./data')

    serveData(trusted)

    // The MCP server, on the loopback if the reader turned it on — see `mcp.ts`.
    // Its tools call the toolkit's globals as they load, so those come first.
    const { installMcpGlobals } = await import('~~/server/utils/mcpToolkit')

    installMcpGlobals()

    const { closeMcp, opensTabs, serveMcp, tabFocused, tabLeft } = await import('./mcp')

    await serveMcp(trusted, mainWindow)

    // The same tools for the window's own assistant, in memory — see `assistant.ts`.
    const { serveAssistant } = await import('./assistant')

    serveAssistant(trusted)
    leaving.push(tabLeft)
    focusing.push(tabFocused)
    opensTabs((publicId, show) => tabs?.reveal(publicId, show) ?? null)
    app.on('will-quit', () => {
      closeMcp().catch(() => {})
    })
  } catch (error) {
    console.error('[database] could not open', error)
    dialog.showErrorBox('Kemolate could not open its database', `Your workspaces' work could not be read: ${error instanceof Error ? error.message : String(error)}

Nothing has been deleted.`)
  }
}

// A last backup of anything changed since the previous one.
app.on('will-quit', closeDatabase)

app.whenReady().then(async () => {
  // Straight after an update, the splash it was installed behind stays up until the window is ready.
  await splashAfterUpdate()
  await startDatabase()
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
