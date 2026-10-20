/**
 * The pixels behind the pictures a reader has placed — see `utils/placed.ts`.
 *
 * The stack records a *reference*: a hash, a type, a name and a size. That is
 * the right thing for a row to hold, because a row is synced to the server and
 * the server holds no pixels. What it is not is something a canvas can draw. So
 * this is the other half — one object URL per hash, made once and shared by
 * every row that names it.
 *
 * ## Keyed by the image, not by the row and not by the page
 *
 * One clean placed on twenty pages is twenty rows, one file and one URL. Keying
 * this by the row would have made twenty decodes of the same bytes, and keying
 * it by the page would have been the same mistake wearing a different name.
 *
 * ## Nothing here is cleared when the workspace changes
 *
 * Deliberate, and the same reasoning `useWorkspaceReset` sets out for every
 * other content-addressed store: what is filed under a hash is about the bytes
 * rather than about the chapter they are currently being looked at in. Walking
 * between two workspaces that share a clean should not cost a re-read.
 */
import type { PlacedImage } from '#shared/utils/layers'

import { PLACED_KINDS, placedExtension, readPlacedMany, writePlaced } from '~/utils/placed'

export function usePlacedImages () {
  const { pages } = useComic()

  /** Object URLs by image hash — what the canvas draws. */
  const urls = useState<Record<string, string>>('placed-urls', () => ({}))

  /** The URL for one reference, or nothing while its bytes are still being found. */
  function urlFor (image: PlacedImage | undefined): string | null {
    return image ? urls.value[image.hash] ?? null : null
  }

  function hold (hash: string, file: Blob) {
    // Already held is already right: the bytes are content-addressed, so a
    // second URL onto the same hash would be a second claim on the same file
    // and the first would be leaked rather than replaced.
    if (urls.value[hash]) return

    urls.value = { ...urls.value, [hash]: URL.createObjectURL(file) }
  }

  /**
   * Keep a file and answer with what a row should say about it.
   *
   * Answers a sentence when it will not do, and the reference when it will —
   * the shape the merge and the auto run already use, because every caller has
   * somewhere to put a sentence and nowhere to put an exception.
   *
   * The two refusals are told apart deliberately. "Not a format we can keep"
   * and "not an image at all" are different mistakes with different fixes, and
   * a single "that did not work" would leave a reader re-picking the same file.
   */
  async function place (file: File): Promise<{ image: PlacedImage } | { refused: string }> {
    if (!placedExtension(file)) return { refused: `A placed image has to be ${PLACED_KINDS}.` }

    const image = await writePlaced(file)

    if (!image) return { refused: 'That file could not be opened as an image.' }

    hold(image.hash, file)

    return { image }
  }

  /**
   * Every reference the open chapter names, folded by hash.
   *
   * The whole chapter and not the page in front of you, now that a stack
   * belongs to its page — see `ComicPage.stack`. Reading only the open page
   * would find each picture's bytes at the moment somebody turned to it, so
   * every page with a placed clean would show a gap for as long as the read
   * took. Folding by hash is what keeps that cheap: a clean placed on all
   * twenty pages is twenty rows and one file.
   */
  function referenced (): PlacedImage[] {
    const found = new Map<string, PlacedImage>()

    const walk = (rows: StackLayer[]) => {
      for (const row of rows) {
        if (row.image) found.set(row.image.hash, row.image)

        if (row.children) walk(row.children)
      }
    }

    for (const target of pages.value) walk(target.stack ?? [])

    return [...found.values()]
  }

  /**
   * What the stack is asking for right now, as one string to watch.
   *
   * The watcher lives in the workspace page rather than here, and that is not
   * arbitrary: this composable is called from the canvas and from the panel, so
   * a watcher registered inside it would be registered twice — and `useComic`
   * has the same shape, which is why `useWorkspaceReset` says at length that
   * these are asked for during setup and never from inside a callback. One
   * owner, one watcher.
   */
  const asked = computed(() => referenced().map((image) => image.hash).join(','))

  /**
   * Find the bytes for whatever the stack in front of us refers to.
   *
   * A reference arrives by more than one route — a picture placed here, a stack
   * pulled back from the server on a reload, a collaborator's row arriving live
   * — and only the first goes through `place`, which is why this is driven by
   * what the stack says rather than called at the moment of placing.
   *
   * A reference whose bytes are nowhere is left alone rather than reported. It
   * is the ordinary state of a chapter somebody shared: the row is here, the
   * file is on their machine, and the row says so itself rather than the whole
   * restore reading as a failure.
   */
  async function restore (): Promise<void> {
    const wanted = referenced().filter((image) => !urls.value[image.hash])

    if (!wanted.length) return

    for (const [hash, file] of await readPlacedMany(wanted)) hold(hash, file)
  }

  return { urls, urlFor, place, restore, referenced, asked }
}
