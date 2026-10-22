/**
 * Say which scans the open chapter holds, and which page is on screen, so an
 * agent can be shown them — desktop.
 *
 * In the web build a tab joins its workspace's room and announces the hashes it
 * can serve (`have`), and that is what the MCP server's `holders` reads before
 * it asks anybody for a page. Here the room is the main process's note of the
 * window (`server/utils/swarm.ts`), and this is the announcing: every page of
 * the open chapter with a file and a hash, again whenever that changes — a page
 * hashed, a file linked to an absent page, a book still streaming in — and
 * nothing once the workspace page goes.
 *
 * The page on screen rides along, by its row (`rowOfPage`), which is the
 * desktop's own: it is what lets an agent work on "this chapter" and "this
 * page" without an id (`get_active_workspace`). Null until the page has a row.
 *
 * Called once, from the workspace page, beside `useReadErrands`.
 */
export function useHolding () {
  const { pages, page } = useComic()
  const { shared } = useShared()

  // The workspace open here, taken once: the workspace page is made again for
  // every address, so this only ever belongs to one.
  const open = String(useRoute().params.workspaceId ?? '')

  /** The hashes held, as one string, so a watcher wakes only when they change. */
  const held = computed(() => pages.value
    .map((each) => each.scan?.hash ?? '')
    .filter(Boolean)
    .join('\n'))

  /** The row of the page on screen. */
  const onScreen = computed(() => (page.value ? rowOfPage(shared.value?.pages ?? [], page.value)?.id ?? null : null))

  watch([held, onScreen], () => {
    const files = new Map<string, File>()

    for (const each of pages.value) {
      if (each.scan?.hash) files.set(each.scan.hash, each.scan.file)
    }

    holdScans(open, files, onScreen.value)
  }, { immediate: true })

  onScopeDispose(() => holdScans(null, new Map()))
}
