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
 * ## Local is not a lesser cloud
 *
 * It is worth saying plainly, because the interface has to: a workspace with no
 * server row is not one that failed to sync. It is a chapter somebody is
 * working on without signing in, and everything about it — the reading, the
 * paint, the layer stack — is in this browser and nowhere else. That is the
 * app's own promise kept at its strongest, and it is also the state in which
 * clearing site data loses the work. Both halves are true and the badge is the
 * only place either of them is ever said.
 */

import type { ProjectStroke } from '~/utils/project'

import { localise, localSurface } from '~/composables/useBlockCache'
import { renamePatch, usePatchMap } from '~/composables/useClean'
import { serverGlossaries } from '~/composables/useGlossary'
import { serverStacks } from '~/composables/useLayerSync'

/** A cloud workspace's strokes, page by page — see `paint.everything`. */
interface ServerPaint {
  uid: string
  surfaces: { key: string, strokes: ProjectStroke[] }[]
}

/** Where a workspace's record lives, which is also who can see it. */
export type WorkspaceKeeping = 'local' | 'cloud'

export function useWorkspaceName () {
  const route = useRoute()
  const { title, open, pages, setBlocks } = useComic()
  const { shared, look, syncPages, pageRowOf } = useShared()
  const paint = usePaintCache()
  const patchMap = usePatchMap()
  const { loggedIn } = useUserSession()
  const { target } = useTargetLanguage()

  const workspace = computed(() => String(route.params.workspaceId ?? ''))

  /**
   * Cloud exactly when the server has answered for this workspace.
   *
   * `shared` is what a workspace's own record came back as, so this is not a
   * guess about the network or about being signed in — it is whether there is a
   * row. A signed-in reader who has not claimed a chapter is still local, which
   * is right: nothing about it has left the machine.
   */
  const keeping = computed<WorkspaceKeeping>(() => (shared.value ? 'cloud' : 'local'))

  /**
   * *Why* it is local, which is two different situations wearing one word.
   *
   * Signed out, local is the whole arrangement: there is no account for a
   * record to live in and nothing to be done about it but sign in. Signed in,
   * local means only that this particular chapter has never been put on the
   * server — a workspace made before signing in, or one nobody has shared —
   * and it is one gesture from not being: `useSharing.invite` creates the
   * record on its way past.
   *
   * Telling somebody "local" without telling them which of those they are in
   * leaves the second case looking like a failure, and the first looking like
   * something a button could fix.
   */
  const because = computed<'signed-out' | 'unshared' | null>(() => {
    if (keeping.value === 'cloud') return null

    return loggedIn.value ? 'unshared' : 'signed-out'
  })

  /**
   * What the workspace is called, preferring the chapter that is open.
   *
   * The open chapter's title wins over the stored name because it is the newer
   * statement of the same thing — `christen` pushes one into the other — and
   * because a workspace named before a chapter was dropped into it is named
   * after nothing.
   */
  const name = computed(() => {
    if (open.value && title.value && title.value !== UNTITLED) return title.value

    return shared.value?.workspace.name ?? title.value ?? UNTITLED
  })

  /**
   * A viewer may not rename somebody else's chapter; anybody may rename their
   * own. Asked here rather than left to the server so the control can be absent
   * instead of failing, which is the difference between an interface that says
   * what you may do and one that finds out.
   */
  const renameable = computed(() => keeping.value === 'local' || atLeast(shared.value!.role, 'editor'))

  /**
   * Give it another name, wherever that name has to reach.
   *
   * The open chapter first and unconditionally, because that is the copy on
   * screen and the reader is watching it. Then the local index, which is what
   * the collection page lists. Then the server, only where there is one — and
   * `renameWorkspace` writes the index again on its way through, which is
   * harmless: `retitle` compares before it writes.
   *
   * False only when there was a server to tell and it refused. A local rename
   * cannot fail in a way worth reporting: the name is already on screen.
   */
  async function rename (next: string): Promise<boolean> {
    const wanted = next.trim()

    if (!wanted || wanted === name.value || !renameable.value) return true

    title.value = wanted

    await useWorkspaces().retitle(workspace.value, wanted).catch(() => {})

    if (keeping.value === 'local') return true

    const done = await renameWorkspace(workspace.value, wanted)

    // Kept in step by hand, because the workspace's record is fetched rather
    // than watched — without this the badge and the collection page disagree
    // until something else asks the server.
    if (done && shared.value) {
      shared.value = { ...shared.value, workspace: { ...shared.value.workspace, name: wanted } }
    }

    return done
  }

  /**
   * Put this workspace on the server.
   *
   * Additive and safe, which is why this direction needs no warning and no
   * confirmation — but it is not enough to create the record and leave the rest
   * to the watchers, and it used to be. They keep the page *on screen* in step,
   * so a local chapter moved to the cloud arrived with one page's reading on the
   * server and forty-nine still only in this browser, each going up only when
   * somebody happened to turn to it. Now that a cloud workspace does not read
   * its blocks from this browser's cache, a page nobody visited before closing
   * the tab would have come back empty.
   *
   * So the move carries the chapter with it, in the order the rows depend on
   * each other: the page list, then every page's blocks, then what they say.
   * Layer stacks still go up a page at a time as each is shown — a local one
   * lives only as long as the session anyway, see `useLayerSync`.
   *
   * `createWorkspace` is idempotent, so pressing it twice is not two
   * workspaces; the server hands back the one it already has.
   */
  async function toCloud (): Promise<boolean> {
    if (!workspace.value || keeping.value === 'cloud') return true

    // Read while this is still a local workspace: once `shared` exists, the
    // glossary and cast answer from the server instead.
    const glossaries = await localGlossaries(workspace.value)
    const cast = await localCast(workspace.value)

    const done = await createWorkspace(workspace.value, name.value, target.value)
      .then(() => true)
      .catch((error: unknown) => {
        console.warn('[kemolate] workspace not created on the server:', error)

        return false
      })

    // Read back rather than assumed, because `shared` is what every other part
    // of the app watches to decide it may start syncing — writing it by hand
    // here would be a second opinion about a shape the server owns.
    if (!done) return false

    await look()

    // Each of these is best effort and silent, like the syncs they come from:
    // anything that does not go up now is still in this browser, and still
    // goes up when its page is next on screen.
    await useWorkspaces().markKind(workspace.value, true)
    await syncPages()
    await uploadChapterBlocks()
    await uploadChapterTranslations()

    // And what the chapter has learned: its terms, merged first-translation-
    // wins, and its cast, saved whole — which pins every member, the same
    // conservative choice importing a project makes.
    for (const glossary of glossaries) await sendGlossary(workspace.value, glossary)

    if (cast.members.length || cast.notes) await sendCast(workspace.value, cast.members, cast.notes)

    return true
  }

  /**
   * Take it off the server and keep it here.
   *
   * The record goes, with everything filed against it: the page rows, the
   * blocks, the translations, the layer stacks, the glossary and the cast. So
   * each is written into this browser first — the reading, every stack this
   * session has loaded, and the glossary and cast for the language in hand —
   * and a local workspace keeps them from there. What cannot come down is a
   * stack for a page nobody turned to this session (the server hands stacks out
   * a page at a time), and the glossaries of other languages.
   *
   * Refused while anybody else is a contributor, and that refusal lives in the
   * interface rather than here — see `WorkspaceSettings`. A switch sitting
   * beside a rename box is surrounded by harmless controls, which is exactly
   * when a destructive one gets pressed by momentum; making it unavailable
   * until the workspace is yours alone is cheaper than making it undoable,
   * which it cannot be.
   */
  /**
   * Take a cloud workspace back into this browser, and off the server.
   *
   * The server's record is deleted at the end, so everything it holds that a
   * local workspace keeps has to be here first — and it used to be only what
   * this session had happened to load: the stacks of the pages somebody had
   * turned to (every other page wrote down the default it opened with), the
   * glossary in the language being worked in, and no retouching or mask
   * corrections at all, which on a cloud workspace are strokes on the server.
   * Now all of it is read first, and the move stops — nothing written, nothing
   * deleted — if any of it does not arrive.
   *
   * The blocks lose their row names on the way (`localise`, `block:41` to
   * `read:r41`), and a mask correction is filed under its block's name, so the
   * corrections are carried to the new names, and so is the cleaning on
   * screen. That renaming waits for the record to be gone: done while it still
   * existed, `useBlockSync` would read every renamed block as new and every old
   * one as deleted.
   */
  async function toLocal (): Promise<boolean> {
    if (!workspace.value || keeping.value === 'local') return true

    const here = workspace.value

    const [stacks, glossaries, cast, painted] = await Promise.all([
      serverStacks(here, pages.value, pageRowOf),
      serverGlossaries(here),
      serverCast(here),
      $fetch<ServerPaint[]>(`/api/workspaces/${here}/surfaces`).catch(() => null),
    ])

    if (!stacks || !glossaries || !cast || !painted) {
      console.warn('[kemolate] not moved to this browser: the workspace could not be read in full.')

      return false
    }

    // The reading into this browser before the only other copy goes. A cloud
    // workspace records nothing here as it goes — see `useBlockCache` — so
    // without this the chapter would come back as bare scans on the next
    // reload, with everything on it deleted from the server a moment ago.
    await keepChapterLocally()

    // Every page's stack as the server has it, not just the ones looked at.
    for (const page of pages.value) {
      const held = stacks.get(page.id)

      if (held) page.stack = held
    }

    await keepLayersLocally()

    for (const glossary of glossaries) await keepGlossaryLocally(here, glossary)

    if (cast.members.length || cast.notes) await keepCastLocally(here, cast.members, cast.notes)

    // The retouching and the mask corrections, into this browser's stroke logs.
    // A correction is filed under its block's row (`mask-41`) on the server and
    // under the block's name here, which after this move is `read:r41`.
    for (const answered of painted) {
      const page = pages.value.find((candidate) => candidate.uid === answered.uid)
      const hash = page?.scan?.hash

      // A page whose picture is not on this machine has no key to file under.
      if (!hash) continue

      for (const surface of answered.surfaces) {
        const key = localSurface(surface.key)
        const held = new Set((await paint.load(`${hash}:${key}`)).map((row) => `${row.clientId}:${row.seq}`))
        const laid = surface.strokes
          .filter((row) => !held.has(`${row.clientId}:${row.seq}`))
          .map((row) => ({ ...row, retracted: false }))

        await paint.seed(hash, key, laid)
      }
    }

    const done = await $fetch(`/api/workspaces/${here}`, {
      method: 'DELETE',
      headers: peerHeader(here),
    }).then(() => true).catch((error: unknown) => {
      console.warn('[kemolate] workspace not removed from the server:', error)

      return false
    })

    // Cleared outright rather than re-read: the record is gone, so asking for
    // it again is a 404 that every watcher would have to be taught to read as
    // "local" — and `shared` being null already means exactly that.
    if (done) {
      shared.value = null
      await useWorkspaces().markKind(here, false)

      // The names the blocks have on disk now, on the page as well — and the
      // cleaning on screen carried across, since a repair is held by block.
      for (const page of pages.value) {
        const renamed = new Map<string, string>()
        const blocks = localise(page.blocks, renamed)

        if (!renamed.size) continue

        setBlocks(page.id, blocks)

        for (const [from, to] of renamed) patchMap.value = renamePatch(patchMap.value, page.id, from, to)
      }
    }

    return done
  }

  return { name, keeping, because, renameable, rename, toCloud, toLocal }
}
