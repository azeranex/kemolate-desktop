/**
 * Project files the operating system hands the app — a `.kemolate` double-
 * clicked, dropped on the app's icon, or named on the command line.
 *
 * The web build has one road for a project file that is not opened from inside
 * a workspace: dropped on the workspace list, it gets a workspace of its own
 * (`useProjectFile.handOver`). A file from the OS is that drop, arriving from
 * outside, and goes the same way — always a *new* workspace, never the one on
 * screen, because opening a project replaces a chapter and a double-click is not
 * a reader choosing to replace this one.
 *
 * ## How the bytes reach the page
 *
 * Not through IPC. A project carries its scans and runs to hundreds of
 * megabytes, which would be copied whole into a message. Instead each file is
 * given a one-time token and the page fetches it from the app's own origin,
 * `https://app.kemolate.invalid/opened/<token>`, served from disk here
 * (`openedFile`). A token names one file the OS handed over, is unguessable,
 * and is spent once read — the route can serve nothing else.
 *
 * ## When
 *
 * A file can arrive before the page exists (the launch that opened it) or long
 * after (a second launch, which the single-instance lock turns into a message
 * to this one). Both are queued here: the page asks for what is waiting once it
 * is up (`files:pending`), and is told about anything that arrives later
 * (`files:opened`).
 */

import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { ipcMain, net } from 'electron'

import type { BrowserWindow } from 'electron'

export const PROJECT_EXTENSION = '.kemolate'

/** One file handed over: the token the page fetches it by, and what it is called. */
export interface OpenedFile {
  token: string
  name: string
}

/** Files not yet taken by the page. */
const waiting: OpenedFile[] = []

/** Every token handed out and not yet read, to the path it serves. */
const served = new Map<string, string>()

let window: () => BrowserWindow | null = () => null

/** The project files named in a command line — a launch's, or a second launch's. */
export function projectsIn (argv: readonly string[]): string[] {
  return argv.filter((arg) => !arg.startsWith('-')
    && path.extname(arg).toLowerCase() === PROJECT_EXTENSION
    && existsSync(arg) && statSync(arg).isFile())
}

/** Queue a file the OS handed over, and tell the page if it is up. */
export function opened (file: string) {
  const entry = { token: randomUUID(), name: path.basename(file) }

  served.set(entry.token, path.resolve(file))
  waiting.push(entry)

  const win = window()

  if (!win || win.isDestroyed()) return

  win.webContents.send('files:opened')

  // Brought forward, as any program does when it is asked to open something.
  if (win.isMinimized()) win.restore()
  win.focus()
}

/**
 * Wire up the page's half. `trusted` says whether a call came from the app's
 * own page; `current` finds the window to tell.
 */
export function serveOpening (trusted: (event: Electron.IpcMainInvokeEvent) => boolean, current: () => BrowserWindow | null) {
  window = current

  ipcMain.handle('files:pending', (event) => {
    if (!trusted(event)) throw new Error('Not the app.')

    return waiting.splice(0)
  })
}

/**
 * The response for `/opened/<token>`, or null for a token that names nothing.
 * Spent as it is read: a token is one delivery of one file.
 */
export async function openedFile (token: string): Promise<Response | null> {
  const file = served.get(token)

  if (!file) return null

  served.delete(token)

  return net.fetch(pathToFileURL(file).toString()).catch(() => null)
}
