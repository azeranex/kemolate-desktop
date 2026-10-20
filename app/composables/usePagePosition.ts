/**
 * Which page this browser was on, so a reload comes back to it.
 *
 * Every open used to start on page one — `openImages` sets `at` to nought, and
 * nothing remembered otherwise — so checking a fix on page fourteen meant
 * paging back to fourteen after every reload.
 *
 * Kept in IndexedDB beside the chapter's other per-workspace records
 * (`workspace:<id>:at`), and never sent anywhere: where one reader has got to
 * is theirs, and a collaborator turning pages is not a reason for yours to move.
 * Not in the address either, although that would survive a reload just as
 * well: the workspace page is keyed on `route.fullPath`, so a query that moved
 * with every page turn would re-create the whole workspace each time.
 *
 * ## By page id, not by number
 *
 * A number names a place in the order, and the order changes: pages are
 * dragged, dropped in and removed. `scan:<path>` names the page itself, so a
 * chapter rearranged since still opens on the page that was being looked at
 * rather than on whichever page has moved into its slot.
 *
 * ## Why nothing is written until the page has been put back
 *
 * A chapter reopened from this browser now opens *on* the kept page —
 * `useLibrary.resume` reads it and hands it to `openImages` — so for most
 * reloads there is nothing left here to turn. What remains is everything the
 * open could not know: a page that is not a file here and only joins the list
 * once the workspace's record is laid in (`showMissing`), and a PDF's page that
 * has not streamed in yet. Until `restore` has settled one of those, a writer
 * armed from the start would record whatever page is open over the page it
 * was about to turn to, so the writer waits.
 *
 * ## Armed per opening, not once
 *
 * The writer used to be armed once, when the first restore settled, and stay
 * armed through anything after it. On 2026-09-28 a tab opened a chapter on page
 * one and wrote `scan:1.png` over the `scan:17.png` it had been kept on: an
 * opening of the chapter after the restore had settled landed on page one, as
 * an opening does when nobody hands it a page, and the writer took the landing
 * for the reader turning there. The trigger was a dev-server restart around a
 * background tab and did not come back when looked for; the hole was there
 * either way. So it is armed per opening (`epoch`): the page an opening lands on
 * is never a page turn, and only a turn after it is written down.
 *
 * ## By either of a page's names
 *
 * A page has two: `scan:<path>` while its file is open here, and `page:<uid>`
 * while the chapter is only the workspace's record of it (`withAbsent`) — the
 * uid being the one name that is the same in everybody's copy. The position is
 * written under whichever the page had at the time, and read back against a
 * chapter that may be showing the other. Matched on id alone, a kept file name
 * was never found in a chapter shown from its record, the restore gave up, and
 * the writer was armed on page one — the same overwrite by the other road.
 * `keptIs` matches either name.
 *
 * ## Nothing drawn until the page is known
 *
 * For the same cases the canvas waits too: a chapter opened on some other page
 * and turned a frame or two later is a flash of the wrong page. `placing` is
 * what the workspace hides the canvas behind until the turn has happened, so
 * the first page shown is the right one.
 */
import { idbKey } from '~/utils/idbKeys'
/** The longest the canvas is kept blank waiting for the kept page. */
const PLACING_MS = 1500

/**
 * Whether a page is the one kept — by its id, or by its other name: see "By
 * either of a page's names" above.
 */
function keptIs (candidate: ComicPage, kept: string): boolean {
  if (candidate.id === kept) return true
  if (kept.startsWith('page:')) return candidate.uid === kept.slice('page:'.length)
  if (kept.startsWith('scan:')) return candidate.path !== undefined && candidate.path === kept.slice('scan:'.length)

  return false
}

export function usePagePosition () {
  const route = useRoute()
  const { pages, page, at, epoch, go } = useComic()
  const { arriving } = useLibrary()

  const workspace = () => String(route.params.workspaceId ?? '')
  const key = () => idbKey.position(workspace())

  /**
   * The opening (`epoch`) whose page turns are the reader's and worth writing
   * down — the one the restore settled in, and after it each opening once it
   * has landed. Null until the restore has settled.
   */
  let armedIn: number | null = null

  /** The page the armed opening landed on, which is not a turn. */
  let landedOn: string | null = null

  /**
   * Whether the page on screen may still be the wrong one — see "Nothing drawn
   * until the page is known" above. Raised until `restore` has either turned to
   * the kept page or decided it is not here yet, and never for longer than
   * `PLACING_MS`: a stall somewhere in the open should cost a page turn, not a
   * canvas left blank.
   */
  const placing = ref(true)
  const placed = setTimeout(() => { placing.value = false }, PLACING_MS)
  const place = () => {
    clearTimeout(placed)
    placing.value = false
  }

  onScopeDispose(() => clearTimeout(placed))

  watch(() => [page.value?.id, epoch.value] as const, ([id, opening]) => {
    if (armedIn === null || !id || !workspace()) return

    // Another opening of the chapter: where it lands is not a turn — see "Armed
    // per opening, not once" above. It is armed from here.
    if (opening !== armedIn) {
      armedIn = opening
      landedOn = id

      return
    }

    // The landing page again — a re-lay of the list that kept it under the
    // reader, not a turn.
    if (id === landedOn) return

    landedOn = null

    idb.set(key(), id).catch(() => {
      // A position that cannot be kept costs the next reload a page turn, not
      // this visit anything at all.
    })
  })

  /**
   * Turn back to the page this browser was last on, once the chapter is open.
   *
   * The page may not be here yet. A PDF's pages arrive behind the first few
   * (`arriving`), so a position deep in a book waits for its page to land. It
   * stops waiting when the page turns up, when the pages stop coming, when the
   * reader turns a page themselves, or when the chapter is replaced. A page
   * that has gone for good is simply not found, and writing starts from
   * wherever the reader is.
   */
  async function restore () {
    const settle = () => {
      armedIn = epoch.value
      landedOn = page.value?.id ?? null
      place()
    }

    if (!workspace()) return settle()

    const kept = await idb.get<string>(key()).catch(() => undefined)
    const started = epoch.value

    const found = () => (kept ? pages.value.findIndex((candidate) => keptIs(candidate, kept)) : -1)

    if (!kept) return settle()

    const index = found()

    if (index !== -1) {
      go(index)

      return settle()
    }

    if (!arriving.value) return settle()

    // Waiting on a PDF's later pages is not worth a blank canvas: show the page
    // that is open and turn when the kept one lands, as a reader would.
    place()

    const stop = watch([() => pages.value.length, arriving, at, epoch], () => {
      const later = found()

      // Found as it arrived, and nobody has moved off page one in the meantime.
      if (later !== -1 && at.value === 0 && epoch.value === started) go(later)

      if (later !== -1 || !arriving.value || at.value !== 0 || epoch.value !== started) {
        stop()
        settle()
      }
    })
  }

  return { restore, placing }
}
