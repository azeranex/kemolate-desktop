/**
 * Getting what a block should say, and how it is set, back to the row that
 * holds it.
 *
 * `useBlockSync` is the same idea one table along, and its header explains the
 * shape; this file is the half it deliberately leaves out. A `blocks` row holds
 * the reading — the box, the kind, what was printed there — and has no column
 * for either the translation or the lettering style, because both belong to a
 * *rendering* rather than to the reading: one box read once can be set two ways
 * in two languages, and a column on `blocks` could only ever hold one of them.
 * They live on `translations`, keyed by block and locale, and until now nothing
 * on the client wrote there at all.
 *
 * What that cost was not obvious, because a solo chapter looked fine: the whole
 * block including its style goes into `useBlockCache`, so a local workspace came
 * back intact. A *shared* one did not. `useOcr.restore` runs first and fills
 * every page the workspace knows about, which means the cache — which only fills
 * pages still empty after it — never got a look in, and the blocks it would have
 * restored were replaced by rows that had nowhere to keep a translation or a
 * style. So the moment a chapter was claimed (which a reading did on its own,
 * then) every lettering choice on it stopped surviving a reload.
 *
 * Two places that bit, and they are the same bug wearing different clothes:
 *
 * - the H button. A letterer forces a direction, reloads, and it is gone.
 * - Transpose, which pins `style.vertical` to the block's currently resolved
 *   direction on purpose, so that `verticalOf`'s guess cannot re-decide
 *   underneath the quarter turn and cancel it. The turned frame is saved —
 *   `w`, `h` and `angle` are all in the shape `useBlockSync` watches — and the
 *   pin was not. Reloaded, the block kept its turn and handed the direction back
 *   to the guess, and on a near-square CJK balloon `readsVertical`'s
 *   `h > w * 0.8` veto could come back the other way and flip the type.
 *
 * ## A page at a time, and the whole page
 *
 * Not per block, which is where this differs from `useBlockSync`. There is no
 * honest way for a browser to say which line changed — it watches the blocks and
 * knows only that they no longer match what it last sent — and a page opened
 * with thirty translations on it would have been thirty requests. It is one, and
 * the server writes only the rows that are actually different (see
 * `translations.putOnPage`), so a page nobody has touched costs one round trip
 * and no writes.
 *
 * ## Blocks with nothing to say are not sent
 *
 * A row on `translations` is a claim that something has been said about a block
 * in a language. A page of untouched balloons has said nothing, and writing
 * thirty rows holding an empty string and no style to record that would be
 * filling the table with the absence of work.
 *
 * So a block is sent when it differs from what was last sent for it, and a block
 * never sent is treated as having been sent empty. Which means: nothing goes for
 * a page nobody has worked on, everything goes the moment somebody types or
 * letters, and clearing a line back to nothing still goes — because by then
 * there is something on record to differ from.
 *
 * It is also what makes the one race here harmless. The target language is
 * settled from the workspace at about the same moment the blocks are read back
 * (see `useTargetLanguage`), and a browser that hydrated before the answer
 * arrived holds a page of empty translations under the wrong locale — which,
 * being empty, is exactly the page this refuses to send. The worst case is a
 * reload showing nothing rather than a reload writing nothing over something.
 *
 * ## A run's lines are the run's
 *
 * A page's words have two writers, and only one of them knows who wrote them.
 * This file sends what the page says as a person's — no `origin`, which pins
 * the line — and `useTranslate` sends what a run wrote as the run's, with its
 * engine and the batch that lets the whole press be taken back. The run's
 * `updateMany` wakes the watcher here as surely as a keystroke does, so both
 * used to send the same lines: whichever landed first decided what they were,
 * and when the run's save was slow or failed it was this file's copy — the
 * model's words filed as typing, pinned against every later run, and out of the
 * batch that Undo takes back.
 *
 * Three things close that, and they only work together (see `saveRun`):
 *
 * - a run's lines are agreed *before* they are sent, so the watcher sees
 *   nothing to send;
 * - a save waiting out its settle asks `sent` again when it fires, so lines
 *   agreed meanwhile are not sent on the strength of an older look;
 * - a run's lines are **owed** until the server has them, under the run's
 *   origin, and whoever carries them — the run's own retries, or this file on a
 *   later settle after the run gave up — carries that origin with them. They
 *   are never sent as typing, which is the one thing that cannot be undone.
 *
 * ## Top level only
 *
 * A balloon somebody joined *is* the object — it carries the kind, the
 * translation and the lettering, and its columns carry only their own boxes and
 * the per-column reading (see `blocks.parentId`). `toBlocks` hydrates the parent
 * and not the children for the same reason, and a child given a translation row
 * here would be a second copy of the line inside the thing that draws it.
 */
import { rowOf } from '~/utils/ocr/blocks'

/**
 * How long a page has to sit still before it is sent.
 *
 * `useBlockSync`'s settle, and for the near-enough reason. That one swallows a
 * drag; this one swallows typing, which is the same hundred-changes-a-second
 * problem with a slower hand on it. Long enough that a sentence is one request,
 * short enough that finishing it and closing the tab does not lose it.
 */
const SETTLE = 500

/**
 * One block's translation and lettering, on its way to the row that holds it.
 *
 * Three things rather than two, and the third is the newest: **where** the line
 * is set, as well as what it says and how. See `Block.letter` — a block's own
 * box says where the original lettering was *found*, which is what the repair
 * under it was cut from, so the room a translation is given had to become a
 * separate box or widening a balloon for English orphaned the cleaned artwork.
 *
 * It travels here rather than with the block for the reason the style does: it
 * is a property of the rendering, and one box read once is set two ways in two
 * languages. Which also means it is *this* file that had to carry it — a frame
 * on the shape `useBlockSync` watches would have been the same mistake one table
 * along.
 *
 * All eight of the frame's fields are sent every time, null and all, because
 * the server treats absent and null alike and writes both. Saying nothing is how
 * a balloon gets put back on its block, so it cannot also be how one stays where
 * it was dragged.
 */
type Entry = ReturnType<typeof toLetterPatch> & {
  blockId: number
  text: string
  style: Partial<Lettering> | null
}

/**
 * What a block that has never been written looks like, so "never sent" and
 * "sent, and it said nothing" compare equal — see the header.
 *
 * The frame's share of it is the all-null one `toLetterPatch` returns for a
 * block whose lettering still sits where it was found, because that is what a
 * page nobody has re-lettered honestly is.
 */
const NOTHING = `||${frameSignature(toLetterPatch(undefined, { width: 0, height: 0 }))}`

/**
 * One block's translation, style and lettering frame in the shape the row wants.
 *
 * Exported, and that is the point of it. A page's words are written from two
 * places — here on a settle, and `useTranslate.persist` on a run — and the two
 * used to build this object separately. Which was survivable while it held two
 * fields and stopped being so the moment it held a box: the server writes every
 * column an entry names and treats a missing one as null, so a translation run
 * that did not know about frames would have quietly put every re-lettered
 * balloon on the page back on its block. One derivation, so that cannot happen
 * to the next field either.
 */
export function translationEntry (block: Block, row: number, scan: { width: number, height: number }): Entry {
  return {
    blockId: row,
    text: block.translation,
    // Null rather than absent, so taking a block's settings off — which is
    // what Reset does, by giving it nothing of its own to say — clears the
    // column instead of leaving yesterday's lettering in it.
    style: block.style && Object.keys(block.style).length ? { ...block.style } : null,
    // Flat, and the same eight names the request body uses, so an entry *is*
    // what goes on the wire and there is no second shape to keep in step.
    ...toLetterPatch(block.letter, scan),
  }
}

/** The frame's eight fields as one string, in one order. */
function frameSignature (frame: ReturnType<typeof toLetterPatch>): string {
  return [
    frame.cx, frame.cy, frame.w, frame.h,
    frame.angle, frame.skewX, frame.skewY, frame.quad?.join(','),
  ].join('/')
}

/**
 * One entry as one string, with the style's keys in a fixed order.
 *
 * Sorted rather than serialised as written, because a style is built up a
 * setting at a time in whatever order a letterer pressed things: two blocks that
 * agree on every value routinely disagree on the order they stringify in, and
 * the difference would read as a change on every reload. The server compares key
 * by key for the same reason, so this only has to be stable — not to match it.
 *
 * The frame needs no sorting: it comes out of `toLetterPatch` with its keys
 * written in one order, always all of them, so it stringifies the same way every
 * time by construction.
 */
function signature (entry: Entry): string {
  const style = entry.style && Object.keys(entry.style).length
    ? JSON.stringify(Object.fromEntries(
        Object.entries(entry.style).sort(([a], [b]) => (a < b ? -1 : 1)),
      ))
    : ''

  return `${entry.text}|${style}|${frameSignature(entry)}`
}

/**
 * What was last agreed with the server for each row, keyed by **language and**
 * block row id.
 *
 * At module level for the reason `useBlockSync.sent` gives at length: a line
 * read back because somebody else wrote it already agrees with the server, and a
 * watcher that does not know that sends it straight back. `useLiveSync` is what
 * knows, and `agreedTranslation` is how it says so.
 *
 * The language is half the key because a row is one block *in one language*,
 * which is what the unique index on `translations` says and what this map spent
 * a while disagreeing with. Keyed by the block alone, everything a reader had
 * written in English went on standing as the agreement after they changed the
 * chapter's target — so the first line edited afterwards was compared against
 * the English that was still on screen, found to differ in exactly that one
 * balloon, and filed under the new locale. A page of English with one
 * Indonesian line in it, and nothing anywhere saying so.
 *
 * It also makes switching back cheap and honest: the pages read under the old
 * language are still agreed under it, so returning to it sends nothing.
 */
const sent = new Map<string, string>()

/** One row in one language — the same pair the table's unique index is on. */
const agreedKey = (locale: string, blockId: number) => `${locale}:${blockId}`

/**
 * Who wrote a run's lines: the `origin` a machine write carries, and the whole
 * of how the server tells a run from a keystroke — see `translations.putOnPage`.
 */
export interface RunOrigin {
  engine: TranslateEngine
  model: string | null
  /** The press, so everything it wrote can be taken back together. */
  batch: string | null
}

/**
 * Lines a run has written that the server has not yet confirmed, with the run
 * that wrote them — keyed like `sent`.
 *
 * Held against the *text* the run wrote. While the line still says that, it is
 * the run's, and it goes to the server under the run's origin whoever sends it;
 * once somebody has typed over it, the words are theirs and go as theirs. So a
 * letterer dragging a balloon the run has just filled, while the run's save is
 * still out, sends the move under the run's name rather than claiming the
 * model's words as their own.
 *
 * `settled` is the run's own save finishing, whichever way. A write of an owed
 * line waits for it, so the two go out in the order they were made: sent
 * alongside, the move could land first and the run's slower request — carrying
 * the balloon where it was *before* the move — land on top of it, and the
 * server keep the old frame while the page showed the new one.
 *
 * At module level beside `sent`, for its reason: the run and the watcher are
 * two composables, and the thing they must agree about is one line.
 */
const owed = new Map<string, { text: string, origin: RunOrigin, settled: Promise<void> }>()

/**
 * Note that a row and the block on the page now say the same thing, in the
 * language it is being said in.
 *
 * A whole entry rather than the fields spread out, so that adding one to what a
 * row holds cannot leave a caller agreeing to less than it sent. That is not
 * hypothetical: the frame is the third field, and the two call sites outside
 * this file both had to be found by hand when it arrived.
 *
 * Agreement settles anything a run still owed on the line: the page now shows
 * what the server holds, whoever put it there.
 */
export function agreedTranslation (locale: string, entry: Entry) {
  const key = agreedKey(locale, entry.blockId)

  sent.set(key, signature(entry))
  owed.delete(key)
}

/**
 * Forget what the last workspace was told — `useBlockSync.forgetAgreed`'s twin,
 * called from the same one place and for the same reason it had to move there:
 * the `watch(workspace, …)` that used to do this could never fire, because the
 * workspace page is keyed on its address and takes this composable's scope with
 * it when the address changes.
 */
export function forgetAgreedTranslations () {
  sent.clear()
  owed.clear()
}

/**
 * How long a run's save waits before each further try. Two more, then the
 * lines are left owed — see `saveRun`.
 */
const RETRIES = [500, 1500]

/**
 * A refusal worth asking again about: no answer at all, a timeout, a rate
 * limit, or the server's own 5xx. A 4xx is the request itself — a role taken
 * away, a block since deleted — and says the same thing however often it is
 * sent.
 */
function transient (thrown: unknown): boolean {
  const status = typeof thrown === 'object' && thrown !== null && 'status' in thrown
    ? Number(thrown.status)
    : Number.NaN

  return Number.isNaN(status) || status === 408 || status === 429 || status >= 500
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Save the lines a run wrote on one page, as the run's.
 *
 * `useTranslate.persist` is the caller, and this lives here rather than there
 * because what it has to get right is the agreement with the watcher below —
 * see "A run's lines are the run's" in the header. In order:
 *
 * 1. **Agreed, and owed, before anything is sent.** Synchronously, before the
 *    first await, so the watcher the run's `updateMany` just woke finds these
 *    lines already agreed and has nothing to send. Agreeing only once the
 *    server answered is what left a gap the watcher's own copy fell through.
 * 2. **Sent with the run's origin**, and on a refusal that passes, sent again —
 *    twice, a moment apart, which is what a server restarting looks like from
 *    here. Only what is still owed to *this* run is sent again: a line the
 *    watcher has since carried, or that a re-read has since agreed, is settled.
 * 3. **Given up on honestly.** The agreement claimed in step 1 is withdrawn —
 *    where nothing has written over it since — so the watcher sees these lines
 *    as unsent again; and they stay owed, so when it next sends this page it
 *    sends them under the run's origin. The caller says the save failed.
 *
 * Answers with the reason it gave up, or null once the server has the lines.
 */
export async function saveRun (
  workspace: string,
  pageId: number,
  locale: string,
  entries: Entry[],
  origin: RunOrigin,
): Promise<string | null> {
  let finish = () => {}
  const settled = new Promise<void>((resolve) => { finish = resolve })

  const claims = entries.map((entry) => {
    const key = agreedKey(locale, entry.blockId)
    const claim = { key, entry, mark: signature(entry), before: sent.get(key) }

    sent.set(key, claim.mark)
    owed.set(key, { text: entry.text, origin, settled })

    return claim
  })

  /** Whether this run is still the one the line is waiting on. */
  const still = (claim: (typeof claims)[number]) => owed.get(claim.key)?.origin === origin

  try {
    for (let attempt = 0; ; attempt += 1) {
      const due = claims.filter(still)

      if (!due.length) return null

      try {
        await $fetch(`/api/workspaces/${workspace}/pages/${pageId}/translations`, {
          method: 'PUT',
          body: { locale, entries: due.map((claim) => claim.entry), origin },
          headers: peerHeader(workspace),
        })

        for (const claim of due) if (still(claim)) owed.delete(claim.key)

        return null
      } catch (thrown) {
        const wait = RETRIES[attempt]

        if (wait !== undefined && transient(thrown)) {
          await pause(wait)

          continue
        }

        for (const claim of claims) {
          if (sent.get(claim.key) !== claim.mark) continue

          if (claim.before === undefined) sent.delete(claim.key)
          else sent.set(claim.key, claim.before)
        }

        return thrown instanceof Error ? thrown.message : String(thrown)
      }
    }
  } finally {
    finish()
  }
}

/**
 * Every page's translations, from the one mounted instance — the translations
 * half of `uploadChapterBlocks`, and there for the same reason: this file keeps
 * the page on screen in step, and a chapter moving to the cloud needs all of
 * them sent once.
 */
let sendAll: (() => Promise<void>) | null = null

/** Send what every page says that the server has not been told — see `sendAll`. */
export function uploadChapterTranslations (): Promise<void> {
  return sendAll?.() ?? Promise.resolve()
}

export function useTranslationSync () {
  const route = useRoute()
  const { page, pages, setBlocks } = useComic()
  const { shared, pageRowOf } = useShared()
  const { target } = useTargetLanguage()

  const workspace = computed(() => String(route.params.workspaceId ?? ''))

  /** One timer per page, because one request carries the whole of one. */
  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  /**
   * Whether this workspace can be written to at all.
   *
   * Translator rather than editor, unlike `useBlockSync`: choosing what a
   * balloon says is the one thing a translator is for, and how it is lettered
   * rides along with it because it is the same row. The role is asked about here
   * rather than left to the server to refuse, for the reason `useBlockSync`
   * gives — a viewer typing in their own copy of the page would otherwise
   * generate a 403 and a console warning per settle, for doing nothing wrong.
   */
  const writable = computed(() => Boolean(
    workspace.value && shared.value?.pages?.length && atLeast(shared.value.role, 'translator'),
  ))

  /**
   * Send these entries, each under the name of whoever wrote it.
   *
   * Most of the time that is one request with no origin: a person's edits. A
   * line a run wrote and the server has not confirmed goes in a request of its
   * own under that run's origin instead — see `owed`. That happens when the
   * run's save gave up and this is the next settle of the page, or when a
   * balloon the run just filled is moved while its save is still out. Either
   * way the words are the model's, and sending them as typing would pin them.
   */
  async function send (pageId: number, locale: string, entries: Entry[]) {
    const parcels = new Map<RunOrigin | null, { entries: Entry[], after: Promise<void> | null }>()

    for (const entry of entries) {
      const debt = owed.get(agreedKey(locale, entry.blockId))
      const origin = debt && debt.text === entry.text ? debt.origin : null

      const parcel = parcels.get(origin) ?? { entries: [], after: origin ? debt!.settled : null }

      parcel.entries.push(entry)
      parcels.set(origin, parcel)
    }

    let landed = true

    for (const [origin, { entries: parcel, after }] of parcels) {
      // Behind the run's own save, never beside it — see `owed.settled`.
      if (after) await after

      try {
        await $fetch(`/api/workspaces/${workspace.value}/pages/${pageId}/translations`, {
          method: 'PUT',
          body: origin ? { locale, entries: parcel, origin } : { locale, entries: parcel },
          // This tab's peer id, so the change notice this raises skips it — see
          // `peerHeader`. An optimisation, not a rule: re-reading its own words
          // would hand this browser exactly what it already has.
          headers: peerHeader(workspace.value),
        })

        for (const entry of parcel) {
          const key = agreedKey(locale, entry.blockId)

          sent.set(key, signature(entry))

          if (origin && owed.get(key)?.origin === origin) owed.delete(key)
        }
      } catch (error) {
        // Dropped rather than retried, and noted rather than swallowed — the same
        // bargain `useBlockSync.send` makes. What is on the page is still what the
        // reader wrote, `sent` is left alone so the next keystroke tries again,
        // and a toast per failed word would be worse than the failure.
        console.warn('[kemolate] translation not saved:', error)

        landed = false
      }
    }

    return landed
  }

  /**
   * Put back the history an import parked for this page.
   *
   * Here, and immediately after the translations have gone up, because this is
   * the first instant at which it is possible: a revision needs a translation
   * row, a translation row needs a block row, and the send above is what has
   * just made sure of both. `utils/history` explains why the wait is necessary
   * at all rather than being done during the import.
   *
   * By the block's **index in the page**, resolved against the live blocks now
   * that they carry their row ids. The index is the only name the manifest
   * could keep — see `ProjectPage.revisions`.
   *
   * Quiet in every direction. A page with nothing parked is the overwhelming
   * case and costs one storage read; a workspace that has never imported
   * anything never has one. And a failure loses the trail behind the words
   * rather than the words, so it is worth a console line and nothing more.
   */
  async function restoreHistory (here: ComicPage, locale: string) {
    const parked = await takeHistory(workspace.value, here.id)

    if (!parked) return

    const entries = Object.entries(parked).flatMap(([index, lines]) => {
      const block = here.blocks[Number(index)]
      const row = block ? rowOf(block) : null

      if (row === null) return []

      return lines
        .filter((line) => line.locale === locale && line.revisions.length)
        .map((line) => ({ blockId: row, locale: line.locale, pinned: line.pinned, head: line.head, revisions: line.revisions }))
    })

    if (!entries.length) {
      // Nothing here belongs to the language being worked in. Kept rather than
      // dropped: switching target language is a thing readers do, and the
      // history for the other one is still waiting for its turn.
      return
    }

    const done = await $fetch<{ filled: number, skipped: number }>(
      `/api/workspaces/${workspace.value}/revisions`,
      { method: 'POST', body: { entries }, headers: peerHeader(workspace.value) },
    ).catch((error: unknown) => {
      console.warn('[kemolate] imported history not restored:', error)

      return null
    })

    // Only on an answer. A request that never arrived is the one failure worth
    // trying again, and the next settle on this page will — see `dropHistory`,
    // which says why a partial answer is not one of them.
    if (done) await dropHistory(workspace.value, here.id)
  }

  /**
   * Put every page into another language.
   *
   * The chapter is not being re-read and nothing about it has changed: a block
   * has one row per language (`translations`, unique on block and locale), and
   * switching the target changes only which of them is the one being looked at.
   * So this changes exactly the three things that are per-language — what the
   * line says, how it is set, and where that lettering sits — and touches
   * nothing else. Which blocks a page has, their boxes, their kinds and their
   * order are `blocks` columns and are the same in every language.
   *
   * That is the whole reason it is not `useLiveSync.reread`, which was the first
   * answer and the wrong one. A re-read rebuilds the list from the server's rows
   * and carries the local blocks no row stands behind — right for a change
   * notice, and on a chapter holding any such blocks it *doubles every balloon*
   * for a question that was never about which blocks exist. This cannot add or
   * drop a block, because it only ever maps over the ones already there.
   *
   * Without it the picker was a setting for the next run rather than a view of
   * the chapter: `toBlocks` has always chosen by locale and `useOcr.restore` has
   * always handed it the right one, but nothing asked again when the answer
   * changed — so a reader who switched went on seeing the previous language's
   * words on every page already open, with no way back but a reload.
   *
   * Pages with nothing on them are skipped: an empty page is showing no language
   * at all and `restore` fills it with whatever is current when it gets there.
   * That is also what keeps opening a chapter quiet, since the target settles
   * from storage and then from the workspace while the canvas is still blank.
   * One page at a time, like `restore`, rather than a burst of forty requests.
   */
  async function relocalise (locale: string) {
    for (const here of pages.value) {
      if (!here.blocks.length) continue

      const pageId = pageRowOf(here)

      // Nothing to ask for a chapter no server knows about — and nothing it
      // could answer either. A local workspace's blocks live in `useBlockCache`
      // under one translation with no locale on it, so it has exactly one
      // language's worth of work by construction. Said here because this is
      // where somebody would expect otherwise.
      if (!pageId) continue

      const rows = await $fetch<StoredBlock[]>(
        `/api/workspaces/${workspace.value}/pages/${pageId}/blocks`,
      ).catch(() => null)

      if (!rows?.length) continue

      // Given up on rather than applied late. A reader who changed their mind
      // twice would otherwise have the first answer land on top of the second,
      // and the page would be in a language the picker does not name.
      if (target.value !== locale) return

      // Looked up again after the await, the way `reread` does: pages turn and
      // chapters close while a chapter's worth of these are in flight.
      const still = pages.value.find((candidate) => candidate.id === here.id)

      if (!still) continue

      // Measured first — see `sized`. A stored lettering frame is converted
      // with this size as well, and at the guessed shape it came out too high,
      // was agreed to that way below, and was sent back shrunk on the next save.
      const scan = await sized(still)

      if (!pages.value.includes(still)) continue

      // Through `toBlocks` rather than reading the rows here, because that is
      // the one place a stored translation becomes a translation, a style and a
      // frame — and a second reading of those columns would eventually be a
      // different reading of them.
      const said = new Map(toBlocks(rows, scan, locale).map((block) => [block.id, block]))

      const next = still.blocks.map((block) => {
        const row = said.get(block.id)

        // A block no row stands behind is in no language rather than in this
        // one, so it keeps what it has. It is also never sent — `entriesOf`
        // drops it for want of a row — so nothing is being filed anywhere.
        if (!row) return block

        // Absent, not empty, where this language has nothing to say about it:
        // `Block.style` and `Block.letter` both read absence as "lettered the
        // way the app would", and an empty object is the different claim that
        // somebody chose these settings.
        return { ...block, translation: row.translation, style: row.style, letter: row.letter }
      })

      setBlocks(still.id, next)

      // What is on the page is now exactly what the row says, in this language.
      // Without saying so the watcher below finds every block changed and sends
      // the whole page straight back — see `sent`.
      for (const block of next) {
        const row = rowOf(block)

        if (row) agreedTranslation(locale, translationEntry(block, row, scan))
      }
    }
  }

  // Only on a change, which is why it is not `immediate`: the target settling on
  // the way in is not somebody switching language, and the pages have nothing on
  // them at that point anyway.
  watch(target, (locale) => { if (locale) relocalise(locale) })

  /**
   * This page's rows, and what each of them ought to say.
   *
   * The page's size is what the two coordinate spaces meet at — a frame is held
   * in page percentages and stored normalised by the width on both axes — and
   * `pageSize`, so a page whose file is elsewhere converts at the shape the
   * workspace recorded, which is the shape its frames were read at.
   *
   * Null where the size is not known yet, and nothing is sent. It used to fall
   * back to the usual page proportions, "a little out rather than infinite" —
   * and a little out is a frame moved up or down the page, saved, and read back
   * that way on every reload. `toLetterPatch` drops a frame's pulled corners at
   * nought as well. The frames were never out on screen; only what was sent.
   */
  function entriesOf (here: ComicPage): Entry[] | null {
    const scan = pageSize(here)

    if (!scan.width || !scan.height) return null

    return here.blocks.flatMap((block) => {
      const row = rowOf(block)

      return row ? [translationEntry(block, row, scan)] : []
    })
  }

  /** Everything on the page that no longer matches what the server was told. */
  function flush () {
    const here = page.value

    if (!writable.value || !here) return

    const pageId = pageRowOf(here)

    if (!pageId) return

    // The locale and the rows are read now and held by the timer, not read
    // again when it fires. A page turn or a change of target language inside the
    // settle would otherwise send this page's words to the next page's rows, or
    // file them under a language nobody was working in when they were written.
    //
    // It is read *before* the comparison as well as before the timer, because
    // the comparison is now against what was agreed in this language — see
    // `sent`. Asking what a block last said without saying in which language is
    // the question that has no answer.
    const locale = target.value

    const entries = entriesOf(here)

    // Nothing to say while the page's size is unknown, and nothing still
    // waiting to be said either — see `entriesOf`.
    if (!entries) {
      clearTimeout(timers.get(here.id))
      timers.delete(here.id)

      return
    }

    const changed = entries.filter((entry) =>
      signature(entry) !== (sent.get(agreedKey(locale, entry.blockId)) ?? NOTHING))

    // Back to what the server already has: a save still waiting is a save of
    // something that is no longer true, and is called off. It was left to fire,
    // and when the difference had been a page measured a moment late, what it
    // sent was every frame on the page at the wrong height.
    if (!changed.length) {
      clearTimeout(timers.get(here.id))
      timers.delete(here.id)

      return
    }

    clearTimeout(timers.get(here.id))
    timers.set(here.id, setTimeout(async () => {
      timers.delete(here.id)

      // Asked again now rather than trusted from half a second ago. A run agrees
      // its lines as it sends them (see `saveRun`), and when that landed inside
      // the settle, sending what was captured before it was this file's copy of
      // the run's words going out a second time — as typing.
      const due = changed.filter((entry) =>
        signature(entry) !== (sent.get(agreedKey(locale, entry.blockId)) ?? NOTHING))

      if (!due.length) return

      // Only after the words have actually landed. A history filed against a
      // translation row that was never written is every line `skipped`, and the
      // record dropped for nothing.
      if (await send(pageId, locale, due)) await restoreHistory(here, locale)
    }, SETTLE))
  }

  /**
   * Every block on the page and what it should say, as one string.
   *
   * Deliberately not the block's own box, the kind or the source: those are
   * `blocks` columns and `useBlockSync` is already watching them, so including
   * them here would send a translation that had not changed on every pixel of
   * every drag. It is the same division of labour stated from the other side.
   *
   * The lettering *frame* is here, and is the one piece of geometry that
   * belongs on this side of that line: it has no column on `blocks` and
   * `useBlockSync` cannot see it, so without it dragging a translated balloon
   * would settle nothing and the frame would live only until the tab closed.
   * Which is the bug this whole concept was built to end, arriving by the back
   * door.
   */
  const shape = computed(() => {
    const here = page.value
    const scan = here ? pageSize(here) : { width: 0, height: 0 }

    // Nothing to compare while the size is unknown — see `entriesOf`.
    if (!scan.width || !scan.height) return ''

    return (here?.blocks ?? [])
      .map((block) => `${block.id}|${signature(translationEntry(block, 0, scan))}`)
      .join('\n')
  })

  // `writable` alongside the shape for the reason `useBlockSync` watches it: a
  // workspace being claimed — which a reading does on its own — changes nothing
  // about any block, and without it a page translated before the claim would sit
  // unsaved until somebody happened to touch a word of it.
  watch([shape, writable], flush)

  /**
   * `flush` for every page, sent now rather than on a settle — see `sendAll`.
   *
   * After `uploadChapterBlocks`, never before it: a translation is filed
   * against a block's row, and a block with no row yet has no line to send.
   */
  async function sendEvery () {
    if (!writable.value) return

    const locale = target.value

    for (const here of [...pages.value]) {
      const pageId = pageRowOf(here)

      if (!pageId) continue

      const scan = await sized(here)
      const changed = here.blocks
        .flatMap((block) => {
          const row = rowOf(block)

          return row ? [translationEntry(block, row, scan)] : []
        })
        .filter((entry) => signature(entry) !== (sent.get(agreedKey(locale, entry.blockId)) ?? NOTHING))

      // And the page's parked history after its words land, as `flush` does —
      // an imported chapter's history waits for exactly this. See `restoreHistory`.
      if (changed.length && await send(pageId, locale, changed)) await restoreHistory(here, locale)
    }
  }

  sendAll = sendEvery

  // Another chapter's rows are not these rows — the same reset `useBlockSync`
  // makes, from the same place, and for the same reason.

  onScopeDispose(() => {
    for (const timer of timers.values()) clearTimeout(timer)

    if (sendAll === sendEvery) sendAll = null
  })
}
