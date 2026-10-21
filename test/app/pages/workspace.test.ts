import { mountSuspended } from '@nuxt/test-utils/runtime'
import { describe, expect, it } from 'vitest'
import { nextTick } from 'vue'

import { useComic } from '~/composables/useComic'
import { useLibrary } from '~/composables/useLibrary'
import WorkspacePage from '~/pages/w/[workspaceId].vue'

/**
 * A frame of a zoom redraws the zoom, and not the column around it.
 *
 * The status bar is a slot of the workspace layout, and a slot is drawn by the
 * component that renders it — here, the splitter panel the canvas column sits
 * in. The zoom's percentage was read in that slot, so every frame of a zoom
 * drew the whole column again: the context bar, the drop zone around the
 * canvas, and the status bar's buttons. Measured on the test chapter, ten frames
 * of a zoom drew the column ten times, its three buttons thirty and the drop
 * zone ten. See `WorkspaceZoom`.
 *
 * Seam: the workspace page as the router mounts it, in its own layout, with
 * the canvas and the docks stubbed — each draws a world of its own and none of
 * them is what this is about. Renders are counted on whatever draws the status
 * bar, found by the words it always shows.
 */

/** Counts the renders of a mounted component from outside it. */
function counted (instance: { render?: (...args: unknown[]) => unknown }) {
  const render = instance.render!
  const tally = { renders: 0 }

  instance.render = function (this: unknown, ...args: unknown[]) {
    tally.renders++

    return render.apply(this, args)
  }

  return tally
}

const stubs = {
  CanvasDrop: true,
  CanvasSwarm: true,
  Dock: true,
  ToolRail: true,
}

describe('the workspace page, zooming', () => {
  it('redraws the percentage on every frame, and nothing else in the column', async () => {
    // happy-dom loads no fonts, and the page waits on them before it shows the
    // board.
    Object.defineProperty(document, 'fonts', { configurable: true, value: { ready: Promise.resolve() } })

    const wrapper = await mountSuspended(WorkspacePage, { route: '/w/zoom-test', global: { stubs } })

    // Whatever the page makes of its own storage on the way in, then a chapter
    // open in it — the status bar only says anything about one.
    for (let wait = 0; wait < 5; wait++) await new Promise((resolve) => setTimeout(resolve, 0))

    const comic = useComic()

    comic.pages.value = [{ id: 'scan:1.png', name: '1.png', blocks: [], size: { width: 1000, height: 1500 } }] as unknown as ComicPage[]
    comic.at.value = 0
    comic.open.value = true
    useLibrary().restoring.value = false
    comic.zoom.value = 1
    await nextTick()

    const quiet = wrapper.findAll('span').find((span) => span.text() === 'Nothing selected')

    expect(quiet).toBeDefined()

    const tally = counted((quiet!.element as unknown as { __vueParentComponent: never }).__vueParentComponent)

    for (let step = 1; step <= 10; step++) {
      comic.zoom.value = 1 + step / 4
      await nextTick()
    }

    expect(tally.renders).toBe(0)
    expect(wrapper.text()).toContain('350%')
  })
})
