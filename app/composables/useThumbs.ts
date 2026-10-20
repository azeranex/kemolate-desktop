/**
 * The thumbnails the Pages panel draws, one per open scan.
 *
 * `utils/thumbs.ts` knows how to make and keep one; this knows which pages
 * there are and hands out URLs for them. The split is the same as everywhere
 * else here: the util is about a file, the composable is about the chapter.
 *
 * Made lazily and in order, as pages appear. A chapter opens with its scans
 * arriving over a second or two and their hashes landing after that — a
 * thumbnail cannot be filed before its page has an identity — so this watches
 * rather than being called, and picks up whatever has become ready.
 *
 * ## Once, however many ask
 *
 * The queue, what it has seen and the watcher that feeds it are installed the
 * first time anything asks, and every later caller only reads `urls` — the
 * guard `useLibrary` keeps for its uid watcher. They used to be made per call,
 * and the caller is `PageArt`, which the Pages panel draws once per page: a
 * fifty-page chapter opened with fifty-one queues each reading all fifty
 * thumbnails. Two and a half thousand OPFS reads kept the origin's storage
 * busy for eight seconds, every other reader waited behind them — the
 * chapter's cleaning took four and a half seconds to come back that it could
 * have had in one — and each read minted an object URL nobody revoked, while
 * the panel's pictures re-decoded every time their URL was replaced.
 *
 * Module-level `seen` is safe across workspaces for the reason the store is: a
 * thumbnail is filed under its scan's hash, and the same hash is the same
 * picture wherever it turns up.
 *
 * ## Written in batches
 *
 * `urls` is one object, replaced whole — which is what tells the panel — and it
 * was replaced once per thumbnail. Each replacement copied every URL already
 * there and woke every page's picture to compare its own, so a chapter's
 * thumbnails cost the square of its length, and a chapter opened again, whose
 * thumbnails are all on disk and arrive a few milliseconds apart, paid it in
 * one burst. In development each write of a `useState` is also a walk of the
 * whole payload. So what arrives is gathered and written together, once
 * `BATCH_MS` has passed since the first of them was waiting or when the run
 * ends — the first thumbnail still shows at once to the eye.
 */
import type { EffectScope } from 'vue'

import { backgroundDecoders } from '~/utils/resources'
import { thumbFor } from '~/utils/thumbs'

/** Hashes already dealt with, so a watcher that fires often does not requeue. */
const seen = new Set<string>()

/** The one watcher, once installed. */
let installed: EffectScope | null = null

/**
 * A few at a time, never all at once.
 *
 * Decoding is the expensive half and the browser will happily run forty at
 * once if asked, which is the freeze this exists to prevent — a chapter would
 * open by locking up for as long as it took to shrink every page. That was on
 * the page's own thread; a thumbnail is now made on the background decoders
 * (`scanJob`), and this asks for as many at once as there are of them
 * (`backgroundDecoders`) — more would only wait there, holding their files.
 * The first thumbnails still appear first and the rest fill in behind them.
 */
let working = false

/** Asked for while a run was going: one more run once it finishes. */
let again = false

/** How long a thumbnail that has arrived waits for others to be written with it. */
const BATCH_MS = 100

/** Thumbnails made and not yet in `urls`, by scan hash — see "Written in batches". */
const arrived = new Map<string, Blob>()

let batching: ReturnType<typeof setTimeout> | null = null

export function useThumbs () {
  /** An object URL per scan hash, for as long as the tab is open. */
  const urls = useState<Record<string, string>>('page-thumbs', () => ({}))

  if (import.meta.client && !installed) {
    const { pages } = useComic()
    const { cover } = useWorkspaces()
    // The router's route, not `useRoute()`: this watcher outlives the component
    // that happened to install it, and a page's own route goes stale the
    // moment somebody walks to another workspace.
    const router = useRouter()

    /** Whether the open chapter still has a page with this scan. */
    const stillOpen = (hash: string) => pages.value.some((candidate) => candidate.scan?.hash === hash)

    /**
     * Everything that has arrived, into `urls` in one write.
     *
     * Checked here as well as when each arrived: a chapter closed in the
     * moments a thumbnail waited takes its pages with it, and an object URL
     * nobody can reach is a leak — so the URL is only made for a page still
     * open, and the rest are forgotten as they are below.
     */
    function flush () {
      if (batching) clearTimeout(batching)

      batching = null

      const batch: Record<string, string> = {}

      for (const [hash, image] of arrived) {
        if (stillOpen(hash)) batch[hash] = URL.createObjectURL(image)
        else seen.delete(hash)
      }

      arrived.clear()

      if (Object.keys(batch).length) urls.value = { ...urls.value, ...batch }
    }

    /** One thumbnail made — written with whatever else arrives in the next `BATCH_MS`. */
    function landed (hash: string, image: Blob) {
      arrived.set(hash, image)
      batching ??= setTimeout(flush, BATCH_MS)
    }

    async function drain () {
      if (working) {
        again = true

        return
      }

      working = true

      try {
        do {
          again = false

          const todo = pages.value.flatMap((target) => {
            const hash = target.scan?.hash
            const file = target.scan?.file

            if (!hash || !file || seen.has(hash)) return []

            seen.add(hash)

            return [{ hash, file }]
          })

          let next = 0

          await Promise.all(Array.from({ length: Math.min(backgroundDecoders(), todo.length) }, async () => {
            for (let one = todo[next++]; one; one = todo[next++]) {
              const { hash, file } = one

              // Checked before and after the await: a chapter closed mid-run
              // takes its pages with it, and an object URL nobody can reach is a
              // leak. Forgotten as well as dropped — the hash was marked seen
              // before the wait, and a mark with no picture behind it is a page
              // whose thumbnail never comes when the chapter is opened again. A
              // picture that could not be made at all stays marked: asking again
              // on every change would fail again on every change.
              if (!stillOpen(hash)) {
                seen.delete(hash)

                continue
              }

              const image = await thumbFor(hash, file)

              if (!stillOpen(hash)) {
                seen.delete(hash)

                continue
              }

              if (image) landed(hash, image)
            }
          }))
        } while (again)

        flush()

        // The first page is the chapter's cover, recorded here because this is
        // the moment both halves exist: the page has an identity and there is a
        // picture filed under it. The list on `/` reads the same file.
        const first = pages.value[0]?.scan?.hash
        const workspace = String(router.currentRoute.value.params.workspaceId ?? '')

        if (first && workspace) await cover(workspace, first)
      } finally {
        working = false
      }
    }

    installed = effectScope(true)

    installed.run(() => {
      /**
       * Watched on the hashes rather than on `pages`, because that is the
       * moment a page becomes fileable — the scan arrives first and is
       * identified after.
       */
      watch(
        () => pages.value.map((target) => target.scan?.hash ?? '').join(','),
        () => { drain().catch(() => {}) },
        { immediate: true },
      )
    })
  }

  return { urls }
}
