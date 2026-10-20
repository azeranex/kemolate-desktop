/**
 * Joining blocks into a balloon, and letting one go again.
 *
 * Illustrator's compound path, in both directions: `merge` makes one object out
 * of several, `split` releases it and the parts are exactly as they were. What
 * makes that work is on `Block.children` and `blocks.parentId` — a balloon is a
 * block that has children, so `page.blocks` holds one entry for it and every
 * consumer sees an object rather than a grouping it has to know about.
 *
 * Its own composable rather than part of `useComic` because it needs two things
 * that file deliberately does not have: the route's workspace and the server's
 * page rows. `useComic` works on a chapter no server has heard of, and so does
 * this — see below.
 *
 * ## Local chapters join blocks too
 *
 * Dragging images into a new workspace makes a chapter that exists in this
 * browser and nowhere else, which is the state the app starts in. Its pages have
 * no rows, so its blocks have none either, and demanding one would refuse the
 * commonest flow there is. So a balloon made on a local page is assembled here
 * and kept by `useBlockCache` along with everything else; ids beginning `local:`
 * say which kind it is, and `rowOf` already returns null for anything that is
 * not `block:`.
 */
import type { Block, ComicPage } from './useComic'

import { rowOf } from '~/utils/ocr/blocks'

/** What went wrong, in a sentence, or null when nothing did. */
type Outcome = string | null

/** Ids for balloons no server will ever see. Never collides with `block:`. */
let localBalloon = 0

export function useBlockMerge () {
  const route = useRoute()
  const { pageRowOf } = useShared()
  // `epoch` for `settled` — see `held` in `useBlockSync`.
  const { page, selection, selected, setSelection, setBlocks, epoch } = useComic()

  const workspace = computed(() => String(route.params.workspaceId ?? ''))

  /**
   * Tell `useBlockSync` what this page legitimately holds now.
   *
   * The stamp on the writes below buys ordering and costs this: a write nobody
   * echoes back is a write `useLiveSync` never re-reads, and it is that re-read
   * which calls `settled` — the guard that stops a row leaving the local list
   * from being read as a deletion. Without it, one bad local write becomes a
   * DELETE per row about ten seconds later, which is how a page of blocks left
   * the server having been asked for nothing of the kind.
   *
   * So the two of them go together and must stay together: opting out of the
   * echo means taking on the job the echo was doing. Children included, because
   * `flush` walks a balloon's columns as rows of their own.
   */
  function agreed (target: ComicPage) {
    settled(epoch.value, target.id, target.blocks
      .flatMap((block) => (block.children?.length ? [block, ...block.children] : [block]))
      .map((block) => rowOf(block))
      .filter((row): row is number => row !== null))
  }

  /** Whatever the server said, or a plain sentence when it said nothing useful. */
  function reason (error: unknown, fallback: string): string {
    const said = error as { data?: { statusMessage?: string }, statusMessage?: string }

    return said?.data?.statusMessage ?? said?.statusMessage ?? fallback
  }

  /**
   * The box that encloses several, which is the balloon's own.
   *
   * Measured rather than stored anywhere lasting: a compound path has no
   * geometry beyond its subpaths, so this is recomputed from the children every
   * time they change and can never drift away from them.
   */
  function around (members: Block[]) {
    const x = Math.min(...members.map((m) => m.x))
    const y = Math.min(...members.map((m) => m.y))

    return {
      x,
      y,
      w: Math.max(...members.map((m) => m.x + m.w)) - x,
      h: Math.max(...members.map((m) => m.y + m.h)) - y,
    }
  }

  /**
   * Two or more blocks, and a balloon among them is allowed.
   *
   * It used to refuse any selection holding one, which read as "a balloon is
   * finished" and was really "the server said no": joining two balloons is one
   * balloon holding both their columns, which is exactly as flat as the page
   * already is. The only way through was to split both by hand and join the
   * pieces — the same row, three presses later. See `compound` on the server,
   * which now dissolves them.
   */
  const canMerge = computed(() => selected.value.length > 1)

  /** Exactly one balloon chosen, and nothing else. */
  const canSplit = computed(() =>
    selected.value.length === 1 && Boolean(selected.value[0]?.children?.length))

  /**
   * Join the selected blocks into one.
   *
   * Their order is the order they sit in the list, not the order they were
   * clicked: what the balloon says is its columns end to end, and that has one
   * right answer which is not "whichever I picked first". Sort the page into
   * reading order before joining and the sentence comes out right.
   */
  async function merge (): Promise<Outcome> {
    const here = page.value

    if (!here || !canMerge.value) return 'Pick two or more blocks to join.'

    const chosen = here.blocks.filter((block) => selection.value.includes(block.id))

    /*
     * What the new balloon is actually made of: a chosen balloon gives up its
     * columns, anything else stands for itself. Flat, because a balloon holds
     * columns and never balloons — the server says the same thing at greater
     * length in `compound`.
     *
     * The translation of a balloon being taken apart here is not carried over
     * and is not kept. What this makes says something neither half said on its
     * own, so a wording written for one of them is not a wording for it.
     */
    const members = chosen.flatMap((block) => (block.children?.length ? block.children : [block]))
    const box = around(members)

    /*
     * The wordings this is about to cost, read before anything is written.
     *
     * Only the balloons: their rows are deleted and `translations.blockId`
     * cascades, so those wordings and every revision of them are gone. A plain
     * block keeps its row and therefore its translation — it stops being shown,
     * because a column does not carry one, and splitting the balloon brings it
     * back. Warning about that one too would call a thing lost that is not.
     */
    const losing = chosen
      .filter((block) => block.children?.length && block.translation.trim())
      .map((block) => block.translation.trim())

    const balloon: Block = {
      ...box,
      id: `local:${--localBalloon}`,
      type: members[0]!.type,
      /*
       * Joined on the break, and then the break is spent.
       *
       * `tidyText` holds the one rule for what a break between two pieces of
       * lettering reads as, and it needs to see the break to apply it: nothing
       * between the columns of a vertical CJK balloon, where a column end is
       * not a word end, and a space between the lines of a Latin one, where it
       * is. This used to join with nothing whatever the script, so two lines of
       * an English aside came out welded into one word — and that source is
       * what every later translation of the line is made from.
       *
       * The break does not survive into the source, deliberately. Where the
       * lettering wrapped is a fact about this page's balloon, not about what
       * the sentence says, and keeping it would put a newline through the
       * middle of every prompt — as well as making a merged balloon read
       * differently from the same balloon read again, which is the same string
       * arrived at two ways. `useOcr.readBlock` joins its own pieces exactly
       * like this.
       */
      source: tidyText(members.map((m) => m.source).join('\n')),
      translation: '',
      confidence: Math.min(...members.map((m) => m.confidence)),
      hidden: false,
      children: members,
    }

    // Which row this page is — `pageRowOf`, the one rule; see `useOcr.remoteId`.
    const pageRow = pageRowOf(here)

    // The blocks that were *chosen*, not the columns they resolve to: the
    // server is told what was picked and does the flattening itself, in the one
    // transaction that also deletes the emptied parents. Sending the columns
    // instead would leave those parents behind as childless balloons that
    // nothing would ever clean up.
    const rows = chosen.map((block) => rowOf(block))

    // A page with no row of its own has blocks with none either, and refusing
    // on that would refuse every local chapter — see the header.
    if (pageRow && rows.every(Boolean)) {
      try {
        // Measured before the box is converted, or `toPatchBox` stores it at
        // the 2:3 guess. The auto run joins on a page it has only just turned
        // to, which is the page most likely not to have been drawn — see `sized`.
        await sized(here)

        const made = await $fetch<{ id: number }>(
          `/api/workspaces/${workspace.value}/pages/${pageRow}/compound`,
          {
            method: 'POST',
            body: {
              children: rows,
              kind: balloon.type,
              ...toPatchBox(balloon, here),
              source: balloon.source,
              confidence: balloon.confidence,
            },
            // Stamped so the notice this raises skips this tab — see
            // `peerHeader`, and `useOcr.persist`, which says the same thing.
            // Every other block write in the app carries this and this one did
            // not, which cost more than a wasted fetch: the notice came back
            // here, `useLiveSync` re-read the page and put the blocks back in
            // the server's stored order, throwing away any ordering this
            // browser had not yet managed to save. Sorting a page and then
            // joining a balloon on it lost the sort, every time, and it looked
            // like the sort had never run.
            headers: peerHeader(workspace.value),
          },
        )

        balloon.id = `block:${made.id}`
      } catch (error) {
        return reason(error, 'Those blocks could not be joined.')
      }
    }

    // Put in at the first chosen block's place, so the balloon keeps the
    // position in the reading order that its opening column had.
    //
    // `chosen`, emphatically not `members`: once a balloon can be among them,
    // the first member may be a *column*, which is not in the top-level list at
    // all. `findIndex` answers -1 for it, and `rest.slice(0, -1)` is not "the
    // start of the list" but "all but the last" — the balloon would be dropped
    // in second from the end, one place further back each time.
    const at = here.blocks.findIndex((block) => block.id === chosen[0]!.id)
    const rest = here.blocks.filter((block) => !selection.value.includes(block.id))

    setBlocks(here.id, [...rest.slice(0, at), balloon, ...rest.slice(at)])
    agreed(here)
    setSelection([balloon.id])

    /*
     * Say what it cost, and say the words themselves.
     *
     * The merge is what was asked for, so this is news rather than a refusal —
     * but it is the one press in the app that destroys a wording, and it does
     * it to make room for nothing: the joined balloon says something neither
     * half said alone, so it starts empty. The lost wording goes in the line so
     * it can be read back and pasted, which is the whole difference between a
     * warning and a way out; `toast.warning` files it in the bell on its way
     * past, so looking away does not lose it — see `utils/toast.ts`.
     */
    if (losing.length) {
      toast.warning(
        losing.length === 1
          ? 'A translation was removed'
          : `${losing.length} translations were removed`,
        {
          description: `${losing.map((wording) => `“${wording}”`).join(' · ')} — the joined balloon needs its own wording.`,
        },
      )
    }

    return null
  }

  /** The balloon's box in the space a row is stored in — see `toPatch`. */
  function toPatchBox (balloon: Block, here: ComicPage) {
    const scan = here.scan
    const aspect = scan?.width && scan.height ? scan.width / scan.height : PAGE_RATIO

    return {
      cx: (balloon.x + balloon.w / 2) / 100,
      cy: (balloon.y + balloon.h / 2) / 100 / aspect,
      w: balloon.w / 100,
      h: balloon.h / 100 / aspect,
    }
  }

  /**
   * Let a balloon go, giving back the blocks it was made of.
   *
   * They come back where the balloon was rather than at the end, so releasing
   * one does not rearrange the page around it.
   */
  async function split (): Promise<Outcome> {
    const here = page.value
    const balloon = selected.value[0]

    if (!here || !balloon?.children?.length) return 'Pick a joined balloon to split.'

    const row = rowOf(balloon)

    if (row) {
      try {
        await $fetch(`/api/workspaces/${workspace.value}/blocks/${row}/release`, {
          method: 'POST',
          // Stamped for the reason the join above is: this browser puts the
          // freed columns back itself, so the notice coming home would only
          // re-read the page and impose the server's order on it.
          headers: peerHeader(workspace.value),
        })
      } catch (error) {
        return reason(error, 'That balloon could not be split.')
      }
    }

    const at = here.blocks.findIndex((block) => block.id === balloon.id)
    const freed = balloon.children

    setBlocks(here.id, [
      ...here.blocks.slice(0, at),
      ...freed,
      ...here.blocks.slice(at + 1),
    ])
    agreed(here)
    setSelection(freed.map((block) => block.id))

    return null
  }

  return { canMerge, canSplit, merge, split }
}
