/**
 * A reading, kept in this browser.
 *
 * Everything else about an open chapter already survives a reload — the scans
 * are copied into the browser's own storage, and a cleaned balloon is a file in
 * the patch cache — and the blocks were the one thing that did not. So a page
 * read, corrected and cleaned came back after a refresh as the bare scan: no
 * boxes, no text, and Clean page greyed out because there was nothing left to
 * clean. The patches were still on disk the whole time; nothing could name them
 * any more, because a patch is filed under the box of the block it covers.
 *
 * Blocks did have somewhere to live — the `blocks` table — but only for a
 * workspace somebody had shared. Sharing is a thing you do when you want other
 * people in, and it is not a reasonable price for your own work being there
 * tomorrow, which is why this is not the same mechanism as `useBlockSync`. That
 * one is about agreeing with other people; this one is about not losing what
 * you did.
 *
 * ## Keyed by the workspace *and* the scan
 *
 * It used to be the scan alone, filed under the hash of its bytes exactly as
 * its patches are — and the argument for that was that re-importing a chapter
 * into a new workspace would find the reading again. That turned out to be the
 * wrong thing to want. A new workspace is somebody starting again: they drop
 * the same file in and get a page already covered in boxes they did not make,
 * with a reading and a set of translations from work they may have been trying
 * to leave behind. There is no way to refuse it and no sign of where it came
 * from.
 *
 * So the key carries the workspace. A page whose bytes changed still rightly
 * starts blank, a reload of the workspace that read it still gets it back, and
 * a new workspace starts empty — which is what dropping a file into an empty
 * workspace should mean.
 *
 * Patches are deliberately *not* changed to match. A repair is a picture of
 * pixels and is the same repair wherever the same pixels turn up; a reading is
 * a set of decisions somebody made inside one piece of work.
 *
 * ## Local workspaces only
 *
 * A cloud workspace's blocks come from the server or not at all, and this
 * neither fills nor records one. It used to fill any page the server's answer
 * had not reached, on the reasoning that the server had the last word and this
 * only covered what it left blank — but "left blank" also meant "not asked
 * yet", and a chapter reopened before the workspace's record arrived came back
 * with a run of pages taken from here. Those carry no row ids (see `localise`),
 * so nothing on them could be saved, corrected or versioned, and the server's
 * answer never replaced them because a page with blocks is never offered it.
 * The rule that settles it is simpler than the race: where the reading lives is
 * decided by what kind of workspace it is, not by which answer arrives first.
 *
 * The one crossing is a cloud workspace going back to local. The server's
 * record is deleted, so the reading has to be here before it is — see
 * `keepChapterLocally`, which `useWorkspaceName.toLocal` calls first.
 */

import type { ComputedRef } from 'vue'

import { idbKey } from '~/utils/idbKeys'
import { rowOf } from '~/utils/ocr/blocks'

/**
 * The blocks, renamed so none of them claims a row it does not have.
 *
 * A block's id *is* its server row when it has one — `block:41`, which `rowOf`
 * reads back out — and this cache is filed under the scan rather than the
 * workspace, which is the whole point of it. Those two facts were in direct
 * contradiction and the result was a page nobody could work on.
 *
 * Dropping the same scan into a second workspace restored blocks still calling
 * themselves `block:41`, naming rows that belong to the *first* workspace's
 * page. Every consequence followed from that one lie: `useBlockSync.rowless`
 * saw blocks that already had rows and never created any, so the page stayed
 * empty server-side for ever; and every edit patched a row id that was not
 * there, so a reading came back as twenty-five `404 No such block` and nothing
 * a reader typed was ever saved. It looked like the blocks were fine and the
 * app was ignoring them, which is exactly what it was doing.
 *
 * So the cache holds local names only. Doing it on the way *in* as well as on
 * the way out is what heals entries already on disk — including the ones that
 * caused this — without anybody having to clear anything.
 *
 * It is always safe to forget the row here, and that is worth being precise
 * about rather than hoping: `restore` only fills pages that are still empty
 * after `useOcr.restore` has had its turn, so the cache is read exactly when
 * the server had nothing to say about the page. A row id that survived to be
 * read back is therefore one that cannot mean anything where it is being read.
 */
export function localise (blocks: Block[], renamed?: Map<string, string>): Block[] {
  return blocks.map((block) => {
    const row = rowOf(block)

    // Named from the row it forgets, not at random. It used to be a fresh
    // random name on every call, and this runs on every write of the cache —
    // so a block moved back to local was renamed on disk each time it was
    // saved, and nothing filed under its name (a mask correction) could follow
    // it. The row id is unique, and `read:r41` is no row's name.
    const id = row === null ? block.id : `read:r${row}`

    // Which name became which, for a caller carrying things filed under the old
    // one — a cloud workspace's mask corrections, going local. See `toLocal`.
    if (id !== block.id) renamed?.set(block.id, id)

    return {
      ...block,
      id,
      ...(block.children ? { children: localise(block.children, renamed) } : {}),
    }
  })
}

/**
 * A stroke log's surface key, renamed the way `localise` renames its block.
 *
 * A cloud workspace files a mask correction under its block's row, `mask-41`;
 * the block becomes `read:r41` here, and the correction has to be filed under
 * that name or nothing ever reads it. Every other surface — `bg`, a sheet's
 * stack id, a local block's correction — keeps its key.
 */
export function localSurface (surface: string): string {
  const row = /^mask-(\d+)$/.exec(surface)?.[1]

  return row ? `mask-read:r${row}` : surface
}

/**
 * What is written per page. Versioned so a later shape can be recognised.
 *
 * Version 3 needed no new field: a balloon is a block with `children` on it, so
 * the tree writes itself. Version 2 briefly kept joins in a `merges` list beside
 * the blocks — that shape is gone, and its entries still read as a page with
 * blocks and nothing joined, which costs a reader their balloons and not their
 * reading. Version 1 was blocks alone and reads the same way.
 */
interface CachedBlocks {
  v: 1 | 2 | 3
  blocks: Block[]
}

const VERSION = 3

/** The name a page's blocks are filed under, within one workspace. */
const keyOf = (workspace: string, hash: string) => idbKey.blocks(workspace, hash)

/**
 * The old cross-workspace entry for a page, adopted by whoever opens it first.
 *
 * `blocks:<hash>` was the whole key once. Those entries are the ones that put a
 * reading into workspaces it had nothing to do with, so they must stop being
 * read by everybody — but they must not simply be deleted, and that distinction
 * cost a reading before it was understood.
 *
 * A workspace nobody has signed in for has no rows on any server. The cache is
 * then not a convenience, it is *the* copy: throwing the old entries away takes
 * the only record of a reading somebody made, and the page comes back blank
 * with nothing to restore it from. Deleting them was exactly that mistake,
 * shipped, and this is it undone.
 *
 * So the first workspace to ask for a page takes the entry over — written under
 * its own name, then removed from the old one. For local-only work that is the
 * workspace that wrote it, which is the case this protects. Where two
 * workspaces really did share a scan, the first keeps the reading and the
 * second starts blank, which is the behaviour being asked for anyway.
 */
async function adoptLegacy (workspace: string, hash: string): Promise<CachedBlocks | undefined> {
  const old = `blocks:${hash}`
  const held = await idb.get<CachedBlocks>(old).catch(() => undefined)

  if (!held) return undefined

  // Moved rather than copied, and in that order: a failed write leaves the
  // entry where it was, which is recoverable. A delete that ran first would
  // not be.
  await idb.set(keyOf(workspace, hash), held).catch(() => {})
  await idb.del(old).catch(() => {})

  return held
}

/**
 * How long a page has to sit still before its blocks are written.
 *
 * The same argument as `useBlockSync`'s settle: dragging a balloon changes the
 * page a hundred times a second, and only the last of them is worth a write.
 * Shorter than that one because this write is local — nothing is waiting on a
 * network, and a tab closed a moment after a nudge should still have kept it.
 */
const SETTLE = 250

/**
 * Write the whole chapter's reading into this browser now, from the mounted
 * instance — see the note on local workspaces at the top of this file.
 */
let keepAll: (() => Promise<void>) | null = null

/** Each page's blocks as a string, one computed a page — see `written`. */
const pageShapes = new WeakMap<object, ComputedRef<string>>()

/** Every page's blocks, kept here before a workspace stops being a cloud one. */
export function keepChapterLocally (): Promise<void> {
  return keepAll?.() ?? Promise.resolve()
}

export function useBlockCache () {
  const route = useRoute()
  const { pages, setBlocks, epoch } = useComic()
  const { shared, asking } = useShared()

  /**
   * Which workspace's reading this is.
   *
   * Read per call rather than held, so that a composable which outlives a
   * change of address cannot go on filing pages under the workspace it was
   * created in — the mistake this whole change is about, one level up.
   */
  const workspace = () => String(route.params.workspaceId ?? '')

  /**
   * The pages this browser has already looked up.
   *
   * The guard that stops the cache eating itself. A page arrives with no blocks
   * on it and gains them a moment later, so a watcher armed from the start
   * would write "no blocks" over a perfectly good reading in the gap between
   * the scan being drawn and the lookup coming back. A page is only written
   * once it has been read for.
   */
  const looked = new Set<string>()

  /**
   * Pages whose lookup is in flight — claimed, so a second `restore` leaves
   * them alone, but not yet `looked`, so the watcher leaves them alone too.
   *
   * They used to be marked looked before the lookup's await, which is the gap
   * the note above is about opened from the other side: a page arriving woke
   * the watcher while the *next* page was still being read, found it looked
   * and empty, and scheduled "no blocks" as its write. The restore landing a
   * moment later usually replaced that write before it went — but a write
   * still waiting is run at once on the way out, so leaving a local chapter
   * while it was still coming back could write nothing over pages whose only
   * copy was this one.
   */
  const looking = new Set<string>()

  /**
   * A page's name in `looked` and `looking`: its scan, *in this open of the
   * chapter*.
   *
   * By the scan alone, the mark outlived the open it was made in. A chapter can
   * be opened again under the same page — folder access granted again, the
   * same folder picked again, a hot reload in development — and `openImages`
   * hands every page back fresh, with no blocks, under the same scan. Each was
   * already "looked up" and now different, so the watcher wrote the empty
   * reading over the saved one; and `restore`, finding the scan looked-up,
   * never put it back. On a local workspace that copy is the only one.
   * Found when every page of the test chapter went to an empty list under a
   * run of hot reloads. `useBlockSync` learned the same about its own page keys
   * on 2026-08-09 — see the epoch gotcha in CLAUDE.md.
   */
  const inOpen = (hash: string) => `${epoch.value}:${hash}`

  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  /** Each page's write still waiting out its settle — run at once on the way out. */
  const waiting = new Map<string, () => void>()

  /** What was last written for each page, so an unchanged one is not rewritten. */
  const kept = new Map<string, string>()

  /**
   * Put back what this browser kept, onto pages nothing else has filled.
   *
   * Quiet throughout: a page nobody has read has no entry, which is the
   * ordinary case and not worth reporting. Storage that will not open is the
   * same — see the note on `PATIENCE` in `utils/idb` — and costs a reading
   * rather than a workspace.
   */
  async function restore () {
    const here = workspace()

    if (!here) return

    // The workspace's record first, because it decides what kind of workspace
    // this is — and a cloud one is not this file's to fill at all. See the note
    // on local workspaces at the top.
    await settled()

    if (shared.value) return

    for (const target of pages.value) {
      const hash = target.scan?.hash

      if (!hash) continue

      // Named for the open it is made in, and kept so: an open that ends while
      // this lookup is out marks *that* open's page looked, not the next one's.
      const mark = inOpen(hash)

      // Claimed before the await, not after: two of these can be in flight for
      // the same page — the watcher that calls it fires again on every hash
      // that lands — and the second must leave the page to the first. But only
      // looked once the lookup is over; see `looking`.
      if (looked.has(mark) || looking.has(mark)) continue

      looking.add(mark)

      try {
        if (target.blocks.length) continue

        // This workspace's own entry, or the old cross-workspace one taken over
        // if nobody has claimed it yet — see `adoptLegacy`.
        const held = await idb.get<CachedBlocks>(keyOf(here, hash)).catch(() => undefined)
          ?? await adoptLegacy(here, hash)

        // Checked again after the await for the same reason `useOcr.restore`
        // does: a reading can land while the lookup is in flight, and it is
        // newer than anything on disk.
        if (target.blocks.length) continue

        // Nothing to put back — no entry, one that is empty, or one this
        // browser cannot read (a newer version's). The page is empty and so,
        // as far as this browser can tell, is what is kept: agreed, rather
        // than written, so opening a chapter does not write an empty entry per
        // page — nor an empty one over a newer version's reading.
        // Any version this browser knows, not only the newest — see `CachedBlocks`.
        if (!held?.v || held.v > VERSION || !held.blocks.length) {
          kept.set(hash, written(target))

          continue
        }

        setBlocks(target.id, localise(held.blocks))

        // Agreed as it lands, or the watcher reads what was just put back as an
        // edit and writes every page of the chapter straight back where it came
        // from — the local half of "an arrival is not an edit". Only an entry
        // already in this version's shape, though: an older one is left to be
        // written back, which is what brings it up to date on disk.
        const placed = held.v === VERSION && pages.value.find((candidate) => candidate.id === target.id)

        if (placed) kept.set(hash, written(placed))
      } finally {
        looking.delete(mark)
        looked.add(mark)
      }
    }
  }

  /** Resolves once the workspace's record is not in the air. */
  function settled (): Promise<void> {
    if (!asking.value) return Promise.resolve()

    return new Promise((resolve) => {
      const stop = watch(asking, (now) => {
        if (now) return

        stop()
        resolve()
      })
    })
  }

  /** One page's blocks, written. Emptied deliberately is a thing to keep too. */
  function write (here: string, hash: string, shape: string) {
    kept.set(hash, shape)

    const save = () => {
      timers.delete(hash)
      waiting.delete(hash)

      // Parsed from the signature rather than read off the page again, which
      // also takes care of the other half: these are Vue's reactive proxies,
      // and structured clone — how IndexedDB stores — refuses them.
      const blocks = localise(JSON.parse(shape) as Block[])

      idb.set(keyOf(here, hash), { v: VERSION, blocks } satisfies CachedBlocks)
        // Then this browser's other tabs on the chapter read it back — see
        // `hear` below.
        .then(() => announceLocal(here, 'blocks', hash))
        .catch(() => {
          // A cache that cannot be written costs the next visit a reading, not
          // this one a failure.
          kept.delete(hash)
        })
    }

    clearTimeout(timers.get(hash))
    waiting.set(hash, save)
    timers.set(hash, setTimeout(save, SETTLE))
  }

  /**
   * Everything about every block that is worth keeping, one string a page.
   *
   * The whole block rather than its box: unlike `useBlockSync`, this is the
   * only home the translation and the lettering style have, so a page whose
   * words changed is a page to write.
   *
   * One string *per page*, each remembered by `written` — this used to be one
   * string for the chapter, built by stringifying every block of every page,
   * and the watcher then stringified every page again. A local workspace keeps
   * the whole chapter, so that was the whole chapter serialised twice on every
   * drag frame and every keystroke: measured at 14 ms a change on 30 pages and
   * 125 ms on 200. Now an edit re-serialises the page it touched and nothing
   * else. The array is new whenever this re-runs, which it does only when some
   * page's string changed (or a page gained its hash), so the watcher runs
   * exactly as often as there is something to look at.
   */
  const shape = computed(() => {
    // Nothing for a cloud workspace, before anything is read. The watcher below
    // ignores one anyway, but only after this had serialised every block of the
    // chapter — on every drag frame and every keystroke, for nothing.
    if (shared.value) return []

    // Pairs rather than one joined string: joining would copy every page's
    // text into a chapter-sized string on every change, which is the cost
    // being taken away.
    return pages.value.map((target) => [target.scan?.hash ?? '', written(target)] as const)
  })

  /**
   * A page's blocks, children and all — a balloon carries its own — as one
   * string, worked out again only when something on *that* page changes.
   *
   * A computed per page, held against the raw page object so a page that
   * leaves the chapter takes its entry with it. The same string comes back
   * until the page changes, so comparing it with what `kept` holds is a
   * pointer compare for every page nobody touched.
   */
  function written (target: ComicPage) {
    const raw = toRaw(target)
    let one = pageShapes.get(raw)

    if (!one) {
      // The reactive page, not the raw one, or the computed tracks nothing.
      const page = reactive(raw) as ComicPage

      one = computed(() => JSON.stringify(page.blocks))
      pageShapes.set(raw, one)
    }

    return one.value
  }

  watch(shape, () => {
    const here = workspace()

    // Nothing recorded for a cloud workspace either: a copy nothing reads is a
    // copy that can only ever be out of date.
    if (!here || shared.value) return

    for (const target of pages.value) {
      const hash = target.scan?.hash

      if (!hash || !looked.has(inOpen(hash))) continue

      const now = written(target)

      if (kept.get(hash) === now) continue

      write(here, hash, now)
    }
  })

  // A new open of the chapter: whatever the last one still had waiting goes to
  // disk now, before this open's `restore` reads it. It is the newer copy, and
  // read before it landed, the page would come back without it — and the next
  // edit would write that older reading over it.
  watch(epoch, () => {
    for (const timer of timers.values()) clearTimeout(timer)
    for (const save of [...waiting.values()]) save()
  }, { flush: 'sync' })

  /**
   * Every page's blocks, written now rather than on a settle — see
   * `keepChapterLocally`. Awaited, because the caller is about to delete the
   * only other copy.
   */
  async function keepEvery () {
    const here = workspace()

    if (!here) return

    for (const target of pages.value) {
      const hash = target.scan?.hash

      if (!hash) continue

      const now = written(target)

      kept.set(hash, now)
      // Looked, so that edits made from here on are written as they happen.
      looked.add(inOpen(hash))

      await idb.set(keyOf(here, hash), {
        v: VERSION,
        blocks: localise(JSON.parse(now) as Block[]),
      } satisfies CachedBlocks).catch(() => {
        kept.delete(hash)
      })
    }
  }

  keepAll = keepEvery

  /**
   * Another tab on this chapter wrote a page's reading: take it up.
   *
   * Without it the two tabs each held the reading they opened with, and the
   * next change either made — a box nudged, a word typed — wrote that tab's
   * whole page back over whatever the other had done since. Not while this tab
   * has its own write for the page waiting (`timers`): that is the newer edit,
   * and it will say so to the other tab when it lands.
   */
  async function hear (here: string, hash: string) {
    if (timers.has(hash)) return

    const held = await idb.get<CachedBlocks>(keyOf(here, hash)).catch(() => undefined)

    if (!held?.v || held.v > VERSION || workspace() !== here || shared.value || timers.has(hash)) return

    const incoming = localise(held.blocks)

    for (const target of pages.value) {
      if (target.scan?.hash !== hash) continue

      looked.add(inOpen(hash))

      if (written(target) !== JSON.stringify(incoming)) setBlocks(target.id, incoming)

      // What is on the page now is what is on disk, so the watcher does not
      // write it straight back — and announce it, and start the other tab
      // reading its own write.
      kept.set(hash, written(target))
    }
  }

  onLocalChange((room, scope, key) => {
    if (scope === 'blocks' && key && room === workspace() && !shared.value) hear(room, key).catch(() => {})
  })

  onScopeDispose(() => {
    // Written now rather than dropped. On a local workspace this is the only
    // copy of the reading there is, and the page going away — walking back to
    // the collection, opening another chapter — used to throw away the last
    // quarter-second of it. Each write carries its own workspace and page, so
    // running it after the route has moved on still files it where it belongs.
    for (const timer of timers.values()) clearTimeout(timer)
    for (const save of [...waiting.values()]) save()

    if (keepAll === keepEvery) keepAll = null
  })

  return { restore }
}
