import { describe, expect, it } from 'vitest'

import { askShape, planPage } from '~/composables/useTranslate'

/**
 * `planPage` is the one place in this app that decides to spend somebody's
 * money, and it is also the answer the panel prints on the button before the
 * money is spent. Both of those are worth pinning down without standing a
 * workspace up.
 *
 * The interesting cases are all about what is *not* sent. A run that translates
 * everything is easy and expensive; the rules below are each a page that came
 * back with a bill nobody expected, or a balloon nobody wanted touched.
 */

function block (over: Partial<Block> & { id: string }): Block {
  return {
    type: 'bubble',
    x: 1,
    y: 2,
    w: 3,
    h: 4,
    source: 'こんにちは',
    translation: '',
    confidence: 90,
    hidden: false,
    ...over,
  }
}

/** A Japanese page: two balloons, a shirt logo, a shout, and some rubbish. */
const page = () => [
  block({ id: 'a', source: 'こんにちは' }),
  block({ id: 'b', source: 'どうして……' }),
  block({ id: 'logo', source: 'ECLIPSE' }),
  block({ id: 'bang', source: '!?', type: 'sfx' }),
  block({ id: 'junk', source: 'ページ 12', type: 'garbage' }),
]

const ids = (blocks: Block[]) => blocks.map((each) => each.id)

describe('planPage', () => {
  it('asks about the dialogue and nothing else', () => {
    const plan = planPage(page(), 'en')

    expect(ids(plan.pending)).toEqual(['a', 'b'])
  })

  it('answers the logo and the shout for nothing, without sending them', () => {
    const plan = planPage(page(), 'en')

    // Both are lettered, so both need an answer; neither needs a model.
    expect(ids(plan.asItself)).toEqual(['logo', 'bang'])
    expect(ids(plan.pending)).not.toContain('logo')
  })

  it('leaves out what will never be lettered', () => {
    const plan = planPage([
      ...page(),
      block({ id: 'hidden', source: 'ないしょ', hidden: true }),
      block({ id: 'blank', source: '   ' }),
    ], 'en')

    for (const gone of ['junk', 'hidden', 'blank']) {
      expect(ids(plan.shown)).not.toContain(gone)
      expect(ids(plan.pending)).not.toContain(gone)
    }
  })

  /**
   * The asymmetry the page button is built on: a translator's own wording is
   * the most valuable thing on the page, and a run that quietly replaced it
   * would be the one mistake this app cannot apologise for.
   */
  it('never touches a line somebody has already written', () => {
    const blocks = page()

    blocks[0]!.translation = 'Hi there'

    const plan = planPage(blocks, 'en')

    expect(ids(plan.pending)).toEqual(['b'])
    expect(plan.kept).toBe(1)
  })

  it('whitespace is not a translation', () => {
    const blocks = page()

    blocks[0]!.translation = '   '

    expect(ids(planPage(blocks, 'en').pending)).toContain('a')
  })

  /**
   * The model is shown the whole page even when only some of it is being
   * written, because a comic's lines lean on each other — see the composable's
   * header. `worth` is that list, and it is wider than `pending`.
   */
  it('keeps the whole page as context, wider than what it will write', () => {
    const blocks = page()

    blocks[0]!.translation = 'Hi there'

    const plan = planPage(blocks, 'en')

    expect(ids(plan.worth)).toEqual(['a', 'b'])
    expect(ids(plan.pending)).toEqual(['b'])
  })

  describe('one block by name', () => {
    it('asks about that block whatever it currently says', () => {
      const blocks = page()

      blocks[1]!.translation = 'Why...'

      expect(ids(planPage(blocks, 'en', { only: 'b' }).pending)).toEqual(['b'])
    })

    it('still offers the rest of the page as context', () => {
      expect(ids(planPage(page(), 'en', { only: 'b' }).worth)).toEqual(['a', 'b'])
    })

    /**
     * Asking about one balloon must not fill in the page's logos as a side
     * effect — that would be an edit nobody requested, landing on the undo
     * stack under somebody else's press.
     */
    it('touches nothing else, not even the free answers', () => {
      const plan = planPage(page(), 'en', { only: 'b' })

      expect(plan.asItself).toEqual([])
      expect(plan.kept).toBe(0)
    })

    it('finds nothing for a block that is not worth asking about', () => {
      // The caller answers this one itself, with what is printed there.
      expect(planPage(page(), 'en', { only: 'logo' }).pending).toEqual([])
    })
  })

  describe('again', () => {
    /**
     * The bug this was written for. A page carried over with Google has no
     * missing lines, so the ordinary plan is empty and the panel greys out —
     * and putting the same page through a model became an ask with no button.
     */
    it('is the only plan with anything to do on a page that is already full', () => {
      const blocks = page().map((each) => ({ ...each, translation: 'done' }))

      expect(planPage(blocks, 'en').pending).toEqual([])
      expect(ids(planPage(blocks, 'en', { force: true }).pending)).toEqual(['a', 'b'])
    })

    it('replaces typed lines too, which is what makes it a separate press', () => {
      const blocks = page()

      blocks[0]!.translation = 'Something a person wrote'

      const plan = planPage(blocks, 'en', { force: true })

      expect(ids(plan.pending)).toEqual(['a', 'b'])
      // Nothing is being kept, so there is nothing to report as kept.
      expect(plan.kept).toBe(0)
    })

    it('still refuses to send what no model could improve on', () => {
      const plan = planPage(page(), 'en', { force: true })

      expect(ids(plan.pending)).not.toContain('logo')
      expect(ids(plan.asItself)).toEqual(['logo', 'bang'])
    })

    it('still leaves out rubbish and hidden blocks', () => {
      const blocks = [...page(), block({ id: 'hidden', source: 'ないしょ', hidden: true })]

      expect(ids(planPage(blocks, 'en', { force: true }).pending)).toEqual(['a', 'b'])
    })
  })

  /**
   * The same page read into a Latin language is not the same plan. Into
   * Indonesian the logo is still Latin and still skipped; into Chinese it is
   * neither the page's script nor the target's, so only a model can say whether
   * a Chinese edition wants 日蝕 there.
   */
  it('depends on the language being translated into', () => {
    expect(ids(planPage(page(), 'id').pending)).toEqual(['a', 'b'])
    expect(ids(planPage(page(), 'zh').pending)).toEqual(['a', 'b', 'logo'])
  })
})

/**
 * `askShape` is the other half of the same bargain: which lines actually
 * travel, and which one of them is being asked about. The request and the
 * estimate both call it, so what it decides is what gets billed.
 */
describe('askShape', () => {
  it('a page run with context carries the written lines along', () => {
    const blocks = page()

    blocks[0]!.translation = 'Hi there'

    const { sent, one } = askShape(planPage(blocks, 'en'), true)

    expect(ids(sent)).toEqual(['a', 'b'])
    // Only one line is missing, so only one answer is asked for — the model
    // writes one string instead of two, and output is most of the cost.
    expect(one).toBe(1)
  })

  it('a page run without context sends only what is missing', () => {
    const blocks = page()

    blocks[0]!.translation = 'Hi there'

    const { sent, one } = askShape(planPage(blocks, 'en'), false)

    expect(ids(sent)).toEqual(['b'])
    expect(one).toBe(-1)
  })

  /**
   * The context switch governs whether *already-translated* lines ride along
   * on a page run. It must not strip the page from around a single-block ask:
   * `怎...` sent alone comes back as a standalone "what?", not as the opening
   * of the line it breaks off from — which is the exact failure the
   * single-block button exists to fix.
   */
  it('an ask by name always travels with its page, whatever the switch says', () => {
    const blocks = page()

    blocks[1]!.translation = 'Why...'

    for (const context of [true, false]) {
      const { sent, one } = askShape(planPage(blocks, 'en', { only: 'b' }), context)

      expect(ids(sent)).toEqual(['a', 'b'])
      expect(one).toBe(1)
    }
  })

  it('an ask on a page with nothing else worth sending goes alone, as itself', () => {
    const blocks = [block({ id: 'a', source: 'こんにちは' })]

    const { sent, one } = askShape(planPage(blocks, 'en', { only: 'a' }), false)

    expect(ids(sent)).toEqual(['a'])
    // The model is asked for the page's one line, so there is no "only".
    expect(one).toBe(-1)
  })
})
