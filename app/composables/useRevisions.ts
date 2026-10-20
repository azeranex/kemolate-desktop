/**
 * Every wording the selected line has had, and which of them is on the page.
 *
 * Fetched for one block at a time, when somebody selects it — never for a page.
 * A history is opened by a reader who has decided to compare two answers, and
 * fetching thirty of them to draw a page would be paying for a panel that is
 * usually shut.
 *
 * ## It follows the selection, and that is the whole of its lifecycle
 *
 * There is no cache and no invalidation. Selecting a block asks; changing what
 * the block says asks again, because the answer has just gained a row. Both are
 * one small query, and a stale list here is worse than a refetch — it would
 * offer to restore a wording that no longer exists, or hide the one the reader
 * just made.
 *
 * "Changing what the block says" is settled, not per keystroke. The Text panel
 * writes the translation on every input event, so a watch on the text fires
 * once per character — fifty characters, fifty fetches, and enough of them in
 * the air at once that they land out of order. The server folds those same
 * keystrokes into one revision anyway (`COALESCE_MS`), so nothing mid-typing
 * could show a row that the settled fetch will not. Hence `SETTLE` below, and
 * the ticket in `load` for the responses that still cross.
 */
import { rowOf } from '~/utils/ocr/blocks'

/**
 * How long typing has to pause before the list is asked again. Long enough to
 * ride out a burst of keystrokes, short enough that the list has caught up by
 * the time a hand has moved from the keyboard to the version list.
 */
const SETTLE = 800

/**
 * Which ask is the current one. Bumped by every `load`, checked after every
 * await: a response holding an older number lost a race — the selection moved,
 * or a later ask for the same row already answered — and writing it now would
 * put a stale list over a fresh one. Module-level to match the `useState`s it
 * guards: the panel can be dragged between docks, which unmounts and remounts
 * it, and a counter that restarted at nought would let the old mount's response
 * pass the new mount's check.
 */
let ticket = 0

/** The settle timer — module-level for the reason `ticket` is. */
let settling: ReturnType<typeof setTimeout> | undefined

/** One wording, as the panel lists it. */
export interface Revision {
  id: number
  text: string
  /** 'human', or the machine that drafted it. */
  engine: string
  model: string | null
  /** The run it came from, where a machine made it. */
  batch: string | null
  authorId: number | null
  at: string
  /** Whether this is the wording currently on the page. */
  head: boolean
}

export function useRevisions () {
  const route = useRoute()
  const { selected, page, update } = useComic()
  const { shared } = useShared()
  const { target: locale } = useTargetLanguage()

  const workspace = computed(() => String(route.params.workspaceId ?? ''))

  const list = useState<Revision[]>('revisions', () => [])

  /** Whether the line is held against later runs — see `translations.pinned`. */
  const pinned = useState('revisions-pinned', () => false)

  const loading = useState('revisions-loading', () => false)

  /**
   * What went wrong with the last `choose`, in a sentence the panel can show
   * beside the list — the one call here whose failure loses a decision rather
   * than a refresh. Cleared by the next attempt and by the list moving on.
   */
  const trouble = useState<string | null>('revisions-trouble', () => null)

  /** The one selected block, and only when exactly one is. */
  const only = computed(() => (selected.value.length === 1 ? selected.value[0] : null))

  /**
   * The row this line lives on, where it has one.
   *
   * A block read a moment ago has no row until it has been saved, and a
   * workspace nobody has claimed has no rows at all. Both are ordinary states
   * rather than faults, and both mean there is no history to ask about.
   */
  const row = computed(() => (only.value ? rowOf(only.value) : null))

  const available = computed(() => Boolean(row.value && shared.value?.workspace))

  /**
   * Why there is no history to show, when there is none — so the panel can say
   * so instead of rendering nothing.
   *
   * Silence was the first version of this and it was the wrong answer: a
   * feature that is simply absent under conditions the reader cannot see reads
   * as a feature that does not exist. Both cases below are ordinary states of
   * this app rather than faults, and both have something the reader could
   * actually do about them.
   */
  const missing = computed<'unclaimed' | 'unsaved' | null>(() => {
    if (!only.value) return null
    if (!shared.value?.workspace) return 'unclaimed'
    if (!row.value) return 'unsaved'

    return null
  })

  async function load () {
    // Every ask supersedes the last, including an ask that turns out to be
    // "there is nothing to ask about" — an in-flight response must not land a
    // history under a block that has none.
    const mine = ++ticket

    const wanted = row.value

    if (!wanted || !available.value) {
      list.value = []
      pinned.value = false
      loading.value = false

      return
    }

    loading.value = true

    const answer = await $fetch<{ pinned: boolean, revisions: Revision[] }>(
      `/api/workspaces/${workspace.value}/blocks/${wanted}/revisions`,
      { query: { locale: locale.value } },
    ).catch(() => null)

    // A newer ask went out while this was in the air — for another balloon, or
    // for this one again after an edit. Either way that one speaks for the
    // state as it is now, and this one landing would put a stale list over it.
    // Comparing tickets rather than rows is what catches the second case: two
    // asks for the same row pass a row test in either order.
    if (mine !== ticket) return

    loading.value = false

    list.value = answer?.revisions ?? []
    pinned.value = answer?.pinned ?? false
  }

  /**
   * Put one of the earlier wordings back, or — with null — let the line follow
   * the newest again.
   *
   * The page is written from the answer rather than optimistically, for one
   * reason: choosing a revision is the one edit here whose result the browser
   * does not already know. It knows the text it asked for, but not whether the
   * server accepted it, and a balloon that changed and then changed back is a
   * worse thing to watch than one that changes a moment late.
   */
  async function choose (revisionId: number | null) {
    const wanted = row.value
    const block = only.value

    if (!wanted || !block || !atLeast(shared.value?.role, 'translator')) return

    trouble.value = null

    try {
      await $fetch(`/api/workspaces/${workspace.value}/blocks/${wanted}/revisions`, {
        method: 'PUT',
        body: { locale: locale.value, revisionId },
        // Stamped so the change notice this raises skips this tab — the words
        // are put on the page below.
        headers: peerHeader(workspace.value),
      })
    } catch {
      // Said where the press happened rather than left as an unhandled
      // rejection, and the page is left alone: writing the wording locally
      // after the server refused it would show a choice that was not made —
      // and be silently overwritten by the next run, which is the exact
      // surprise `pinned` exists to prevent.
      trouble.value = 'That could not be saved — check the connection and try again.'

      return
    }

    if (revisionId !== null) {
      const wording = list.value.find((revision) => revision.id === revisionId)

      // Through `update`, so switching revisions is a step on the timeline like
      // every other change to a block. Somebody who compares two answers and
      // dislikes the second should get it back with Cmd+Z, not by finding the
      // list again.
      if (wording) update(block.id, { translation: wording.text })
    }

    await load()
  }

  /**
   * Whether this reader may change the line's history — the same bar `choose`
   * sets, so the panel does not offer a press the server will refuse.
   */
  const editable = computed(() => atLeast(shared.value?.role, 'translator'))

  /**
   * Throw one earlier wording away — see `translations.deleteRevision`.
   *
   * Never the one on the page, which the panel does not offer and the server
   * refuses. Unlike `choose` this is not on the undo stack: it changes nothing
   * on the page, and a revision deleted cannot be put back by a client that no
   * longer has it. So it is taken off the list only once the server agrees, and
   * a refusal is said beside the rows like any other.
   */
  async function remove (revisionId: number) {
    const wanted = row.value

    if (!wanted || !editable.value) return

    trouble.value = null

    try {
      await $fetch(`/api/workspaces/${workspace.value}/blocks/${wanted}/revisions/${revisionId}`, {
        method: 'DELETE',
        query: { locale: locale.value },
      })
    } catch (error) {
      const said = error as { statusMessage?: string, data?: { statusMessage?: string } }

      trouble.value = said.data?.statusMessage ?? said.statusMessage ?? 'That could not be removed — check the connection and try again.'

      return
    }

    await load()
  }

  // The list belongs to whatever is selected: a new selection, language or
  // page is a new question, asked at once — a reader clicking from balloon to
  // balloon should never watch the previous one's history linger. A complaint
  // from `choose` is about the old question, so it goes with it.
  watch([row, locale, () => page.value?.id], () => {
    trouble.value = null
    clearTimeout(settling)
    load()
  }, { immediate: true })

  // And to what the block currently says — a fresh translation is a new row,
  // and the panel is often open while a run lands on the very block being
  // looked at. Asked only once typing has paused, because this fires per
  // keystroke — see the header.
  watch(() => only.value?.translation, () => {
    clearTimeout(settling)
    settling = setTimeout(() => { load() }, SETTLE)
  })

  return { list, pinned, loading, trouble, available, missing, editable, load, choose, remove }
}
