/**
 * A local workspace's layer stacks, kept in this browser.
 *
 * A stack belongs to a page — `ComicPage.stack` — and until now only a cloud
 * workspace kept one anywhere but memory: `useLayerSync` writes it to the
 * server, and needs a server record to do it. On a local workspace every sheet,
 * group, adjustment and placed image added to a page was gone on the next
 * reload, and a stack restored from a project file lived exactly as long as the
 * tab. A local workspace keeps everything in the browser, and a stack is part of
 * everything.
 *
 * `useBlockCache`'s shape, for its reasons: filed under the workspace and the
 * scan's hash (`layers:<workspace>:<hash>`), put back when the chapter opens,
 * and written as it changes — but only once a page has been looked up, so the
 * `DEFAULT_STACK` a page is opened with never lands on top of the stack it had.
 * A cloud workspace is left to `useLayerSync` entirely.
 *
 * The whole stack is kept, twirls included: `open` is this reader's and is not
 * sent to the server for that reason, but a local workspace has no other reader.
 */
import type { StackLayer } from '#shared/utils/layers'
import type { ComputedRef } from 'vue'

import { idbKey } from '~/utils/idbKeys'

/** How long a page's stack has to sit still before it is written. */
const SETTLE = 250

interface CachedStack {
  v: 1
  stack: StackLayer[]
}

/** Write every page's stack now, from the mounted instance — see `keepLayersLocally`. */
let keepAll: (() => Promise<void>) | null = null

/** Each page's stack as a string, one computed a page — see `stacked`. */
const pageStacks = new WeakMap<object, ComputedRef<string>>()

/**
 * A page's stack as one string, worked out again only when *that page's*
 * stack changes — see the same thing in `useBlockCache`. Held against the raw
 * page, so a page that leaves the chapter takes its entry with it; the same
 * string comes back until the stack changes, so comparing it with `kept` is a
 * pointer compare for every page nobody touched.
 */
function stacked (target: ComicPage) {
  const raw = toRaw(target)
  let one = pageStacks.get(raw)

  if (!one) {
    // The reactive page, not the raw one, or the computed tracks nothing.
    const page = reactive(raw) as ComicPage

    one = computed(() => JSON.stringify(page.stack ?? []))
    pageStacks.set(raw, one)
  }

  return one.value
}

/**
 * Keep every page's stack in this browser, before a workspace stops being a
 * cloud one and its server rows go.
 *
 * What it has is what this session has loaded: `useLayerSync` reads a page's
 * stack from the server when the page is shown, so a page nobody turned to is
 * kept as the default it was opened with.
 */
export function keepLayersLocally (): Promise<void> {
  return keepAll?.() ?? Promise.resolve()
}

export function useLayerCache () {
  const route = useRoute()
  const { pages, epoch } = useComic()
  const { shared } = useShared()

  const workspace = () => String(route.params.workspaceId ?? '')
  const keyOf = (here: string, hash: string) => idbKey.layers(here, hash)

  /** Pages whose saved stack has been looked for — see the header. */
  const looked = new Set<string>()

  /**
   * Pages whose lookup is in flight: claimed, so a second `restore` leaves
   * them alone, but not yet `looked`, so the watcher leaves them alone too.
   *
   * They used to be marked looked before the lookup's await. A page put back
   * woke the watcher while the next page was still being read; that page was
   * looked, still on the `DEFAULT_STACK` every page opens with, and so the
   * default was scheduled as its write — and the saved stack landing a moment
   * later was agreed to without the write being called off. A quarter of a
   * second after a local chapter opened, every page after the first had its
   * saved stack on disk replaced by the default one: sheets, groups and placed
   * pictures gone from the stack on the next open.
   */
  const looking = new Set<string>()

  /**
   * A page's name in `looked` and `looking`: its scan in this open of the
   * chapter. By the scan alone, a chapter opened again under the same page came
   * back on `DEFAULT_STACK` with every page already "looked up", and the watcher
   * wrote the default over every saved stack — see the same function in
   * `useBlockCache`, which has the whole story.
   */
  const inOpen = (hash: string) => `${epoch.value}:${hash}`

  const kept = new Map<string, string>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  /** Each page's write still waiting out its settle — see `useBlockCache`. */
  const waiting = new Map<string, () => void>()

  /** Put back each page's saved stack. Local workspaces only. */
  async function restore () {
    const here = workspace()

    if (!here || shared.value) return

    for (const target of pages.value) {
      const hash = target.scan?.hash

      if (!hash) continue

      // Named for the open it is made in — see `inOpen`.
      const mark = inOpen(hash)

      if (looked.has(mark) || looking.has(mark)) continue

      looking.add(mark)

      try {
        const held = await idb.get<CachedStack>(keyOf(here, hash)).catch(() => undefined)

        // Checked again after the await: the chapter may have been replaced.
        const still = pages.value.find((candidate) => candidate.scan?.hash === hash)

        if (!still) continue

        // Nothing saved: the page keeps the stack it opened with, and that is
        // agreed rather than written — there is nothing on disk it would be
        // bringing up to date.
        if (held?.v !== 1 || !held.stack.length) {
          kept.set(hash, stacked(still))

          continue
        }

        still.stack = held.stack
        // Agreed as it lands, from the page rather than the entry: the string
        // the watcher will compare is the page's own.
        kept.set(hash, stacked(still))
      } finally {
        looking.delete(mark)
        looked.add(mark)
      }
    }
  }

  // Nothing for a cloud workspace, before anything is read — see the same line
  // in `useBlockCache`. One string a page, each remembered by `stacked`, so an
  // edit to one page's stack serialises that page and no other. This re-runs —
  // and hands the watcher a new array — only when some page's string changed
  // or a page gained its hash, which is exactly when there is something to look
  // at; it used to be one joined string for the chapter, rebuilt on every change.
  const shape = computed(() => (shared.value
    ? []
    : pages.value.map((target) => [target.scan?.hash ?? '', stacked(target)] as const)))

  watch(shape, () => {
    const here = workspace()

    if (!here || shared.value) return

    for (const target of pages.value) {
      const hash = target.scan?.hash

      if (!hash || !looked.has(inOpen(hash))) continue

      const now = stacked(target)

      if (kept.get(hash) === now) continue

      kept.set(hash, now)

      const save = () => {
        timers.delete(hash)
        waiting.delete(hash)

        idb.set(keyOf(here, hash), { v: 1, stack: JSON.parse(now) as StackLayer[] } satisfies CachedStack)
          .then(() => announceLocal(here, 'layers', hash))
          .catch(() => {
            kept.delete(hash)
          })
      }

      clearTimeout(timers.get(hash))
      waiting.set(hash, save)
      timers.set(hash, setTimeout(save, SETTLE))
    }
  })

  // A new open of the chapter: the last one's waiting saves go now, before this
  // one reads — see the same watcher in `useBlockCache`.
  watch(epoch, () => {
    for (const timer of timers.values()) clearTimeout(timer)
    for (const save of [...waiting.values()]) save()
  }, { flush: 'sync' })

  async function keepEvery () {
    const here = workspace()

    if (!here) return

    for (const target of pages.value) {
      const hash = target.scan?.hash

      if (!hash) continue

      const now = JSON.stringify(target.stack ?? [])

      kept.set(hash, now)
      looked.add(inOpen(hash))

      await idb.set(keyOf(here, hash), { v: 1, stack: JSON.parse(now) as StackLayer[] } satisfies CachedStack).catch(() => {})
    }
  }

  keepAll = keepEvery

  /**
   * Another tab on this chapter saved a page's stack: take it up — see the
   * same function in `useBlockCache`, for the same reason and with the same
   * exception for a save of this tab's own still waiting.
   */
  async function hear (here: string, hash: string) {
    if (timers.has(hash)) return

    const held = await idb.get<CachedStack>(keyOf(here, hash)).catch(() => undefined)

    if (held?.v !== 1 || workspace() !== here || shared.value || timers.has(hash)) return

    const now = JSON.stringify(held.stack)

    for (const target of pages.value) {
      if (target.scan?.hash !== hash) continue

      looked.add(inOpen(hash))
      kept.set(hash, now)

      if (JSON.stringify(target.stack ?? []) !== now) target.stack = held.stack
    }
  }

  onLocalChange((room, scope, key) => {
    if (scope === 'layers' && key && room === workspace() && !shared.value) hear(room, key).catch(() => {})
  })

  onScopeDispose(() => {
    // Written now rather than dropped — the only copy of a local workspace's
    // stack, as `useBlockCache` says of its reading.
    for (const timer of timers.values()) clearTimeout(timer)
    for (const save of [...waiting.values()]) save()

    if (keepAll === keepEvery) keepAll = null
  })

  return { restore }
}
