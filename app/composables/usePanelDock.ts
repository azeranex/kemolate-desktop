/**
 * Where the side panel's sections live, and how they get moved around.
 *
 * A section is a unit of panel — Blocks, Align — that belongs to a dock rather
 * than to a place in the markup. It sits in a column; columns are stacked
 * side by side within a dock; there is a dock on each edge of the canvas. The
 * whole of that arrangement is the layout, and it is data: two lists of
 * columns, each an ordered list of section ids.
 *
 * Columns are not fixed the way the two sides are — they are made by dropping
 * a section at the edge of one and go away again when the last section leaves,
 * so the user builds the shape of their panel by dragging and never has to
 * tidy up after themselves.
 *
 * The registry below is the only list of sections there is: adding one here
 * puts it in a dock, in the drag-and-drop and in what gets persisted, without
 * touching the docks themselves.
 *
 * ## Carried over from the web build
 *
 * The arrangement logic is the web build's, unchanged. Two things around it are
 * not: the state is held at module level rather than in Nuxt's `useState`, and
 * it is kept in local storage rather than a cookie — see `readStored`. (Every
 * panel has now come across; the stand-in body sections wore until then is
 * gone.)
 */
import {
  AlignCenterHorizontalIcon,
  BookMarkedIcon,
  CaseSensitiveIcon,
  FilesIcon,
  FlaskConicalIcon,
  ImagesIcon,
  LanguagesIcon,
  LayersIcon,
  MessageSquareTextIcon,
  MoveIcon,
  ScanTextIcon,
  TypeIcon,
  UsersRoundIcon,
} from '@lucide/vue'

import type { Component, Ref } from 'vue'

import PanelAlign from '~/components/panel/Align.vue'
import PanelBlockImages from '~/components/panel/BlockImages.vue'
import PanelBlocks from '~/components/panel/Blocks.vue'
import PanelCast from '~/components/panel/Cast.vue'
import PanelDetect from '~/components/panel/Detect.vue'
import PanelDev from '~/components/panel/Dev.vue'
import PanelGlossary from '~/components/panel/Glossary.vue'
import PanelLayers from '~/components/panel/Layers.vue'
import PanelLettering from '~/components/panel/Lettering.vue'
import PanelPages from '~/components/panel/Pages.vue'
import PanelText from '~/components/panel/Text.vue'
import PanelTransform from '~/components/panel/Transform.vue'
import PanelTranslate from '~/components/panel/Translate.vue'

export type DockSide = 'left' | 'right'

export interface PanelSection {
  id: string
  label: string
  icon: Component
  component: Component
}

export interface DockColumn {
  id: string
  sections: string[]
  /** Squeezed down to a rail of icons, its sections opened as flyouts. */
  compact: boolean
  /** How wide it wants to be, in pixels. Ignored while compact. */
  width: number
}

export type PanelLayout = Record<DockSide, DockColumn[]>

/**
 * Where a dragged section would land — a line drawn, not a move made. Either
 * between two sections of a column that already exists, or between two columns
 * as a column that does not exist yet.
 */
export type PanelDropTarget =
  | { side: DockSide, kind: 'section', column: string, index: number }
  | { side: DockSide, kind: 'column', index: number }

export const DOCK_SIDES = ['left', 'right'] as const

export const PANEL_SECTIONS: PanelSection[] = [
  // Blocks gives up the stack of sheets to the panel that is actually about a
  // stack of sheets, and takes the speech mark — which is what a block is.
  // Detect before Blocks, because it comes before Blocks: it is what puts
  // the blocks there.
  { id: 'detect', label: 'Detect', icon: ScanTextIcon, component: PanelDetect },
  { id: 'translate', label: 'Translate', icon: LanguagesIcon, component: PanelTranslate },
  { id: 'blocks', label: 'Blocks', icon: MessageSquareTextIcon, component: PanelBlocks },
  // After Translate, because it is what Translate sends: who these people are
  // and how they are named, settled once for the whole comic rather than
  // guessed per page. Nothing on it is about the block in front of you, which
  // is why it sits above Text rather than beside it.
  { id: 'cast', label: 'Cast', icon: UsersRoundIcon, component: PanelCast },
  // Beside the cast, because they are the same kind of thing: what the chapter
  // has settled about its words, sent with every page. Two sections rather than
  // one, because the glossary is per target language and the cast is not, and
  // nesting them would hide the difference that matters.
  { id: 'glossary', label: 'Glossary', icon: BookMarkedIcon, component: PanelGlossary },
  { id: 'text', label: 'Text', icon: TypeIcon, component: PanelText },
  // After Text, because it is the next question about the same block: Text
  // settles what the line says, this settles how it is set.
  { id: 'lettering', label: 'Lettering', icon: CaseSensitiveIcon, component: PanelLettering },
  { id: 'align', label: 'Align', icon: AlignCenterHorizontalIcon, component: PanelAlign },
  { id: 'transform', label: 'Transform', icon: MoveIcon, component: PanelTransform },
  { id: 'layers', label: 'Layers', icon: LayersIcon, component: PanelLayers },
  { id: 'pages', label: 'Pages', icon: FilesIcon, component: PanelPages },

  /**
   * The bench, and only while there is somebody at it.
   *
   * `import.meta.env.DEV` is folded away at build, so the entry is gone from a
   * production bundle and — because everything downstream is keyed off this
   * list — so is every trace of it. A stored layout naming `dev` has that id
   * dropped by `reconcile`, which already does the same for any section since
   * removed, so a panel arranged with the bench in it does not come back
   * broken on a build without one.
   */
  ...(import.meta.env.DEV
    ? [
        { id: 'dev', label: 'Dev', icon: FlaskConicalIcon, component: PanelDev },
        // Each block's crop, repair and repair-over-crop — see `BlockImages.vue`.
        { id: 'block-images', label: 'Block images', icon: ImagesIcon, component: PanelBlockImages },
      ]
    : []),
]

const SECTIONS_BY_ID = new Map(PANEL_SECTIONS.map((section) => [section.id, section]))

/** A compacted column, in pixels — a rail of icons and nothing else. */
export const RAIL_WIDTH = 44

/** The narrowest a column is allowed to be squeezed by resizing its dock. */
export const MIN_COLUMN_WIDTH = 360

/**
 * What a column is worth when nobody has said otherwise.
 *
 * Never under the minimum: a default a column is not allowed to hold is one
 * every new column is corrected out of the moment it is made, and it would put
 * the width a dock asks for below the width its columns insist on — a dock
 * narrower than the things inside it.
 */
export const COLUMN_WIDTH = Math.max(360, MIN_COLUMN_WIDTH)

/**
 * Desktop: two columns on the right — the page and what is on it (reading,
 * layers, the chapter's pages) beside the words (translation, the blocks, how
 * each is set, what the chapter has settled). The web build's default is one
 * column; a desktop window is wide enough for both at once. The left dock
 * starts with no columns at all, and takes up no room until something is
 * dragged into it.
 */
const DEFAULT_LAYOUT: PanelLayout = {
  left: [],
  right: [
    {
      id: 'main',
      sections: ['detect', 'layers', 'pages'],
      compact: false,
      width: COLUMN_WIDTH,
    },
    {
      id: 'words',
      // The bench goes in the default as well as the registry, and has to: the
      // second loop in `reconcile` is what slots a newly added section into a
      // layout somebody has already arranged, and it works from this list. Left
      // out, the panel would exist and only ever appear for someone who had never
      // touched their docks — which is nobody, after the first drag.
      sections: ['translate', 'blocks', 'text', 'lettering', 'cast', 'glossary', 'align', 'transform', ...(import.meta.env.DEV ? ['dev', 'block-images'] : [])],
      compact: false,
      width: COLUMN_WIDTH,
    },
  ],
}

const STORAGE_KEY = 'panel-layout'

/**
 * The saved arrangement.
 *
 * The web build kept this in a cookie so its *server* could render the user's
 * arrangement in the first paint. There is no server render here: the page
 * starts in the renderer, and local storage is read synchronously before the
 * first render, so the first paint is already right by the plainer route.
 * Electron keeps it under the app's own profile, per machine.
 *
 * Read defensively: a stored value is a preference, and one that will not parse
 * is the same as none — `reconcile` builds the default from `null`.
 */
interface StoredLayout extends Partial<PanelLayout> {
  /** The ids of the sections left open, in no particular order. */
  opened?: string[]
}

function readStored (): StoredLayout | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) as StoredLayout : null
  } catch {
    return null
  }
}

function writeStored (value: StoredLayout) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
  } catch {
    // Storage full or unavailable: the arrangement simply is not remembered.
  }
}

/**
 * The dock's state, made once and shared by everything that asks — what Nuxt's
 * `useState` gave the web build. Lazily, so storage is first read when a dock is
 * first drawn rather than when this module happens to be imported.
 */
let state: {
  layout: Ref<PanelLayout>
  dragging: Ref<string | null>
  dropTarget: Ref<PanelDropTarget | null>
  opened: Ref<string[]>
  shown: Ref<Record<DockSide, boolean>>
} | undefined

function dockState () {
  if (!state) {
    const stored = readStored()

    state = {
      layout: ref(reconcile(stored)),
      dragging: ref(null),
      dropTarget: ref(null),
      opened: ref(reconcileOpened(stored?.opened)),
      shown: ref({ left: false, right: false }),
    }
  }

  return state
}

/** What is open before anyone has said otherwise. */
const DEFAULT_OPENED = ['detect', 'layers', 'pages', 'translate', 'blocks', 'text', 'lettering']

/**
 * Read back which sections were left open, keeping only the ones that still
 * exist — a section removed since would otherwise sit in the list for ever,
 * opening nothing.
 *
 * Nothing saved and the default stands; an empty list saved means every
 * section was shut, which is a state the user can perfectly well have chosen
 * and is not the same thing as never having chosen at all.
 */
function reconcileOpened (stored: string[] | undefined): string[] {
  if (!stored) return [...DEFAULT_OPENED]

  return stored.filter((id) => SECTIONS_BY_ID.has(id))
}

function nextColumnId () {
  return `column-${crypto.randomUUID().slice(0, 8)}`
}

/**
 * Read a layout back as an arrangement of the sections that exist *now*. A
 * stored layout is a preference, not a source of truth: ids that have since
 * been removed are dropped, and a section the user has never seen — one added
 * after they last arranged their panels — falls in wherever the default puts
 * it rather than going missing. Columns emptied by that are dropped with it.
 */
function reconcile (stored: Partial<PanelLayout> | null): PanelLayout {
  const layout: PanelLayout = { left: [], right: [] }
  const placed = new Set<string>()

  for (const side of DOCK_SIDES) {
    for (const column of stored?.[side] ?? []) {
      const sections = (column?.sections ?? []).filter((id) => {
        if (placed.has(id) || !SECTIONS_BY_ID.has(id)) return false

        placed.add(id)

        return true
      })

      if (sections.length) {
        layout[side].push({
          id: column.id || nextColumnId(),
          sections,
          compact: !!column.compact,
          width: Number(column.width) || COLUMN_WIDTH,
        })
      }
    }
  }

  for (const side of DOCK_SIDES) {
    // Desktop: a side nobody has arranged takes the default's columns as they
    // are. Only into an arranged one are the missing sections gathered up.
    const fresh = !layout[side].length

    for (const column of DEFAULT_LAYOUT[side]) {
      const missing = column.sections.filter((id) => !placed.has(id))

      if (!missing.length) continue

      missing.forEach((id) => placed.add(id))

      // Into the first column that is already there, so a newly added section
      // joins the panel rather than opening a column of its own.
      const home = fresh ? undefined : layout[side][0]

      if (home) home.sections.push(...missing)
      else layout[side].push({ id: column.id, sections: missing, compact: false, width: COLUMN_WIDTH })
    }
  }

  return layout
}

export function usePanelDock () {
  const {
    layout,
    /** The id of the section being dragged, for as long as it is in the air. */
    dragging,
    dropTarget,
    /**
     * Which sections are open, held here rather than per-column: an accordion
     * that owned this would close a section the moment it was dragged out of it,
     * and carrying a panel across the screen only to find it shut is not what
     * the drag said it would do.
     *
     * Kept with the arrangement, and for the same reason. Which panels a user
     * works with open is as much a part of how they have set the place up as
     * where those panels sit, and it was the one half of that not being written
     * down: every reload built it back from the default and left them with the
     * two it happens to name.
     */
    opened,
    shown,
  } = dockState()

  /**
   * Whether each dock is on screen at all — and the only thing that decides it.
   *
   * A hidden dock is one whose width may be nothing and must be nothing, and
   * that is the whole mechanism: no collapsing, no expanding, nothing to call
   * and nothing to be told. The panel group already re-clamps a panel when its
   * constraints move, so flipping this both puts a dock away and brings it back,
   * in one assignment, with no order to get wrong.
   *
   * It replaced a pair of imperative collapse/expand calls that had to be made
   * a tick after the constraints they depended on — which lost the race often
   * enough that a dock could take a panel and stay shut around it.
   *
   * Here rather than in the layout, where it lived until the toggles moved to
   * the tool rail. The layout is still the only thing that *reads* it for
   * sizing, but the buttons are now three components away from it, and a dock's
   * visibility is a fact about the dock — which is what this composable is for.
   * (`shown`, above.)
   */
  function toggle (side: DockSide) {
    shown.value[side] = !shown.value[side]
  }

  function sectionsOf (column: DockColumn) {
    return column.sections
      .map((id) => SECTIONS_BY_ID.get(id))
      .filter((section) => section !== undefined)
  }

  /** A working copy deep enough that nothing below is shared with the state. */
  function draft (): PanelLayout {
    return {
      left: layout.value.left.map((column) => ({ ...column, sections: [...column.sections] })),
      right: layout.value.right.map((column) => ({ ...column, sections: [...column.sections] })),
    }
  }

  /**
   * Put the dragged section where the target says, taking it out of wherever
   * it was.
   *
   * Both halves are one step because an index means a gap between things as
   * they are on screen: lifting the section out first closes the gap it left,
   * so anything below it — including the gap being aimed at — has moved up by
   * one. Columns left with nothing in them go at the end, which is the only
   * way a column is ever removed.
   */
  function moveSection (id: string, target: PanelDropTarget) {
    const next = draft()
    let index = target.kind === 'section' ? target.index : 0

    for (const side of DOCK_SIDES) {
      for (const column of next[side]) {
        const at = column.sections.indexOf(id)

        if (at === -1) continue

        column.sections.splice(at, 1)
        if (target.kind === 'section' && column.id === target.column && at < index) index--
      }
    }

    if (target.kind === 'column') {
      const columns = next[target.side]

      columns.splice(clamp(target.index, columns.length), 0, {
        id: nextColumnId(),
        sections: [id],
        compact: false,
        width: COLUMN_WIDTH,
      })
    } else {
      const column = next[target.side].find((candidate) => candidate.id === target.column)

      if (!column) return

      column.sections.splice(clamp(index, column.sections.length), 0, id)
    }

    for (const side of DOCK_SIDES) next[side] = next[side].filter((column) => column.sections.length)

    layout.value = next
  }

  /**
   * How wide a dock wants to be: the sum of what its columns want.
   *
   * A dock is the columns in it and nothing else, so its width is theirs
   * added up rather than a size of its own that they then divide between
   * them. Pulling a section out into a new column widens the dock by that
   * column, instead of halving the one that was already there.
   */
  function dockWidth (side: DockSide, part: 'want' | 'min' = 'want') {
    // An empty dock is measured as the column it is about to be given. Summing
    // nothing comes to nothing, and a dock whose every width is nothing has no
    // room to open into — which would make the first drop into it the one drop
    // that could never land.
    if (!layout.value[side].length) {
      return part === 'min' ? MIN_COLUMN_WIDTH : COLUMN_WIDTH
    }

    return layout.value[side].reduce((total, column) => {
      if (column.compact) return total + RAIL_WIDTH
      if (part === 'min') return total + MIN_COLUMN_WIDTH

      return total + column.width
    }, 0)
  }

  /**
   * Take a dock's new width back out on its columns.
   *
   * This is the other direction of the same relationship: the user drags the
   * dock's edge, and the columns have to agree about what that made them, or
   * the next column added would widen the dock back to a total nobody asked
   * for. Rails are not in it — they are a fixed width by definition.
   *
   * All of it lands on the column against the handle, rather than being shared
   * out over the columns in proportion. A dock's handle is on the side it
   * faces the canvas across, so that column is the one the pointer is dragging
   * the edge of, and the boundaries further in are ones the user has already
   * placed by hand. Shared out, every one of them crept as the dock was
   * resized: the drag appeared to move two edges at once, and an arrangement
   * inside a dock could not be kept while the dock itself was adjusted.
   *
   * Only what a column cannot give up passes to the one behind it, so pulling
   * a dock shut closes the columns from the outside in, each stopping at its
   * minimum, instead of collapsing all of them together.
   */
  function setDockWidth (side: DockSide, width: number) {
    const next = draft()
    const open = next[side].filter((column) => !column.compact)
    const rails = (next[side].length - open.length) * RAIL_WIDTH
    const available = width - rails

    if (!open.length || available <= 0) return

    const order = side === 'right' ? open : [...open].reverse()
    let delta = available - open.reduce((total, column) => total + column.width, 0)

    for (const column of order) {
      // Widening is unbounded, so the first column takes all of it. Narrowing
      // stops at the minimum and hands on what is left.
      const give = delta < 0 ? Math.max(delta, MIN_COLUMN_WIDTH - column.width) : delta

      column.width += give
      delta -= give

      if (Math.abs(delta) < 0.5) break
    }

    layout.value = next
  }

  /**
   * Move the boundary between two neighbouring columns: what the left one is
   * to be worth, against what the pair was worth when the drag began.
   *
   * The pair's total is passed in rather than read back off the columns
   * because this runs on every movement of one drag, and the branch below can
   * change that total midway. Measured afresh each time, every movement would
   * be against whatever the last one had just made, and the boundary would run
   * away from the pointer instead of following it.
   *
   * Normally the pair is all this touches: what the two are worth together
   * does not change, so the dock does not change either, and a boundary moved
   * inside a dock cannot make the canvas jump. Which is why it is measured
   * against the pair — the pointer is over a boundary between two columns,
   * not over the dock.
   *
   * The exception is a column already down at its minimum. One of the pair has
   * the dock's own edge behind it — the side the handle is on — and that one
   * can be held at its minimum while the dock widens to find the room. Without
   * that, a dock whose columns were all at the minimum was stuck: widening the
   * dock only ever feeds the column against the handle, and the only way to
   * grow the one behind it is to take width from a neighbour that has none
   * left to give. The innermost column could never be made wider again.
   *
   * Its neighbour backs onto the window edge the dock is anchored by, so there
   * is nowhere for width to come from on that side and the boundary stops.
   */
  function resizeColumns (side: DockSide, index: number, width: number, total: number) {
    const next = draft()
    const before = next[side][index]
    const after = next[side][index + 1]

    // Rails are a fixed width by definition; there is no boundary to move.
    if (!before || !after || before.compact || after.compact) return

    const wanted = [width, total - width]
    const free = side === 'right' ? 0 : 1

    if (wanted[free]! < MIN_COLUMN_WIDTH) {
      // Held at the minimum, its neighbour keeping all of what it asked for —
      // which comes to more than the pair had, and widens the dock behind it.
      wanted[free] = MIN_COLUMN_WIDTH
    } else if (wanted[1 - free]! < MIN_COLUMN_WIDTH) {
      wanted[1 - free] = MIN_COLUMN_WIDTH
      wanted[free] = total - MIN_COLUMN_WIDTH
    }

    before.width = wanted[0]!
    after.width = wanted[1]!
    layout.value = next
  }

  /** Squeeze a column down to its icons, or let it back out. */
  function toggleCompact (side: DockSide, columnId: string) {
    const next = draft()
    const column = next[side].find((candidate) => candidate.id === columnId)

    if (!column) return

    column.compact = !column.compact
    layout.value = next
  }

  function endDrag () {
    dragging.value = null
    dropTarget.value = null
  }

  return {
    layout,
    dragging,
    dropTarget,
    opened,
    shown,
    toggle,
    sectionsOf,
    moveSection,
    resizeColumns,
    toggleCompact,
    dockWidth,
    setDockWidth,
    endDrag,
  }
}

function clamp (index: number, max: number) {
  return Math.max(0, Math.min(index, max))
}

/**
 * Keep the arrangement across reloads: write it back as it changes.
 *
 * Reading it is not done here — that happens where the state is first made,
 * so the arrangement is there before anything renders. This is only the other
 * half, and it is called once, from the layout, rather than by each dock for
 * itself.
 *
 * Widths are rounded on the way out. Sharing a width between columns divides
 * it, and a column that has been dragged about for a while is worth something
 * like 319.99999999973596 — a number that is only ever true to the nearest
 * pixel, written down to eighteen characters.
 */
export function usePanelLayoutStorage () {
  const { layout, opened } = usePanelDock()

  watch([layout, opened], ([value, open]) => {
    writeStored({
      left: value.left.map(toStored),
      right: value.right.map(toStored),
      opened: open,
    })
  }, { deep: true })
}

function toStored (column: DockColumn): DockColumn {
  return { ...column, width: Math.round(column.width) }
}
