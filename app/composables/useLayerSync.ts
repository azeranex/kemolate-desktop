/**
 * The layer stack, kept somewhere other than this tab's memory.
 *
 * It lived in `useState('comic-layers')` and nowhere else, which meant more
 * than "layers do not sync": a layer added, renamed, hidden, faded, locked,
 * grouped or dragged was gone on the next reload of the very tab that made it.
 * The server side had been written the whole time — `services/layers.ts` has a
 * full `stack`/`add`/`update`/`move`/`remove` — and nothing but `ensurePlate`
 * was ever routed to it. This is the wire between the two.
 *
 * ## A whole stack at a time
 *
 * Not a call per gesture, and that is a decision rather than a shortcut. The
 * canvas mutates the tree in place from a dozen places — `setLayer`,
 * `moveLayer`, `addPaintLayer`, `addGroupLayer`, `addAdjustLayer`,
 * `removeLayer`, the eye and lock sweeps — and none of them can honestly report
 * "this field of this row changed": the eye drag alone touches four rows in one
 * gesture. Watching the whole stack and sending it is one description both ends
 * agree on, and a stack is a dozen rows.
 *
 * ## Upsert, never rewrite
 *
 * The server matches rows by `uid`, which *is* the client's `StackLayer.id`, so
 * a row keeps its database id across every edit. That is not tidiness:
 * `surfaces.layer_id` cascades, so a stack written back by deleting and
 * re-inserting would take every stroke on every plate with it. The id has to
 * flow from here to there, which is why the browser names the rows.
 *
 * ## What is not shared
 *
 * A group's twirl. `open` is which rows *this reader* has expanded, and pushing
 * it would have one person's collapsing fold up somebody else's panel mid-edit.
 * It is dropped on the way out and preserved on the way in.
 *
 * ## A stack belongs to a page
 *
 * It used to belong to the chapter, and the trouble was not that it was shared
 * but that it could not be anything else: a sheet added to sketch over one
 * awkward panel turned up on all three hundred pages. So every request here
 * names a page, and turning to another one re-reads the stack, because the
 * stack is about the page.
 *
 * What was worth keeping about the old arrangement is the panel's presets —
 * see `useLayerPresets`. They are the one thing that speaks for every page, and
 * they can do it safely because they only ever set three fields on the seven
 * rows a page is founded with. Nothing in *this* file ever leaves its page.
 */
import { readPaint } from './usePaintSync'

import type { layerDraftSchema } from '#shared/schemas/workspace'
import type { PlacedImage, StackLayer } from '#shared/utils/layers'
import type { z } from 'zod'

import { DEFAULT_STACK } from '#shared/utils/layers'

// Desktop: the row as the schema takes it, rather than the service's own
// `LayerDraft` — the window's project cannot load the services, which open the
// database. The two are the same shape; the schema is what checks it.
type LayerDraft = z.input<typeof layerDraftSchema>

/** One row of the stack as the server keeps it. */
interface StoredLayer {
  id: number
  uid: string
  parentId: number | null
  position: number
  label: string
  hint: string | null
  plate: PlateId | null
  visible: boolean
  opacity: number
  locked: boolean
  paint: boolean
  fixed: boolean
  clipped: boolean
  adjust: Adjustment | null
  image: PlacedImage | null
}

/**
 * How long the stack has to sit still before it is sent.
 *
 * Longer than a block's settle, because the gestures are coarser and come in
 * bursts: dragging the opacity slider is a change a frame, and sweeping the eye
 * across a group is one per row it crosses. Nothing here is at risk from a
 * slower hand — a layer is not a sentence somebody is halfway through typing.
 */
const SETTLE = 600

/**
 * The row id each layer was filed under, by its uid.
 *
 * Kept because a surface had to name a layer and the canvas only knew the
 * stack's own names. It used to be able to ask `layers/ensure` for one, which
 * works for the five plates and for nothing else: a blank sheet somebody added
 * has no plate, so the ask was a 400 and every mark drawn on it stayed in the
 * tab that drew it, unsaved and unshared.
 *
 * Nothing reads it now. A batch of strokes names a sheet by its uid and the
 * server finds the row (`paint.appendMany`), so the canvas no longer needs the
 * id — and needing it was what made the first marks on a new sheet wait for
 * the stack to come back. Still written, and still cleared on the way out of
 * a workspace, until whoever owns `useWorkspaceReset` takes both out.
 */
export const useLayerRows = () => useState<Record<string, number>>('layer-rows', () => ({}))

/**
 * Pages whose stack came from somewhere with a better claim than the server's —
 * which today means one thing: an imported project file.
 *
 * State of its own, and reached the way `useLayerRows` is, because the claim is
 * made from `useProjectFile` and honoured in `pull`. Calling `useLayerSync`
 * from the importer to reach it would register a second set of its watchers,
 * which is the hazard `useWorkspaceReset` sets out at length.
 *
 * Holds the **client's own page id** rather than a `uid` or a row id, and both
 * alternatives fail for reasons worth writing down. A row id does not exist
 * when the claim has to be made: the pages have only just been put on screen
 * and nothing has synced them. A `uid` is nearly right and is sometimes absent
 * — a project file's uid is dropped when it is not a uuid, and the workspace
 * then mints its own. The local id is the one name that exists before anything
 * has been told about the page and does not change afterwards.
 *
 * A claim is **spent the first time it is honoured**, so this says "the file's
 * stack wins once, on arrival" and not "this page never pulls again". A page
 * turned to next week reads the server's rows like any other.
 */
export const useLayerClaims = () => useState<string[]>('layer-claimed', () => [])

/**
 * A stack flattened into the rows the server takes, each naming its parent by
 * uid — see `layerSyncSchema`.
 *
 * Desktop: lifted out of `useLayerSync`, where it was `flatten`, so a
 * workspace moving into the database can send every page's stack at once
 * (`useMoveIn`) without standing up a second copy of the sync's watchers.
 */
export function layerDrafts (stack: StackLayer[], parentUid: string | null = null): LayerDraft[] {
  return stack.flatMap((layer, position) => [
    {
      uid: layer.id,
      parentUid,
      position,
      label: layer.label,
      hint: layer.hint ?? null,
      plate: layer.plate ?? null,
      visible: layer.visible,
      opacity: layer.opacity,
      locked: layer.locked ?? false,
      paint: layer.paint ?? false,
      fixed: layer.fixed ?? false,
      clipped: layer.clipped ?? false,
      adjust: layer.adjust ?? null,
      image: layer.image ?? null,
    },
    ...layerDrafts(layer.children ?? [], layer.id),
  ])
}

/**
 * A page's stored rows, folded back into the tree the canvas draws.
 *
 * `open` comes from `twirls` where given — the rows do not carry it and should
 * not, see the header — and a group nobody has seen before opens, which is what
 * a group somebody else has just made should do.
 */
export function stackOf (rows: StoredLayer[], twirls: ReadonlyMap<string, boolean> = new Map()): StackLayer[] {
  const under = (parent: number | null): StackLayer[] => rows
    .filter((row) => row.parentId === parent)
    .sort((a, b) => a.position - b.position)
    .map((row) => {
      const children = under(row.id)

      return {
        id: row.uid,
        label: row.label,
        visible: row.visible,
        opacity: row.opacity,
        ...(row.hint ? { hint: row.hint } : {}),
        ...(row.plate ? { plate: row.plate } : {}),
        ...(row.locked ? { locked: true } : {}),
        ...(row.paint ? { paint: true } : {}),
        ...(row.fixed ? { fixed: true } : {}),
        ...(row.clipped ? { clipped: true } : {}),
        ...(row.adjust ? { adjust: row.adjust } : {}),
        ...(row.image ? { image: row.image } : {}),
        ...(children.length ? { children, open: twirls.get(row.uid) ?? true } : {}),
      } satisfies StackLayer
    })

  return under(null)
}

/**
 * Every page's stack as the server keeps it, by the page's own id here — for a
 * workspace carrying all of itself somewhere else. A stack is only read from
 * the server when its page is shown, so the ones in memory are the pages this
 * session looked at, and every other page holds the default it was opened
 * with; moving back to local and exporting both used to write those defaults
 * down as if they were the page's.
 *
 * Null when any page's answer did not arrive: the caller is about to delete the
 * server's copy, or to call this the chapter, and half an answer is not one. A
 * page the server holds no stack for is left out and keeps its own.
 */
export async function serverStacks (
  workspace: string,
  pages: readonly ComicPage[],
  rowOf: (page: ComicPage) => number | null,
): Promise<Map<string, StackLayer[]> | null> {
  const out = new Map<string, StackLayer[]>()

  for (const page of pages) {
    const row = rowOf(page)

    if (!row) continue

    const stored = await $fetch<StoredLayer[]>(`/api/workspaces/${workspace}/layers`, { query: { pageId: row } }).catch(() => null)

    if (!stored) return null
    if (stored.length) out.set(page.id, stackOf(stored))
  }

  return out
}

export function useLayerSync () {
  const route = useRoute()
  const { epoch, layers, page, setLayer } = useComic()
  const { shared, standing, pageRowOf } = useShared()

  const rows = useLayerRows()

  const workspace = computed(() => String(route.params.workspaceId ?? ''))

  /**
   * The row id of the page whose half of the stack is on screen.
   *
   * Null until the page list has been read back, which is the state a browser
   * is in for the first moment of every workspace. Everything here treats that
   * as "the chapter's rows only" rather than as an error: a stack with no
   * page-owned rows in it is a correct stack, and the watcher below picks the
   * page up the instant it is known.
   */
  const pageId = computed(() => (page.value ? pageRowOf(page.value) ?? null : null))

  /**
   * What was last agreed with the server for each page, so an unchanged stack
   * is not resent.
   *
   * Per page, and it had to become so the moment a stack started belonging to
   * one — see `ComicPage.stack`. It was a single string, which was right while
   * every page shared a stack and became wrong the same day they stopped:
   * turning the page now changes `shape`, so a single agreed value reads every
   * page turn as an edit and writes the page you have just arrived at straight
   * back, before `pull` has had a chance to say what the server holds.
   *
   * Keyed by the server's page id, which is the only name both ends know.
   *
   * **A page with no entry here has not been heard from, and nothing is sent
   * for it** — see `flush`. Every page this browser opens is founded on
   * `DEFAULT_STACK` until `pull` says what the server holds, so a save before
   * then is the default written over the page. Cleared when the chapter is
   * opened again (`epoch`), because every page is back on the default by then
   * and what was agreed describes stacks nobody is holding any more.
   */
  const sent = new Map<number, string>()

  const claimed = useLayerClaims()

  const pageKey = computed(() => page.value?.id ?? null)

  /**
   * Which page is on screen *and which opening of the chapter it belongs to*.
   *
   * The id alone is not an arrival: opening the chapter again — `openImages`,
   * which a restore or a folder picked afresh both run — hands every page back
   * under the id it had, as a new page on `DEFAULT_STACK`. The id stays put, the
   * row stays put, the stack jumps to the default, and that read as an edit on
   * the same page and was saved. The same trap `useBlockSync` fell into with its
   * blocks, and the same way out: `epoch` moves on every opening.
   */
  const arrival = computed(() => (page.value ? `${epoch.value}:${page.value.id}` : null))

  function release (id: string | null) {
    if (id) claimed.value = claimed.value.filter((held) => held !== id)
  }

  let timer: ReturnType<typeof setTimeout> | null = null

  /**
   * Whether this workspace can be written to at all.
   *
   * Editor, like the blocks: the stack is a claim about how the page is put
   * together rather than about what it says. Asked here rather than left to the
   * server to refuse, so a viewer looking at their own copy does not generate a
   * 403 per settle for doing nothing wrong.
   */
  const writable = computed(() => Boolean(
    workspace.value && shared.value && atLeast(shared.value.role, 'editor'),
  ))

  /* ---------- the two shapes ---------- */

  /**
   * The tree, flattened depth-first, each row naming its parent by uid.
   *
   * Depth-first so a parent is written before its children in the ordinary
   * case; the server fills parents in on a second pass regardless, because a
   * row dragged into a group that sorts after it would otherwise name a parent
   * that does not exist yet.
   */
  /**
   * The rows, folded back into the tree the canvas draws.
   *
   * `open` is carried over from whatever is on screen rather than taken from
   * the rows, because the rows do not carry it and should not — see the header.
   * A group nobody has seen before opens, which is what a group somebody else
   * has just made should do.
   */
  function build (rows: StoredLayer[]): StackLayer[] {
    const twirls = new Map<string, boolean>()

    const note = (stack: StackLayer[]) => {
      for (const layer of stack) {
        if (layer.open !== undefined) twirls.set(layer.id, layer.open)

        note(layer.children ?? [])
      }
    }

    note(layers.value)

    return stackOf(rows, twirls)
  }

  /** The stack as one string, for noticing that it moved. */
  const shape = computed(() => JSON.stringify(layerDrafts(layers.value)))

  /** What a page with no rows on the server is — see `pull`. */
  const DEFAULT_SHAPE = JSON.stringify(layerDrafts(DEFAULT_STACK))

  /* ---------- out ---------- */

  /**
   * The page the unsent stack is about — its row, and which page of this
   * browser's it is.
   *
   * Captured when a change is noticed rather than read when the timer fires,
   * and the difference is a sheet somebody loses. A row added and the page
   * turned inside one settle would otherwise be saved against the page that is
   * open *now* — filed on the wrong page, and taken as the deletion of whatever
   * that page had of its own.
   *
   * The page itself as well as its row, and that half was missing: the row was
   * captured, but the rows *sent* were read from `layers` when the timer fired —
   * which by then is the stack of the page turned to. So the save went to the
   * right page with the wrong page's rows. Walking a chapter quickly after a
   * chapter-wide preset wrote each page's stale stack onto the page before it,
   * and half of Business trip grooming 2 came out in the wrong arrangement.
   *
   * The page object rather than its id. An id outlives the page it named when
   * the chapter is opened again (see `arrival`), and looking the stack up by it
   * then finds the fresh page's `DEFAULT_STACK` — the edit lost and the default
   * saved in its place.
   */
  let pending: { row: number, page: ComicPage } | null = null

  /** The waiting save, sent now — its own page's rows, against its own page. */
  function sendPending () {
    const due = pending

    pending = null

    if (due) send(due.row, due.page.stack)
  }

  async function send (page: number | null, stack: StackLayer[] | undefined) {
    // No page, no stack to save. A browser that has not finished reading the
    // page list back is in this state for a moment on the way into every
    // workspace, and it has nothing worth writing down yet.
    if (!page || !stack) return

    const body = layerDrafts(stack)
    const was = JSON.stringify(body)

    const written = await $fetch<StoredLayer[]>(`/api/workspaces/${workspace.value}/layers`, {
      method: 'PUT',
      // The page as well as the rows: a stack belongs to one, and this is the
      // page whose stack these rows are.
      body: { layers: body, pageId: page },
      headers: peerHeader(workspace.value),
    }).catch((error: unknown) => {
      // Dropped rather than retried, and noted rather than swallowed — the same
      // bargain the block sync makes. The stack on screen is still the one the
      // reader arranged, and `sent` is left alone so the next change tries
      // again.
      console.warn('[kemolate] layer stack not saved:', error)

      return null
    })

    if (!written) return

    sent.set(page, was)
    remember(written)
  }

  /** Note which row each stack id was filed under — see `rowIds`. */
  function remember (stored: StoredLayer[]) {
    rows.value = Object.fromEntries(stored.map((row) => [row.uid, row.id]))
  }

  function flush () {
    if (!writable.value) return

    /*
     * Nothing has been agreed about this page yet, so nothing on screen can be
     * an edit to it — it is the stack the page was opened with, and `pull` is
     * on its way to replace it.
     *
     * This is the rule the page turn already followed, stated for every other
     * way of arriving. The one that cost a finished chapter its locks: a
     * chapter opens from this browser's storage before the workspace's record
     * answers, and when the record lands the page gains its row and the
     * workspace becomes writable in the same tick. That change of `writable`
     * came here, found no agreement to compare with, and scheduled a save of
     * `DEFAULT_STACK`; the `pageId` watcher then sent it at once, "against the
     * page it was drawn on", ahead of the pull. The Final arrangement differs
     * from the default only in its locks, so the page came back unlocked and
     * otherwise untouched — every time a browser opened a workspace on it.
     *
     * An edit made in the moment before the pull lands is not saved, and would
     * not have survived anyway: the pull assigns the server's stack over it.
     */
    if (!pageId.value || !sent.has(pageId.value)) return

    if (shape.value === sent.get(pageId.value)) {
      // Back to what was agreed — an edit taken back inside the settle — so a
      // save still waiting for this page has nothing left to say.
      if (timer && pending?.row === pageId.value) {
        clearTimeout(timer)
        timer = null
        pending = null
      }

      return
    }

    if (timer) clearTimeout(timer)

    pending = page.value ? { row: pageId.value, page: page.value } : null

    timer = setTimeout(() => {
      timer = null
      sendPending()
    }, SETTLE)
  }

  /* ---------- in ---------- */

  /** The reads in the air, by opening, page and kind — see `pull`. */
  const asking = new Set<string>()

  /**
   * Read the stack back and put it on screen — and, arriving at a page, the
   * paint on it in the same read.
   *
   * One request a page turn. The stack came from here and every paint canvas
   * on the page then made its own three — `layers/ensure` and `surfaces` to
   * found a stack and make a surface for having been looked at, and the log —
   * so the stack and the paint now come back together (`readPaint`, which
   * files the paint where the canvases read it). A notice about the stack
   * alone (`paint: false`) reads the stack alone.
   *
   * A page with no rows is a page nobody has changed: its stack is the one it
   * was founded with, which is what is on screen. Nothing is written to say so
   * — see the branch below.
   */
  async function pull (paint = true) {
    if (!workspace.value || !shared.value) return

    // Nothing to ask about until the page list has come back and named the page
    // on screen. The watcher on `pageId` brings this straight back when it does.
    const asked = pageId.value

    if (!asked) return

    // A page with no picture here has no canvas to paint on and nothing to
    // show the paint over, so it is asked for its stack alone.
    const painted = Boolean(paint && page.value?.scan)

    // The same arrival already in the air is this one. Arriving at a workspace
    // moves `standing` and `pageId` in the same tick — the record lands, and
    // with it the page's row — and each watcher asked for the page. Only an
    // arrival: a notice about the stack may be news the read in the air
    // started too early to see, and is read again.
    const ticket = `${epoch.value}:${asked}:${painted}`

    if (painted && asking.has(ticket)) return

    asking.add(ticket)

    const stored = await (painted
      ? readPaint<StoredLayer>(workspace.value, asked, { layers: true }).then((answer) => answer?.layers ?? null)
      : $fetch<StoredLayer[]>(`/api/workspaces/${workspace.value}/layers`, {
          query: { pageId: asked },
        })
          .catch(() => null))
      .finally(() => asking.delete(ticket))

    if (!stored) return

    /*
     * The page can turn while this is in flight, and the answer is about the
     * page that was asked about rather than the one now on screen.
     *
     * Harmless while every page shared one stack, and not any more: assigning
     * below would write page one's rows onto page two — which is the same
     * "somebody else's stack turned up here" the per-page stack exists to
     * prevent, arriving by a slower route. Dropped rather than applied,
     * because the `pageId` watcher has already started the pull that *is*
     * about the page in front of you.
     */
    if (pageId.value !== asked) return

    if (!stored.length) {
      /*
       * Nothing filed for this page, which is what every page looks like until
       * somebody changes one: its stack is `DEFAULT_STACK`, and so, on arrival,
       * is what is on screen.
       *
       * This used to send what was on screen regardless, and a paint canvas
       * connecting founded the stack anyway (`ensurePlate`) — so every page
       * anybody turned to was written on for being looked at. Now the default
       * is taken as agreed and nothing is sent, and the page's rows are written
       * the first time somebody changes something: an edit here (see `flush`),
       * a stroke (`paint.appendMany`), or a preset, which founds every page
       * that has none before it arranges them.
       *
       * What is on screen is still sent when it is *not* the default, because
       * then it is something the server does not know: a stack carried here
       * from a local workspace moved to the cloud, which goes up a page at a
       * time as each is shown, or one a project file brought — whose claim is
       * spent here like anywhere else.
       */
      const claim = writable.value && claimed.value.includes(pageKey.value ?? '')

      if (claim) release(pageKey.value)

      if (writable.value && (claim || shape.value !== DEFAULT_SHAPE)) {
        await send(asked, layers.value)

        return
      }

      // No rows, so no row ids — and the last page's must not stand in for them.
      remember([])
      sent.set(asked, DEFAULT_SHAPE)

      return
    }

    /*
     * Unless this page's stack arrived with it, in which case it wins over
     * whatever is filed — see `claimStack`.
     *
     * The branch above is nearly this case and cannot cover it, because the
     * server may well hold rows by the time a pull happens. It used to be
     * certain to: `ensurePlate` founded a page's whole `DEFAULT_STACK` the
     * moment a paint canvas connected, within a tick of the pages appearing, so
     * an imported stack lost a race it could not win — the default was planted,
     * read back here, and assigned over the reader's own rows. On a workspace
     * with a server record that took every sheet, group, adjustment and
     * **placed image** out of the file, which is the one kind of row whose
     * bytes cannot be made again. Looking no longer founds anything, but a
     * stroke or a preset still can, and the claim still has to win over them.
     */
    if (writable.value && claimed.value.includes(pageKey.value ?? '')) {
      release(pageKey.value)

      await send(asked, layers.value)

      return
    }

    remember(stored)

    const built = build(stored)

    if (!built.length) return

    layers.value = built

    // Taken as agreed, so applying what the server just said does not read as
    // an edit and get sent straight back — the echo the block sync had to be
    // taught the same lesson about.
    sent.set(asked, JSON.stringify(layerDrafts(built)))
  }

  /**
   * Somebody else's hand on an adjustment slider.
   *
   * Applied to the stack so the canvas redraws through the ordinary path — an
   * adjustment is a standing instruction the plates read, and there is no
   * second way to preview one — and then immediately taken as agreed.
   *
   * That last step is the whole of it. Without it the arriving value looks
   * exactly like an edit made here: `shape` moves, the watcher settles, and
   * this browser writes back a number it did not choose, mid-drag, fighting the
   * hand that is actually on the slider. Marking it agreed says "this came from
   * the record's direction, not towards it". Whoever is dragging owns the value
   * and their own settle writes it; the change notice that follows brings this
   * browser the version that was actually kept.
   */
  onSwarmLive((room, from, live) => {
    if (room !== workspace.value || live.kind !== 'adjust') return

    setLayer(live.uid, { adjust: live.adjust as Adjustment })

    // Only over an agreement already in hand. Recording one here for a page
    // that has not been read back would make the default it was opened with
    // look agreed — see `sent`.
    if (pageId.value && sent.has(pageId.value)) sent.set(pageId.value, shape.value)
  })

  /*
   * An edit is the stack moving *on the same page*. Turning the page moves it
   * too — `layers` is the page's own stack — and that is not an edit: it is
   * arriving somewhere, and what the page should show is `pull`'s to say.
   * Treated as an edit, arriving at a page this tab had not agreed with the
   * server scheduled a save of whatever this tab happened to hold for it; after
   * a preset applied elsewhere, that was the arrangement from before the preset.
   */
  watch([shape, writable, arrival], (now, before) => {
    if (now[2] !== before[2]) return

    flush()
  })

  // Once the workspace is known — the stack belongs to it, and before `shared`
  // lands there is nothing to ask about.
  watch(standing, (now) => { if (now) pull() }, { immediate: true })

  /*
   * And again whenever the page turns, because half the stack is about the page.
   *
   * A settle still waiting is sent first, against the page it was made on. A
   * sheet added and a page turned inside the same six hundred milliseconds would
   * otherwise fire the old timer *after* the new page's rows had landed, saving
   * page one's sheet against page two — and, worse, saving it as the deletion of
   * whatever page two had of its own. Dropping the timer instead would be safe
   * and would quietly lose the sheet, which is not better.
   */
  watch([pageId, epoch], ([now, opened], [was, before]) => {
    if (now === was && opened === before) return

    if (timer) {
      clearTimeout(timer)
      timer = null

      // Against the page it was drawn on, with that page's rows — see `pending`.
      sendPending()
    }

    // The chapter opened again: every page is a new one on the default stack,
    // so nothing agreed before describes what is held now — see `sent`.
    if (opened !== before) sent.clear()

    pull()
  })

  // The stack alone: a notice about it says nothing about the paint, which has
  // notices of its own.
  onSwarmChange((room, change) => {
    if (room !== workspace.value || change.scope !== 'layers') return

    pull(false)
  })

  onScopeDispose(() => {
    if (timer) clearTimeout(timer)
  })
}
