/**
 * How a comic gets opened, and how it is still open next time.
 *
 * There are two ways to hold onto a chapter and the difference between them is
 * the difference between the browsers:
 *
 * - A **handle** on the user's own folder. Chromium gives one up, it survives in
 *   IndexedDB, and it costs nothing — the pages stay exactly where they are, in
 *   the folder the user already keeps them in, and one day the finished plates
 *   can be written back beside them. Reading it again needs the user's say-so,
 *   once per session.
 * - A **copy**, in the origin's private filesystem. Firefox and Safari will not
 *   hand over a real folder, so the only way to have the pages tomorrow is to
 *   have our own. No permission is ever needed and nothing can move underneath
 *   us, but a chapter of scans now exists twice on the disk.
 *
 * The handle is preferred wherever it can be had, and the copy is what happens
 * otherwise. Which one is in force is worth knowing rather than hiding — it is
 * the difference between working on the user's files and working on a duplicate
 * of them, and they should be told which.
 *
 * `useComic` holds what is open. This holds where it came from.
 *
 * Everything that goes wrong here is said in a toast rather than left in a
 * rejected promise. Opening a folder is one gesture with a great many ways to
 * come to nothing — a dismissed dialog, a folder the browser will not read, a
 * folder with no pages in it — and the failure that says nothing is the one that
 * looks like a broken button.
 */
import { idbKey } from '~/utils/idbKeys'
import { pickedName } from '~/utils/images'
import { PdfPasswordError } from '~/utils/pdf/decrypt'
import { knowRowsBy } from '~/utils/pdf/known'
import { hashLanes } from '~/utils/resources'

/** What is remembered between sessions, and all that is. */
type Chapter =
  | { kind: 'handle', title: string, handle: FileSystemDirectoryHandle }
  | { kind: 'copy', title: string }
  /*
   * Desktop: kept as what it was opened from — every file and folder dropped or
   * picked, by handle (see `Source` in `utils/images.ts`) — rather than copied.
   * `removed` is the paths of pages taken out of the chapter that a folder among
   * the sources still holds, so they stay out when it is read again. Pages the
   * app made itself (a blank, a file linked to a page) have no source, and live
   * in the private filesystem as before; reopening reads both.
   */
  | { kind: 'sources', title: string, sources: Source[], removed?: string[] }

/**
 * What this browser has done to the pages that their files cannot say.
 *
 * A restore works the order out from paths and the names out from files, which
 * is right until somebody drags a page somewhere else or calls it something
 * better — neither of which changes a byte of any file. So the changes live
 * beside the chapter, keyed by page id, and are laid back over whatever a
 * restore worked out.
 */
interface PagesMeta {
  /** Every page id, in the order the reader arranged them. */
  order?: string[]
  /** What renamed pages are called now. */
  names?: Record<string, string>
  /**
   * The chapter's own name for each page, by this browser's page id.
   *
   * Kept because a `ComicPage` is rebuilt from the folder every time a chapter
   * opens, and a uid the workspace handed out would otherwise be forgotten on
   * every reload — leaving the page to be matched by its bytes again, which is
   * the thing `uid` exists because it cannot do. See `pages.uid`.
   */
  uids?: Record<string, string>
}

/**
 * Which reading of a book owns the "still reading" line, counted.
 *
 * A number rather than the object itself, because the object cannot be
 * compared: what goes into a `useState` comes back out as a reactive proxy of
 * what went in, so a drain checking whether the line on screen is still its own
 * would be comparing a proxy against the raw object it made, and never
 * recognising its own work. A count has no such second identity.
 */
let readings = 0

/**
 * The `identify` run in flight, and whether pages arrived while it ran — see
 * `identify`. Module-level for the reason `readings` is: every caller of
 * `useLibrary` gets its own closure, and a guard in one of them guards nothing.
 */
let identifying: Promise<void> | null = null
let identifyAgain = false

/**
 * The scope the watcher that writes page uids down lives in.
 *
 * Detached — `effectScope(true)` — rather than a plain flag, and the difference
 * is the whole of why the first attempt wrote nothing. A watcher created inside
 * `useLibrary` belongs to whichever component happened to call it first, and
 * several do; when that component unmounted the watcher went with it while the
 * flag stayed set, so nothing re-created it and no uid was ever kept. A page
 * then came back from a reload with no name of its own and fell straight back
 * to being matched by its bytes, which is the one thing `uid` exists because
 * bytes cannot do.
 *
 * A detached scope has no parent to be collected by, so it outlives every
 * component and is created exactly once.
 */
let keepingUids: ReturnType<typeof effectScope> | null = null

/** How long a PDF's first compressed page waits for the workspace record — see `knowRowsBy`. */
const ROWS_WAIT_MS = 30_000

/**
 * What became of an attempt to give an absent page its file — see `link`.
 *
 * `mismatch` is not a failure, and is the whole reason this is an answer rather
 * than a promise of nothing: the file opens, it is a picture, and it is simply
 * not the one the workspace recorded for that page. Only the reader can settle
 * whether that is the wrong file or the same page exported again, so the
 * question comes back out to where there is somebody to ask.
 */
export type Linked = 'linked' | 'mismatch' | 'unknown'

/**
 * `work` over `items`, at most `lanes` at once, started in order.
 *
 * For reading files to hash them, which is the one thing here bound by how
 * much can be held at once: `crypto.subtle` has no streaming digest, so every
 * file in flight is in memory whole. One at a time left the disk idle while
 * each digest ran, and everything at once — what a drop did — held the whole
 * drop. See `hashLanes` for the width.
 */
async function inLanes<T> (items: readonly T[], lanes: number, work: (item: T, index: number) => Promise<void>) {
  let next = 0

  await Promise.all(Array.from({ length: Math.max(1, Math.min(lanes, items.length)) }, async () => {
    while (next < items.length) {
      const at = next++

      await work(items[at]!, at)
    }
  }))
}

export function useLibrary () {
  const {
    openImages,
    appendImages,
    addBlankPage,
    movePage,
    removePage,
    renamePage,
    identified,
    attach,
    pages: openPages,
    at: openAt,
    title: openTitle,
    open,
    epoch,
  } = useComic()
  const { note, purge } = useWorkspaces()
  const { shared, asking, push, pageRowOf, forgetPage } = useShared()

  /**
   * The workspace's page rows, for a PDF deciding which files its pages come
   * out as — see `utils/pdf/identity.ts`. Waits for a record still on its way:
   * a chapter restored on the way in opens at the same moment the record is
   * asked for (`look`), and a cloud chapter first opened before its PDFs had a
   * second road is recognised by those rows alone on a computer that has
   * never held it.
   *
   * Bounded, because a page waits on it: a server that never answers leaves
   * the book decided on this browser's own stores, which is what it would be
   * signed out.
   */
  knowRowsBy(async () => {
    if (asking.value) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer)
          stop()
          resolve()
        }
        const timer = setTimeout(done, ROWS_WAIT_MS)
        const stop = watch(asking, (now) => { if (!now) done() })
      })
    }

    return shared.value?.pages ?? []
  })

  /**
   * Which workspace this is, taken from the address rather than passed in.
   *
   * The address is the truth about which workspace you are in — it is what gets
   * shared, bookmarked and reopened — so reading it here means every part of
   * the workspace agrees on that without any of them having to be told, and a
   * component like the drop zone needs to know nothing about workspaces at all.
   */
  const route = useRoute()

  const workspace = computed(() => String(route.params.workspaceId ?? ''))

  const key = computed(() => idbKey.workspace(workspace.value))

  /** Where the reader's own ordering and naming of the pages is kept. */
  const metaKey = computed(() => idbKey.pages(workspace.value))

  /** Where the open comic is being kept, once one is open from disk. */
  const kind = useState<'handle' | 'copy' | 'sources' | null>('library-kind', () => null)

  /**
   * A chapter we remember but may not read yet.
   *
   * A kept handle comes back with its permission lapsed, and permission can
   * only be asked for from a gesture — so it cannot be settled on the way in.
   * The chapter waits here and the workspace offers to reopen it, which is the
   * gesture.
   */
  const pending = useState<Chapter | null>('library-pending', () => null)

  /** What is happening, while it is: copying a folder in is not instant. */
  const busy = useState<string | null>('library-busy', () => null)

  /**
   * Pages still coming out of a book, while they come.
   *
   * Deliberately not `busy`. `busy` puts an overlay over the canvas, which is
   * the right thing while there is nothing yet to see and exactly the wrong
   * thing here: the whole point of handing over page one early is that it can
   * be read, and a spinner over the top would take back what was given. This
   * says so along the status bar instead, out of the way of the page.
   */
  const arriving = useState<{ done: number, total: number, of: string } | null>('library-arriving', () => null)

  /** Which reading put that line up — see `readings`. */
  const reader = useState('library-reader', () => 0)

  /**
   * Whether we have worked out what was open last time.
   *
   * True until `restore` has been and settled it, and true on the server as
   * well — which is the point. What is open is kept in the browser's own
   * storage, so the server cannot know it and neither can the first frame; and
   * the stand-in comic is what the workspace holds meanwhile. Rendering it and
   * then swapping it out is a chapter of somebody else's comic flashing up on
   * every refresh, which reads as the app losing the real one.
   */
  const restoring = useState('library-restoring', () => true)

  /**
   * Open what was found, and arrange for it to still be there next time.
   *
   * The pages go on screen first and are persisted after. Copying a folder into
   * the private filesystem takes as long as the folder is big, and there is no
   * reason to make the user watch a progress bar before seeing page one.
   *
   * ## `dress`, and why it cannot simply be done afterwards
   *
   * A caller that already knows something about these pages — importing a
   * project is the only one — gets to say so here, in the gap between the pages
   * existing and anything being told about them. It is called **synchronously**
   * and that is the whole of its value: Vue's watchers run on the next tick, so
   * a function invoked here beats every one of them, and a caller doing the
   * same work after this promise settles does not.
   *
   * What is at stake is not tidiness. The moment pages land, `syncPages` pushes
   * them and mints a `uid` for every one that has not got one, and
   * `useLayerSync.pull` founds each page's stack from `DEFAULT_STACK` and reads
   * it straight back over whatever the client held. An import that assigned its
   * uids and its stacks afterwards therefore lost both — silently, and only on
   * a workspace with a server record, which is exactly the case a signed-in
   * reader gets by default. Every sheet, group, adjustment and placed image in
   * the file went with them.
   */
  async function opened ({ handle, images, title, rest, sources }: Opened, dress?: () => void) {
    if (!images.length) {
      // A folder that came back empty *and* still has a good handle is the case
      // where nothing could be read rather than nothing was there — permission
      // the browser will only discuss with a click. So it becomes an offer with
      // a button on it instead of a dead end.
      if (handle) {
        pending.value = { kind: 'handle', title: handle.name, handle }
        open.value = false

        // The toast carries the way out as well as the news, because the button
        // it names is the only thing that can ask for what is missing.
        toast.warning(`Nothing could be read from “${handle.name}”`, {
          description: 'If it has pages in it, press Reopen folder to let the browser in.',
          action: { label: 'Reopen folder', onClick: () => { reopen() } },
        })

        await remember({ kind: 'handle', title: handle.name, handle })

        return false
      }

      // Named, and with what was looked for. "Nothing to open" about a folder
      // the user can plainly see has pages in it tells them nothing about why.
      if (title) toast.warning(`No pages found in “${title}”`, { description: `Looked for ${IMAGE_KINDS}, in it and under it.` })
      else toast.warning('Nothing there we can open', { description: 'Drop images, or a folder of them.' })

      return false
    }

    await openImages(images, title ?? undefined)

    // Desktop: the pages a missing copy asked for have arrived — see `resume`.
    toast.dismiss(missingToast(workspace.value))

    // Before the first `await` below, and before anything has had a tick to
    // notice the pages — see the note above, which is where the reason lives.
    dress?.()

    // A fresh chapter starts with its own order and its own names — whatever
    // was rearranged or renamed belonged to the chapter this one replaces.
    await idb.del(metaKey.value).catch(() => {})

    const name = title ?? (images.length === 1 ? pickedName(images[0]!) : `${images.length} pages`)

    if (handle) {
      kind.value = 'handle'
      await remember({ kind: 'handle', title: name, handle })

      // Whatever was copied in for the last chapter is now a chapter nothing
      // points at. Gigabytes of one, potentially — a folder opened by handle
      // after one opened by copy would otherwise leave the copy on the disk for
      // good, since nothing ever looks at it again to know it is there.
      await clear(workspace.value).catch(() => {})

      // A folder of PDFs is read where it stands, so the pages that are still
      // coming only have to reach the canvas — there is nothing to keep.
      drain(rest, null)

      return true
    }

    // Desktop: loose files and PDFs kept as the files they are, where the drop or
    // the picker handed over a handle on each — see `Source`. Nothing is copied;
    // whatever an earlier chapter here had copied in is cleared, as for a folder,
    // and a PDF's later pages only have to reach the canvas.
    if (sources?.length) {
      kind.value = 'sources'
      await remember({ kind: 'sources', title: name, sources })
      await clear(workspace.value).catch(() => {})

      drain(rest, null)

      return true
    }

    if (!opfsUsable()) {
      // Nothing to be done about it, and worth saying plainly rather than
      // letting the chapter quietly not be there tomorrow.
      kind.value = null
      toast.warning('These pages are open for this visit only', {
        description: 'This browser can’t keep them — they’ll need opening again next time.',
      })

      drain(rest, null)

      return true
    }

    kind.value = 'copy'
    busy.value = `Copying ${images.length} pages…`

    try {
      await copyIn(workspace.value, images, (done, total) => (busy.value = `Copying ${done} of ${total}…`))
      await remember({ kind: 'copy', title: name })

      // Kept as they land, rather than in one go at the end. A book still
      // being read is a chapter that already half exists, and the half that
      // exists should survive the tab being closed.
      drain(rest, workspace.value)
    } catch (error) {
      kind.value = null
      unsaved(error)

      // Storage would not have them, but the canvas still will.
      drain(rest, null)
    } finally {
      busy.value = null
    }

    return true
  }

  /**
   * Take the rest of a book as it comes, without anybody waiting on it.
   *
   * Never awaited by `opened`, which is the point: the pages already handed
   * over are on screen, and this is the remainder arriving behind them. Each
   * page joins the open comic the moment it exists and is written to storage
   * straight after, so what is on screen and what is kept never drift apart by
   * more than one page.
   *
   * `into` is the workspace to keep them in, or null where there is nothing to
   * keep — a folder we hold a handle on, or a browser that will not store.
   */
  function drain (rest: Rest | null, into: string | null) {
    if (!rest) return

    // Which comic these belong to. A chapter closed and another opened while a
    // book is still being read would otherwise pour the rest of the old one
    // into the new — see `epoch`.
    const mine = epoch.value

    // Whose line on screen is whose. Taking it down at the end has to take down
    // *ours*: a book abandoned half-read still owes the status bar that much,
    // and the comic opened over the top of it may already be reading a book of
    // its own that this one must not silence.
    const me = ++readings

    const say = (state: { done: number, total: number, of: string } | null) => {
      if (reader.value !== me && state === null) return

      reader.value = me
      arriving.value = state
    }

    const run = async () => {
      say({ done: 1, total: rest.expected, of: rest.of })

      try {
        for await (const { image, done, total, of } of rest.pages) {
          // Somebody opened something else. The book is dropped mid-sentence,
          // and `return` rather than `break` so the generator's own cleanup
          // runs — which is what stops the worker still reading it.
          if (epoch.value !== mine) return

          appendImages([image])
          say({ done, total, of })

          if (into) await addIn(into, [image]).catch(unsaved)
        }

        // The pages that just streamed in were slotted by path, which is right
        // until the reader has kept an order of their own — laid back on once
        // the book is whole, not per page, and only if this is still the comic
        // the order belongs to.
        if (epoch.value === mine) await applyMeta(openPages.value[openAt.value]?.id)
      } catch (error) {
        // The pages that did arrive are open and kept. What went wrong stopped
        // the rest of that book, which is worth saying once, plainly.
        failed('The rest of those pages couldn’t be read.', error)
      } finally {
        say(null)
      }
    }

    run()
  }

  /**
   * Say what went wrong, in the interface and in the console.
   *
   * Both, and always. An opening that fails silently is indistinguishable from
   * one that did nothing at all — the user is left pressing a button that has
   * no effect, with the reason sitting in a rejected promise nobody caught.
   */
  function failed (what: string, error: unknown) {
    // A locked file nobody typed a password for is not a failure — it is the
    // answer somebody just gave, and the dialog they gave it in has already
    // gone. Said once, quietly, rather than in red and until dismissed.
    if (error instanceof PdfPasswordError) {
      toast.warning('That PDF wasn’t opened', {
        description: 'It needs its password. Drop it in again if you want another go.',
      })

      return
    }

    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)

    // The sentence in the toast and the object in the console: one for the
    // person using this, one for whoever has to work out why.
    toast.error(what, { description: detail })
    console.error('[kemolate]', what, error)
  }

  /**
   * The browser's own storage would not open.
   *
   * Its own case because it is not a failure of the thing the person just did —
   * the pages are open and usable, and what is lost is only the note saying so
   * for next time. Reporting it as an error over a chapter that plainly arrived
   * reads as though the chapter did not.
   *
   * It is also the one storage problem with a reliable fix. The database gets
   * into this state when a deletion is left pending by a connection that never
   * closed, and reloading the tab drops the connection and clears it — so the
   * remedy goes in the toast rather than being left for somebody to guess.
   */
  function unsaved (error: unknown) {
    const wedged = error instanceof Error && /did not open in time|another tab/i.test(error.message)

    console.warn('[kemolate] could not write to storage', error)

    if (!wedged) {
      toast.warning('This chapter is open, but won’t be remembered', {
        description: 'The browser refused to save it for next time.',
      })

      return
    }

    toast.warning('This chapter is open, but won’t be remembered', {
      description: 'This browser’s storage is stuck. Reloading the page usually clears it.',
      action: { label: 'Reload', onClick: () => { window.location.reload() } },
    })
  }

  /**
   * The folder dialog, by whichever means this browser has.
   *
   * The timer is for the dialog nobody can see. It is an operating system
   * window rather than part of the page, so it can open behind this one or on
   * another desktop, and while it waits there the promise below simply does not
   * settle — the button looks broken, and pressing it again only raises "file
   * picker already active", because as far as the browser is concerned one is
   * already open.
   *
   * Nothing here can raise or cancel that window. What it can do is stop
   * pretending the press did nothing, and say where to go looking.
   */
  async function openFolder () {
    let settled = false

    const hint = setTimeout(() => {
      if (settled) return

      toast.info('Still waiting on the file dialog', {
        description: 'It opens as a separate window and may be behind this one. If you can’t find it, drag the folder onto the canvas instead.',
      })
    }, 20_000)

    try {
      const found = await pickFolder()

      // A dismissed dialog gives nothing back and means nothing by it.
      if (!found.images.length && !found.handle) return

      await opened(found)
    } catch (error) {
      failed('That folder couldn’t be opened.', error)
    } finally {
      settled = true
      clearTimeout(hint)
    }
  }

  /**
   * Open loose files — images, or PDFs — as the chapter, the way a folder or a
   * drop is opened. For the File menu, beside `openFolder`: a folder is the
   * usual case, and a handful of pages is the other one, which until now only
   * a drop could reach.
   *
   * Desktop: the picker hands back a handle on each file, so a chapter opened
   * this way is kept as the files it is (`Source`); where it would not, as a
   * copy. `opened` decides, as it does for a drop.
   */
  async function openFiles () {
    try {
      const found = await pickImages()

      // A dismissed dialog gives nothing back and means nothing by it.
      if (!found.images.length) return

      await opened({ ...found, handle: null, title: null })
    } catch (error) {
      failed('Those files couldn’t be opened.', error)
    }
  }

  /**
   * Pick up whatever was open last time, on the way in.
   *
   * A copy can simply be read. A handle usually can too — see below — and where
   * it cannot, it is parked in `pending` for the workspace to offer back.
   *
   * Everything it might do is wrapped so that `restoring` comes down however it
   * goes. A workspace that never learns the answer is a workspace that waits
   * for ever, and an empty canvas is a worse lie than the stand-in was.
   */
  /** Desktop: the id of a workspace's "pages are missing" warning — see `resume`. */
  const missingToast = (id: string) => `pages-missing:${id}`

  async function restore () {
    // Cleared first, because these outlive the page they were set on. Walking
    // from one workspace to another keeps the same running app, and a stale
    // "In your folder" under a workspace holding nothing of the sort is a lie
    // told confidently.
    kind.value = null
    pending.value = null
    restoring.value = true

    try {
      await resume()
    } finally {
      restoring.value = false
    }
  }

  /** The page this browser was last on in this workspace — see `usePagePosition`. */
  const lastAt = () => idb.get<string>(idbKey.position(workspace.value)).catch(() => undefined)

  async function resume () {
    const chapter = await idb.get<Chapter>(key.value).catch(() => null)

    // Nothing to come back to under this workspace — but there may be a chapter
    // from before workspaces existed, and losing somebody's open comic to a
    // change of address would be a poor way to introduce one.
    if (!chapter) {
      if (await adopt()) return await resume()

      // Genuinely nothing here — which is what a new workspace is, and what a
      // workspace somebody has just been invited into looks like from their
      // side. The empty state says which.
      open.value = false

      return
    }

    if (chapter.kind === 'copy') {
      const images = await readBack(workspace.value).catch(() => [])

      /*
       * Desktop: the pages are missing, and nothing else is given up with them.
       *
       * The web build forgets the workspace here — `purge`, which deletes its
       * reading, translations, layers, glossary and its row in the list. There a
       * copy is the Firefox and Safari fallback; here it is how every dropped file
       * is kept, so a copy that failed or was cut short (the app closed while it
       * was writing, storage refusing a write — "won't be remembered") turned the
       * next launch into a silent wipe of everything done on the chapter. The
       * workspace went from the list, with its work, and nobody was told.
       *
       * Everything the chapter holds is filed by each scan's content, not by the
       * copy, so the same pages dropped in again find their readings, lettering
       * and layers waiting. So the workspace stays, open and empty, and says so.
       * Deleting it is still one choice away, on the list. The warning is filed
       * under the workspace and taken down when pages arrive (`opened`), since a
       * warning stays until it is dismissed and this one is answered by a drop.
       *
       * Since the database (2026-10-21) the workspace's record puts its pages
       * back on screen with their work, pictures absent (`useShared.showMissing`,
       * which raises `open` again), and the reader gives each its file back —
       * `CanvasAbsent`. The warning says so.
       */
      if (!images.length) {
        open.value = false
        toast.warning('This chapter’s pages are missing', {
          id: missingToast(workspace.value),
          description: 'The copy the app kept of them is gone. The work on them is safe — open their folder, or give each page its file from the page list.',
        })

        return
      }

      kind.value = 'copy'

      const at = await lastAt()

      await openImages(images, chapter.title, at)
      await applyMeta(at)

      return
    }

    if (chapter.kind === 'sources') {
      const found = await imagesOf(chapter.sources, { reopening: true })
        .catch(() => ({ images: [], rest: null, missing: chapter.sources.length }))
      const made = await readBack(workspace.value).catch(() => [])
      const removed = new Set(chapter.removed ?? [])
      const images = inReadingOrder([...found.images, ...made]).filter((image) => !removed.has(image.path))

      // Every file gone — moved, renamed, deleted, or a drive not plugged in.
      // The work stays, as for a copy that went missing (see above), and the
      // same pages dropped in again find it.
      if (!images.length) {
        open.value = false
        toast.warning('This chapter’s files are missing', {
          id: missingToast(workspace.value),
          description: 'They have been moved or deleted since it was opened. The work on them is safe — open their folder, or give each page its file from the page list.',
        })

        return
      }

      kind.value = 'sources'

      const at = await lastAt()

      await openImages(images, chapter.title, at)
      await applyMeta(at)

      drain(found.rest, null)

      if (found.missing) {
        toast.warning(`${found.missing} of this chapter’s files ${found.missing === 1 ? 'is' : 'are'} missing`, {
          description: 'Moved or deleted since the chapter was opened, so their pictures are not here. The work on them is safe — give each page its file from the page list.',
        })
      }

      return
    }

    // Tried rather than asked about. A permission query is a second opinion on
    // something reading the folder settles outright, and the query has a habit
    // of saying "prompt" about folders that read perfectly well — which turned
    // opening one into a permission error nobody could clear.
    const found = await imagesIn(chapter.handle, { reopening: true }).catch(() => null)

    if (found?.images.length) {
      kind.value = 'handle'

      const at = await lastAt()

      await openImages(found.images, chapter.handle.name, at)
      await applyMeta(at)

      // A folder with PDFs in it is read again on every visit, and again the
      // first page of one need not wait for the last.
      drain(found.rest, null)

      return
    }

    // Not ours to open yet, or not ours any more. Either way the offer belongs
    // in the empty state, where a click can ask for it — which is the only
    // place permission can be asked for at all.
    pending.value = chapter
    open.value = false
  }

  /**
   * Take over the chapter an earlier build kept, which had nowhere to say which
   * workspace it belonged to because there were none.
   *
   * It goes to whichever workspace asks first, which is the one the front door
   * has just made — so somebody who had a comic open before this change finds
   * it still open afterwards, at a new address. The old record is cleared as it
   * is taken, so this happens once and never again.
   *
   * Deletable, along with `adoptLegacy`, once nobody can still be arriving from
   * a build that stored things this way.
   */
  async function adopt () {
    const legacy = await idb.get<Chapter>('chapter').catch(() => null)

    if (!legacy) return false

    await idb.del('chapter').catch(() => {})

    if (legacy.kind === 'copy') await adoptLegacy(workspace.value).catch(() => {})

    await remember(legacy)

    return true
  }

  /** The offer in the empty state, taken. Must be called from a gesture. */
  async function reopen () {
    const chapter = pending.value

    if (!chapter || chapter.kind !== 'handle') return

    // Here, and only here, is asking worth doing: a click carries the activation
    // that `requestPermission` requires, which is exactly what a drop does not.
    // A browser without the call at all has nothing to refuse, so we go and read.
    const state = await chapter.handle.requestPermission?.({ mode: 'read' })
      .catch(() => 'denied' as PermissionState) ?? 'granted'

    if (state !== 'granted') {
      toast.error('That folder can’t be reopened', {
        description: 'The browser needs permission to read it.',
      })

      return
    }

    pending.value = null
    await use(chapter)
  }

  /**
   * Give up on a remembered chapter, and on the copy of it if there is one.
   *
   * The erasing itself is `purge`, shared with the collection page — which has
   * to do the same thing to a workspace it is not standing in. It used to be
   * written out here as well and the two had already drifted: this one knew
   * nothing about the target language, so a deleted workspace left its language
   * behind to be inherited by the next one to be made.
   */
  async function forget () {
    pending.value = null
    kind.value = null

    await purge(workspace.value)
  }

  async function use (chapter: Chapter & { kind: 'handle' }) {
    busy.value = 'Reading the folder…'

    try {
      const { images, rest } = await imagesIn(chapter.handle, { reopening: true })

      // Read, and genuinely empty — permission was just granted, so this is the
      // folder having no pages rather than us being unable to see them. Said,
      // and then given up on, because there is nothing there to come back to.
      if (!images.length) {
        toast.warning(`No pages found in “${chapter.handle.name}”`, {
          description: `Looked for ${IMAGE_KINDS}, in it and under it.`,
        })

        await forget()

        return
      }

      kind.value = 'handle'
      pending.value = null

      const at = await lastAt()

      await openImages(images, chapter.handle.name, at)
      await applyMeta(at)
      drain(rest, null)
    } catch (error) {
      failed('That folder couldn’t be read. It may have been moved.', error)
      await forget()
    } finally {
      busy.value = null
    }
  }

  async function remember (chapter: Chapter) {
    // Asked for once we have something worth keeping, rather than on the way in
    // — a prompt before the user has opened anything is a prompt about nothing.
    await persist()

    // A chapter that cannot be written down is one that will not be there next
    // time. Worth saying, but not worth refusing to open the pages over.
    await idb.set(key.value, chapter).catch(unsaved)

    // And into the index, which is how the front door knows this workspace
    // exists and that it is the one you were last in.
    await note(workspace.value, chapter.title)
  }

  /**
   * Lay the reader's ordering and naming back over a restored chapter.
   *
   * After the paths have had their say rather than instead of it: the restore
   * puts the pages in reading order, and this moves only what somebody moved.
   * A page the meta has never heard of — arrived since the last reorder — goes
   * below everything it has, keeping its own order among the rest, which is
   * the same rule `align` in `useShared` applies for the same situation.
   */
  async function applyMeta (keep?: string) {
    const meta = await idb.get<PagesMeta>(metaKey.value).catch(() => null)

    if (!meta) return

    if (meta.names) {
      for (const page of openPages.value) {
        const called = meta.names[page.id]

        if (called) page.name = called
      }
    }

    // Before anything asks the server which row a page is: without its uid a
    // page falls back to being matched by its bytes, and two pages of a chapter
    // can honestly share those.
    if (meta.uids) {
      for (const page of openPages.value) {
        const named = meta.uids[page.id]

        if (named) page.uid = named
      }
    }

    if (meta.order?.length) {
      const rank = new Map(meta.order.map((id, index) => [id, index]))

      openPages.value = [...openPages.value].sort(
        (a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
      )

      /*
       * Deliberately *not* keeping the previously-shown page on screen across
       * the sort, the way `appendImages` does. That follow is for a reader in
       * the middle of something; this only ever runs during a restore, where
       * "the page being looked at" is just whoever happened to sort first by
       * path. Following it meant a chapter arranged cover-first came back on
       * page two — showing the same wrong page the sort had just moved, on
       * every refresh. A restore lands on the first page of the reader's own
       * order — or, where a page is named, on that page, wherever the order has
       * put it: the page this browser was last on (see `resume`), or the page
       * being read when a book finished streaming in (see `drain`), which used
       * to be sent back to the first page the moment the last one arrived.
       */
      openAt.value = keep ? Math.max(0, openPages.value.findIndex((page) => page.id === keep)) : 0
    }
  }

  /** Change the kept meta in one read-change-write, however little of it exists. */
  async function keepMeta (change: (meta: PagesMeta) => void) {
    const meta = (await idb.get<PagesMeta>(metaKey.value).catch(() => null)) ?? {}

    change(meta)

    await idb.set(metaKey.value, meta).catch(() => {})
  }

  /**
   * Write the chapter's names for its pages down as they are handed out.
   *
   * Watched rather than called from `useShared.adopt`, which is where they
   * arrive: that file knows about the server and nothing about where this
   * browser keeps a chapter, and reaching across would put a storage decision
   * in the one place that has no business making it. Watching also catches the
   * uids that come back from a plain `look`, not only the ones a push earned.
   *
   * Installed once however many components ask for this composable — the same
   * guard `useMaskEdits` uses, and for the same reason: a watcher per caller is
   * one write per caller for every page that gets a name.
   */
  if (import.meta.client && !keepingUids) {
    keepingUids = effectScope(true)

    keepingUids.run(() => {
      watch(
        () => openPages.value.map((page) => `${page.id}=${page.uid ?? ''}`).join('\n'),
        () => {
          const named = openPages.value.filter((page) => page.uid)

          if (!named.length) return

          keepMeta((meta) => {
            meta.uids = { ...meta.uids, ...Object.fromEntries(named.map((page) => [page.id, page.uid!])) }
          })
        },
      )
    })
  }

  /**
   * Move a page in the reading order, and make it stick: beside the chapter
   * for next time, and on the workspace for everybody in it, where there is a
   * workspace to tell — `push` is a no-op for anyone it is not theirs to tell.
   */
  async function arrange (id: string, to: number) {
    movePage(id, to)

    await keepMeta((meta) => { meta.order = openPages.value.map((page) => page.id) })
    await push()
  }

  /** Rename a page, with the same two places to make it stick. */
  async function rename (id: string, name: string) {
    renamePage(id, name)

    const target = openPages.value.find((page) => page.id === id)

    if (!target) return

    await keepMeta((meta) => { (meta.names ??= {})[id] = target.name })
    await push()
  }

  /**
   * Take a page out of the chapter, in every place that remembers it.
   *
   * Four of them, and missing any one is how a deleted page comes back: the
   * open chapter, the kept order, the copied file, and the workspace row. They
   * are done in that order so the page is off the screen before anything slower
   * happens, and the failures are quiet for the usual reason — a page removed
   * here and not on the server reads as removed either way until a reload, and
   * saying so mid-gesture helps nobody.
   *
   * What is *not* touched is the reading. The blocks, the thumbnail and the
   * cleanup patches are filed under the scan's own hash rather than under the
   * page — see `useBlockCache` — so adding the same file back finds all of it
   * again. That is the behaviour somebody who deleted a page by mistake wants,
   * and the reason nothing here tries to be thorough about it.
   */
  /**
   * `onServer` is false when the page has *already* gone from the workspace and
   * this browser is catching up — see `useLiveSync.relist`.
   *
   * Everything else is identical, because everything else needs doing either
   * way: the page comes off the chapter, out of the kept order and out of this
   * browser's own copy. Only the DELETE is skipped, and skipping it matters —
   * sent for a row that is already gone it answers 404, which this reads as a
   * failure and reports as "removed here but not on the workspace", telling the
   * reader something alarming and untrue about somebody else's deletion.
   */
  async function discard (id: string, onServer = true) {
    const target = openPages.value.find((page) => page.id === id)

    if (!target) return

    const path = pathOfPage(target)
    const row = pageRowOf(target)

    removePage(id)

    await keepMeta((meta) => {
      if (meta.order) meta.order = openPages.value.map((page) => page.id)

      // Rebuilt without it rather than deleted out of it: the name of a page
      // that is gone is a name nothing will ask for, and leaving it would put
      // the old name back if the same file were added again.
      if (meta.names) {
        meta.names = Object.fromEntries(Object.entries(meta.names).filter(([key]) => key !== id))
      }
    })

    // Only a copied chapter has a file of its own to take out — see `removeIn`
    // — and only a page that had a file here at all. A page whose picture was
    // never on this computer has nothing under that path but somebody else's,
    // and asking for it by name is how a removal would take the wrong one.
    if (kind.value === 'copy' && target.scan) await removeIn(workspace.value, path)

    // Desktop: a sources chapter drops a file that was this page from its
    // sources, and otherwise remembers the page as removed — a folder among the
    // sources still holds it, and would put it back. See `Chapter`.
    if (kind.value === 'sources') {
      await removeIn(workspace.value, path).catch(() => {})

      const chapter = await idb.get<Chapter>(key.value).catch(() => null)

      if (chapter?.kind === 'sources') {
        const sources = chapter.sources.filter((source) => !(source.kind === 'file' && source.path === path))
        const removed = sources.length === chapter.sources.length ? [...new Set([...chapter.removed ?? [], path])] : chapter.removed

        await idb.set(key.value, { ...chapter, sources, removed }).catch(unsaved)
      }
    }

    if (row && onServer) {
      await $fetch(`/api/workspaces/${workspace.value}/pages/${row}`, {
        method: 'DELETE',
        headers: peerHeader(workspace.value),
      })
        .then(() => forgetPage(row))
        .catch(() => {
          toast.warning('The page was removed here but not on the workspace', {
            description: 'It will come back on the next reload.',
          })
        })
    } else if (row) {
      // Already gone from the server — this browser is only catching up, and
      // its idea of what the workspace holds has to catch up too.
      forgetPage(row)
    }
  }

  /**
   * Pages dropped onto a chapter that is already open — added, not opened.
   *
   * The distinction is the whole of why this is not `opened`. Dropping a folder
   * onto the canvas *replaces* what is there, which is right: a folder is a
   * chapter, and dropping one means "work on this instead". Dropping a file
   * onto the page list means the opposite — it is the gesture for "and this
   * one too", and doing it through `opened` would throw away the chapter it was
   * aimed at.
   *
   * Kept the same three ways `addBlank` keeps a blank, and the sentence about
   * a folder-held chapter is the same sentence for the same reason: a page that
   * is not in the folder is not there tomorrow, and work done on a page that
   * quietly vanishes is work lost.
   *
   * Nothing open is not a failure, it is just the other gesture — the pages
   * become the chapter, exactly as if they had been dropped on the canvas.
   *
   * ## And they are pages in their own right
   *
   * A dropped page used to be matched to whatever row held the same picture, so
   * dropping page four onto a chapter that already had page four did nothing
   * visible and silently re-pointed the file at the existing row. That reads as
   * clever until you are on a second computer, where *every* page of the
   * chapter has a row and no file: dropping the folder in then re-linked the
   * lot, which is why it seemed to work — and dropping anything the workspace
   * had not seen before was refused outright as "not this workspace's chapter".
   *
   * So a drop now adds, always. Each page names itself on the way in (see
   * `appendImages`) and the server files it under that name rather than hunting
   * for a lookalike. Re-linking did not disappear with it — it became a gesture
   * of its own, aimed at the page it is about, which is `link` below.
   */
  async function addImages (found: Opened) {
    if (!found.images.length) return

    if (!open.value) return opened(found)

    /*
     * Hashed *before* the pages join the chapter, and the ordering of these
     * three lines is the whole of two bugs.
     *
     * A page is asked for by content hash and by nothing else, so a row written
     * with `hash: null` is a page no peer can ever fetch. Opening a chapter can
     * afford that — a hundred pages take seconds to hash and `fill` comes along
     * behind to write them in — but adding one page cannot, because until the
     * hash lands the page is invisible to everybody else *and* `align` counts
     * it a stranger to the chapter it was just added to. That is the "2 of 3
     * pages match this workspace" everybody saw.
     *
     * Hashing *first* rather than after appending is the second half. Every
     * await here is a window in which the watchers run, and `align` running in
     * that window sinks a page the workspace has not been told about yet to the
     * end of the chapter — so the page was hashed correctly and filed last
     * anyway. With the hashing done up front there is no window: appending,
     * naming and telling the server all happen without yielding, and `push`
     * reads the page list synchronously as it is called.
     *
     * A few at a time (`hashLanes`), not all at once: each file being hashed
     * is held whole, and sixty 25 MB scans dropped together were a gigabyte
     * and a half in memory before the first page was appended. The memo is
     * asked for them all in one read first, as `identify` does, and only
     * what it does not know is read.
     */
    const files = found.images.map((image) => image.file)
    const hashes = await rememberedHashes(files).catch(() => files.map(() => null))

    await inLanes(files, hashLanes(), async (file, at) => {
      hashes[at] ??= await hashFile(file, { recall: false }).catch(() => null)
    })

    appendImages(found.images, true)

    found.images.forEach((image, at) => {
      const hash = hashes[at]

      if (hash) identified(`scan:${image.path}`, hash)
    })

    // Onto the workspace before anything is awaited, so the list it is handed
    // is the one just built rather than whatever a watcher has since made of it.
    const told = push()

    // Into the kept order, where the reader has made one.
    await keepMeta((meta) => { if (meta.order) meta.order = openPages.value.map((page) => page.id) })
    await told

    if (kind.value === 'copy') {
      await addIn(workspace.value, found.images).catch(unsaved)

      return
    }

    // Desktop: onto a chapter kept by its sources, the new ones join them — or,
    // where the drop came without handles, are kept the way a copy keeps them.
    if (kind.value === 'sources') {
      const chapter = await idb.get<Chapter>(key.value).catch(() => null)

      if (chapter?.kind === 'sources' && found.sources?.length) {
        await remember({ ...chapter, sources: [...chapter.sources, ...found.sources] })
      } else {
        await addIn(workspace.value, found.images).catch(unsaved)
      }

      return
    }

    if (kind.value === 'handle' && !blankWarned.value) {
      blankWarned.value = true

      toast.info('These pages are here for this visit', {
        description: 'They aren’t in the folder this chapter was opened from, so reopening it starts without them.',
      })
    }
  }

  /**
   * Give a page whose picture is not on this computer the file it is.
   *
   * The other half of the rule that a drop adds a page. Dropping is "and this
   * one too" and now always means it; this is the gesture for "that page — here
   * is its picture", and keeping them apart is what stopped a second computer
   * from quietly turning a ten-page chapter into twenty. Nothing is created
   * here: the page already existed, with its uid, its boxes and everything the
   * workspace has filed under its row, and what changes is that it can now be
   * seen.
   *
   * The hash is the check, not the key. A file whose bytes are what the
   * workspace recorded is beyond argument and goes straight in. One that is not
   * comes back as `mismatch` and nothing is touched — it may be the wrong page
   * entirely, or the same page saved out again by somebody with a different
   * export setting, and only the reader knows which. Say `anyway` and it is
   * linked regardless: the page's identity is its uid, and the bytes were only
   * ever how a stranger's copy is *recognised*.
   *
   * What is not done is rewrite the row's hash to the new file's. Everybody
   * else's copy is still the original, and a peer asking for this page asks by
   * the hash the chapter agreed on — moving it would make the page unfetchable
   * for the people who can already serve it, to describe one machine's
   * substitute. The file is linked here and the chapter's account of itself
   * stands. A page the workspace never had a hash for is the exception, and
   * there the push below fills the blank in as it does for any other page.
   *
   * `quiet` is for the caller linking a chapter's worth at once — a fetch from
   * a peer, where every page arriving is one of these. The two things it holds
   * back are the ones that describe the *whole* list rather than this page: the
   * kept reading order and the push. Done per page they would be two hundred
   * read-modify-writes and two hundred requests each carrying the same list, so
   * whoever passes it owes both once at the end.
   *
   * `hash` is for a caller that already knows the file's, from its bytes — a
   * fetch, whose `assemble` checked every page against the hash it asked for.
   * Hashing again here read each page a second time for nothing, and missed
   * the memo every time, because a file put together from a transfer was
   * modified "now".
   */
  async function link (
    id: string,
    file: File,
    { anyway = false, quiet = false, hash: known }: { anyway?: boolean, quiet?: boolean, hash?: string } = {},
  ): Promise<Linked> {
    const target = openPages.value.find((page) => page.id === id)

    // Already has one, or is not here any more. Both are "nothing to do" rather
    // than errors: a fetch and a hand-picked file can race for the same page,
    // and the loser has nothing to complain about.
    if (!target || target.scan) return 'unknown'

    const row = shared.value?.pages.find((candidate) => candidate.uid === target.uid)

    const hash = known ?? await hashFile(file).catch(() => null)

    if (row?.hash && hash && row.hash !== hash && !anyway) return 'mismatch'

    if (!attach(id, file, hash)) return 'unknown'

    /*
     * Kept, and this is where a linked page differs most from a dropped one.
     *
     * A dropped page can afford to be here for the visit — the reader has the
     * file, they dropped it, they can drop it again. This one was linked
     * precisely *because* the chapter had no picture on this machine, so a page
     * that goes absent again on the next reload has given nothing back. Where
     * the browser has a private filesystem, the chapter becomes a copied one
     * for the purpose: `readBack` returns the file tomorrow, its path matches
     * the row, and the page is simply there.
     *
     * A chapter held by a folder handle is left alone. Its pages are read out
     * of the reader's own folder and writing a duplicate of one into browser
     * storage beside it would be keeping the same page twice, in two places,
     * with only one of them ever looked at.
     */
    const path = pathOfPage(target)

    // Desktop: a sources chapter keeps a page with no source of its own in the
    // private filesystem, and reads it back beside its sources — see `Chapter`.
    if (kind.value === 'copy' || kind.value === 'sources') {
      await addIn(workspace.value, [{ file, path }]).catch(unsaved)
    } else if (kind.value !== 'handle' && opfsUsable()) {
      kind.value = 'copy'

      await addIn(workspace.value, [{ file, path }]).catch(unsaved)
      await remember({ kind: 'copy', title: openTitle.value })
    } else if (kind.value === 'handle' && !blankWarned.value) {
      blankWarned.value = true

      toast.info('That page is here for this visit', {
        description: 'It isn’t in the folder this chapter was opened from, so reopening it starts without it.',
      })
    }

    if (!quiet) {
      // And into the kept order, where the reader has made one — the page is
      // not new, but its id has never been in that list before.
      await keepMeta((meta) => { if (meta.order) meta.order = openPages.value.map((page) => page.id) })

      // Last, and only now worth doing: the page has a hash, so the row can be
      // told what it is where it did not know, and this browser becomes
      // somewhere the page can be fetched *from*. The announce is the workspace
      // page's, which watches how many pages here have been identified.
      await push()
    }

    return 'linked'
  }

  /**
   * Pay for a run of quiet links, once — see `link`.
   *
   * The two things a linked page owes the rest of the app are about the whole
   * chapter rather than about that page: the order this browser keeps, and
   * telling the workspace what is now here. A fetch links a chapter's worth in
   * a loop and calls this at the end of it.
   */
  async function settleLinks () {
    await keepMeta((meta) => { if (meta.order) meta.order = openPages.value.map((page) => page.id) })
    await push()
  }

  /** Said once per session, not once per page — see `addBlank`. */
  const blankWarned = useState('library-blank-warned', () => false)

  /**
   * A blank page after the current one — and kept, where keeping is possible.
   *
   * Only a copied chapter can keep it: that store is read back whole, so a
   * page written into it is a page tomorrow. A chapter held by handle is read
   * from the user's own folder, where this page has no file — worth saying
   * once, because a page painted on and gone on the next visit is work lost.
   * A chapter nowhere at all was already said to be open for this visit only.
   */
  async function addBlank () {
    const image = await addBlankPage()

    if (!image) return

    // Already hashed — `addBlankPage` does it before the page joins the
    // chapter, precisely so that nothing has to be awaited between there and
    // here. So the workspace is told straight away, and no watcher gets a turn
    // in which the page exists but the server has never heard of it.
    const told = push()

    // Into the kept order, where the reader has made one — a page put in by
    // hand should not sink to the end of it on the next restore.
    await keepMeta((meta) => { if (meta.order) meta.order = openPages.value.map((page) => page.id) })
    await told

    // Desktop: a sources chapter keeps the pages it made itself as a copy does.
    if (kind.value === 'copy' || kind.value === 'sources') {
      await addIn(workspace.value, [image]).catch(unsaved)

      return
    }

    if (kind.value === 'handle' && !blankWarned.value) {
      blankWarned.value = true

      toast.info('This blank page is here for this visit', {
        description: 'It isn’t in your folder, so reopening the chapter starts without it.',
      })
    }
  }

  /**
   * Work out what each open page actually is, in the background.
   *
   * Never awaited by anything that opens a comic. Hashing a chapter means
   * reading every byte of it, and the pages are already on screen and already
   * usable — the hash is the page's identity to *other people*, and nothing on
   * this machine is waiting for it.
   *
   * A few at a time (`hashLanes`), and not all. There is no streaming digest in
   * the browser, so each file is held whole in memory to be hashed, and a
   * chapter at once would be a chapter resident at once. One at a time, as it
   * was, left the disk idle while each digest ran and the digest idle while the
   * next file was read; overlapping a few of them is the whole gain, and past
   * that the disk is the limit.
   *
   * Pages are looked up by id as each answer arrives rather than captured up
   * front, because a chapter can be closed and another opened while this is
   * still going — see `identified`.
   */
  function identify (): Promise<void> {
    // One run at a time, and a call while one is going asks for another after
    // it rather than a second beside it. Every page that lands fires this — a
    // PDF's pages land one by one — and each call used to start its own run
    // over every page still unhashed, so the runs overlapped and the same page
    // was read and hashed by several of them at once, whole scans in memory
    // twice over. See `useThumbs`, which settled on the same shape.
    if (identifying) {
      identifyAgain = true

      return identifying
    }

    // Taken before anything is awaited: this runs from a watcher's callback.
    const opening = useOpening()

    identifying = (async () => {
      do {
        identifyAgain = false
        await identifyOnce(opening)
      } while (identifyAgain)
    })().finally(() => { identifying = null })

    return identifying
  }

  async function identifyOnce ({ begin, step, end }: ReturnType<typeof useOpening>) {
    const todo = openPages.value
      .filter((page) => page.scan && !page.scan.hash)
      .map((page) => ({ id: page.id, file: page.scan!.file }))

    // Everything this browser has hashed before, at once — see
    // `rememberedHashes`. On a chapter opened again that is all of it, and every
    // page is identified in the same tick rather than one read apart.
    const known = await rememberedHashes(todo.map((page) => page.file))

    for (const [index, page] of todo.entries()) {
      const hash = known[index]

      if (hash) identified(page.id, hash)
    }

    // What is left is real work — every byte of every page read — and the
    // cleaning cannot be looked up for a page until its hash is known, so it
    // is the stage worth counting. See `useOpening`.
    const unknown = todo.filter((_, index) => !known[index])

    if (!unknown.length) return

    begin('identify', unknown.length)

    try {
      await inLanes(unknown, hashLanes(), async (page) => {
        // Identified meanwhile by something else — a drop, a link — which
        // hashes as it adds. Reading it again would only say the same thing.
        if (openPages.value.find((open) => open.id === page.id)?.scan?.hash) {
          step('identify')

          return
        }

        // Not asked of the memo again: `rememberedHashes` just said it has
        // nothing for these, and a read per file queues behind every write the
        // opening chapter is making to the same store.
        const hash = await hashFile(page.file, { recall: false })

        if (hash) identified(page.id, hash)

        step('identify')
      })
    } finally {
      end('identify')
    }
  }

  return { kind, pending, busy, arriving, restoring, failed, opened, addImages, link, settleLinks, openFolder, openFiles, restore, reopen, forget, identify, addBlank, arrange, rename, discard }
}
