/**
 * The splash an update is installed behind, as Discord's — desktop.
 *
 * A downloaded update used to be installed by the window vanishing and, some
 * seconds later, a new one appearing: the installer runs silently
 * (`updates.ts`), so Kemolate looked like it had crashed. Now (2026-10-28):
 *
 * 1. **This version's splash** (`showSplash`) replaces the window from the
 *    press of "Restart to update" until the app quits for the installer, and
 *    leaves `updating.json` behind (`leaveForNext`).
 * 2. The installer replaces the files — a few seconds with nothing on screen.
 * 3. **The new version's splash** (`splashAfterUpdate`, at launch), when the
 *    marker is there: "Updated to …", until the window is ready to show
 *    (`closeLaunchSplash`).
 *
 * Step 2 is not covered. Nothing from the install folder may run while the
 * installer replaces it, and a stand-in from outside it — a PowerShell window
 * started hidden through a script host — was tried and dropped: PowerShell
 * will not run detached without a console, and the way round that is the very
 * pattern antivirus programs flag. The installer's own window is the honest
 * cover for it, if it is wanted: `nsis.oneClick` shows a small progress
 * window and asks nothing.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { app, BrowserWindow } from 'electron'

const WIDTH = 300
const HEIGHT = 320

/** The mark (`Logo.vue`), in the dark theme's colours. */
const MARK = `<svg width="96" height="96" viewBox="0 0 96 96" aria-hidden="true">
  <circle cx="22" cy="14" r="9" fill="#7ccf00"/><circle cx="74" cy="14" r="9" fill="#7ccf00"/>
  <path d="M26 16 H70 A18 18 0 0 1 88 34 V52 A18 18 0 0 1 70 70 H44 L24 88 L31 70 H26 A18 18 0 0 1 8 52 V34 A18 18 0 0 1 26 16 Z" fill="#7ccf00"/>
  <path d="M42 17 V26 M48 17 V30 M54 17 V26" stroke="#171717" stroke-width="4.5" stroke-linecap="round"/>
  <circle cx="33" cy="41" r="4.5" fill="#171717"/><circle cx="63" cy="41" r="4.5" fill="#171717"/>
  <path d="M44 47 L52 47 L48 52 Z" fill="#171717"/>
  <path d="M38 52 Q43 59 48 53 Q53 59 58 52" fill="none" stroke="#171717" stroke-width="4" stroke-linecap="round"/>
</svg>`

const PAGE = `<!doctype html><meta charset="utf-8"><style>
  html, body { margin: 0; height: 100%; background: #171717; color: #fafafa; overflow: hidden; user-select: none; cursor: default;
    font: 13px/1.4 "Segoe UI", system-ui, sans-serif; -webkit-app-region: drag }
  main { height: 100%; display: flex; flex-direction: column; align-items: center; padding-top: 64px; box-sizing: border-box }
  #title { margin-top: 28px; font-size: 15px; font-weight: 600 }
  #detail { margin-top: 4px; color: #a1a1a1 }
  #track { position: absolute; left: 50px; top: 268px; width: 200px; height: 4px; border-radius: 2px; background: #2a2a2a; overflow: hidden }
  #run { position: absolute; top: 0; height: 100%; width: 30%; border-radius: 2px; background: #7ccf00; animation: run 1.2s linear infinite }
  @keyframes run { from { left: -30% } to { left: 100% } }
</style><main>${MARK}<div id="title"></div><div id="detail"></div></main><div id="track"><div id="run"></div></div>`

export interface Splash {
  window: BrowserWindow
  close: () => void
}

/** A splash, centred, showing `title` and `detail` — resolved once it is on screen. */
export function showSplash (title: string, detail = ''): Promise<Splash> {
  const window = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    center: true,
    title: 'Kemolate',
    backgroundColor: '#171717',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })

  return new Promise((resolve) => {
    // Shown once the words are in, so it never appears blank.
    window.webContents.once('did-finish-load', async () => {
      await window.webContents.executeJavaScript(`document.getElementById('title').textContent = ${JSON.stringify(title)};
        document.getElementById('detail').textContent = ${JSON.stringify(detail)}`).catch(() => {})
      window.show()
      resolve({ window, close: () => { if (!window.isDestroyed()) window.destroy() } })
    })
    window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`)
  })
}

/** What the version being replaced leaves for the next: that it was an update, and from which. */
const marker = () => path.join(app.getPath('userData'), 'updating.json')

/** Say to the next launch that it is the end of an update — see the header, step 1. */
export function leaveForNext (next: string): void {
  writeFileSync(marker(), JSON.stringify({ from: app.getVersion(), to: next, at: Date.now() }))
}

let launchSplash: Splash | null = null

/** At launch, straight after an update: the splash, until `closeLaunchSplash`. See the header, step 3. */
export async function splashAfterUpdate (): Promise<void> {
  if (!existsSync(marker())) return

  let from = ''

  try {
    from = JSON.parse(readFileSync(marker(), 'utf8')).from ?? ''
  } catch {
    // Unreadable: still the end of an update.
  }

  rmSync(marker(), { force: true })

  // The same version as before means the install did not take; say only that it is starting.
  launchSplash = await showSplash(from === app.getVersion() ? 'Kemolate' : `Updated to ${app.getVersion()}`, 'Starting…')
}

/** The window is ready: the launch's splash, if any, goes. */
export function closeLaunchSplash (): void {
  launchSplash?.close()
  launchSplash = null
}
