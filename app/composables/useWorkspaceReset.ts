/**
 * Walking into a workspace the state on screen is not about.
 *
 * Everything the editor holds is `useState` under a flat name — `comic-pages`,
 * `comic-title`, `comic-layers`, `comic-selection`, `library-kind`. That is
 * right, and none of it is keyed by workspace on purpose: there is one canvas,
 * and a key per workspace would only be a slower way of holding one thing. What
 * it means is that none of it goes away on its own, because nothing about a
 * change of address touches state that was never scoped to an address.
 *
 * The page component *is* scoped to one — `definePageMeta({ key })` on
 * `w/[workspaceId].vue` re-creates it at every address, which is why its setup
 * runs again and its watchers are rebuilt. The state it reads is the same state.
 * So `/w/A` followed by `/w/B` drew A's chapter under B's name until something
 * happened to overwrite it, and for a workspace with nothing in it nothing ever
 * did: `useLibrary.restore` finds no chapter kept under B, lowers `open`, and
 * returns — leaving the pages, the title, the layer stack and the selection
 * exactly where A left them. Everything but the scans, which the canvas hides
 * behind `open` and which is why it was reported as "the old workspace's data,
 * except no image".
 *
 * ## It was not only a wrong screen
 *
 * The workspace page pushes the open chapter at the workspace in the address,
 * and `useShared.syncPages` takes the browser's word for what a workspace with
 * no pages of its own contains — that is how the first person to open a chapter
 * founds it. Arriving in a brand-new workspace still holding the last one's
 * pages therefore founded it on them: A's page rows written under B, A's name
 * copied onto B by `christen`, A's layer stack sent by `useLayerSync.pull`. The
 * leak wrote itself into the database within a second of the address changing.
 *
 * ## One place
 *
 * A reset per composable that leaks would be nine of them, and the interesting
 * part of this is the list rather than any one entry — a list spread over nine
 * files is a list with a tenth entry nobody notices is missing. So the decision
 * is made once, here, and each composable that owns something contributes the
 * one function that lets go of it: `useComic.reset`, `forgetAgreed`,
 * `forgetAgreedTranslations`.
 *
 * ## What is deliberately left
 *
 * - **Anything filed under a scan's hash** — `useBlockCache`, `usePaintCache`,
 *   `useClean`, `useThumbs`. Those are content-addressed rather than
 *   workspace-addressed, and finding a reading again when the same chapter is
 *   opened somewhere else is the behaviour they were built for.
 * - **Preferences** — the tool that is out, the dock layout, the brush, the
 *   translate settings. They are the reader's, not the chapter's.
 * - **`useUndo`'s stacks and `useTargetLanguage`'s answer**, both of which
 *   already settle this for themselves — one is keyed by workspace, the other
 *   re-reads on entry and says in its own comment why.
 */

export function useWorkspaceReset () {
  const route = useRoute()

  /*
   * Every composable asked for here rather than inside `reset`, and it is not
   * tidiness. `useComic` registers a watcher of its own when it is called, and
   * a watcher callback runs with no effect scope active — so reaching for it
   * from inside one would create a watcher nothing owns and nothing disposes,
   * one more of them for every workspace anybody walked into. Asked for during
   * setup, they belong to the page and go when it does.
   */
  const { reset: shut } = useComic()
  const { shared } = useShared()
  const { restoring } = useLibrary()
  const { error } = useOcr()
  const rows = useLayerRows()
  const claims = useLayerClaims()

  const workspace = computed(() => String(route.params.workspaceId ?? ''))

  /**
   * Which workspace the state on screen is about.
   *
   * Compared rather than assumed, so that *arriving* is not mistaken for
   * *changing*: reloading `/w/A`, moving a query string, or a second caller
   * asking must not throw away the chapter already open at this address. It is
   * `useState` for the reason the reset exists at all — it has to survive the
   * page component being re-created, which is the only thing that does not.
   */
  const holding = useState<string | null>('workspace-holding', () => null)

  function reset () {
    shut()

    /*
     * What the server said about the last workspace is not an answer about this
     * one. `useShared.look` blanks it too, on mount — this is earlier, and the
     * earliness is the point: the page's own `shared` watcher fires on the
     * emptied page list, and with A's standing still in hand under B's address
     * it would reach `syncPages` before anybody had asked the server anything.
     */
    shared.value = null

    // The stack has just gone back to the default, so the note of which server
    // row each of its rows was filed under names layers that no longer exist —
    // in a workspace that is no longer open. A stroke filed against one of them
    // would land on another chapter's plate.
    rows.value = {}

    // And any page still claiming its stack outranks the workspace's. A claim
    // is spent on the first pull that honours it, so one survives here only if
    // the reader imported a project and walked out before turning to the page —
    // at which point the claim names a page id in a chapter that is no longer
    // open, and honouring it would write the stack now on screen over another
    // workspace's rows. See `useLayerClaims`.
    claims.value = []

    // A reading that failed in the last chapter is not news about this one.
    error.value = null

    forgetAgreed()
    forgetAgreedTranslations()

    // We do not yet know what is open here, which is exactly what this flag
    // means; `useLibrary.restore` lowers it on mount once it has been and
    // looked. Without it the canvas draws "No comic open" for a frame on the
    // way into a workspace that has a chapter waiting in storage — the flash
    // that flag was introduced to prevent, arriving by a different route.
    restoring.value = true
  }

  watch(workspace, (now) => {
    /*
     * No workspace in the address is not a different workspace — it is the way
     * out, to the collection or to settings. Left alone, so that stepping out
     * and back is instant and does not cost a chapter its re-read; nothing on
     * those pages draws any of this, so there is nothing stale to see.
     *
     * The first workspace of a session has nothing to leave behind either. That
     * also keeps this off the server, where the state is one request old and
     * there is no object URL to revoke in the first place.
     */
    if (!now || holding.value === now) return

    if (holding.value !== null) reset()

    holding.value = now
  }, { immediate: true })
}
