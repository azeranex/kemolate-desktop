/**
 * What this workspace is called, and where it is kept.
 *
 * Two questions that belong together because the answer to the second changes
 * who the first has to be told. A workspace the server knows about has a row
 * with a name on it and people who may be looking at that name; one that exists
 * only in this browser has an entry in the local index and nobody else to tell.
 * Renaming has to do the right thing in both cases without the caller deciding
 * which case it is in.
 *
 * ## Desktop: a partial port
 *
 * Every workspace here is local, so the second question has one answer and the
 * first has one road. What comes across is the web build's local half, as
 * written: `name` (the open chapter's title first), `keeping` (always `local`),
 * `renameable` and `rename` — the chapter's title, then the local index the
 * workspace list reads. Left out are the server's half of `rename` and the two
 * moves, `toCloud` and `toLocal`, which carry a chapter up to the server and
 * back; with no server they have nowhere to go, and nothing here offers them.
 */

/** Where a workspace's record lives — here, always this machine. */
export type WorkspaceKeeping = 'local' | 'cloud'

export function useWorkspaceName () {
  const route = useRoute()
  const { title, open } = useComic()

  const workspace = computed(() => String(route.params.workspaceId ?? ''))

  const keeping = computed<WorkspaceKeeping>(() => 'local')

  /**
   * What the workspace is called, preferring the chapter that is open — the
   * newer statement of the same thing, and a workspace named before a chapter
   * was dropped into it is named after nothing.
   */
  const name = computed(() => (open.value && title.value && title.value !== UNTITLED ? title.value : title.value ?? UNTITLED))

  /** A local workspace is its reader's to rename. */
  const renameable = computed(() => true)

  /**
   * Give it another name: the open chapter first, because that is the copy on
   * screen, then the local index the workspace list reads. Cannot fail in a way
   * worth reporting — the name is already on screen.
   */
  async function rename (next: string): Promise<boolean> {
    const wanted = next.trim()

    if (!wanted || wanted === name.value) return true

    title.value = wanted

    await useWorkspaces().retitle(workspace.value, wanted).catch(() => {})

    return true
  }

  return { name, keeping, renameable, rename }
}
