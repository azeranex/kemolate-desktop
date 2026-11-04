/**
 * Tabs: several chapters open at once in the one window — and so in reach of an
 * agent at once, which is what they are for.
 *
 * ## A tab is the whole app
 *
 * Each tab is a `WebContentsView` loading the app's page exactly as the window
 * used to: its own collection, workspace, Settings. Nothing in the page knows
 * it is one of several except the strip it draws (`TabStrip.vue`) and the
 * bridge's `tabs` door. The other way — one page drawing several chapters —
 * would mean every `useState` in the app keyed by chapter, and the app is built
 * around "the chapter open here" (`useComic`, `useRoute().params.workspaceId`).
 * The price is memory: each tab loads its own models. That is the cost of a tab
 * kept, said in Settings' wording rather than hidden.
 *
 * Only the tab on screen is visible; the others are hidden with `setVisible`,
 * not detached, and run unthrottled (`backgroundThrottling: false`). Measured
 * 2026-10-30 with the hidden-tab probe: a hidden tab draws one frame a second
 * and keeps its timers, and answers every errand an agent sends — a page shown,
 * a page read, a line measured, a balloon cleaned — in the time a visible one
 * does. Nothing an errand does waits for a frame.
 *
 * ## One tab per chapter
 *
 * A chapter is open in one tab at most (`tabs:claim`): choosing one that is
 * open in another tab goes to that tab instead. Two tabs on one chapter would be
 * two pages writing the same rows with nothing telling either about the other's
 * edits — the swarm's change notices are only an agent's — and each would write
 * back what it last loaded over the other's newer work. The same reason the app
 * keeps one window per profile (`main.ts`).
 *
 * ## What is kept
 *
 * `tabs.json` in the profile: each tab's chapter (or the list), and which was on
 * screen. A launch opens them again, chapters and all, as a desktop program
 * comes back to the documents that were open.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { app, ipcMain, Menu, WebContentsView } from 'electron'
import { z } from 'zod'

import type { TabHello, TabInfo, TabsState } from './preload'
import type { BrowserWindow, IpcMainInvokeEvent, WebContents } from 'electron'

interface Tab extends TabInfo {
  view: WebContentsView
  /** Where it was told to land; spent on the first hello. */
  start: string | null | undefined
  /** Whether its page has said hello since the tab was made — a later one is a reload. */
  greeted: boolean
  files: boolean
}

/** A launch's tabs, as they were left. */
const keptSchema = z.object({
  tabs: z.array(z.object({ workspace: z.string().max(200).nullable() })).max(50),
  active: z.number().int().min(0).catch(0),
})

type Kept = z.infer<typeof keptSchema>

const file = () => path.join(app.getPath('userData'), 'tabs.json')

function load (): Kept | null {
  try {
    if (existsSync(file())) return keptSchema.parse(JSON.parse(readFileSync(file(), 'utf8')))
  } catch (error) {
    console.warn('[tabs] tabs.json unreadable, opening one tab', error)
  }

  return null
}

/** Written beside and moved into place, so a crash mid-write leaves the old file whole. */
function store (kept: Kept) {
  const temporary = `${file()}.tmp`

  writeFileSync(temporary, JSON.stringify(kept, null, 2))
  renameSync(temporary, file())
}

/**
 * Where macOS keeps its traffic lights: centred in the 40px strip the page
 * draws at the top of the window (`TabStrip`), which is always there.
 */
export const TRAFFIC_LIGHTS = { x: 18, y: 13 }

/** What a tab is called before its page says. */
const UNNAMED = 'Kemolate'

const LIST = 'Workspaces'

export interface TabsOptions {
  /** Where every tab's page comes from. */
  load: (contents: WebContents) => void
  /** The `webPreferences` every tab's page is made with — the window's own. */
  webPreferences: Electron.WebPreferences
  /** The app's own page, and not anything a frame might load. */
  trusted: (event: IpcMainInvokeEvent) => boolean
  /** A tab's page is going: a reload, a navigation, the tab closed. */
  leaving: (tab: number) => void
  /** The tab on screen changed. */
  focused: (tab: number | null) => void
  /** Set up a tab's page as the window's own was — links, window state. */
  dress: (contents: WebContents) => void
}

export class Tabs {
  private list: Tab[] = []
  private active: number | null = null
  private saving: ReturnType<typeof setTimeout> | null = null

  constructor (private readonly win: BrowserWindow, private readonly options: TabsOptions) {
    win.on('resize', () => this.fit())
    win.on('focus', () => this.current()?.view.webContents.focus())
    win.on('closed', () => {
      this.flush()
      for (const tab of this.list) options.leaving(tab.id)
      this.list = []
    })
  }

  /** The tabs a launch begins with: those kept, then one for handed-over files. */
  begin (files: boolean) {
    const kept = load()
    const chapters = kept?.tabs ?? []

    for (const entry of chapters) this.open({ start: entry.workspace, focus: false })

    if (!chapters.length && !files) this.open({ start: undefined, focus: false })

    if (files) this.open({ start: null, files: true, focus: true })
    else this.select(this.list[Math.min(kept?.active ?? 0, this.list.length - 1)]!.id)
  }

  /** Every page, for a word said to all of them. */
  pages (): WebContents[] {
    return this.list.map((tab) => tab.view.webContents).filter((contents) => !contents.isDestroyed())
  }

  /** The tab on screen. */
  current (): Tab | undefined {
    return this.list.find((tab) => tab.id === this.active)
  }

  /** Whether a page is one of these tabs. */
  owns (contents: WebContents): boolean {
    return this.list.some((tab) => tab.view.webContents === contents)
  }

  state (): TabsState {
    return { tabs: this.list.map(({ id, title, workspace }) => ({ id, title, workspace })), active: this.active }
  }

  /** A new tab — at the end, or right after `after` — on screen unless told otherwise. */
  open ({ start, files = false, focus = true, after }: { start: string | null | undefined, files?: boolean, focus?: boolean, after?: number }): Tab {
    const view = new WebContentsView({
      webPreferences: { ...this.options.webPreferences, backgroundThrottling: false },
    })
    const contents = view.webContents

    // Clear, so the window's own background shows until the page paints — and
    // Mica, where the window has it, through the rail (`mica` in `main.ts`).
    view.setBackgroundColor('#00000000')
    const tab: Tab = {
      id: contents.id,
      view,
      title: start === null ? LIST : UNNAMED,
      workspace: start ?? null,
      start,
      greeted: false,
      files,
    }

    const at = after === undefined ? -1 : this.list.findIndex((each) => each.id === after)

    if (at < 0) this.list.push(tab)
    else this.list.splice(at + 1, 0, tab)
    view.setVisible(false)
    this.win.contentView.addChildView(view)
    this.fit()

    this.options.dress(contents)
    this.keys(contents)

    contents.on('did-start-navigation', (event) => {
      if (event.isMainFrame && !event.isSameDocument) this.options.leaving(tab.id)
    })
    contents.on('render-process-gone', () => this.options.leaving(tab.id))

    this.options.load(contents)

    if (focus) this.select(tab.id)
    else this.changed()

    return tab
  }

  /** Put a tab on screen, and its page under the keyboard. */
  select (id: number) {
    const tab = this.list.find((each) => each.id === id)

    if (!tab) return

    this.active = id

    for (const each of this.list) each.view.setVisible(each.id === id)

    if (this.win.isFocused()) tab.view.webContents.focus()

    this.options.focused(id)
    this.changed()
  }

  /** Close a tab — never the last, which is the window's to close. */
  close (id: number) {
    if (this.list.length <= 1) return

    const at = this.list.findIndex((tab) => tab.id === id)

    if (at < 0) return

    const [tab] = this.list.splice(at, 1)

    this.win.contentView.removeChildView(tab!.view)
    this.options.leaving(tab!.id)
    tab!.view.webContents.close()

    // The neighbour that takes its place, as a browser does: the one after, or the one before.
    if (this.active === id) this.select(this.list[Math.min(at, this.list.length - 1)]!.id)
    else this.changed()
  }

  /** Every tab but one, which is put on screen first so no other is shown on the way. */
  closeOthers (id: number) {
    if (!this.list.some((tab) => tab.id === id)) return

    this.select(id)

    for (const tab of this.list.filter((each) => each.id !== id)) this.close(tab.id)
  }

  /** Every tab after one. If the one on screen is among them, the one kept takes its place. */
  closeRight (id: number) {
    const at = this.list.findIndex((tab) => tab.id === id)

    if (at < 0) return

    const going = this.list.slice(at + 1)

    if (going.some((tab) => tab.id === this.active)) this.select(id)

    for (const tab of going) this.close(tab.id)
  }

  /**
   * A tab's right-click menu — a native one, not drawn by the page: the page is
   * one view among several, and a menu it drew could not reach past its own
   * edges. What a browser's tab menu offers, less what a tab here cannot be:
   * there is no duplicate, since a chapter is open in one tab at most (header).
   * At the click, in the window's content: every tab's view fills it from its
   * corner (`fit`), so the page's coordinates are the window's.
   */
  menu (id: number, x: number, y: number) {
    const at = this.list.findIndex((tab) => tab.id === id)

    if (at < 0) return

    const tab = this.list[at]!
    const mod = process.platform === 'darwin' ? 'Cmd' : 'Ctrl'
    const shown = { registerAccelerator: false }

    Menu.buildFromTemplate([
      { label: 'New tab to the right', click: () => this.open({ start: null, after: id }) },
      { type: 'separator' },
      { label: 'Reload', click: () => tab.view.webContents.reload() },
      { type: 'separator' },
      { label: 'Close tab', accelerator: `${mod}+W`, ...shown, enabled: this.list.length > 1, click: () => this.close(id) },
      { label: 'Close other tabs', enabled: this.list.length > 1, click: () => this.closeOthers(id) },
      { label: 'Close tabs to the right', enabled: at < this.list.length - 1, click: () => this.closeRight(id) },
    ]).popup({ window: this.win, x: Math.round(x), y: Math.round(y) })
  }

  /** The next or previous tab, round the end. */
  step (by: number) {
    const at = this.list.findIndex((tab) => tab.id === this.active)

    if (at < 0 || this.list.length < 2) return

    this.select(this.list[(at + by + this.list.length) % this.list.length]!.id)
  }

  /** The nth tab, or the last for 9 — as every browser numbers them. */
  nth (n: number) {
    const tab = n === 9 ? this.list.at(-1) : this.list[n - 1]

    if (tab) this.select(tab.id)
  }

  /** A tab's page says what it is showing. */
  at (contents: WebContents, workspace: string | null, title: string) {
    const tab = this.list.find((each) => each.view.webContents === contents)

    if (!tab) return

    tab.workspace = workspace
    tab.title = title.trim() || (workspace ? UNNAMED : LIST)
    this.changed()
  }

  /**
   * A tab's page is about to open a chapter: the tab already showing it, if
   * another one is — put on screen — or null, and the page goes ahead. See the
   * header for why a chapter is never open twice.
   */
  claim (contents: WebContents, workspace: string): number | null {
    const other = this.list.find((tab) => tab.workspace === workspace && tab.view.webContents !== contents)

    if (other) {
      this.select(other.id)

      return other.id
    }

    // Taken now, not when the page gets round to saying so: a second tab asking
    // a moment later must find it taken.
    const mine = this.list.find((tab) => tab.view.webContents === contents)

    if (mine) {
      mine.workspace = workspace
      this.changed()
    }

    return null
  }

  /**
   * A chapter in a tab, for an agent (`open_workspace`): the tab it is already
   * open in, or a new one at the end — on screen only if `show`, since an agent
   * opening a chapter for its own errand must not take the screen from the
   * reader. A new tab is in its chapter from the start (`start`), so a claim
   * made a moment later finds it taken.
   */
  reveal (workspace: string, show: boolean): { already: boolean } {
    const tab = this.list.find((each) => each.workspace === workspace)

    if (tab) {
      if (show) this.select(tab.id)

      return { already: true }
    }

    this.open({ start: workspace, focus: show })

    return { already: false }
  }

  /**
   * What a tab is told when it starts — see `TabHello`. The first time, where it
   * was made to land; after that, a reload, where it already was.
   *
   * From `start`, never from what the page has said since: a page says it is on
   * the list as it mounts, before it asks where to go, and a restored tab read
   * its chapter from that and came back on the list instead.
   */
  hello (contents: WebContents): TabHello | null {
    const tab = this.list.find((each) => each.view.webContents === contents)

    if (!tab) return null

    const open = tab.greeted ? tab.workspace : tab.start
    const files = tab.files

    tab.greeted = true
    tab.files = false

    return { id: tab.id, open, files }
  }

  /** Every tab the size of the window's content. */
  private fit () {
    const { width, height } = this.win.getContentBounds()

    for (const tab of this.list) tab.view.setBounds({ x: 0, y: 0, width, height })
  }

  /**
   * The browser's tab keys, heard before the page and the menu are — so they
   * work whatever has the keyboard, a text box included. ⌘ on macOS; Ctrl+Tab
   * is Ctrl there too, as in every browser.
   */
  private keys (contents: WebContents) {
    const mac = process.platform === 'darwin'

    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return

      const mod = mac ? input.meta : input.control
      const key = input.key.toLowerCase()
      let handled = true

      if (mod && !input.shift && !input.alt && key === 't') this.open({ start: null })
      else if (mod && !input.shift && !input.alt && key === 'w') this.close(this.active ?? -1)
      else if (input.control && key === 'tab') this.step(input.shift ? -1 : 1)
      else if (mod && !input.shift && key === 'pagedown') this.step(1)
      else if (mod && !input.shift && key === 'pageup') this.step(-1)
      else if (mod && !input.shift && !input.alt && /^[1-9]$/.test(key)) this.nth(Number(key))
      else handled = false

      if (handled) event.preventDefault()
    })
  }

  /** Say the new state to every tab, and keep it a moment later. */
  private changed () {
    const state = this.state()

    for (const contents of this.pages()) contents.send('tabs:changed', state)

    if (this.saving) clearTimeout(this.saving)
    this.saving = setTimeout(() => this.flush(), 500)
  }

  /** Keep the tabs as they are now. */
  private flush () {
    if (this.saving) clearTimeout(this.saving)
    this.saving = null

    if (!this.list.length) return

    const at = this.list.findIndex((tab) => tab.id === this.active)

    try {
      store({ tabs: this.list.map((tab) => ({ workspace: tab.workspace })), active: Math.max(at, 0) })
    } catch (error) {
      console.warn('[tabs] could not keep the tabs', error)
    }
  }
}

/** The tabs' IPC, each the app's own page only. */
export function serveTabs (tabs: () => Tabs | null, trusted: (event: IpcMainInvokeEvent) => boolean) {
  const only = <A extends unknown[], R>(handler: (contents: WebContents, ...args: A) => R) =>
    (event: IpcMainInvokeEvent, ...args: A) => {
      if (!trusted(event)) throw new Error('Not the app.')

      return handler(event.sender, ...args)
    }

  const id = z.number().int()
  const workspace = z.string().max(200)

  ipcMain.handle('tabs:hello', only((contents) => tabs()?.hello(contents) ?? null))
  ipcMain.handle('tabs:state', only(() => tabs()?.state() ?? { tabs: [], active: null }))
  ipcMain.handle('tabs:new', only(() => { tabs()?.open({ start: null }) }))
  ipcMain.handle('tabs:select', only((_contents, given: unknown) => { tabs()?.select(id.parse(given)) }))
  ipcMain.handle('tabs:close', only((_contents, given: unknown) => { tabs()?.close(id.parse(given)) }))
  ipcMain.handle('tabs:menu', only((_contents, given: unknown, x: unknown, y: unknown) => {
    tabs()?.menu(id.parse(given), z.number().finite().parse(x), z.number().finite().parse(y))
  }))
  ipcMain.handle('tabs:at', only((contents, chapter: unknown, title: unknown) => {
    tabs()?.at(contents, workspace.nullable().parse(chapter), z.string().max(300).parse(title))
  }))
  ipcMain.handle('tabs:claim', only((contents, chapter: unknown) => tabs()?.claim(contents, workspace.parse(chapter)) ?? null))
}
