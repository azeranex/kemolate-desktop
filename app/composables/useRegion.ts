/**
 * A region somebody painted, turned into a block on the page.
 *
 * The two brushes at the bottom of the rail. Paint over lettering the detector
 * never found, and on release the shape is cut out of the scan, read, and left
 * behind as a block of its own — with a translation already in it, or without
 * one, depending on which brush is out:
 *
 * - **Translate region** asks the model the Translate panel is pointed at to do
 *   both halves in one request. See `regionPrompt`.
 * - **Read region** hands the crop to Google Vision and leaves it in the
 *   language it is printed in.
 *
 * ## Why it is a brush and not a box
 *
 * These exist for the lettering with no balloon around it — an effect drawn into
 * the artwork, a sign, handwriting down a gutter — which is exactly the
 * lettering no rectangle fits. Any rectangle tight enough to exclude the
 * neighbours cuts the glyphs; any rectangle loose enough to hold the glyphs
 * takes the neighbours in with them, and a reader handed both answers with both,
 * in one string, as though they were one line. A stroke says which marks are
 * meant with the precision of the thing being pointed at — see `knockOut`, where
 * the shape stops being a picture and becomes the crop.
 *
 * ## Nothing changes until the answer comes back
 *
 * The block used to be placed on the way in, so that something appeared while
 * the request was out. That was the wrong bargain once a region started
 * *replacing* what it covers: a call that failed left the covered blocks deleted
 * and an empty box in their place, and somebody had to work out what had been
 * there. The page is now untouched until there is a reading to put on it, so a
 * failed gesture costs the seconds and nothing else — and what does land lands
 * in one breath, which is what lets it be one press of Cmd+Z.
 *
 * Feedback while it is out is the note at the foot of the page — see
 * `RegionBrush` — rather than a box that might not survive.
 */
/*
 * Named explicitly because there are two `Box`es and the auto-import picks the
 * other one: `shared/utils/ocr.ts` has the detector's, which is a centre and an
 * angle, while a block's is a top-left corner in percentages. They are the same
 * word for two coordinate systems, and confusing them is the bug this file
 * would be most likely to have.
 */
import type { Box, ComicPage } from '~/composables/useComic'
import type { CropShape } from '~/utils/images'

/** Which of the two brushes made the stroke. */
export type RegionMode = 'read' | 'translate'

export function useRegion () {
  const { pages, page, addBlock, removeBlock, reach, translate, epoch } = useComic()
  const { gather } = useUndo()

  /*
   * The reading state is `useOcr`'s rather than a second copy of it.
   *
   * There is one "something is being read" in this app: the Detect panel draws
   * that progress line, and `running` is what stops two readings fighting over
   * the same models and the same processor. A region is a reading, so it says so
   * in the same place — and a page read cannot start while one is out, which is
   * right and would not be true of a flag of this composable's own.
   */
  const { progress, error, running } = useOcr()

  const { require } = useProviderKeys()
  const { byId } = useModels()
  const { record } = useAiUsage()
  const { target: locale } = useTargetLanguage()
  const { direction } = useReadingDirection()
  const { ready: glossaryReady, learn } = useGlossary()
  const { ready: castReady, learn: learnCast } = useCast()

  const model = computed(() => byId(translate.value.model))

  /**
   * The box a stroke covers: its own bounds, grown by the brush.
   *
   * The ring is what somebody aimed with, so the mark is as wide as the ring was
   * and not as wide as the line through its middle. Held on the page, because a
   * stroke run off the edge is a box that starts outside the scan and every
   * consumer of a block reads its box as a fraction of a page it is inside.
   */
  function boxOf (shape: CropShape, scan: { width: number, height: number }) {
    let bounds: Bounds | null = null

    for (let i = 0; i + 1 < shape.path.length; i += 2) {
      bounds = grownBounds(bounds, shape.path[i]!, shape.path[i + 1]!, shape.radius)
    }

    if (!bounds) return null

    const x = Math.max(0, bounds.x0)
    const y = Math.max(0, bounds.y0)
    const w = Math.min(scan.width - x, bounds.x1 - x)
    const h = Math.min(scan.height - y, bounds.y1 - y)

    return w < 4 || h < 4 ? null : { x, y, w, h }
  }

  /**
   * The blocks this region stands in place of.
   *
   * By **centre**, not by overlap, which is the rule `selectWithin` already
   * settles for the rubber band and for the same reason: the boxes on a page
   * routinely overlap, and taking one away because a corner of it grazed the
   * region is exactly the surprise that makes a destructive tool unusable. A
   * block whose middle is inside what you painted is a block you painted over.
   *
   * Hidden and garbage blocks go too. They are what is *there*, which is what a
   * replacement replaces — and a hidden block left behind is a duplicate that
   * reappears the day somebody turns its plate back on, by which time nothing
   * says where it came from. One press takes the lot back.
   *
   * `blockBoxOf` rather than the lettering frame: this is about where the
   * reading was found, not where its translation has since been dragged to.
   */
  function coveredBy (target: ComicPage, box: Box) {
    return target.blocks
      .filter((block) => {
        const at = blockBoxOf(block)
        const cx = at.x + at.w / 2
        const cy = at.y + at.h / 2

        return cx >= box.x && cx <= box.x + box.w && cy >= box.y && cy <= box.y + box.h
      })
      .map((block) => block.id)
  }

  /**
   * The model's answer, and what it taught the chapter.
   *
   * The glossary and the cast go out with the ask and come back merged, exactly
   * as they do on a page run — see `useGlossary`, which explains at length why
   * agreeing on a spelling is the one part of this pipeline that cannot live in
   * a browser alone. A region translated outside that loop is a line that calls
   * a character by a name the rest of the volume does not use.
   *
   * The spend is filed on the reader's own ledger like any other call, so the
   * usage table counts what these brushes cost beside what a page costs. It is
   * the same money and the same key; a ledger that only counted page runs would
   * quietly stop adding up the day somebody worked a chapter of sound effects
   * with this.
   */
  async function askModel (crop: Blob, key: string, target: ComicPage) {
    const answer = await translateRegion(key, {
      model: model.value,
      image: crop,
      target: locale.value,
      glossary: await glossaryReady(),
      cast: await castReady(),
      honorifics: translate.value.honorifics,
      direction: direction.value,
      effort: REASONING_FOR[translate.value.effort],
    })

    if (answer.usage) {
      await record({
        at: Date.now(),
        pageId: target.id,
        page: target.name,
        model: model.value.label,
        what: 'region',
        input: answer.usage.input,
        output: answer.usage.output,
        reasoning: answer.usage.reasoning,
        cost: answer.usage.cost,
      })
    }

    if (answer.learnedTerms.length) await learn(answer.learnedTerms)
    if (answer.learnedCast.length) await learnCast(answer.learnedCast, locale.value)

    return { source: tidyText(answer.source), translation: answer.translation.trim() }
  }

  /** Google Vision, on the crop. The reading only — there is no second half. */
  async function askVision (crop: { file: Blob, width: number }, key: string) {
    const read = await readWithReader(
      'vision',
      { file: crop.file, width: crop.width },
      // No regions: the crop *is* the region, and a reader that finds its own
      // finds the one thing in the picture.
      [],
      (message, step) => { progress.value = { page: 1, pages: 1, message, step, found: 0 } },
      { key },
    )

    // Joined and collapsed by `tidyText` rather than by fiat — it holds the rule
    // for what replaces a break, which is nothing for CJK and a space for
    // everything else. See `readBlock`, which was taught that by an English
    // balloon that came back "HELLOWORLD".
    return { source: tidyText(read.map((found) => found.text).join('\n')), translation: '' }
  }

  /**
   * One stroke, start to finish.
   *
   * Returns the block it left behind, or null — with `error` saying why in
   * words. Every refusal that can be known in advance is made before the request
   * goes out, because the only thing worse than a tool that will not work is one
   * that spends a call finding out.
   */
  async function runRegion (
    pageId: string,
    shape: CropShape,
    mode: RegionMode,
  ): Promise<Block | null> {
    if (running.value) return null

    const target = pages.value.find((candidate) => candidate.id === pageId)
    const scan = target?.scan

    if (!target || !scan?.width || !scan.height || shape.path.length < 2) return null

    // `addBlock` puts the block on the page being looked at, so a stroke whose
    // page has been turned since is a stroke from a gesture ago.
    if (page.value?.id !== pageId) return null

    const region = boxOf(shape, scan)

    if (!region) return null

    error.value = null

    let key: string

    try {
      // A block lands on the Dialogue plate — see `addBlock`, which refuses when
      // that row is shut. Asked here rather than there, because there is after
      // the call has been paid for.
      if (!reach.value.has('dialogue')) {
        throw new Error('Nowhere to put it: the layer a new block would land on is hidden or locked.')
      }

      // A model with no eyes, handed a message whose picture has been dropped,
      // answers fluently and invents the line — a failure indistinguishable from
      // a reading, so it is turned away at the same door as a missing key.
      const blind = mode === 'translate' ? cannotSee(model.value) : null

      if (blind) throw new Error(blind)

      key = await require(mode === 'translate' ? 'openrouter' : 'vision')
    } catch (thrown) {
      error.value = thrown instanceof Error ? thrown.message : String(thrown)

      return null
    }

    const started = epoch.value

    progress.value = {
      page: 1,
      pages: 1,
      message: mode === 'translate'
        ? `Reading the region with ${model.value.label}…`
        : 'Reading the region with Google Vision…',
      found: 0,
    }

    try {
      const crop = await cropOut(scan.file, region, 0.08, shape)

      if (!crop) throw new Error('That region could not be cut out of the page.')

      const { source, translation } = mode === 'translate'
        ? await askModel(crop.file, key, target)
        : await askVision(crop, key)

      // A page turned, a chapter closed, a re-read: whatever the answer is, it
      // is an answer about a page that is no longer the one in front of anybody.
      if (epoch.value !== started || page.value?.id !== pageId) return null

      if (!source) {
        error.value = 'Nothing readable in that region.'

        return null
      }

      // The block's box, in the percentages every consumer of a block reads.
      const box: Box = {
        x: (region.x / scan.width) * 100,
        y: (region.y / scan.height) * 100,
        w: (region.w / scan.width) * 100,
        h: (region.h / scan.height) * 100,
      }

      /*
       * The page changes here and nowhere else, in one gathered step: what the
       * region covers comes off, and the region goes on in its place. See
       * `gather` — four presses to undo one stroke is three presses somebody
       * stops halfway through.
       *
       * A bubble, which is what `toDrafts` calls a block read without a detector
       * saying otherwise, and nothing here has one to say it. The type is a menu
       * away in the Blocks panel where it turns out to be a sound effect.
       */
      return gather(() => {
        for (const id of coveredBy(target, box)) removeBlock(id)

        return addBlock(box, { type: 'bubble', source, translation, confidence: 100 })
      })
    } catch (thrown) {
      error.value = thrown instanceof Error ? thrown.message : String(thrown)

      return null
    } finally {
      progress.value = null
    }
  }

  return { runRegion, model }
}
