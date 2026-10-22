/**
 * Getting a changed block back to the row it came from.
 *
 * Until now a reading was pushed once, whole, and nothing after that ever
 * reached the server: moving a balloon, turning it, retyping its source or
 * correcting its kind all lived in this browser and died with the tab. The row
 * has always had somewhere to put every one of those — `cx`, `cy`, `w`, `h`,
 * `angle`, `skew_x`, `skew_y`, `quad` — so this is plumbing, not a new idea.
 *
 * Watched rather than called from each place that edits. There are a dozen of
 * those already — the transform tool, the nudge keys, the block list, the text
 * panel, the type menu — and a save that has to be remembered at each is a save
 * that will be forgotten at the next one. Watching the blocks means the rule is
 * "a block that differs from what the server has, goes", stated once.
 *
 * The row is mutable and keeps no history. Undo lives in the browser and
 * re-sends the earlier numbers through the same path, which is why there is no
 * second way in here for it: an undone block is just a changed block.
 *
 * ## Blocks that have no row yet
 *
 * Patching assumes a row, and two kinds of block arrive without one: a block
 * placed with the Text tool, which is `text:…` because nothing has ever filed
 * it, and a reading taken while the workspace was still nobody's, which is
 * `read:…` for the same reason. Both reached IndexedDB and came back after a
 * reload, so they looked saved; neither ever reached the `blocks` table, so
 * neither was ever visible to anybody else in the workspace.
 *
 * So this makes rows for them and puts the ids back on the blocks. It is the one
 * place a row-less block on the page becomes a filed one, deliberately, because
 * a second way is a second way for it to go wrong — which is why a reading on a
 * cloud workspace no longer sits on the page row-less while its PUT is out:
 * `useOcr.persist` puts it there as the rows the server answered with (see
 * `rewriting`). Everything downstream keys off a block's id being `block:<n>`
 * — patches here, the merge that makes balloons, the mask a cleaner authors —
 * so the swap is not bookkeeping, it is what joins the block to its row.
 *
 * ## A page at a time
 *
 * A settle's patches go up as one request per page (`patchPage`), where each
 * block used to be a PATCH of its own — three to five hundred of them for a
 * chapter's worth of edits, each raising a change notice for every other tab.
 * The server writes a page's patches in one transaction and refuses them
 * together, so the two things a single PATCH got for free have to be kept on
 * purpose here: a row somebody else deleted must not take the rest of the page
 * down with it (see `patchPage`), and nor must a row the server would refuse on
 * sight (see `fits`).
 */
import { blockPatchSchema } from '#shared/schemas/workspace'
import { rowOf, toDraft, toPatch } from '~/utils/ocr/blocks'

/** What goes up for one row: the whole block, as `toPatch` has it. */
type Patch = ReturnType<typeof toPatch>

/**
 * How long a block has to sit still before it is sent.
 *
 * A drag is a hundred changes a second and every one of them is a real edit;
 * sending each would be a hundred writes for one gesture, and the last would
 * still be the only one that mattered. Long enough to swallow a drag, short
 * enough that letting go and closing the tab does not lose it.
 */
const SETTLE = 500

/**
 * What was last agreed with the server for each row, keyed by row id.
 *
 * At module level, and not because two components need it — this composable is
 * mounted once, from the workspace page. `useLiveSync` needs it, and the reason
 * is worth spelling out because the symptom is invisible from inside this file.
 *
 * A block read back because somebody else changed it is, by definition, already
 * in agreement with the server. The watcher below cannot know that: it sees the
 * page change shape and finds a row it has never sent, so it sends it — and what
 * it sends is exactly what it was just handed. That is a wasted write per peer
 * per edit, and each of those raises a notice of its own, so a workspace with
 * three people in it paid a write per peer *per peer*. Worse than the traffic:
 * a browser echoing back a copy of what it read is a browser that can overwrite
 * a newer edit it has not heard about yet.
 *
 * Row ids are unique across workspaces so nothing here collides, and it is
 * emptied on the way into a different chapter regardless — a stale agreement is
 * worse than a missing one, because it silences a real change rather than
 * causing a spare one.
 */
const sent = new Map<number, string>()

/**
 * Rows known to be deleted on the server: by this browser, past the settle, or
 * by somebody else — a patch answered 404.
 *
 * What `revive` looks for. Undo is local, so a block deleted a moment too long
 * ago came back on the page still carrying the id of a row that no longer
 * existed, and everything this file then sent for it was refused: its moves as
 * 404s, and — because the translations endpoint turns the whole page away over
 * one block it cannot find — every later translation edit on that page. All of
 * it silently, a console warning apiece, while the page on screen looked fine.
 */
const gone = new Set<number>()

/**
 * Note that a row and the block on the page now say the same thing.
 *
 * For `useLiveSync` to call as it applies what the server gave it, so that the
 * arrival is not mistaken for an edit. Deliberately not exported as the map
 * itself: the only safe thing to do to it from outside is agree.
 */
export function agreed (row: number, patch: ReturnType<typeof toPatch>) {
  sent.set(row, JSON.stringify(patch))
}

/**
 * The rows each page was last seen holding, so a row that disappears can be
 * told apart from a row that was never here.
 *
 * Keyed by page, which is the whole of why it is a map rather than a set.
 * Turning to page four replaces every block on screen with different ones —
 * diffed against one flat list that reads as "page three's twelve blocks have
 * all been deleted", and a page turn would have sent twelve deletes. A page is
 * only ever compared with itself.
 *
 * At module level alongside `sent`, and for a sharper reason than that one:
 * see `settled`.
 *
 * ## Keyed by the *chapter* as well as the page, and that is not tidiness
 *
 * A page's id is `scan:<path>` — the reader's own folder and nothing more — so
 * opening the same chapter again gives every page the same key it had before.
 * `openImages` builds its pages with `blocks: []`, because a scan is a picture
 * until something has read it, and the blocks arrive afterwards from
 * `useOcr.restore`. In between there is a `flush` that sees a page it recognises
 * holding nothing, and every row the *previous* open had loaded is a row that
 * has left the page.
 *
 * That is the whole bug. It destroyed two workspaces' finished work on
 * 2026-08-09 and matches the two unexplained losses from 2026-08-03: a run of
 * one DELETE per block, a moment after a chapter was opened into a workspace
 * whose pages already had rows. `forgetAgreed` was the only thing that cleared
 * this map, and it is wired to a change of *workspace*, which this is not.
 *
 * So the key carries `useComic`'s `epoch`, which is bumped by every path that
 * replaces the pages — `openImages` and `reset`. A re-opened page has a key
 * nothing has ever written, so it is a page never seen rather than a page
 * emptied, and nothing is deleted. The old entries are left to be cleared with
 * everything else on the way out of the workspace; they are a set of numbers
 * per page and cost nothing to abandon.
 *
 * Keying on the epoch rather than clearing on open is deliberate: it holds for
 * paths nobody has thought of yet. Anything that replaces the pages has to bump
 * the epoch — that is already true of `epoch`'s own contract, because the OCR
 * and translate runs use it to notice a chapter closing underneath them.
 */
const held = new Map<string, Set<number>>()

/** The key `held` and `appendable` are kept under — see `held`. */
const keyOf = (epoch: number, pageId: string) => `${epoch}:${pageId}`

/**
 * Every block on the page including the ones inside balloons.
 *
 * A balloon's columns are rows of their own — see `blocks.parentId` — so they
 * are edited, moved and saved like any other block. They are simply not in
 * the top-level list, and a save that walked only that list would drop every
 * correction made to a column.
 *
 * The parent comes before its children, so the index each gets here is stable
 * and is the `position` written for it.
 */
const flatten = (list: Block[]): Block[] =>
  list.flatMap((block) => (block.children?.length ? [block, ...block.children] : [block]))

/** The rows a page holds, columns and all. */
const rowsIn = (here: ComicPage): number[] =>
  flatten(here.blocks).map(rowOf).filter((row): row is number => row !== null)

/**
 * Whether the server would take this patch at all — its own schema, asked
 * before the request rather than by it.
 *
 * A page's patches go up together and are refused together, so one row the
 * schema turns away — a block dragged past the bound on a very tall page, a
 * source pasted in longer than a row holds — would take every other edit on the
 * page down with it, on every settle until that one block changed. Sent one at
 * a time, only that row failed. Asking first keeps it that way: the row that
 * cannot be saved is not, with a warning, exactly as before, and the rest of the
 * page is.
 *
 * The same schema the endpoint parses with, so this cannot come to disagree
 * with it.
 */
function fits (row: number, patch: Patch): boolean {
  const checked = blockPatchSchema.safeParse(patch)

  if (!checked.success) console.warn(`[kemolate] block ${row} not saved:`, checked.error.issues)

  return checked.success
}

/**
 * Take the rows a page now holds as read, without calling any of them deleted.
 *
 * This is the guard that keeps a mistake from becoming data loss, and it is
 * worth being blunt about the asymmetry it closes. `flush` treats a row that has
 * left the page as a deletion and sends a DELETE — which is right when the
 * reader deleted a block, and catastrophic when the block left for any other
 * reason. `useLiveSync` replaces a page wholesale from what the server says is
 * on it, so *anything* that makes that read wrong — a page id resolved to the
 * wrong local page, a chapter holding two pages with identical bytes and so
 * identical hashes — arrives here as "every block on this page just vanished",
 * and the next flush would faithfully delete every one of them from under
 * everybody else.
 *
 * So the rule is: a change that came *from* the server never sends a delete
 * back *to* it. The worst a bad read can then do is leave a page looking empty
 * until it is read again, which is a glitch rather than somebody's afternoon.
 */
export function settled (epoch: number, pageId: string, rows: number[]) {
  held.set(keyOf(epoch, pageId), new Set(rows))
}

/**
 * Which rows have left this page since it was last looked at — and record what
 * it holds now.
 *
 * Lifted out of `flush` so the one decision that can destroy data is reachable
 * on its own. Everything around it is plumbing that a test would have to stand
 * up a workspace to exercise; this is the whole of the judgement, and it is two
 * lines.
 *
 * The empty answer for a page never seen is the fix, stated once: a key with no
 * entry means *nothing is known about this page yet*, which is true of a page
 * the chapter has just been opened onto and false of a page somebody emptied.
 * Conflating those cost two workspaces their finished work.
 */
export function departed (epoch: number, pageId: string, rows: Set<number>): number[] {
  const key = keyOf(epoch, pageId)
  const before = held.get(key)

  held.set(key, rows)

  return before ? [...before].filter((row) => !rows.has(row)) : []
}

/**
 * Forget everything agreed with the last workspace — see `useWorkspaceReset`,
 * which is the one caller.
 *
 * All three of these outlive the page component, which is the point of their
 * being at module level, and none of them may outlive the workspace. `sent` is
 * the mildest: row ids are unique across workspaces, so a stale agreement only
 * silences a change that was never going to be about the same row. `held` and
 * `appendable` are keyed by *page* id — `scan:<path>` — which is the reader's
 * folder and nothing more, so the same chapter opened in two workspaces gives
 * the same keys twice. A carried-over `held` reads as "every row this page used
 * to hold has just been deleted" and `flush` would faithfully send a DELETE for
 * each of them, against the other workspace's rows.
 *
 * This used to be `watch(workspace, …)` here, which cannot fire: the workspace
 * page is keyed on its address (`definePageMeta`), so walking from one to
 * another destroys this composable's scope and builds a new one that has only
 * ever seen the new id. The watcher was disposed before it could notice.
 */
export function forgetAgreed () {
  sent.clear()
  held.clear()
  appendable.clear()
  gone.clear()
  rewrites.clear()
}

/**
 * Pages this browser is sure it can append to without saying anything twice.
 *
 * Appending is the one request here that cannot be taken back by repeating it,
 * and a page full of `read:` blocks looks identical in two very different
 * situations: nothing was ever saved for it, or `useOcr.restore` failed to
 * fetch what was and `useBlockCache` filled the page from this browser's own
 * copy. Appending in the second case doubles the page for everybody.
 *
 * A page holding even one `block:` id proves the restore landed. A page holding
 * none is asked, once, before anything is added to it. The answer is kept
 * because it cannot change underneath us — `restore` and the cache both only
 * ever fill a page that is *empty*, and one with blocks on it is not.
 *
 * ## Told, as well as asked
 *
 * A reading is the one thing that does change it underneath us. Its PUT
 * replaces the page's rows, and a question put while that was in the air was
 * answered by a server half-way through writing it: "empty", and the reading
 * was appended a second time; "not empty", and that was kept for the session —
 * no block placed on the page by hand was ever saved again. So the page says
 * what it knows when it knows it: `arrived` opens a page that now holds the
 * server's rows and nothing else, a reading the server refused closes one
 * (`rewriting`), and a question answered after either defers to it.
 *
 * At module level beside the other two so that `forgetAgreed` can reach it; the
 * answer is about a page in a workspace, and neither half of that survives a
 * change of address.
 */
const appendable = new Map<string, boolean>()

/**
 * Pages a reading is being written over right now, under the key `held` uses.
 *
 * `useOcr.persist` puts a cloud page's reading on it only once the server has
 * answered — see there for why — so for the length of the PUT the page on
 * screen is the one about to be replaced. A row made for anything on it in that
 * window is a row the reading then takes off the page, and whether the server
 * keeps it depends on which of the two requests it handled first: a race this
 * browser sees neither end of, and the loser is a box on the server that nothing
 * on this page names. So `create` leaves the page alone until the answer, and a
 * block placed by hand meanwhile goes with the rest of the page when the reading
 * lands — which is what reading a page means.
 */
const rewrites = new Set<string>()

/**
 * A reading about to be written over a page — `useOcr.persist`, around its PUT.
 *
 * Holds `create` off the page until `end`, and notes the rows the page holds as
 * the reading goes. Every one of those existed before the PUT was sent, so every
 * one is deleted by it if it lands; nothing the page gains while it is out can
 * be said to be, which is why the note is taken now and not when it answers.
 * How it went is then said with `written` or `refused` — the two things about a
 * reading's answer that `arrived`, which is all the rest of it, cannot know.
 *
 * One reading at a time is `useOcr`'s rule, so a page is only ever being
 * rewritten once and a set is enough.
 */
export function rewriting (epoch: number, here: ComicPage) {
  const key = keyOf(epoch, here.id)
  const before = rowsIn(here)

  rewrites.add(key)

  return {
    /**
     * The server took it: the rows the page held are gone, and noted as gone.
     * `drop` then sends nothing for one still waiting out its settle — a block
     * the reader deleted while the PUT was out — and a block undo brings back
     * under one of those ids is made a row again by `revive` rather than
     * patched into a 404.
     *
     * Only these, never a row the page gained meanwhile: a block somebody else
     * placed and a notice read in while the PUT was out may have been written
     * after the reading, and is theirs.
     */
    written (now: ComicPage) {
      const kept = new Set(rowsIn(now))

      for (const row of before) if (!kept.has(row)) gone.add(row)
    },

    /**
     * It did not, and the reading is on the page anyway, as blocks no row
     * stands behind. The server still has the reading it had — or this very
     * one, when the PUT landed and only its answer was lost — so:
     *
     * - the rows that left the page were taken off by the reading, not by the
     *   reader, and are settled rather than deleted;
     * - the page is closed to appending until it is read again, which `arrived`
     *   opens. Appended, the reading would sit beside the server's — or on top
     *   of itself — and a block placed by hand would be saved beside a reading
     *   that is not the one on screen: half a page, with nothing saying so.
     *
     * So the reading is this browser's alone until the page is read again, and
     * the error `persist` shows says as much. Opening the chapter again shows
     * the server's reading in its place.
     */
    refused (now: ComicPage) {
      settled(epoch, now.id, rowsIn(now))
      appendable.set(keyOf(epoch, now.id), false)
    },

    /** Let `create` at the page again — always, in a `finally`, once the rest is said. */
    end () {
      rewrites.delete(key)
    },
  }
}

/**
 * A page now holds what the server says it holds: nothing on it is an edit.
 *
 * The block half of every way the server's rows reach a page — `useOcr.restore`
 * opening a chapter, `useOcr.persist` putting a reading's reply on the page,
 * `useLiveSync.reread` answering a notice — and reached through `agreeArrived`,
 * which adds the translations. The three used to do three different subsets of
 * it and the reading's reply did none, so every reading was followed by a PATCH
 * per block repeating what the PUT had just written, and every re-read of a page
 * by a DELETE per row it had replaced. Each raised a change notice for every
 * peer. One function, so the next arrival cannot be the one that forgets.
 *
 * Three things, all about the rows the page holds now:
 *
 * - `settled`: they are what the page holds, so no row that left it on the way
 *   is a deletion. A change that came *from* the server never sends a delete
 *   back *to* it — see `settled`, which argues the case.
 * - `agreed`: each row says what its block says, so no patch goes. The blocks
 *   `held` names are left out, because their local numbers are newer than the
 *   server's — that is what holding means — and must still go up.
 * - `appendable`, only where the page is now the server's rows and nothing
 *   else: anything row-less placed on it after this is new. A page still
 *   carrying row-less blocks keeps whatever answer it had — `useLiveSync`
 *   carries those across a re-read, and one may be a reading the server
 *   refused, which must stay closed.
 */
export function arrived (
  epoch: number,
  here: ComicPage,
  scan: { width: number, height: number },
  held: (blockId: string) => boolean = () => false,
) {
  const blocks = flatten(here.blocks)

  settled(epoch, here.id, rowsIn(here))

  for (const [at, block] of blocks.entries()) {
    const row = rowOf(block)

    if (row === null || held(block.id)) continue

    agreed(row, toPatch(block, scan, at))
  }

  if (blocks.every((block) => rowOf(block) !== null)) appendable.set(keyOf(epoch, here.id), true)
}

/**
 * Rows for every page's row-less blocks, from the one mounted instance.
 *
 * Everything else here works on the page on screen, which is right for keeping
 * up with edits and wrong for a chapter becoming a cloud workspace: its reading
 * was taken while there was nothing to write to, and page by page it would reach
 * the server only as each was visited. `useWorkspaceName.toCloud` asks for all
 * of it at once through `uploadChapterBlocks`, and this is how the request finds
 * the instance the workspace page mounted — a second `useBlockSync()` would be a
 * second set of watchers, which is the thing this file exists once to avoid.
 */
let uploadAll: (() => Promise<void>) | null = null

/** Give every page's row-less blocks a row — see `uploadAll`. */
export function uploadChapterBlocks (): Promise<void> {
  return uploadAll?.() ?? Promise.resolve()
}

export function useBlockSync () {
  const route = useRoute()
  // `epoch` because both page-keyed maps below are scoped to the chapter that
  // filled them — see `held`, which is where the data loss this closes is set
  // out. A page id is a file path and says nothing about which open it belongs
  // to.
  const { page, pages, selection, epoch, writing } = useComic()
  const { shared, pageRowOf } = useShared()
  const { renameBlock } = useUndo()
  const { carryLocal } = useMaskEdits()
  const cleaned = usePatchMap()

  const workspace = computed(() => String(route.params.workspaceId ?? ''))

  /** Each row's DELETE, waiting out its settle — see `drop`. Patches wait by page, in `outbox`. */
  const timers = new Map<number, ReturnType<typeof setTimeout>>()

  /**
   * Each page's patches waiting out the settle, by row, under the page's own
   * row — the address they go to — with the one timer that sends them.
   *
   * One timer for the page rather than one per row, and that changes nothing
   * about when anything goes. Every pass re-armed the timer of every row still
   * waiting — a drag of one balloon held back a neighbour that was finished with
   * a moment before, until the drag settled too — so the rows a page had
   * waiting always went within the same instant, as separate requests. Now they
   * go as one. What a row's own timer did that mattered — calling off its
   * DELETE when undo puts the block back — stays per row, in `timers`.
   *
   * A row stays until it is sent, found agreed, or deleted. A pass over the page
   * that does not find it leaves it be, as its own timer used to: a chapter
   * opened again shows every page empty before `restore` refills it, and a
   * patch still waiting then is an edit, not a page that was emptied.
   */
  const outbox = new Map<number, { patches: Map<number, Patch>, timer?: ReturnType<typeof setTimeout> }>()

  /** A row's waiting patch, called off wherever it waits — the block went with it. */
  const unqueue = (row: number) => {
    for (const waiting of outbox.values()) waiting.patches.delete(row)
  }

  /**
   * Blocks whose row is being made right now, under the id they have until it
   * arrives.
   *
   * `flush` watches a shape the block itself is part of, and a row-less block
   * sits in the list for the whole round trip. Without this, the next change to
   * *any* block on the page would find it still row-less and make it a second
   * row — and appending is not a request that can be repeated safely, so a page
   * would quietly end up holding two of everything the reader placed.
   */
  const making = new Set<string>()

  /**
   * One timer per page for the blocks on it that have no row.
   *
   * Through the same settle a patch waits out, and for a second reason on top
   * of that one. A page restored from the block cache gains thirty row-less
   * blocks in a single tick and the watcher fires on the way past; waiting
   * turns that into one request carrying thirty drafts, which is what the
   * endpoint takes an array for. Firing the instant the watcher first ran would
   * have made thirty.
   */
  const births = new Map<string, ReturnType<typeof setTimeout>>()

  /**
   * Whether this workspace can be written to at all.
   *
   * A workspace nobody has shared has no rows to patch, and a viewer has no
   * right to. Neither is an error worth showing — the page still works, it is
   * simply this machine's own — so the failure is silent and the watcher just
   * has nothing to do.
   *
   * The role is asked about rather than left to the server to refuse, which it
   * would: `editWorkspace` is what every one of these endpoints checks. A
   * viewer who nudges a balloon around their own copy of the page was
   * generating a 403 per settle, and each of those came out as a warning — a
   * page of them for a person who has not done anything wrong.
   */
  const writable = computed(() => Boolean(
    workspace.value && shared.value?.pages?.length && atLeast(shared.value.role, 'editor'),
  ))

  /**
   * This tab's peer id, so the server can leave it out of its own change notice.
   *
   * On every write here rather than on none, and it is an optimisation rather
   * than a rule: a browser that re-read its own edit would find exactly what it
   * already has. What it saves is the round trip, and — where the reader is
   * still dragging the block — a needless pass through `reconcile`.
   */
  const stamp = () => peerHeader(workspace.value)

  /** A page's waiting patches, off to the server once the settle is out — see `outbox`. */
  function sendPage (pageId: number) {
    const waiting = outbox.get(pageId)

    outbox.delete(pageId)

    if (!waiting) return

    // Gone while this waited out its settle, and a patch now could only be
    // refused — taking the rest of the page with it, since a page's patches are
    // refused together. A row waits until a pass finds it agreed, and a row a
    // reading took off the page is never found again: its neighbour's position,
    // shifted by a block deleted while the PUT was out, went up as a 404 after
    // the reading had replaced them both.
    const patches = [...waiting.patches].filter(([row, patch]) => !gone.has(row) && fits(row, patch))

    if (patches.length) patchPage(pageId, patches)
  }

  /**
   * Patches for a page's rows, in one request, and each one agreed when the
   * server says it has it.
   *
   * Agreed as sent, which is what agreeing a single PATCH always meant: the row
   * now says what this patch said. A block changed again while the request was
   * out is newer than that, so it still differs and still goes. Only the rows
   * the reply names — it names every one it wrote, and a row it did not name is
   * better sent twice than taken for saved.
   *
   * A page's patches are refused together, which one row's PATCH never had to
   * survive: a block somebody else deleted — a 404 naming it in `data.missing`
   * — would otherwise lose every other edit on the page with it. So the rows
   * the refusal names are noted as gone, exactly as a 404 on their own PATCH
   * would have been, and the rest are sent once more without them. A row noted
   * as gone is never sent again (see `sendPage`), so a page is not refused over
   * the same block twice.
   *
   * Anything else is dropped rather than retried, and noted rather than
   * swallowed: the blocks on screen are still what the reader arranged, and the
   * next thing they do will try again. A toast per failed keystroke would be
   * worse than the failure. This exact catch is why a 403 on a read-only
   * workspace does not turn into a page full of warnings.
   */
  async function patchPage (pageId: number, patches: [number, Patch][], again = true) {
    try {
      const stored = await $fetch<StoredBlock[]>(`/api/workspaces/${workspace.value}/pages/${pageId}/blocks`, {
        method: 'PATCH',
        body: { blocks: patches.map(([id, patch]) => ({ id, ...patch })) },
        headers: stamp(),
      })

      const asSent = new Map(patches)

      for (const { id } of stored) {
        const patch = asSent.get(id)

        if (patch) sent.set(id, JSON.stringify(patch))
      }
    } catch (error) {
      console.warn('[kemolate] blocks not saved:', error)

      const said = error as { statusCode?: number, data?: { data?: { missing?: unknown } } }
      const missing = said?.statusCode === 404 && Array.isArray(said.data?.data?.missing) ? said.data.data.missing : []
      const named = new Set(patches.map(([row]) => row))

      // Deleted by somebody else. Noted, so the next pass makes each block a
      // row of its own rather than patching a dead one for good — see `gone`.
      for (const row of missing) if (typeof row === 'number' && named.has(row)) gone.add(row)

      const rest = patches.filter(([row]) => !gone.has(row))

      if (again && rest.length && rest.length < patches.length) await patchPage(pageId, rest, false)
    }
  }

  /**
   * A row whose block is gone, after a moment's grace.
   *
   * Held back rather than sent at once, and the delay is doing real work here:
   * undo is local and instant, and there is no way to write a block back to
   * the id it had. So a deletion the reader takes back within the settle never
   * leaves the browser — the block reappears, `flush` finds its row again and
   * clears this timer. Past that window the row is gone for good, and undo
   * restores the block on the page but not in the workspace.
   */
  function drop (row: number) {
    // Already gone, which is what a revived block's old row is — see `revive`.
    if (gone.has(row)) return

    // A patch still waiting for the row goes with it: the block it described is
    // off the page. Undo inside the settle brings both back — `flush` finds the
    // row again, calls this timer off and patches it if it differs.
    unqueue(row)
    clearTimeout(timers.get(row))
    timers.set(row, setTimeout(async () => {
      timers.delete(row)
      sent.delete(row)

      // Gone while this waited — a reading written over the page took it with
      // the rest (see `rewriting`) — and a DELETE now could only be refused.
      if (gone.has(row)) return

      await $fetch(`/api/workspaces/${workspace.value}/blocks/${row}`, {
        method: 'DELETE',
        headers: stamp(),
      })
        .then(() => { gone.add(row) })
        .catch((error: unknown) => console.warn('[kemolate] block not deleted:', error))
    }, SETTLE))
  }

  /**
   * A block back on the page whose row is gone — undo, past the settle — made a
   * new block as far as the workspace is concerned.
   *
   * Its row cannot be had back: a deletion takes the row's translation and its
   * history with it. So the block drops the dead id for a local one, like a
   * block placed by hand, and the ordinary path makes it a row: `create` sends
   * it, `adopt` names it, and its translation goes up under the new name. The
   * rename is carried everywhere an id is held — undo, the repair, the
   * selection and the caret — for the reasons `adopt` gives.
   */
  function revive (here: ComicPage) {
    for (const block of here.blocks) {
      const row = rowOf(block)

      if (row === null || !gone.has(row)) continue

      const from = block.id
      const to = `text:${crypto.randomUUID().slice(0, 8)}`

      clearTimeout(timers.get(row))
      timers.delete(row)
      unqueue(row)
      sent.delete(row)

      block.id = to

      // A balloon's pieces went with it, and are made again with it.
      for (const child of block.children ?? []) child.id = `text:${crypto.randomUUID().slice(0, 8)}`

      renameBlock(from, to)
      cleaned.value = renamePatch(cleaned.value, here.id, from, to)

      if (selection.value.includes(from)) selection.value = selection.value.map((id) => (id === from ? to : id))
      if (writing.value === from) writing.value = to
    }
  }

  /**
   * A row that was made and cannot be given to anything — taken back at once.
   *
   * No settle, because there is nothing to change its mind: `drop` waits so
   * that an undo inside the window keeps the row, and this is for a row no
   * block on the page has ever named. Left alone it would be invisible from
   * here for good — nothing names it, so the deletion pass above never sees it
   * leave — while showing up for everybody else, and on this browser's own next
   * reload, as an empty box from nowhere.
   */
  function erase (row: number) {
    $fetch(`/api/workspaces/${workspace.value}/blocks/${row}`, { method: 'DELETE', headers: stamp() })
      .catch((error: unknown) => console.warn('[kemolate] block not deleted:', error))
  }

  /**
   * The blocks of a page that no row stands behind, and that may be given one
   * right now.
   *
   * Top level only. A column of a balloon is a row like any other, but it is a
   * row with a parent and a draft has nowhere to say so — appended on its own
   * it would reach everybody else as a stray box beside the balloon it belongs
   * inside. Columns only ever come from joining rows that already exist, so
   * there is nothing here to lose by leaving them out.
   *
   * Nothing selected, either, and that is the part worth spelling out. Making a
   * row means swapping the block's id, and an id is precisely what everything
   * holding a block holds: the selection, the caret in the canvas text editor —
   * which finds the block it is typing into by looking that id up on every
   * keystroke — and the panel row. Renamed underneath them the block simply
   * stops existing as far as they are concerned, and the sentence being typed
   * goes nowhere. A block nobody is pointed at can be renamed safely; one that
   * is, waits until they look away, which is why `selection` is watched below.
   */
  const rowless = (here: ComicPage) => here.blocks.filter((block) =>
    rowOf(block) === null && !making.has(block.id) && !selection.value.includes(block.id))

  /** Whether a page's blocks may be appended to — see `appendable`. */
  async function mayAppend (here: ComicPage, pageId: number): Promise<boolean> {
    // Epoch-keyed for the reason `held` is: the cached answer is about a page
    // as it stood in one open of the chapter, and the comment on `appendable`
    // claims it "cannot change underneath us" because only an *empty* page is
    // ever filled. Re-opening the chapter empties it, which is exactly the case
    // that claim missed.
    const key = keyOf(epoch.value, here.id)
    const known = appendable.get(key)

    if (known !== undefined) return known

    if (flatten(here.blocks).some((block) => rowOf(block) !== null)) {
      appendable.set(key, true)

      return true
    }

    const rows = await $fetch<StoredBlock[]>(
      `/api/workspaces/${workspace.value}/pages/${pageId}/blocks`,
    ).catch(() => null)

    // Told while this was out — a reading's reply, a restore or a re-read
    // (`arrived`), or a reading refused (`rewriting`) — and what the page was
    // told is about it as it stands now, which this read may well predate. See
    // "Told, as well as asked" on `appendable` for the session this cost.
    const told = appendable.get(key)

    if (told !== undefined) return told

    // Nothing remembered on a failure. This is the one question whose wrong
    // answer doubles a page, so an unanswered one has to mean "not now" rather
    // than either "yes" or "no for the rest of the session".
    if (!rows) return false

    appendable.set(key, !rows.length)

    return !rows.length
  }

  /**
   * Rows for the blocks on a page that have none — one request, whatever the
   * page is holding.
   *
   * Best effort throughout and silent about it, exactly as `send` is: the
   * blocks are on the page and in this browser's storage either way, and a
   * workspace that will not take them is not something to keep asking about.
   */
  async function create (here: ComicPage, scan: { width: number, height: number }) {
    const pageId = pageRowOf(here)

    if (!pageId || !writable.value) return

    // A reading is being written over the page — see `rewrites`. Nothing is
    // lost by leaving it: what is row-less when the answer lands is either
    // replaced with the rest of the page or offered again by the pass that
    // putting the answer on the page sets off.
    if (rewrites.has(keyOf(epoch.value, here.id))) return

    const fresh = rowless(here)

    if (!fresh.length) return

    // Claimed before the first await rather than before the request, and that
    // ordering is the whole guard. `mayAppend` can go to the server, the timer
    // that runs this is re-armed by every change, and a second run beginning
    // inside that gap would find exactly the same blocks still row-less and
    // send them again — two rows for each, and nothing that could tell.
    for (const block of fresh) making.add(block.id)

    // A copy of each block as it went. `sent` is seeded from these rather than
    // from the block afterwards: a balloon dragged while its row was being made
    // must come out of this as a block that differs from its row, or the move
    // is silently agreed to and never sent.
    const asSent = fresh.map((block) => ({ ...block }))

    try {
      if (!(await mayAppend(here, pageId))) return

      // Again, because that was an await: a reading begun while the question
      // was out has made the page the server's to say.
      if (rewrites.has(keyOf(epoch.value, here.id))) return

      const stored = await $fetch<StoredBlock[]>(
        `/api/workspaces/${workspace.value}/pages/${pageId}/blocks`,
        {
          method: 'POST',
          body: { blocks: fresh.map((block) => toDraft(block, scan)) },
          headers: stamp(),
        },
      ).catch((error: unknown) => {
        // Dropped rather than retried, and for the reasons `send` gives. A
        // viewer never reaches here at all — see `writable` — so a read-only
        // workspace still produces neither requests nor warnings.
        console.warn('[kemolate] block not created:', error)

        return null
      })

      if (!stored) return

      // Paired by place in the list, which is the whole of what the endpoint
      // promises: the rows come back in the order the drafts went out.
      for (const [at, row] of stored.entries()) {
        const block = fresh[at]
        const was = asSent[at]

        if (block && was) adopt(here, block, was, row, scan)
        // A row with no draft opposite it cannot be matched to anything on the
        // page and so can never be patched, moved or deleted from here again.
        else erase(row.id)
      }
    } finally {
      // Released only once every id that is going to change has changed, so the
      // pass this sets off sees rows rather than the blocks it just sent.
      for (const block of fresh) making.delete(block.id)
    }
  }

  /**
   * The row exists: put its id on the block, so every later edit is a patch.
   *
   * This is the half `useOcr.persist` explains under "Why the reply is put back
   * on the page", and it is the whole point of the request above. A block that
   * keeps a row-less id is one this file goes on skipping — a move made a
   * second after its row was created would never be saved, and the reload that
   * appeared to fix it would only be fetching the row that was there all along.
   */
  function adopt (
    here: ComicPage,
    block: Block,
    was: Block,
    row: StoredBlock,
    scan: { width: number, height: number },
  ) {
    // Gone from the page, or picked up by somebody, while the row was being
    // made. Either way the id must not go on: there is nothing to put it on in
    // the first case, and in the second the swap would take the caret and the
    // selection with it. The row is given up instead of the block's identity,
    // and the block will be offered one again the next time it is free.
    if (!here.blocks.includes(block) || selection.value.includes(block.id)) {
      erase(row.id)

      return
    }

    const from = block.id

    block.id = `block:${row.id}`

    // Undo files its steps by block id, so everything already recorded for this
    // block — the placement itself, and any run of edits since — would name
    // something the page no longer answers to. `applyGone` would look it up,
    // not find it, and report success having done nothing: Cmd+Z on a block you
    // had just placed would leave it exactly where it was.
    renameBlock(from, block.id)

    // And its repair, which is filed by block id for the same reason and was
    // lost to exactly this swap — see `renamePatch`.
    cleaned.value = renamePatch(cleaned.value, here.id, from, block.id)

    // And its mask corrections, which a local workspace keeps under the old
    // name and a cloud one reads from the server under the row — see
    // `carryLocal`. Not awaited: nothing here waits on them.
    carryLocal(here, block, from).catch(() => {})

    // Into the page's row set by hand rather than waiting for the next pass to
    // notice it. `held` is what tells a deleted row from one that was never
    // here, and a row this browser made but never saw arrive is one it could
    // never afterwards see leave. Adding it here also makes the *next* page
    // turn a no-op for this row rather than a deletion, because by then the set
    // and the page already agree.
    held.get(keyOf(epoch.value, here.id))?.add(row.id)

    // Seeded, or the pass this very swap sets off — `block.id` is part of the
    // watched shape — would find a row nothing has been sent for and patch it
    // with precisely what was just inserted.
    //
    // From the block as it was sent, and with the server's own `position`
    // rather than the block's place in the list. If those two disagree the
    // disagreement is real — the reading order here is not the one the row
    // landed in — and is worth exactly one patch to settle.
    sent.set(row.id, JSON.stringify(toPatch(was, scan, row.position)))
  }

  /** Every block on the page that has a row and no longer matches it. */
  function flush () {
    const here = page.value
    const scan = here?.scan

    if (!writable.value || !here || !scan?.width || !scan.height) return

    revive(here)

    const blocks = flatten(here.blocks)

    // What this page holds now against what it held a moment ago: anything
    // that has left is a deletion. A block that has arrived needs nothing said
    // about it here — it is patched below like every other row.
    const rows = new Set(blocks.map(rowOf).filter((row): row is number => row !== null))

    /*
     * A page this open has never been seen holding anything is a page that has
     * not been read from the server yet, not a page somebody emptied. Keyed by
     * epoch, so re-opening the chapter puts every page back in that state — see
     * `held`, and the two workspaces this cost.
     */
    for (const row of departed(epoch.value, here.id, rows)) drop(row)

    // Blocks with no row of their own — one placed by hand, or a reading taken
    // before this workspace had anywhere to put it. Scheduled rather than sent,
    // through the same settle and reset the same way, so that a page arriving
    // with a cache's worth of them at once is one request and not thirty.
    if (rowless(here).length) {
      clearTimeout(births.get(here.id))
      births.set(here.id, setTimeout(() => {
        births.delete(here.id)
        create(here, scan)
      }, SETTLE))
    }

    // Where this page's patches go. A page the workspace's record does not name
    // has nowhere to send them, and its blocks' rows cannot be on it; `create`
    // gives up on such a page for the same reason.
    const pageId = pageRowOf(here)
    const waiting = pageId ? outbox.get(pageId) ?? { patches: new Map<number, Patch>() } : null

    for (const [at, block] of blocks.entries()) {
      const row = rowOf(block)

      if (!row) continue

      // On the page, so the DELETE of a block that undo has just put back is
      // called off — as it was, which an unchanged block used to let go
      // through, or changed, which goes up as a patch below.
      clearTimeout(timers.get(row))
      timers.delete(row)

      const patch = toPatch(block, scan, at)

      // The server already has this, so a patch of a shape since undone is
      // called off too. Anything else waits with the rest of the page.
      if (sent.get(row) === JSON.stringify(patch)) waiting?.patches.delete(row)
      else waiting?.patches.set(row, patch)
    }

    if (!pageId || !waiting) return

    // Re-armed by every pass while anything waits, so the page goes up a settle
    // after it last changed — see `outbox` for why one timer does what one per
    // block did.
    clearTimeout(waiting.timer)

    if (!waiting.patches.size) {
      outbox.delete(pageId)

      return
    }

    waiting.timer = setTimeout(() => sendPage(pageId), SETTLE)
    outbox.set(pageId, waiting)
  }

  /**
   * Everything a row can hold, as one string.
   *
   * Deliberately not the whole block — the translation and the lettering style
   * have their own home in `translations` and no column here, so watching them
   * would send a patch that changed nothing on every keystroke. They are
   * `useTranslationSync`'s, which watches exactly the fields this one leaves
   * out.
   */
  const shape = computed(() => flatten(page.value?.blocks ?? [])
    .map((block, at) => [
      // The index is part of what a row holds, so it belongs in the string that
      // decides whether anything changed. Without it, reordering the list left
      // every block's own fields identical and the watcher never fired.
      at,
      block.id, block.type, block.x, block.y, block.w, block.h,
      block.angle, block.skewX, block.skewY, block.quad?.join(','),
      // The balloon's room, so measuring a chapter that was read before rooms
      // existed is a change this sees and saves — see `Block.room`.
      block.room && [block.room.x, block.room.y, block.room.w, block.room.h, block.room.round ? 'o' : ''].join(','),
      block.source, block.hidden,
    ].join('|'))
    .join('\n'))

  // Three sources, and the two beyond the shape are both about blocks that have
  // no row. `selection`, because `rowless` refuses a block somebody is pointed
  // at, so looking away has to be something that happens rather than something
  // waited for. `writable`, because a workspace being claimed — or a viewer
  // being made an editor — changes nothing about any block, and without it a
  // page of blocks placed before the claim sits row-less until somebody happens
  // to nudge one. Everything else a spare pass runs is a comparison that finds
  // nothing changed.
  watch([shape, selection, writable], flush)

  /**
   * `create` for every page rather than the one on screen — see `uploadAll`.
   *
   * One page at a time, and each measured first: a row is written in the
   * width-normalised space, and a page converted at the guessed shape is the
   * drift `sized` exists to prevent. `mayAppend` still guards each page, so a
   * page the server already holds rows for is asked about rather than doubled.
   */
  async function createAll () {
    for (const here of [...pages.value]) {
      if (!rowless(here).length) continue

      await create(here, await sized(here))
    }
  }

  uploadAll = createAll

  // A different chapter's rows are not these rows — cleared by `forgetAgreed`
  // from `useWorkspaceReset` rather than by a watcher here, which could not
  // fire. See that function.

  onScopeDispose(() => {
    for (const timer of [...timers.values(), ...births.values()]) clearTimeout(timer)
    for (const waiting of outbox.values()) clearTimeout(waiting.timer)

    if (uploadAll === createAll) uploadAll = null
  })
}
