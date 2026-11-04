/**
 * The window's tabs, as this tab's page sees them — desktop. The tabs are the
 * main process's (`electron/tabs.ts`); this is the list it last said, for the
 * strip to draw (`TabStrip`), and the asks a page can make of it.
 *
 * One list for the page, heard once: every title bar in the page draws from it.
 * Outside Electron — a plain browser, the tests — there are no tabs, and
 * `tabbed` says so.
 */
import type { TabsState } from '../../electron/preload'

const state = ref<TabsState>({ tabs: [], active: null })

let heard = false

export function useTabs () {
  const bridge = typeof window === 'undefined' ? undefined : window.kemolate?.tabs

  if (bridge && !heard) {
    heard = true
    bridge.state().then((given) => { state.value = given }).catch(() => {})
    bridge.onChanged((given) => { state.value = given })
  }

  /** Whether this page is in a tab at all. */
  const tabbed = Boolean(bridge)

  /** Whether there is more than one, which is when the strip is drawn. */
  const many = computed(() => state.value.tabs.length > 1)

  return {
    state,
    tabbed,
    many,
    open: () => { bridge?.open().catch(() => {}) },
    select: (id: number) => { bridge?.select(id).catch(() => {}) },
    close: (id: number) => { bridge?.close(id).catch(() => {}) },
    /** The tab's right-click menu, which the main process draws (`Tabs.menu`). */
    menu: (id: number, at: MouseEvent) => { bridge?.menu(id, at.clientX, at.clientY).catch(() => {}) },
  }
}
