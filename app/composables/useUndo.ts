/**
 * One undo history per workspace, whichever page is open.
 *
 * The stack is *yours*: it lists the strokes this browser laid, in the order it
 * laid them, across every page of the workspace. Turning to page five does not
 * start a new history — Cmd+Z takes back the last thing you did, wherever you
 * did it, which is what undo means everywhere else drawing happens.
 *
 * Undoing is not deleting. A stroke is retracted — one boolean, flipped on the
 * server — and the row keeps its place in the paint order, so redo puts the
 * mark back exactly where it was: *under* anything painted over it since,
 * because `(seq, clientId)` decides where paint sits and neither ever changes.
 * The log stays append-only and nothing about undo can corrupt it.
 *
 * Two things this deliberately is not:
 *
 * - **It is not shared.** The *effect* of your undo reaches everyone — the
 *   stroke is retracted in the one log they all replay — but your Cmd+Z only
 *   ever touches strokes in your own stack. If it could take back a
 *   collaborator's work, two people pressing undo would be fighting over whose
 *   history it was, and "undo" would stop meaning "take back what *I* did."
 *   That is the same line Figma and every multiplayer editor draws.
 * - **It is not persistent.** The stacks live for the session, like every
 *   editor's. The log could seed "undo my recent strokes" across a reload —
 *   your own unretracted strokes, newest first — but redo cannot be rebuilt
 *   from a boolean, so a reload starts clean rather than half-remembered.
 */

/**
 * A stroke, taken back the way the log takes strokes back — see `flip`.
 */
export interface StrokeEntry {
  kind: 'stroke'
  strokeId: number
  surfaceId: number
  /** Where the mark sits in the log — what `pruneBaked` compares against. */
  seq: number
  clientId: string
  /** Where it landed, for saying "on page 4" once pages have server identity. */
  pageId: number
  pageName: string
}

/**
 * A block, before and after — the other half of the history, and a different
 * animal from a stroke.
 *
 * A stroke is a row on the server and undoing it is a boolean the server owns.
 * A block is state in this browser, and the only thing that can say what it used
 * to be is a copy of what it used to be. So this is a snapshot pair rather than
 * an inverse command, and applying it is an assignment rather than a request.
 *
 * Both sides are *complete* — every field an edit can touch, not only the ones
 * this edit did. A sparse pair cannot be run backwards: `toBoxed` leaves an
 * angle of nought off entirely, so a step that recorded only what it wrote would
 * undo a rotation and have no way to redo it.
 *
 * The server is not asked for anything here. `useBlockSync` is watching the
 * blocks, so an undone block is simply a changed block and goes back to its row
 * by the one path every other edit uses.
 */
export interface BlockEntry {
  kind: 'block'
  /** The page it is on, as the canvas knows pages. */
  page: string
  blockId: string
  before: BlockState
  after: BlockState
  /** What a following edit has to match to be folded into this one. */
  merge: string
  at: number
}

/**
 * Several blocks changed by one press, taken back by one press.
 *
 * A `BlockEntry` cannot say this, and folding cannot be made to: an entry names
 * one block, and `recordBlock` only folds an edit onto the step above it when
 * that step is holding the *same* block written with the same set of fields.
 * That is right for a drag, which is one block a hundred times, and no use at
 * all for a utility that works on the selection — through `update` alone,
 * transposing six balloons files six steps, and taking back one press of one
 * button costs six presses of Cmd+Z.
 *
 * So the grouping is stated rather than inferred, which is also what makes it
 * honest: the entry says these edits happened together because the thing that
 * made them says so, not because they arrived close enough in time to look like
 * one gesture. Each edit carries a complete pair for the reason `BlockEntry`
 * gives, and nothing folds into one of these unprompted — a press on a button
 * is a deliberate act, not the continuation of whatever came before it.
 */
export interface BlocksEntry {
  kind: 'blocks'
  page: string
  edits: Array<{ blockId: string, before: BlockState, after: BlockState }>
  /**
   * What a following group has to match to be folded into this one — only when
   * the caller says so. A button press leaves it off and stands alone, as
   * above. A gesture over the selection — dragging or nudging several blocks,
   * a lettering slider with several picked — names itself, because it is one
   * act spread over many events: without this each event filed a step per
   * block, a drag of three filled the whole history in half a second, and undo
   * walked it back one block and one frame at a time.
   */
  merge?: string
  at?: number
}

/**
 * A pass of the eraser: every stroke it cut, taken as one.
 *
 * Grouped because that is what the gesture was — one sweep across three
 * corrections is one thing the person did, and should be one press of Cmd+Z
 * to take back, not three. The strokes are the same shape a `StrokeEntry`
 * holds, minus the kind, because undoing them is the same retraction flip —
 * run the other way: undo puts the strokes *back*, redo takes them again.
 *
 * The eraser cuts *through* strokes rather than deleting them: what
 * survives a partial pass is written back as fresh rows, and those ride
 * here as `remade`. They flip opposite their originals — undo retracts the
 * pieces while it restores the whole, redo the reverse — so either
 * direction leaves exactly one generation of the mark on the page.
 */
export interface EraseEntry {
  kind: 'erase'
  strokes: Array<Omit<StrokeEntry, 'kind'>>
  remade: Array<Omit<StrokeEntry, 'kind'>>
}

/**
 * A block taken off the page, whole, and where it sat.
 *
 * A separate kind because the other one cannot express it: a `BlockEntry` is
 * two sets of fields written back onto a block that is still there, and the
 * whole point of a deletion is that there is nothing left to write onto. So
 * this carries the block itself — a plain copy, not the reactive object it was
 * — and the index it came out of, because putting it back at the end would
 * quietly renumber the page and the numbers are how a letterer refers to it.
 */
export interface GoneEntry {
  kind: 'gone'
  page: string
  /** The block it was filed under, for one that is part of a split balloon. */
  parent: string | null
  index: number
  block: Block
}

/**
 * A block put on the page by hand, and where it went.
 *
 * The deletion entry read the other way round, and deliberately the same shape:
 * a placement has no `before` to write back — the block did not exist a moment
 * ago — so it cannot be a `BlockEntry`, and undoing one is exactly what redoing
 * a deletion is. Sharing the fields is what lets `applyGone` serve both
 * directions of both kinds instead of there being two ways to put a block back.
 */
export interface MadeEntry {
  kind: 'made'
  page: string
  parent: string | null
  index: number
  block: Block
}

/**
 * Several changes that were one gesture, undone by one press.
 *
 * `BlocksEntry` was the only grouping there was, and it groups the wrong thing:
 * it is a list of *field snapshots on blocks that continue to exist*, so it can
 * hold six edits and not a single creation or deletion. The region brush is the
 * case that needs the other kind — one stroke takes away the blocks it covers
 * and puts one in their place, which is a deletion, a deletion, a deletion and
 * a placement, and four presses of Cmd+Z to get back to where you were. A
 * gesture that takes four presses to undo is one somebody gives up undoing
 * halfway through, and half-undone is the one state the page must never be
 * left in.
 *
 * Children rather than a flattened list of fields, so anything that can be
 * recorded can be batched — including, in principle, another batch. `gather` is
 * how one is built; nothing constructs this by hand.
 */
export interface BatchEntry {
  kind: 'batch'
  /** In the order they happened. Undone last-first — see `apply`. */
  entries: UndoEntry[]
}

export type UndoEntry =
  | StrokeEntry | BlockEntry | BlocksEntry | EraseEntry | GoneEntry | MadeEntry | BatchEntry

/**
 * Everything about a block an edit can change. Confidence is absent: it is a
 * fact about a reading, and nothing done to the block afterwards alters it.
 */
const FIELDS = [
  'x', 'y', 'w', 'h', 'angle', 'skewX', 'skewY', 'quad',
  'type', 'source', 'translation', 'hidden', 'style',
  // The lettering frame, which is a whole box rather than a field — see
  // `Block.letter`. It is here because on a translated block it is what a drag
  // now writes: without it, every resize of a balloon that had been carried over
  // would be a transform Cmd+Z had nothing to say about.
  'letter',
  // Not `room`, and it was here once. A balloon's room is a measurement, not an
  // edit — Measure balloons writes it outside undo — so every snapshot carried
  // the room as it was *then*, and undoing an edit made before measuring put
  // the old room (none) back over the measured one; on the page on screen the
  // sync then cleared it on the server. See `useUndo.room.test.ts`.
] as const

export type BlockState = Partial<Pick<Block, typeof FIELDS[number]>>

/** A block's editable state, copied rather than referenced. */
export function blockState (block: Block): BlockState {
  const out: BlockState = {}

  for (const key of FIELDS) {
    const value = block[key]

    // The three that are not primitives. All are replaced wholesale everywhere
    // they are written, so a shallow copy is enough — but only just, and a copy
    // costs nothing next to being wrong about it later. `letter` holds a `quad`
    // of its own, which is the one place that reasoning is stretched: the frame
    // is always rebuilt from `toBoxed` rather than patched in place, so the
    // nested array is a new one on every write and is never mutated under a
    // snapshot holding it.
    if (key === 'quad') out.quad = Array.isArray(value) ? [...value] : undefined
    else if (key === 'style') out.style = value ? { ...value as object } : undefined
    else if (key === 'letter') out.letter = value ? { ...value as LetterBox } : undefined
    else Object.assign(out, { [key]: value })
  }

  return out
}

interface Stacks {
  past: UndoEntry[]
  future: UndoEntry[]
}

/**
 * How long an edit stays open to being folded into.
 *
 * A drag is a hundred edits a second and a slider is nearly as many; filing one
 * step each would make undo useless — a dozen presses to take back one gesture.
 * Long enough to bridge the gap between two pointer moves and two keystrokes,
 * short enough that two deliberate edits stay two steps.
 */
const RUN_MS = 600

/**
 * Deep enough that nobody runs out mid-thought, and comfortably inside the
 * bake window: a baked stroke cannot be un-baked, so undo must never reach one.
 * The schema's rule — "whatever depth undo offers, the live window has to be
 * comfortably longer" — is agreed from both sides by these two numbers.
 */
const LIMIT = 100

/**
 * The gesture being gathered, if one is — see `gather`.
 *
 * A module variable rather than state on the composable, because it must be the
 * same buffer for every caller of `useUndo()` inside one gesture: the region
 * brush gathers, and what lands in the buffer is recorded by `useComic`'s own
 * instance of this composable. Held here, that is one variable; held per
 * instance, `record` would file into a buffer nobody is watching.
 *
 * Safe as a single variable because a gather is synchronous and the browser is
 * not — see the note there.
 */
let gathering: UndoEntry[] | null = null

export function useUndo () {
  const route = useRoute()

  /**
   * The pages, reached for directly rather than through `useComic`.
   *
   * `useComic` calls this composable to file its edits, so calling it back would
   * put the two modules in a cycle for the sake of one ref. The state is shared
   * either way — this is the same `comic-pages` that composable owns.
   */
  const pages = useState<ComicPage[]>('comic-pages', () => [])

  /**
   * Keyed by workspace rather than held flat, because the stacks outlive the
   * page component — that is the point — but must not outlive their workspace:
   * an entry names row ids, and row ids from one workspace mean nothing (or
   * worse, 404) under another's address.
   */
  const all = useState<Record<string, Stacks>>('undo-stacks', () => ({}))

  /**
   * A change counter per surface. The canvas watches its surface's number and
   * replays when it moves — how an undo of a page you are not looking at still
   * redraws that page when you get back to it, without anyone holding a
   * reference to a canvas that is not mounted.
   */
  const versions = useState<Record<number, number>>('surface-versions', () => ({}))

  const workspace = computed(() => String(route.params.workspaceId ?? ''))

  // The strokes this browser holds on its own. Reached for here because a
  // history that could only take back the shared half of the page would be a
  // history that stops working the moment somebody paints without a server.
  const { retract } = usePaintCache()

  function stacks (): Stacks {
    const key = workspace.value

    all.value[key] ??= { past: [], future: [] }

    return all.value[key]!
  }

  const canUndo = computed(() => (all.value[workspace.value]?.past.length ?? 0) > 0)
  const canRedo = computed(() => (all.value[workspace.value]?.future.length ?? 0) > 0)

  function bump (surfaceId: number) {
    versions.value[surfaceId] = (versions.value[surfaceId] ?? 0) + 1
  }

  /**
   * A stroke landed — the paint session calls this after the server accepts it.
   *
   * A fresh mark is a new branch of history: whatever was undone before it is
   * no longer reachable, so the redo pile empties. Same rule as every editor,
   * and the reason redo can trust its entries are still redoable.
   */
  function record (entry: UndoEntry) {
    if (gathering) {
      gathering.push(entry)

      return
    }

    const stack = stacks()

    stack.past.push(entry)
    stack.future = []

    if (stack.past.length > LIMIT) stack.past.shift()
  }

  /**
   * Everything recorded inside `run`, filed as one step.
   *
   * Collected rather than assembled, which is the whole reason this is worth
   * having: `removeBlock` and `addBlock` already know how to describe what they
   * did, and a caller that had to build the entries itself would be a second
   * description of a deletion — one that would go out of step with the first the
   * next time `GoneEntry` grew a field. Here they record exactly as they always
   * do and this catches what they say.
   *
   * **Synchronous only.** The buffer is one variable for the whole app, so
   * anything awaited inside `run` would put whatever else happened meanwhile
   * into this gesture's step. Every caller does its work first and gathers the
   * changes at the end, which is the shape that wants gathering anyway: a
   * gesture that fails partway should leave nothing behind rather than a batch
   * of half of it.
   *
   * A run that records nothing files nothing — a gesture that turned out to
   * change nothing should not cost a press to undo. One entry is filed as
   * itself rather than wrapped, so the common case stays exactly what it was.
   */
  function gather<T> (run: () => T): T {
    // Nested runs join the one already open rather than starting a second: the
    // outermost gesture is the one somebody made, and the inner one is a
    // function it happened to call.
    if (gathering) return run()

    const buffer: UndoEntry[] = []

    gathering = buffer

    try {
      return run()
    } finally {
      gathering = null

      if (buffer.length === 1) record(buffer[0]!)
      else if (buffer.length) record({ kind: 'batch', entries: buffer })
    }
  }

  /**
   * A block changed. One gesture, one step — however many times it fires.
   *
   * A drag arrives here on every pointer move, and each of those is a real edit
   * that would be a real step. So a change that matches the one on top of the
   * stack, and follows it closely enough, moves that step's `after` instead of
   * pushing another: the run keeps one entry whose `before` is where the gesture
   * started and whose `after` is wherever it has got to.
   *
   * `merge` is what "matches" means — the block, and which of its fields are
   * being written. Dragging writes the same set of fields on every move, so a
   * drag folds; letting go and turning the same block instead writes a different
   * set, so it does not.
   */
  function recordBlock (page: string, block: Block, before: BlockState, merge: string) {
    const stack = stacks()
    const top = stack.past.at(-1)
    const now = Date.now()

    if (top?.kind === 'block' && top.merge === merge && now - top.at < RUN_MS) {
      top.after = blockState(block)
      top.at = now
      // The redo pile is already empty — it was cleared when the run began —
      // and clearing it again here would be harmless but say the wrong thing.
      return
    }

    record({ kind: 'block', page, blockId: block.id, before, after: blockState(block), merge, at: now })
  }

  /**
   * Several blocks changed together — one step, however many they are.
   *
   * Nothing folds into this unless the caller names a `merge` — see
   * `BlocksEntry`, which says which callers do and why. An empty run files
   * nothing rather than an empty step, so a button pressed with a selection it
   * can do nothing with leaves no press to take back.
   */
  function recordBlocks (page: string, edits: BlocksEntry['edits'], merge?: string) {
    if (!edits.length) return

    const now = Date.now()

    if (merge && !gathering) {
      const top = stacks().past.at(-1)

      // The same fold `recordBlock` makes for one block, over several: each keeps
      // where the gesture started and takes where it has got to.
      if (top?.kind === 'blocks' && top.merge === merge && top.page === page && now - (top.at ?? 0) < RUN_MS) {
        for (const edit of edits) {
          const held = top.edits.find((was) => was.blockId === edit.blockId)

          if (held) held.after = edit.after
          else top.edits.push(edit)
        }

        top.at = now

        return
      }
    }

    record({ kind: 'blocks', page, edits, ...(merge ? { merge, at: now } : {}) })
  }

  /**
   * A local stroke has become a server row — point the history at the new one.
   *
   * Called when a workspace that was painted in alone is shared and its strokes
   * go up. Without it every entry in the stack would still name a negative id
   * that nothing holds any more, and Cmd+Z would silently do nothing for as far
   * back as the person had painted before inviting anybody.
   */
  function renumber (from: number, to: number, surfaceId: number) {
    const swap = (entry: Omit<StrokeEntry, 'kind'>) =>
      (entry.strokeId === from ? { ...entry, strokeId: to, surfaceId } : entry)

    for (const stack of Object.values(all.value)) {
      for (const side of ['past', 'future'] as const) {
        stack[side] = stack[side].map((entry) => {
          if (entry.kind === 'stroke') return { ...swap(entry), kind: 'stroke' as const }

          if (entry.kind === 'erase') {
            return { ...entry, strokes: entry.strokes.map(swap), remade: entry.remade.map(swap) }
          }

          return entry
        })
      }
    }
  }

  /**
   * A block's id changed under the history — point the steps at the new one.
   *
   * The block half of `renumber`, and it exists for the same reason. A block
   * placed by hand is `text:…` until the workspace makes a row for it, and
   * `useBlockSync` swaps in `block:<n>` when that row comes back — after the
   * placement and any editing since have already been filed. Every one of those
   * entries names an id that nothing on the page answers to any more, so undo
   * would look the block up, not find it, and report success having done
   * nothing: Cmd+Z on a block you just placed would leave it sitting there.
   *
   * Both stacks and every workspace's, because a page turn does not end a
   * round trip and the swap can land after the reader has moved on.
   */
  function renameBlock (from: string, to: string) {
    /*
     * Per entry, and *into* a batch rather than past it. A batch that was
     * skipped here would keep naming an id nothing answers to, so undoing the
     * region brush's own step — which is a batch, and whose new block is
     * renamed the moment its row lands — would report success and leave the
     * block sitting there. That is the exact failure this function was written
     * for, reaching one level deeper.
     */
    const renamed = (entry: UndoEntry): UndoEntry => {
      if (entry.kind === 'batch') return { ...entry, entries: entry.entries.map(renamed) }

      if (entry.kind === 'block' && entry.blockId === from) return { ...entry, blockId: to }

      // Per edit, since a grouped step names several blocks and only one of
      // them is being renamed.
      if (entry.kind === 'blocks') {
        return {
          ...entry,
          edits: entry.edits.map((edit) =>
            (edit.blockId === from ? { ...edit, blockId: to } : edit)),
        }
      }

      // The whole block rides in these two, so the copy has to be renamed
      // as well as the entry — `applyGone` looks it up by `block.id`.
      if ((entry.kind === 'gone' || entry.kind === 'made') && entry.block.id === from) {
        return { ...entry, block: { ...entry.block, id: to } }
      }

      return entry
    }

    for (const stack of Object.values(all.value)) {
      for (const side of ['past', 'future'] as const) stack[side] = stack[side].map(renamed)
    }
  }

  async function flip (entry: Pick<StrokeEntry, 'strokeId' | 'surfaceId'>, retracted: boolean): Promise<boolean> {
    /**
     * A stroke this browser is holding on its own — see `usePaintCache`, where
     * the negative id comes from.
     *
     * Taken back here and no further. There is no row to PATCH, and asking the
     * server about a stroke it has never heard of would fail and be reported as
     * "that couldn't be undone" — which would be the one thing undo must never
     * say about a mark that is plainly still on the page.
     */
    if (entry.strokeId < 0) return retract(entry.strokeId, retracted)

    try {
      // The `bump` below is how this tab hears about its own undo; the notice
      // `retractStroke` raises is for everybody else.
      if (!await retractStroke(workspace.value, entry.strokeId, retracted)) {
        throw new Error('That stroke could not be changed.')
      }

      bump(entry.surfaceId)

      return true
    } catch (error) {
      toast.error(retracted ? 'That couldn’t be undone' : 'That couldn’t be redone', {
        description: error instanceof Error ? error.message : String(error),
      })

      return false
    }
  }

  /**
   * Put a block back to one of its two recorded states.
   *
   * False when the block is no longer there — a page re-read replaces every
   * block on it, and an entry naming one of the old ones has nothing to write
   * to. The step is dropped rather than retried: it describes a block that does
   * not exist, and there is no version of putting it back that is right.
   */
  function applyBlock (entry: BlockEntry, side: 'before' | 'after'): boolean {
    const block = pages.value
      .find((page) => page.id === entry.page)?.blocks
      .find((candidate) => candidate.id === entry.blockId)

    if (!block) return false

    Object.assign(block, entry[side])

    return true
  }

  /**
   * The same, for every block a grouped step names.
   *
   * Best effort across the group rather than all or nothing: a page re-read
   * replaces some or all of the blocks, and a step that can still put four of
   * its six back is worth more than one that refuses because two are missing.
   * False only when it finds none of them, which is the same condition
   * `applyBlock` reports and is dropped the same way.
   */
  function applyBlocks (entry: BlocksEntry, side: 'before' | 'after'): boolean {
    const here = pages.value.find((page) => page.id === entry.page)

    if (!here) return false

    let landed = false

    for (const edit of entry.edits) {
      const block = here.blocks.find((candidate) => candidate.id === edit.blockId)

      if (!block) continue

      Object.assign(block, edit[side])
      landed = true
    }

    return landed
  }

  /**
   * A deletion, taken back or done again.
   *
   * Both directions check first and shrug if the page already agrees: undo is
   * retried after a failure and a step that put a second copy back would be
   * worse than one that did nothing.
   */
  function applyGone (entry: GoneEntry | MadeEntry, back: boolean): boolean {
    const here = pages.value.find((page) => page.id === entry.page)

    if (!here) return false

    // The list it came out of: the page's, or the pieces of the balloon it was
    // split from. A child put back at the top level would be a second balloon
    // rather than a column of the one it belongs to.
    const list = entry.parent
      ? here.blocks.find((candidate) => candidate.id === entry.parent)?.children
      : here.blocks

    if (!list) return false

    const at = list.findIndex((candidate) => candidate.id === entry.block.id)

    if (back) {
      if (at === -1) list.splice(Math.min(entry.index, list.length), 0, { ...entry.block })

      return true
    }

    if (at !== -1) list.splice(at, 1)

    return true
  }

  /**
   * A block leaving the page, remembered whole.
   *
   * Never folded into the entry above it — see `recordBlock`, which coalesces a
   * run of nudges into one step. A deletion is not a continuation of whatever
   * you were doing to the block a moment ago; it is the last thing that happens
   * to it, and merging it into a drag would make one Cmd+Z undo both.
   */
  function recordGone (page: string, block: Block, index: number, parent: string | null = null) {
    record({ kind: 'gone', page, parent, index, block: JSON.parse(JSON.stringify(block)) as Block })
  }

  /**
   * A block arriving on the page, remembered whole — see `MadeEntry`.
   *
   * Copied rather than referenced for the reason a deletion is: the entry has
   * to say what the block was at the moment it was placed, and the block itself
   * goes on being edited afterwards.
   *
   * Never folded into the step above it. Placing a block is the first thing
   * that happens to it, not a continuation of whatever was being done to
   * something else, and merging it into a drag would make one Cmd+Z undo both.
   */
  function recordMade (page: string, block: Block, index: number, parent: string | null = null) {
    record({ kind: 'made', page, parent, index, block: JSON.parse(JSON.stringify(block)) as Block })
  }

  /**
   * Strike every step that names a block from both stacks.
   *
   * For the one gesture that has to leave no trace behind it: a text block
   * placed on the page, typed into and then abandoned empty never happened, and
   * the steps it filed on the way — the placement, and a `block` entry for the
   * run of keystrokes — would otherwise sit on the stack as a series of presses
   * whose only effect is to put an invisible box back on the page and take it
   * off again. Taking it off through `removeBlock` would file a third.
   *
   * Only ever for a block that is leaving the page in the same breath. A block
   * that is staying must keep its history, or undo would skip past its edits to
   * whatever was done before it.
   */
  function forgetBlock (blockId: string) {
    const names = (entry: UndoEntry) =>
      (entry.kind === 'block' && entry.blockId === blockId)
      || ((entry.kind === 'gone' || entry.kind === 'made') && entry.block.id === blockId)
      // A grouped step is struck only once nothing is left in it — the block
      // itself comes out of it below. A batch goes the same way and for the same
      // reason: emptied of this block's steps it may still hold other blocks'.
      || (entry.kind === 'blocks' && !entry.edits.length)
      || (entry.kind === 'batch' && !entry.entries.length)

    // The one edit rather than the whole entry, because a grouped step names
    // other blocks as well and they are staying on the page: dropping the entry
    // outright would take their history with it, and undo would skip past what
    // was done to them.
    const without = (entry: UndoEntry): UndoEntry => {
      if (entry.kind === 'blocks') {
        return { ...entry, edits: entry.edits.filter((edit) => edit.blockId !== blockId) }
      }

      // Into the batch, then strike whatever the same rule strikes at the top
      // level. Skipping it would leave the abandoned block's placement inside a
      // step that is still on the stack, which is precisely the trace this is
      // for getting rid of.
      if (entry.kind === 'batch') {
        return { ...entry, entries: entry.entries.map(without).filter((child) => !names(child)) }
      }

      return entry
    }

    for (const stack of Object.values(all.value)) {
      stack.past = stack.past.map(without).filter((entry) => !names(entry))
      stack.future = stack.future.map(without).filter((entry) => !names(entry))
    }
  }

  /** One step, in whichever direction, by whatever kind of thing it is. */
  async function apply (entry: UndoEntry, back: boolean): Promise<boolean> {
    if (entry.kind === 'stroke') return flip(entry, back)

    // An erase runs the flip the other way round: going back un-retracts
    // what it took — and re-retracts the pieces it left, which exist only
    // because the originals do not. `every` rather than best-effort, so a
    // half-failed step stays on its stack and a retry can finish the job —
    // the flip is idempotent.
    if (entry.kind === 'erase') {
      const results = await Promise.all([
        ...entry.strokes.map((stroke) => flip(stroke, !back)),
        ...entry.remade.map((stroke) => flip(stroke, back)),
      ])

      return results.every(Boolean)
    }

    if (entry.kind === 'gone') return applyGone(entry, back)

    // A placement is a deletion run backwards — see `MadeEntry`. Undo takes the
    // block off the page, redo puts it back at the index it was placed at.
    if (entry.kind === 'made') return applyGone(entry, !back)

    if (entry.kind === 'blocks') return applyBlocks(entry, back ? 'before' : 'after')

    /*
     * A gesture, undone as one — and **backwards**, which is the whole of what
     * makes it correct rather than merely grouped.
     *
     * The children happened in an order and each was recorded against the page
     * as it stood after the one before it. A deletion carries the index it came
     * out of, so restoring three deletions in the order they were made puts the
     * first one back before the second has left its gap and every index after it
     * is one out. Run last-first, each child is put back into exactly the page
     * its `before` was taken from. Redo is the same argument the other way, so it
     * runs first-last.
     *
     * Sequential rather than `Promise.all`, for the same reason: these mutate one
     * array and their order is the point. Best-effort like `applyBlocks` —
     * `every` over a list that mixes kinds would strand a whole gesture on one
     * child whose block a page re-read has taken away.
     */
    if (entry.kind === 'batch') {
      const order = back ? [...entry.entries].reverse() : entry.entries
      let done = false

      for (const child of order) done = await apply(child, back) || done

      return done
    }

    return applyBlock(entry, back ? 'before' : 'after')
  }

  /**
   * Whether a step that would not apply is worth keeping.
   *
   * A stroke that could not be retracted is still undoable and losing it would
   * strand the mark on the page with no way to take it back, so it goes back
   * where it was. The block kinds are the exception: they failed because every
   * block they name is gone — a page re-read — and there is no version of
   * putting those back that is right. A batch is judged as a whole and joins
   * them: it reports failure only when *none* of its children applied, which for
   * a gesture about blocks means the same thing.
   */
  const retriable = (entry: UndoEntry) =>
    entry.kind !== 'block' && entry.kind !== 'blocks' && entry.kind !== 'batch'

  async function undo () {
    const stack = stacks()
    const entry = stack.past.pop()

    if (!entry) return

    if (!(await apply(entry, true))) {
      if (retriable(entry)) stack.past.push(entry)

      return
    }

    stack.future.push(entry)
  }

  async function redo () {
    const stack = stacks()
    const entry = stack.future.pop()

    if (!entry) return

    if (!(await apply(entry, false))) {
      if (retriable(entry)) stack.future.push(entry)

      return
    }

    stack.past.push(entry)
  }

  /**
   * A bake landed on a surface: everything at or under the watermark is now in
   * the bitmap, unretractable, and has no business in either stack. Called by
   * whatever runs the bake, per the schema's rule that baking never reaches
   * into undo range — this is the belt to that braces.
   */
  function pruneBaked (surfaceId: number, bakedSeq: number) {
    // Blocks are none of this function's business and must survive it: a bake
    // is a fact about one paint surface, and filtering on `surfaceId` alone
    // would take every block step in the workspace with it. An erase goes if
    // *any* of its strokes has been baked over — a step that can only half
    // apply is worse than one that is gone.
    const baked = (stroke: Omit<StrokeEntry, 'kind'>) =>
      stroke.surfaceId === surfaceId && stroke.seq <= bakedSeq

    const live = (entry: UndoEntry): boolean =>
      entry.kind === 'block' || entry.kind === 'blocks' || entry.kind === 'gone' || entry.kind === 'made'
        ? true
        : entry.kind === 'erase'
          ? !entry.strokes.some(baked) && !entry.remade.some(baked)
          // A batch survives while any child does, and sheds the rest. It has no
          // strokes of its own, so asking `baked` about it — which is what an
          // unlisted kind would fall through to — would read its undefined
          // `surfaceId` and quietly keep every batch in the workspace forever.
          : entry.kind === 'batch'
            ? Boolean((entry.entries = entry.entries.filter(live)).length)
            : !baked(entry)

    for (const stack of Object.values(all.value)) {
      stack.past = stack.past.filter(live)
      stack.future = stack.future.filter(live)
    }
  }

  return {
    canUndo,
    canRedo,
    versions,
    record,
    gather,
    recordBlock,
    recordBlocks,
    recordGone,
    recordMade,
    forgetBlock,
    renameBlock,
    renumber,
    undo,
    redo,
    bump,
    pruneBaked,
  }
}

/**
 * Cmd+Z and Cmd+Shift+Z (and Cmd+Y, for hands that learned it there), wired
 * once by the workspace page.
 *
 * Nothing fires while something is being typed into: a text field's own undo
 * belongs to the caret, and taking a stroke off the page because somebody
 * pressed Cmd+Z inside a translation box would be indefensible.
 */
export function useUndoShortcuts () {
  const { undo, redo } = useUndo()

  useEventListener(window, 'keydown', (event: KeyboardEvent) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey || event.repeat) return

    const target = event.target as HTMLElement | null

    if (target?.isContentEditable || /^(?:input|textarea|select)$/i.test(target?.tagName ?? '')) return

    const key = event.key.toLowerCase()

    if (key === 'z') {
      event.preventDefault()

      if (event.shiftKey) redo()
      else undo()
    } else if (key === 'y' && !event.shiftKey) {
      event.preventDefault()
      redo()
    }
  })
}
