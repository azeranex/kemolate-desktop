import { mockNuxtImport, registerEndpoint } from '@nuxt/test-utils/runtime'
import { readBody } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick } from 'vue'

import { useComic } from '~/composables/useComic'
import { agreedTranslation, forgetAgreedTranslations, translationEntry, useTranslationSync } from '~/composables/useTranslationSync'

/**
 * A lettering frame is saved at the page's real shape, or not at all.
 *
 * The report: a balloon's lettering sometimes sat higher or lower after a
 * reload than where it had been left. A frame is held in page percentages and
 * stored normalised by the page's width, and the conversion needs the page's
 * height. With the size not known yet — a page turned to before it had been
 * measured, for a moment — it fell back to the usual 2:3 page, so every frame
 * looked changed and a save was scheduled at the wrong height. The size then
 * landed and the frames matched the server again, but the save already waiting
 * was never called off, and it went.
 *
 * Seam: what `useTranslationSync` asks the server to write as the page's size
 * comes and goes, answered by `registerEndpoint`. Real timers: the settle is
 * 500 ms and the test waits it out.
 */

const { shared, target } = await vi.hoisted(async () => {
  const { ref } = await import('vue')

  return { shared: ref<unknown>(null), target: ref('en') }
})

mockNuxtImport('useRoute', () => () => ({ params: { workspaceId: 'ws' }, fullPath: '/w/ws' }))
mockNuxtImport('useShared', () => () => ({ shared, pageRowOf: () => 7 }))
mockNuxtImport('useTargetLanguage', () => () => ({ target }))

const puts: { entries: { cy: number | null }[] }[] = []

registerEndpoint('/api/workspaces/ws/pages/7/translations', {
  method: 'PUT',
  handler: async (event) => {
    const body = await readBody<{ entries: { cy: number | null }[] }>(event)

    puts.push(body)

    return []
  },
})

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** A 1000 × 2000 page with one translated balloon whose frame is a tenth of it down. */
const SIZE = { width: 1000, height: 2000 }

describe('saving a lettering frame', () => {
  let scope = effectScope()

  beforeEach(() => {
    scope = effectScope()
    puts.length = 0
    forgetAgreedTranslations()
    shared.value = { role: 'editor', pages: [{ id: 7 }] }

    const comic = useComic()

    comic.reset()
    comic.pages.value = [{
      id: 'scan:1.png',
      name: '1.png',
      blocks: [{
        id: 'block:40',
        type: 'bubble',
        x: 10,
        y: 10,
        w: 20,
        h: 10,
        source: 'x',
        translation: 'Hello',
        confidence: 100,
        hidden: false,
        letter: { x: 10, y: 10, w: 20, h: 10 },
      }],
      scan: { url: 'blob:x', file: new File([], '1.png'), ...SIZE, hash: 'h' },
    }] as unknown as ComicPage[]
    comic.go(0)

    // As a restore leaves it: the server has this frame, at the real size.
    agreedTranslation('en', translationEntry(comic.pages.value[0]!.blocks[0]!, 40, SIZE))
  })

  afterEach(() => {
    scope.stop()
    shared.value = null
  })

  it('sends nothing when the page is unmeasured for a moment and then measured again', async () => {
    const comic = useComic()

    scope.run(() => useTranslationSync())
    await wait(20)

    const scan = comic.pages.value[0]!.scan!

    scan.width = 0
    scan.height = 0
    await nextTick()
    await wait(50)

    scan.width = SIZE.width
    scan.height = SIZE.height
    await nextTick()
    await wait(700)

    expect(puts).toEqual([])
  })

  it('still saves a frame that really moved, at the real height', async () => {
    const comic = useComic()

    scope.run(() => useTranslationSync())
    await wait(20)

    comic.pages.value[0]!.blocks[0]!.letter = { x: 10, y: 20, w: 20, h: 10 }
    await nextTick()
    await wait(700)

    expect(puts).toHaveLength(1)
    // (20 + 10 / 2) % of a 2000 px page, over its 1000 px width.
    expect(puts[0]!.entries[0]!.cy).toBeCloseTo(0.5)
  })
})
