/**
 * Somebody else's edit, arriving.
 *
 * `useBlockSync` and `useTranslationSync` are this file's mirror image and were
 * for a long time the whole of the story: they watch what is on the page and
 * push it at the server, and nothing ever came back. Every browser therefore
 * rendered the snapshot it fetched when it walked in — `useOcr.restore` and
 * `useShared.look`, once each, on mount — so a block moved in one tab was
 * invisible in the next until somebody reloaded. Two tabs of the *same person*
 * on the *same workspace* disagreed, which is the shape the bug was reported in.
 *
 * ## A notice, and then a read
 *
 * The server does not send the change. It sends word that a page's blocks, or a
 * page list, or a surface's log has moved — see `SwarmChange` — and this goes
 * and re-reads it through the endpoint that was already there.
 *
 * That is one round trip more than pushing the row would cost, and it buys the
 * thing worth having: there is exactly one description of a block on the wire,
 * the one the endpoint already speaks, so there is no second encoding to keep in
 * step with `shared/schemas` and no merge rule living out on the socket. The
 * database stays the only thing anybody argues with.
 *
 * It also means a missed notice is survivable rather than corrupting. Nothing
 * here is a delta applied to a base; every apply is "what does the server say
 * this page is now", so a browser that slept through three edits catches up on
 * the fourth.
 *
 * ## What the reader is holding is not taken from them
 *
 * The rule is remote-wins, with two exceptions, and both are about a block that
 * would be pulled out from under somebody's hands:
 *
 * - anything in the selection, because a block being dragged or nudged is one
 *   whose local numbers are newer than the server's by definition; and
 * - the block a caret is inside, because the canvas editor finds what it is
 *   typing into by looking its id up on every keystroke — swap it and the
 *   sentence goes nowhere. That is why `writing` had to become shared state.
 *
 * Neither is a merge. The held block keeps its local shape and the next settle
 * of `useBlockSync` sends it, so letting go of it is what finally lets the other
 * person's version through — last writer wins, with the hand on the mouse
 * counting as the later one.
 *
 * ## Blocks the server has never heard of stay
 *
 * A block placed with the Text tool is `text:…` until `useBlockSync.create`
 * gives it a row, and that takes a settle plus a round trip. A remote-wins apply
 * landing in that window would replace the page with rows that cannot include
 * it, and the block would be gone — not unsaved, *gone*, along with anything
 * typed into it. So the row-less ones are carried across every apply.
 *
 * ## Strokes are somebody else's problem already
 *
 * Nothing here reads a stroke. `useUndo.bump` marks a surface's log as moved and
 * `useMaskEdits` already watches for that — its own comment says a peer's
 * correction is the same event as an undo from this browser's point of view, and
 * it was right; there was simply nothing raising it from a peer. This is what
 * raises it. `Paint.vue` refreshes itself the same way, for its own surface.
 */
// Imported rather than auto-imported: a dev server already running does not
// learn a new export of an existing file until it is restarted.
import { arrived } from '~/composables/useBlockSync'
import { rowOf } from '~/utils/ocr/blocks'

/**
 * How long to sit on a notice before acting on it.
 *
 * Shorter than the sync composables' settle and doing a different job. Theirs
 * swallows a gesture; this one swallows a *burst* — one balloon dragged across
 * a page is a patch per settle at the far end, so a handful of notices for the
 * same page arrive in convoy and one read answers all of them. Short enough that
 * an edit still feels live.
 */
const SETTLE = 250

/**
 * Tell the two push-watchers that the page and the server now agree.
 *
 * Without this the arrival is indistinguishable from an edit: neither watcher
 * has ever sent these rows, so both find them changed and send back exactly
 * what they were just handed — see the note on `sent` in `useBlockSync`. One
 * wasted write per peer per edit, each raising a notice of its own.
 *
 * Out here rather than inside `useLiveSync` because a notice is not the only
 * way the server's rows arrive. `useOcr.restore` puts a whole chapter's on the
 * pages when it opens, and it never agreed to any of them — so every open of a
 * chapter rewrote the page on screen, block by block and its translations
 * after, with exactly what it had just read. Harmless to the rows; not to
 * everybody else: each write raised a notice, and every other tab on the
 * chapter re-read the page. With many tabs open, each one opening made all the
 * others work. `useOcr.persist` is the third way, a reading's reply, and was
 * the last to come here: it agreed to nothing, so every reading was followed
 * by a patch per block and a delete per row it had replaced.
 *
 * The blocks are `useBlockSync.arrived`, which also takes the page's rows as
 * settled — so a row that left the page on the way is never read as deleted —
 * and says whether it may be appended to. Once, there, for every arrival; this
 * used to agree the blocks and leave the settling to each caller, and the one
 * that forgot was the one that did the damage.
 *
 * `held` blocks are left out on purpose. Their local numbers really are newer
 * than the server's — that is the whole of what holding means — so they must
 * stay un-agreed and go up on the next settle. Leaving them out is not an
 * oversight to be tidied away; it is how letting go of a block finally sends
 * where it was put.
 *
 * `epoch` is the open of the chapter the page belongs to — see `held` in
 * `useBlockSync`, which is keyed by it for the data loss that keying ended.
 */
export function agreeArrived (
  epoch: number,
  here: ComicPage,
  scan: { width: number, height: number },
  locale: string,
  held: (blockId: string) => boolean = () => false,
) {
  arrived(epoch, here, scan, held)

  // Translations are the other table and so the other agreement — top level
  // only, which is the rule `useTranslationSync` states: a balloon holds the
  // line, its columns hold only their own reading.
  //
  // Under the language they were read in, which the caller passes because it
  // is the one `toBlocks` was given: what is being agreed to is this locale's
  // row and not the one that was on screen a moment ago.
  for (const block of here.blocks) {
    const row = rowOf(block)

    if (!row || held(block.id)) continue

    agreedTranslation(locale, translationEntry(block, row, scan))
  }
}

export function useLiveSync () {
  const route = useRoute()
  // `epoch` because `settled` records what a page held *in this open of the
  // chapter* — see `held` in `useBlockSync`, and the losses that keying fixed.
  const { pages, selection, writing, setBlocks, epoch } = useComic()
  const { shared, refresh, align, showMissing, pageRowOf } = useShared()
  const { discard } = useLibrary()
  const { target } = useTargetLanguage()
  const { bump } = useUndo()

  const workspace = computed(() => String(route.params.workspaceId ?? ''))

  /** Pages with a read already scheduled, by row id, so a burst is one fetch. */
  const due = new Map<number, ReturnType<typeof setTimeout>>()

  // A page's cleaning, on its own timers: a chapter cleaned in one go sends a
  // notice a balloon, and a page wants one re-read for all of them.
  const { refreshRepairs } = useClean()
  const cleaning = new Map<number, ReturnType<typeof setTimeout>>()

  /** And the same for the page list, which has no id to key on. */
  let listing: ReturnType<typeof setTimeout> | null = null

  /**
   * The open page a row id belongs to.
   *
   * Through `pageRowOf` rather than a map of its own, because that function is
   * the one answer to "which row is this page" — by hash first, by path second
   * — and a second lookup written here would be a second opinion about it.
   *
   * Null for a page this browser does not hold, which is the ordinary case for
   * a collaborator's chapter: the record of a page arrives long before its
   * bytes do, and there is nothing to draw an edit onto until they have been
   * fetched peer-to-peer.
   */
  function pageOf (pageId: number): ComicPage | null {
    return pages.value.find((candidate) => pageRowOf(candidate) === pageId) ?? null
  }

  /** Whether a block is one the reader would notice being replaced. */
  const held = (id: string) => id === writing.value || selection.value.includes(id)

  /**
   * The server's blocks, with the ones this browser is busy with left as they
   * are — see the header.
   *
   * Recursive, because a balloon's columns are blocks like any other and one of
   * them can be selected on its own. A held parent keeps its children with it:
   * the local copy of a balloon being dragged is a coherent thing and taking
   * half of it from each side would be neither version.
   */
  function reconcile (incoming: Block[], mine: Map<string, Block>): Block[] {
    return incoming.map((block) => {
      const local = mine.get(block.id)

      if (local && held(block.id)) return local

      return block.children?.length
        ? { ...block, children: reconcile(block.children, mine) }
        : block
    })
  }

  /** Every block on a page including the ones inside balloons, by id. */
  function index (list: Block[], into = new Map<string, Block>()): Map<string, Block> {
    for (const block of list) {
      into.set(block.id, block)

      if (block.children?.length) index(block.children, into)
    }

    return into
  }

  /** See `agreeArrived`, which this is for everything arriving from a notice. */
  const agree = (here: ComicPage, scan: { width: number, height: number }) =>
    agreeArrived(epoch.value, here, scan, target.value, held)

  /**
   * Re-read one page's blocks and put them on it.
   *
   * The same fetch and the same conversion `useOcr.restore` does — deliberately
   * the same, because a page rebuilt two ways is a page that will eventually be
   * rebuilt two *different* ways. What this adds is the reconciliation above and
   * the row-less carry, neither of which `restore` needs: it only ever fills a
   * page that is empty.
   *
   * Not what a change of *target language* wants, and that is worth saying here
   * because it looks like the same errand. A switch changes nothing about which
   * blocks a page has — only which of each block's translation rows is the one
   * being looked at — so re-reading the page to answer it puts the whole list
   * through a rebuild that can add and drop rows for a question that was never
   * about them. On a chapter holding blocks no server row stands behind, which
   * `unfiled` below carries on purpose, it doubles every balloon on screen. See
   * `useTranslationSync.relocalise`, which patches the three fields that
   * actually change and touches nothing else.
   */
  async function reread (pageId: number) {
    const here = pageOf(pageId)

    if (!here) return

    const rows = await $fetch<StoredBlock[]>(
      `/api/workspaces/${workspace.value}/pages/${pageId}/blocks`,
    ).catch(() => null)

    if (!rows) return

    // Looked up again after the await. A chapter's pages turn and readings land
    // while this is in flight, and the page may not be the one it was.
    const still = pageOf(pageId)

    if (!still) return

    // The workspace's record of the shape stands in where there is no scan to
    // ask — a page whose picture is on somebody else's machine still receives
    // everybody's edits, and its boxes are shares of a page box either way.
    //
    // Measured first where there *is* a scan. A notice arrives for every page
    // somebody touches, including ones this browser has not drawn, and
    // converting those at the guessed shape — then agreeing to the result — is
    // how a save on the next visit sent them all back shrunk. See `sized`.
    const scan = await sized(still)

    // And looked up once more, because that was another await.
    if (pageOf(pageId) !== still) return

    const incoming = toBlocks(rows, scan, target.value)

    const mine = index(still.blocks)

    // The ones no row stands behind yet — placed by hand a moment ago, or read
    // while the workspace was still nobody's. They cannot be in `rows` and
    // dropping them would lose work that has not had time to be saved.
    const unfiled = still.blocks.filter((block) => rowOf(block) === null)

    setBlocks(still.id, [...reconcile(incoming, mine), ...unfiled])

    // After the page has been set, not before: the agreement is about the list
    // as it now stands, and a block's index in that list is part of what was
    // agreed.
    //
    // It also takes the rows the page now holds as read rather than diffed. A
    // block that is no longer here left because the server said so, and telling
    // the server about it would be this browser deleting rows on the strength of
    // having just been told they were gone. `settled` argues the case at length;
    // it is the difference between a bad read costing a redraw and a bad read
    // costing everybody's blocks. It is inside the agreement now — see
    // `arrived` — so that no way of the server's rows arriving can leave it out.
    agree(still, scan)
  }

  /**
   * Re-read the chapter's page list — one added, removed, renamed, reordered.
   *
   * The removals are the half that has to be *acted* on rather than merely
   * noted, and leaving them out was a bug with a long tail. A page deleted in
   * one browser stayed open in every other one; `pages.sync` is additive by
   * design, so the next thing any of those browsers pushed — a drop, a
   * reorder, a blank page — wrote the row straight back. The browser that did
   * the deleting then saw a page it was missing, fetched it from the browser
   * that had never let go, and got it back. The delete looked like a button
   * that did nothing.
   *
   * It cost more than the page, too: the re-created row is a *new* row, so the
   * blocks, translations and cleaning that cascaded away with the old one do
   * not come back with it. One browser goes on showing the reading it still
   * holds while the other shows an empty page, and no amount of reloading
   * settles it, because the two are no longer talking about the same row.
   */
  async function relist () {
    // Held before the refresh, because the whole question is what stopped being
    // there — and by row id, which is the only identity that cannot be confused
    // with a page that merely got renamed or moved.
    const before = shared.value?.pages ?? []

    await refresh()

    const kept = new Set((shared.value?.pages ?? []).map((row) => row.id))
    const gone = before.filter((row) => !kept.has(row.id))

    for (const row of gone) {
      // Matched the way everything matches a row to a page — `rowOfPage`, from
      // the page's side. A page this browser never held is simply not found,
      // which is the ordinary case for anybody who has not fetched the chapter.
      //
      // Asked page-first rather than row-first on purpose: two pages can share
      // a hash, so "which page is this row" has no answer while "which row is
      // this page" always does.
      const here = pages.value.find((page) => rowOfPage([row], page))

      // Locally only: the row has already gone, and saying so again would
      // answer 404 and be reported to this reader as a failure to delete
      // something they did not delete.
      if (here) await discard(here.id, false)
    }

    // Into this browser's own order, which is what `align` is for. Without it a
    // page somebody else moved is in the right place in `shared` and the wrong
    // one on screen, and the two disagree until the next reload.
    align()

    // And the pages somebody else added, which this browser has no file for.
    // A page is only ever *seen* to be absent here: it arrives as a change
    // notice about a chapter that has grown, and without this it would be a row
    // nothing on screen accounts for until the next reload — which is the shape
    // the old empty canvas had, one page at a time.
    showMissing()
  }

  onSwarmChange((room, change) => {
    // Notices arrive for every workspace this browser is a peer in — it seeds
    // chapters it is not looking at, which is the whole point of the hub — and
    // only the open one has anything on screen to bring up to date.
    if (room !== workspace.value) return

    if (change.scope === 'pages') {
      if (listing) clearTimeout(listing)

      listing = setTimeout(() => {
        listing = null
        relist()
      }, SETTLE)

      return
    }

    // The stack is `useLayerSync`'s, which listens for itself — the same
    // division `Paint.vue` follows for its own surface. Named here rather than
    // left to fall through, because everything below this point is about a page
    // and a layer notice does not carry one.
    if (change.scope === 'layers') return

    // Neither does the cast or the glossary, and they have their own listeners
    // for the same reason the stack does — `useCast` and `useGlossary` each
    // hold one list and know when to re-read it. They are named rather than
    // left to fall through because the fall-through below reads `pageId`, and
    // a chapter-wide notice has none: without this the first term anybody
    // learned would have set a timer keyed on `undefined`.
    if (change.scope === 'cast' || change.scope === 'glossary') return

    // A repair kept or taken back — `useClean` compares the page's repairs with
    // the server's and fetches only what differs.
    if (change.scope === 'repairs') {
      const pageId = change.pageId

      clearTimeout(cleaning.get(pageId))
      cleaning.set(pageId, setTimeout(() => {
        cleaning.delete(pageId)
        refreshRepairs(pageId).catch(() => {})
      }, SETTLE * 4))

      return
    }

    if (change.scope === 'strokes') {
      // Straight through, no settle: a stroke is already one write per mark and
      // the version bump is cheap. What it sets off — `useMaskEdits`' watcher,
      // or `Paint.vue`'s refresh — does its own coalescing.
      bump(change.surfaceId)

      return
    }

    // Blocks and translations are one fetch: `blocks.onPage` hands back each
    // block with what it has been translated to, so asking twice would be two
    // round trips for one page. The locale is not checked against the one being
    // worked in either — `toBlocks` picks the right row out of what comes back,
    // and a notice about a language nobody here is reading costs one read that
    // changes nothing.
    const pageId = change.pageId

    clearTimeout(due.get(pageId))
    due.set(pageId, setTimeout(() => {
      due.delete(pageId)
      reread(pageId)
    }, SETTLE))
  })

  // Nothing to unhook for `onSwarmChange` itself — it takes itself off the list
  // when this scope ends. The timers are ours.
  onScopeDispose(() => {
    for (const timer of due.values()) clearTimeout(timer)
    for (const timer of cleaning.values()) clearTimeout(timer)

    if (listing) clearTimeout(listing)
  })
}
