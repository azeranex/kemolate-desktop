/**
 * Reading the lettering off the open chapter, and putting it on the pages.
 *
 * The engines live in `utils/ocr/` and know nothing about workspaces; this
 * is the seam between them and the comic. It holds how the reader likes to
 * work — which model finds the boxes, which model reads them — runs the two
 * over a page, and hands the result to `setBlocks`.
 *
 * Everything happens on this machine. That is not a detail of the
 * implementation, it is the reason this exists at all: a chapter can be read
 * end to end without a page leaving the browser and without anybody's key
 * being spent. Vision stays available for the pages these cannot manage, but
 * it is no longer the only way to get blocks onto a page.
 *
 * One run at a time, on purpose. Two readings at once would fight over the
 * same models and the same processor for no gain, and the progress line
 * could only tell the truth about one of them.
 */
import type { RoomBox } from '~/utils/ocr/blocks'
import type { DetectorId } from '~/utils/ocr/detectors'
import type { ReaderId } from '~/utils/ocr/readers'

import { blockPatchSchema } from '#shared/schemas/workspace'
// A new export of a file already auto-imported, which a dev server that is
// already running does not learn about until it is restarted.
import { rewriting } from '~/composables/useBlockSync'
// Imported rather than left to the `utils/ocr` auto-import, which only learns
// about a new file's exports when the dev server restarts.
import { roomBoxOf, toBlocks } from '~/utils/ocr/blocks'
import { balloonDetector } from '~/utils/ocr/detectors'
import { fencesOf, roomsFor, roomVerdicts } from '~/utils/ocr/rooms'
import { readScanSheet } from '~/utils/paper'

export interface OcrSettings {
  detector: DetectorId
  reader: ReaderId
  /** Which default these were written under — see `DETECTOR_DEFAULT_SINCE`. */
  since?: string
}

/**
 * When the detector a first run is given last changed: to `full`, from `fast`
 * (see `DEFAULT_BUILD`).
 *
 * Saved settings are written whole on any change — `remember` watches the
 * object, not a field — so a `fast` saved before this date says nothing about
 * anybody's choice. It was the default, carried along the day a reader was
 * picked, and it is let go once. Settings written since carry the date, and a
 * `fast` among them was chosen and stays.
 */
export const DETECTOR_DEFAULT_SINCE = '2026-09-30'

/**
 * What of the settings kept in this browser still stands — `remember`'s half of
 * `useOcr`, kept apart so it can be tested without standing a workspace up.
 *
 * Both ids are checked against the lists as they stand now rather than
 * trusted: an id that has been dropped or renamed since it was written would
 * otherwise be handed to `detectWith`, which has no entry for it, and the first
 * read of the session would fail on a choice nobody made this year.
 */
export function heldOcrSettings (held: Record<string, unknown>): Partial<OcrSettings> {
  const next: Partial<OcrSettings> = {}
  const chose = held.detector !== 'fast' || held.since === DETECTOR_DEFAULT_SINCE

  if (chose && DETECTORS_BY_ID.has(held.detector as DetectorId)) next.detector = held.detector as DetectorId
  if (READERS_BY_ID.has(held.reader as ReaderId)) next.reader = held.reader as ReaderId

  return next
}

/** How far along a run is: which page, and how many there are. */
export interface OcrProgress {
  /** One-based, so it reads as "page 3 of 33" without arithmetic. */
  page: number
  pages: number
  /** What the engine last said it was doing. */
  message: string
  /**
   * How far through the current page, where the engine can say — a download
   * measured in bytes, a page measured in balloons. Absent while something
   * unmeasurable is happening, and the bar holds still rather than guessing.
   */
  step?: { done: number, total: number }
  /** Blocks read so far in this run, over every page of it. */
  found: number
}

/** Whether two rooms are the same, near enough that saving one over the other says nothing. */
function sameRoom (a: Block['room'], b: Block['room']) {
  if (!a || !b) return !a && !b

  return Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6
    && Math.abs(a.w - b.w) < 1e-6 && Math.abs(a.h - b.h) < 1e-6
}

/** Whether a block is one rooms are measured for — see `roomVerdicts`. */
const measurable = (block: { kind: string, hidden?: boolean }) =>
  !block.hidden && (block.kind === 'bubble' || block.kind === 'sfx')

/** A page's blocks in `useBlockSync`'s order — parent, then its columns — which is the `position` a patch carries. */
const flattened = (list: Block[]): Block[] =>
  list.flatMap((block) => (block.children?.length ? [block, ...block.children] : [block]))

export function useOcr () {
  const { pages, page, at, setBlocks, updateMany, epoch } = useComic()

  // Vision is the one reader that spends a key; `require` refuses with a
  // sentence naming which one is missing and where to put it.
  const { require } = useProviderKeys()

  const { shared, pageRowOf } = useShared()

  // Which of a block's translations belongs on the page — see `toBlocks`. A
  // chapter is carried into one language and the workspace is where that is
  // recorded, so this is the workspace's answer wherever there is one and this
  // browser's only until there is. Renamed on the way in because `target` is
  // what every function below calls the page it is working on.
  const { target: locale } = useTargetLanguage()

  // Which way the chapter reads, so a fresh reading comes out in the order
  // somebody would read it rather than the order the detector happened to find
  // things in — see the sort in `readOne`.
  const { direction } = useReadingDirection()

  // The same way `useUndo` and the paint canvas name it: the workspace is the
  // route, and reading it here keeps this composable usable from anywhere
  // inside one without being handed an id.
  const route = useRoute()
  const workspace = computed(() => String(route.params.workspaceId ?? ''))

  /**
   * The server's row for a local page, where there is one — `pageRowOf`, the
   * one rule for which row a page is.
   *
   * This file used to keep its own copy, from before there was one: hash first
   * without asking whether the hash named a single row, and the page's *name*
   * as its path. So a page whose file is on another machine — whose path keeps
   * its folder while its name does not — was matched to no row and never got
   * its reading back, and a chapter holding one image twice had a re-read of
   * one page written over the other's blocks.
   *
   * Nothing at all for a workspace that was never shared, and that is not a
   * failure: a local-only workspace is the state this app starts in and most
   * stay in. Its readings live as long as the tab, the same as before.
   */
  const remoteId = (target: ComicPage): number | null => pageRowOf(target)

  /** Whether this browser may write to the workspace at all. */
  const mayWrite = computed(() => atLeast(shared.value?.role, 'editor'))

  /**
   * Kemolate OCR and the full comic detector: a page read well, found by the
   * build that is both the most thorough and — on WebGPU — the quickest.
   *
   * Desktop: Kemolate OCR rather than the web build's Manga OCR, which is not
   * offered here — see `READERS`.
   */
  const settings = useState<OcrSettings>('ocr-settings', () => ({
    detector: DEFAULT_BUILD.comic,
    reader: 'kemolate-beta',
    since: DETECTOR_DEFAULT_SINCE,
  }))

  /** Kept between sessions — see `remember`, and `heldOcrSettings` for what is kept. */
  remember('kemolate:ocr', settings, heldOcrSettings)

  const progress = useState<OcrProgress | null>('ocr-progress', () => null)
  const error = useState<string | null>('ocr-error', () => null)

  const running = computed(() => progress.value !== null)

  /** A page that can be read: one whose scan is actually to hand. */
  function readable (candidate: ComicPage | undefined) {
    return candidate?.scan ? { file: candidate.scan.file, width: candidate.scan.width } : null
  }

  const canRead = computed(() => Boolean(readable(page.value)))

  /** How many of the open pages have their scan and could be read. */
  const readablePages = computed(() => pages.value.filter((candidate) => readable(candidate)).length)

  /**
   * One page: find the lettering, read it, put it on.
   *
   * The detector runs first for every reader that only recognises — handed a
   * whole page they read it as one balloon — and not at all for the ones
   * that find their own, which would only be told twice. A page with nothing
   * found gets an empty list rather than being left alone: "no lettering
   * here" is an answer, and leaving yesterday's blocks in place would hide it.
   */
  async function readOne (target: ComicPage, index: number, total: number, found: number, key?: string) {
    // The open of the chapter this page belongs to — see the check before the
    // reading is written, below.
    const started = epoch.value

    // Measured before anything is converted. A page the canvas has not drawn
    // yet — every page but the first, in a chapter-wide run — has a scan of
    // nought by nought, and both conversions below then fall back to the 2:3
    // guess: the reading goes on the page too short, and the first save after
    // the page is drawn writes it back to the server that way. See `sized`.
    await sized(target)

    const source = readable(target)

    if (!source) return 0

    const say: MangaProgress = (message, step) => {
      progress.value = { page: index + 1, pages: total, message, step, found }
    }

    const self = READERS_BY_ID.get(settings.value.reader)?.detects

    const regions = self ? [] : await detectWith(settings.value.detector, source, say)

    const read = self || regions.length
      ? await readWithReader(settings.value.reader, source, regions, say, { key })
      : []

    /*
     * Put the page in reading order before anything is written to it.
     *
     * The detector hands its findings back in whatever order it found them,
     * which on a comic is close to arbitrary — a page came back bottom-to-top
     * more than once. Until now the sort happened in two places and neither was
     * here: `useAutoRun` did it after its run, and the Blocks panel has a Sort
     * button. So a plain "Read page" left the list out of order, and so did a
     * reading asked for over MCP, where there is no button to press.
     *
     * Doing it at the source fixes all three, and it has to be *before*
     * `persist`, because `position` is the index of the array that gets sent —
     * so an unsorted write is a wrong `position` on every row, which the panel
     * then draws and every later reader trusts.
     */
    const drafts = centredReadingOrder(
      toDrafts(read, regions, target.scan?.width ?? 0),
      direction.value,
    )

    await measureRooms(target, drafts, fencesOf(regions), say)

    // The chapter was replaced while the page was being read — opened again, or
    // left for another workspace, whose chapter may well hold a page by the same
    // name and the same scan. A reading written now would land on that page and
    // be saved over its rows: this one belongs to an open that has gone.
    if (epoch.value !== started) return 0

    // `persist` puts the reading on the page as well as writing it: at once
    // where nothing is written, and as the server's answer where something is.
    await persist(target, drafts, say)

    return read.length
  }

  /**
   * Put the room inside each balloon on the blocks that have one — see
   * `Block.room` for what it is for and `roomsFor` for who gets one.
   *
   * Taken here, at the reading, because this is the one moment both halves are
   * to hand: the scan, and the balloons the detector drew around the lettering
   * (`fences`), which the readers do not carry past this point.
   *
   * The same rules as Measure balloons, run on the same condition — any balloon
   * text or free text on the page — so a page read now and a page measured later
   * come out alike. It used to stop wherever the detector drew no balloon, which
   * skipped exactly the rules for the lettering that has none: black balloons
   * filed as free text and borderless lines on clear paper. A detector that
   * draws no balloons at all (PP-OCR) hands over no fences, and every balloon
   * line then falls to those rules, each one held to its own tests.
   *
   * Best effort like `persist`: a page that cannot be decoded is read and saved
   * all the same, lettered into its blocks' own boxes.
   */
  async function measureRooms (target: ComicPage, drafts: BlockDraft[], fences: Region[], say: MangaProgress) {
    const scan = target.scan

    if (!scan?.width || !scan.height || !drafts.some(measurable)) return

    say('Measuring the balloons…')

    const sheet = await readScanSheet(scan).catch(() => null)

    if (!sheet) return

    for (const [at, room] of roomsFor(sheet, drafts, fences, scan.width).entries()) {
      if (room) drafts[at]!.room = room
    }
  }

  /**
   * Put a page's reading on it, and write it to the workspace where there is
   * one to write to.
   *
   * Best effort, and deliberately so: a workspace that cannot be reached is not
   * a reason to throw away a reading that took a minute to take, so the reading
   * goes on the page either way. It does say so — a run that looked saved and
   * was not is worse than one that admits it — but it says it without stopping
   * the run.
   *
   * ## On the page once the server has answered, not before
   *
   * A reading replaces the page: the PUT deletes every row it had and writes
   * these in their place. It used to go on the page first, as blocks no row
   * stood behind, and the PUT after — so for as long as the request took,
   * `useBlockSync` was looking at a page of row-less blocks and doing what it
   * does with them. Past its settle it asked the server whether the page had
   * rows, and the answer depended on whether the PUT had landed yet: "no", and
   * the reading was appended a second time; "yes", and that was remembered for
   * the session, after which nothing placed on the page by hand was ever saved.
   * The rows the reading replaced had left the page too, so each was sent a
   * DELETE: a 404 where the PUT had won, and where it had failed, the old
   * reading deleted from under a new one that was never saved.
   *
   * So where the reading is written, it goes on the page as the reply — the rows
   * the server answered with, at the one moment the page and the server agree.
   * Until then the page shows what it showed before, which is still true, and
   * nothing about it is in flight. That was preferred to a guard marking the
   * page as saving because a guard has to be honoured by every path in
   * `useBlockSync` that can see a row-less block or miss a row — the deletions,
   * the appends, the question `mayAppend` asks — and this leaves no window for
   * any of them to see. It costs one round trip before the blocks appear, at the
   * end of a reading that took seconds; and a correction started while "Saving…"
   * is up is made to the page as it was, rather than made to a reading and then
   * lost when the reply replaced it. `rewriting` holds `create` off the page for
   * the same round trip — see there for the one hole that closes.
   *
   * Where nothing is written — a local workspace, a page with no row yet, a
   * reader who may not edit — the reading goes on the page at once, as it
   * always did. A local workspace keeps it in this browser, which is what one
   * is; it used to be claimed here, silently, on the first reading, and a
   * signed-in reader's local chapter became a cloud one because they read a
   * page. Moving to the cloud is a choice now, made in the workspace's settings
   * or in place of Invite, and it carries the reading up with it — see
   * `useWorkspaceName.toCloud`.
   *
   * ## Why the reply is put back on the page
   *
   * A freshly read block is called `read:…` because nothing has given it a row
   * yet. This is what gives it one, and until the answer was used the id stayed
   * `read:…` for the rest of the session — which quietly cost more than it
   * looks. `rowOf` returns null for such a block, and everything that patches a
   * block by row skips it: `useBlockSync` never saved a move, a turn or a
   * retyped source, and a merge refused with "those blocks have not been saved
   * to the server yet". All of it came right on the next reload, when `restore`
   * fetched the same blocks back with real ids — which is the sort of bug that
   * looks like the reload fixed something.
   *
   * So the rows come back and are what goes on the page. They are the same
   * blocks — the server wrote what it was sent — with the one thing added that
   * the browser cannot make up for itself. And they are agreed to as they land,
   * because a reply is an arrival like `restore`'s and a notice's: unagreed, the
   * next pass sent every one of them back as a patch. See `agreeArrived`.
   *
   * ## When the server says no
   *
   * The reading goes on the page anyway, under the error, as blocks no row
   * stands behind, and it stays this browser's alone until the page is read
   * again: the rows it took off the page are not deleted, and nothing on the
   * page is appended, because the server still holds a reading and it is not
   * this one. `rewriting`'s `refused` has the reasons. Opening the chapter again
   * shows the server's reading in its place.
   */
  async function persist (target: ComicPage, drafts: BlockDraft[], say: MangaProgress) {
    const scan = { width: target.scan?.width ?? 0, height: target.scan?.height ?? 0 }
    const pageId = remoteId(target)

    if (!pageId || !mayWrite.value) {
      setBlocks(target.id, toBlocks(drafts, scan))

      return
    }

    say('Saving…')

    const started = epoch.value
    const rewrite = rewriting(started, target)

    try {
      const stored = await $fetch<StoredBlock[]>(
        `/api/workspaces/${workspace.value}/pages/${pageId}/blocks`,
        // Stamped so the notice this raises skips this tab: the reply *is* the
        // new blocks and `setBlocks` puts them on the page below — see
        // `peerHeader`.
        { method: 'PUT', body: { blocks: drafts }, headers: peerHeader(workspace.value) },
      ).catch((thrown: unknown) => {
        error.value = thrown instanceof Error
          ? `The reading is on the page but was not saved: ${thrown.message}`
          : 'The reading is on the page but was not saved.'

        return null
      })

      // No check that this is still the page being *looked at* — a chapter-wide
      // run saves pages nobody is watching and they need their rows just as
      // much. But it has to be the page the reading was taken from, in the open
      // it was taken in, for the reason `readOne` checks before it gets here.
      const placed = pages.value.find((candidate) => candidate.id === target.id)

      if (!placed || epoch.value !== started) return

      if (!stored) {
        setBlocks(placed.id, toBlocks(drafts, scan))
        rewrite.refused(placed)

        return
      }

      setBlocks(placed.id, toBlocks(stored, scan))
      agreeArrived(started, placed, scan, locale.value)
      rewrite.written(placed)
    } finally {
      rewrite.end()
    }
  }

  /**
   * Put back what this workspace already knows about its pages.
   *
   * Only onto pages with nothing on them. A page that already has blocks has
   * either just been read or already been restored, and either way what is
   * on screen is newer than what the server last heard — overwriting it with
   * a fetch that happened to land later is how a reading gets silently
   * undone.
   *
   * Quietly on failure, and quietly when there is nothing to ask: a
   * local-only workspace has no rows, and saying so on every open would be
   * telling the reader off for the ordinary case.
   */
  async function restore () {
    if (!shared.value?.pages.length) return

    const opened = epoch.value
    const waiting = pages.value.filter((target) => !target.blocks.length && remoteId(target))

    if (!waiting.length) return

    // Said in the status bar while it is in the air — see `useOpening`.
    // Taken before the await, like the epoch, because this is reached from a
    // watcher's callback.
    const { begin, end } = useOpening()

    begin('reading')

    // The whole chapter in one request — see `blocks.inChapter` for the twelve
    // seconds of one-page-at-a-time this replaces. A failure is an empty
    // answer: nothing is filled, and the cache is the fallback, as it always
    // was for a server that did not reply.
    const chapter = await $fetch<Record<number, StoredBlock[]>>(
      `/api/workspaces/${workspace.value}/blocks`,
    ).catch(() => ({} as Record<number, StoredBlock[]>))
      .finally(() => end('reading'))

    for (const target of waiting) {
      // The chapter was replaced while this was in the air. What is left is a
      // list of pages nobody is looking at, and filling them is work the next
      // run does again for the pages that replaced them.
      if (epoch.value !== opened) return

      const rows = chapter[remoteId(target)!]

      // Checked after the await: pages turn and readings land while this was
      // in flight, and the page may have gained blocks since it was found empty.
      if (!rows?.length || target.blocks.length) continue

      // `sized` rather than the scan, because this is the one restore that has
      // to work on a page whose picture is not here: the boxes are shares of
      // the page box, and the workspace's own record of the shape is all there
      // is to divide them by. See `showMissing` in `useShared`.
      //
      // And `sized` rather than `pageSize`, because on a page whose picture *is*
      // here but has not been drawn yet `pageSize` is nought: the boxes came out
      // at the guessed 2:3 shape and the first save after the page was measured
      // wrote every one of them back shrunk. This is the path every refresh
      // takes, which is why it did so much damage — see `sized`.
      const size = await sized(target)

      // Again after that await, for the reason the check above is there at all.
      if (target.blocks.length || epoch.value !== opened) continue

      setBlocks(target.id, toBlocks(rows, size, locale.value))

      // And agreed to, or the sync watchers read what was just fetched as an
      // edit and send it straight back — see `agreeArrived`. In this open, which
      // the check above has just said is still the one it was.
      const placed = pages.value.find((candidate) => candidate.id === target.id)

      if (placed) agreeArrived(opened, placed, size, locale.value)
    }
  }

  /** A run over some pages, with the bookkeeping every run shares. */
  /**
   * Reads the pages, and says how many blocks it found.
   *
   * The count is returned as well as accumulated into the progress line because
   * one caller is not a person watching a bar: `useReadErrands` has to report
   * back to whoever asked for the reading, and "it finished" is a much less
   * useful answer than "it found eleven". Null where nothing ran at all —
   * another reading already in flight, or nothing readable handed in — which is
   * a different thing from a page that honestly holds no lettering.
   */
  async function run (targets: ComicPage[]): Promise<number | null> {
    if (running.value || !targets.length) return null

    // The comic these pages belong to. A chapter closed mid-run takes its
    // pages with it, and `setBlocks` would be writing to a page nobody can
    // reach — see `epoch` in `useComic`.
    const started = epoch.value

    error.value = null
    progress.value = { page: 1, pages: targets.length, message: 'Starting…', found: 0 }

    let found = 0

    try {
      // Asked for once, before the run rather than per page: a chapter's
      // worth of pages should not each wait on the same fetch, and a missing
      // key should stop the run at nought rather than at page one.
      const provider = READERS_BY_ID.get(settings.value.reader)?.provider
      const key = provider ? await require(provider) : undefined

      for (const [index, target] of targets.entries()) {
        if (epoch.value !== started) break

        found += await readOne(target, index, targets.length, found, key)
      }
    } catch (thrown) {
      error.value = thrown instanceof Error ? thrown.message : String(thrown)

      return null
    } finally {
      progress.value = null
    }

    return found
  }

  /**
   * Read the pages holding these bytes, wherever they sit in the open chapter.
   *
   * By content hash rather than by position or by row id, because the caller is
   * `useReadErrands` — relaying an ask that came from the server, which knows a
   * page as a hash and cannot know what this browser has called it or where in
   * its own ordering it sits. It is also the one identifier that survives the
   * chapter being opened from a different folder on a different machine.
   *
   * Hashes this browser does not hold are dropped rather than refused: a
   * chapter half fetched is a real state, and reading the half that is here
   * beats reading none of it. The count of pages actually read comes back so
   * the asker can see the difference.
   *
   * Null for "nothing ran", which the caller has to be able to tell from "read
   * them and there was nothing on them".
   */
  async function readScans (hashes: string[]): Promise<{ read: number, blocks: number } | null> {
    const targets = hashes
      .map((hash) => pages.value.find((candidate) => candidate.scan?.hash === hash))
      .filter((candidate): candidate is ComicPage => Boolean(candidate) && Boolean(readable(candidate)))

    if (!targets.length) return null

    // One `run` for the lot rather than one each, which is the whole reason
    // this takes a list: the models are loaded once, the progress line counts
    // the pages properly, and a chapter is one press instead of forty.
    const blocks = await run(targets)

    return blocks === null ? null : { read: targets.length, blocks }
  }

  /**
   * Read one block again, and put what comes back in its source.
   *
   * The counterpart to the Text panel's Translate: that one asks for the line
   * to be carried over again, this asks for it to be *read* again. Both act on
   * the block in front of you rather than the page.
   *
   * ## The crop is the whole trick
   *
   * A reader is handed a picture, not a page and a box. Some of them take
   * regions and some find their own (`detects`), and asking a self-detecting
   * reader about one balloon would get the whole page back with no way to say
   * which answer was the one wanted. Cropping first sidesteps that completely:
   * every reader can read an image, and an image of one balloon has exactly one
   * answer in it. It is also what the earlier build did for its region tools.
   *
   * A margin, because a box drawn tight to the glyphs cuts the strokes that
   * hang outside it and every engine reads worse for it — the same eight per
   * cent `manga.ts` pads its own regions by, for the same reason.
   *
   * The reading is the *source*, never the translation. Re-reading corrects
   * what the page is understood to say; what it should say instead is a
   * separate question with its own button.
   */
  async function readBlock (pageId: string, blockId: string): Promise<string | null> {
    if (running.value) return null

    const target = pages.value.find((candidate) => candidate.id === pageId)
    const block = target?.blocks.find((candidate) => candidate.id === blockId)
    const scan = target?.scan

    if (!target || !block || !scan?.width || !scan.height) return null

    const started = epoch.value

    error.value = null
    progress.value = { page: 1, pages: 1, message: 'Reading the block…', found: 0 }

    try {
      const provider = READERS_BY_ID.get(settings.value.reader)?.provider
      const key = provider ? await require(provider) : undefined

      const crop = await cropOut(scan.file, {
        x: (block.x / 100) * scan.width,
        y: (block.y / 100) * scan.height,
        w: (block.w / 100) * scan.width,
        h: (block.h / 100) * scan.height,
      })

      if (!crop) throw new Error('That block could not be cut out of the page.')

      const read = await readWithReader(
        settings.value.reader,
        { file: crop.file, width: crop.width },
        // No regions: the crop *is* the region, and a reader that finds its own
        // will find the one thing in the picture.
        [],
        (message, step) => { progress.value = { page: 1, pages: 1, message, step, found: 0 } },
        { key },
      )

      // Everything the crop contained, in the order it was read — joined as
      // lines and collapsed by `tidyText`, because *it* holds the rule for what
      // replaces a break: nothing for CJK, a space for everything else. Joined
      // here with '' that rule was decided by fiat, and an English balloon that
      // came back as two blocks read "HELLOWORLD".
      const text = tidyText(read.map((found) => found.text).join('\n'))

      if (epoch.value !== started) return null

      if (!text) {
        error.value = 'Nothing readable in that block.'

        return null
      }

      // Through `useComic.updateMany` so it lands on the timeline and
      // `useBlockSync` carries it to the row — the same door the panel's own
      // typing uses. With the page's own id, not the page on screen: a slow
      // reader — a Vision round trip, a first-time model download — can outlive
      // a page turn, and `update` searches only the page being looked at, so
      // the reading would be silently thrown away. The same race `updateMany`
      // grew the parameter for.
      updateMany([{ id: blockId, patch: { source: text } }], pageId)

      return text
    } catch (thrown) {
      error.value = thrown instanceof Error ? thrown.message : String(thrown)

      return null
    } finally {
      progress.value = null
    }
  }

  /** The page on screen. */
  function readCurrent () {
    const target = pages.value[at.value]

    return target ? run([target]) : undefined
  }

  /** Every page whose scan is to hand, in reading order. */
  function readAll () {
    return run(pages.value.filter((candidate) => readable(candidate)))
  }

  /**
   * Measure the balloons of pages that were read before rooms existed, and
   * say how many blocks got one.
   *
   * A reading measures them as it goes (`measureRooms`), so this is for the
   * chapters already read — and it must not be a re-read, which would replace
   * every block and with them every translation, frame and repair. So only the
   * detector runs, to find the balloons, and the one thing written is each
   * block's `room`. The boxes, the reading, the translations and anything a
   * letterer placed by hand are not touched, and a frame somebody dragged
   * (`Block.letter`) still outranks whatever is measured here.
   *
   * With the chosen detector where it is one that draws balloons, and the fast
   * comic build where it is not — PP-OCR finds lines, and a run of it here
   * would measure nothing.
   *
   * Saved block by block on a cloud workspace, one `room` each, rather than
   * left to `useBlockSync`: that watches the page on screen, and a chapter's
   * worth of measuring happens on pages nobody is looking at. A local
   * workspace needs nothing extra — its cache watches every page.
   *
   * Not undoable as one step, and not meant to need it: a room is the default a
   * frame falls back to, and running this again measures again.
   */
  async function measureBalloons (targets: ComicPage[]): Promise<number | null> {
    if (running.value || !targets.length) return null

    if (shared.value && !mayWrite.value) {
      error.value = 'Only an editor can measure the balloons of a shared chapter.'

      return null
    }

    const started = epoch.value
    const detector = balloonDetector(settings.value.detector)

    error.value = null
    progress.value = { page: 1, pages: targets.length, message: 'Starting…', found: 0 }

    let found = 0

    // A page that fails is reported and passed over, not the end of the run: it
    // used to be, after every page before it had been written, so one lost
    // connection left a chapter half measured with nothing saying which half.
    const failed: string[] = []
    let reason = ''

    try {
      for (const [index, target] of targets.entries()) {
        if (epoch.value !== started) break

        try {
          const page = await measureOne(target, index, targets.length, found, detector)

          found += page.measured

          if (page.unsaved) {
            failed.push(target.name)
            reason ||= page.reason
          }
        } catch (thrown) {
          failed.push(target.name)
          reason ||= thrown instanceof Error ? thrown.message : String(thrown)
        }
      }
    } finally {
      progress.value = null
    }

    if (failed.length) {
      error.value = `Could not measure or save ${failed.length} page${failed.length === 1 ? '' : 's'} (${failed.slice(0, 3).join(', ')}${failed.length > 3 ? '…' : ''}): ${reason}`
    }

    return found
  }

  /**
   * One page of `measureBalloons`: how many blocks on it hold a room now, and
   * whether any could not be saved.
   *
   * Hidden and rubbish blocks are passed over and keep whatever they had — see
   * `skipped` in `rooms.ts`.
   *
   * On a cloud workspace the page's changed rooms go up as one request, through
   * the page's batch PATCH, which writes them all in one transaction or none —
   * it was a PATCH a block, four at a time, a request round trip per balloon. A
   * room goes on its block only once the server has it, so the page never shows
   * a room the server does not hold, and what the server answers is agreed with
   * `useBlockSync`: it watches the room, and on the page on screen would
   * otherwise send every room a second time. Agreed to the server's row rather
   * than to this block, so an edit to the block that has not gone up yet still
   * does.
   *
   * All or nothing is why a room is checked against `blockPatchSchema` before
   * it is sent: one out of bounds would refuse the whole page. It is left off,
   * counted unsaved, and the rest go.
   */
  async function measureOne (target: ComicPage, index: number, total: number, found: number, detector: DetectorId) {
    const none = { measured: 0, unsaved: 0, reason: '' }
    const say: MangaProgress = (message, step) => {
      progress.value = { page: index + 1, pages: total, message, step, found }
    }

    // Measured first, for the reason `readOne` measures first: every conversion
    // below needs the page's real shape, not the 2:3 guess.
    const size = await sized(target)
    const source = readable(target)
    const scan = target.scan

    // Only the top level. A balloon's columns hold no translation and no
    // lettering — see `blocks.parentId` — and counting them would put every
    // joined balloon's parent in a fence it shares with its own children.
    const tops = target.blocks
    const measured = tops.map((block) => toPatch(block, size))

    if (!source || !scan || !size.width || !size.height || !measured.some(measurable)) return none

    const regions = await detectWith(detector, source, say)

    say('Measuring the balloons…')

    const sheet = await readScanSheet(scan).catch(() => null)

    if (!sheet) return none

    const verdicts = roomVerdicts(sheet, measured, fencesOf(regions), size.width)
    const cloud = Boolean(shared.value && remoteId(target))
    const order = flattened(target.blocks)
    const changes: { row: number, room: RoomBox | null, next: Block['room'], block: Block }[] = []
    let count = 0
    let refused = 0

    for (const [at, block] of tops.entries()) {
      const verdict = verdicts[at]!

      if (verdict.reason === 'skipped') continue

      const room = verdict.room
      const next = room ? roomBoxOf(room, size) : undefined

      if (room) count++
      if (sameRoom(block.room, next)) continue

      const row = rowOf(block)

      // A block with no row yet is `useBlockSync`'s to create, and the draft it
      // sends is the whole block, room and all. A local workspace's cache
      // watches every page, so the block itself is all there is to write.
      if (!cloud || row === null) {
        block.room = next

        continue
      }

      if (!blockPatchSchema.safeParse({ room }).success) {
        refused++

        continue
      }

      changes.push({ row, room, next, block })
    }

    const unsaved = (lost: number, reason: string) => ({ measured: count - lost, unsaved: lost, reason })

    if (!changes.length) return unsaved(refused, refused ? 'a room outside the bounds a block may hold' : '')

    try {
      const stored = await $fetch<StoredBlock[]>(`/api/workspaces/${workspace.value}/pages/${remoteId(target)}/blocks`, {
        method: 'PATCH',
        body: { blocks: changes.map(({ row, room }) => ({ id: row, room })) },
        headers: peerHeader(workspace.value),
      })
      const kept = new Map(stored.map((one) => [one.id, one]))
      let lost = refused

      for (const { row, next, block } of changes) {
        const one = kept.get(row)

        if (!one) {
          lost++

          continue
        }

        block.room = next
        agreed(row, toPatch(toBlocks([one], size)[0]!, size, order.indexOf(block)))
      }

      return unsaved(lost, lost ? 'the server did not return every block it was sent' : '')
    } catch (error) {
      // All or nothing: none of this page's rooms were written.
      return unsaved(refused + changes.length, error instanceof Error ? error.message : String(error))
    }
  }

  return {
    settings,
    progress,
    error,
    running,
    canRead,
    readablePages,
    readCurrent,
    readAll,
    measureBalloons,
    readBlock,
    readScans,
    restore,
  }
}
