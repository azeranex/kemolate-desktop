import { mountSuspended } from '@nuxt/test-utils/runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

import PanelDetect from '~/components/panel/Detect.vue'
import { useOcr } from '~/composables/useOcr'

/**
 * A model download draws the Detect panel ten times a second, not once a chunk.
 *
 * The engines report progress on every chunk read off the network, and the
 * panel is one template: every report drew all of it again — both selects, the
 * switch, the buttons — to move a bar by a fraction of a percent. On the test
 * chapter that was 400 renders of the whole panel for a 400-chunk download.
 *
 * Seam: the panel as the dock mounts it, and `useOcr`'s progress written the
 * way a reading writes it, once a chunk, with the clock in the test's hands.
 * Renders are counted on whatever draws the panel's contents, which is the
 * field group they are slotted into.
 */

/** A report of the kind a download sends once a chunk. */
const chunk = (share: number) => ({
  page: 1,
  pages: 1,
  found: 0,
  message: `Fetching model.onnx — ${Math.round(share)}%`,
  step: { done: share, total: 100 },
})

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

describe('the Detect panel, during a download', () => {
  afterEach(() => {
    vi.useRealTimers()
    useOcr().progress.value = null
  })

  it('draws the progress ten times a second, however fast the chunks arrive', async () => {
    // The tip wants the layout's tooltip provider, and is nothing to do with this.
    const wrapper = await mountSuspended(PanelDetect, { global: { stubs: { InfoTip: true } } })
    const { progress } = useOcr()

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })

    // A run starting is drawn at once.
    progress.value = { page: 1, pages: 1, message: 'Starting…', found: 0 }
    await nextTick()

    const line = wrapper.findAll('p').find((p) => p.text() === 'Starting…')

    expect(line).toBeDefined()

    const tally = counted((line!.element as unknown as { __vueParentComponent: never }).__vueParentComponent)

    // Fifty chunks, each in a tick of its own, as a fast disk delivers them.
    for (let at = 1; at <= 50; at++) {
      progress.value = chunk(at * 2)
      await nextTick()
    }

    expect(tally.renders).toBe(0)

    // The interval up, the latest report is drawn — once.
    vi.advanceTimersByTime(100)
    await nextTick()

    expect(tally.renders).toBe(1)
    expect(wrapper.text()).toContain('Fetching model.onnx — 100%')

    // And a run that stops is gone at once, not an interval later.
    progress.value = null
    await nextTick()

    expect(wrapper.text()).not.toContain('Fetching model.onnx')
  })
})
