/**
 * Where the window was, so it opens there again.
 *
 * `window.json` in the app's profile: the window's *normal* bounds — its size
 * and place when it is neither maximised nor full screen — and whether it was
 * maximised or full screen when it closed. The normal bounds rather than the
 * current ones, because a maximised window's bounds are the screen's, and
 * restoring those as a plain window would open one that fills the screen but
 * cannot be un-maximised to anything smaller.
 *
 * ## The first time
 *
 * 1920 × 1080, centred — or the screen's work area where that is smaller, which
 * on a 1080p display it always is once the taskbar has its share. A window
 * bigger than the work area opens with its title bar under the top edge or its
 * controls past the right one, and on Windows cannot be dragged back.
 *
 * ## A display that has gone
 *
 * Bounds remembered on a monitor that is no longer attached would open the
 * window somewhere nobody can see. So kept bounds are used only while most of
 * the title bar's strip still lands on some display's work area; otherwise the
 * window falls back to the first-time size on the primary display, keeping the
 * maximised flag.
 *
 * Written when the window moves or resizes (after it settles) and when it
 * closes, beside and renamed over so a crash mid-write cannot leave half a file.
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { app, screen } from 'electron'

import type { BrowserWindow, Rectangle } from 'electron'

interface Kept {
  bounds: Rectangle
  maximized: boolean
  fullScreen: boolean
}

const FIRST = { width: 1920, height: 1080 }

/** How long the window has to sit still before it is written down. */
const SETTLE = 500

const file = () => path.join(app.getPath('userData'), 'window.json')

function read (): Kept | null {
  try {
    const kept = JSON.parse(readFileSync(file(), 'utf8')) as Partial<Kept>
    const b = kept.bounds

    if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite)) return null

    return { bounds: b, maximized: Boolean(kept.maximized), fullScreen: Boolean(kept.fullScreen) }
  } catch {
    return null
  }
}

function write (kept: Kept) {
  const target = file()
  const temporary = `${target}.tmp`

  try {
    writeFileSync(temporary, JSON.stringify(kept, null, 2))
    renameSync(temporary, target)
  } catch {
    // A window that opens at its default size next time is not worth a crash.
  }
}

/** Whether a window at these bounds would have its title bar somewhere a display shows. */
function visible (bounds: Rectangle): boolean {
  // The top strip, where the title bar is drawn and the window is dragged by.
  const strip = { x: bounds.x, y: bounds.y, width: bounds.width, height: 56 }

  return screen.getAllDisplays().some(({ workArea: area }) => {
    const width = Math.min(strip.x + strip.width, area.x + area.width) - Math.max(strip.x, area.x)
    const height = Math.min(strip.y + strip.height, area.y + area.height) - Math.max(strip.y, area.y)

    return width >= Math.min(200, strip.width / 2) && height >= strip.height / 2
  })
}

/** The first-time bounds: 1920 × 1080, or the primary work area if smaller, centred in it. */
function first (): Rectangle {
  const area = screen.getPrimaryDisplay().workArea
  const width = Math.min(FIRST.width, area.width)
  const height = Math.min(FIRST.height, area.height)

  return {
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + Math.round((area.height - height) / 2),
    width,
    height,
  }
}

/** Where to open, and whether to maximise or go full screen once shown. Ask after the app is ready. */
export function windowPlace (): Kept {
  const kept = read()

  if (kept && visible(kept.bounds)) return kept

  return { bounds: first(), maximized: kept?.maximized ?? false, fullScreen: false }
}

/**
 * How far a window can come back from where it was put and still be where it
 * was put. Converting between window units and the screen's pixels rounds, and
 * at 125% that rounding read a window back a pixel larger than it was set —
 * a pixel more every launch, for ever, unless a read that close is taken as the
 * place it was given.
 */
const ROUNDING = 2

const near = (a: Rectangle, b: Rectangle) =>
  Math.abs(a.x - b.x) <= ROUNDING && Math.abs(a.y - b.y) <= ROUNDING
  && Math.abs(a.width - b.width) <= ROUNDING && Math.abs(a.height - b.height) <= ROUNDING

/** Keep this window's place as it changes, and once more as it closes. `placed` is where it was opened. */
export function keepWindowPlace (win: BrowserWindow, placed: Rectangle) {
  let waiting: ReturnType<typeof setTimeout> | null = null

  const now = (): Kept => {
    const bounds = win.getNormalBounds()

    return {
      bounds: near(bounds, placed) ? placed : bounds,
      maximized: win.isMaximized(),
      fullScreen: win.isFullScreen(),
    }
  }

  const soon = () => {
    if (waiting) clearTimeout(waiting)

    waiting = setTimeout(() => {
      waiting = null

      if (!win.isDestroyed()) write(now())
    }, SETTLE)
  }

  for (const event of ['resize', 'move', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'] as const) {
    win.on(event as 'resize', soon)
  }

  win.on('close', () => {
    if (waiting) clearTimeout(waiting)

    write(now())
  })
}
