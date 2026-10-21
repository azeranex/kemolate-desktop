/**
 * The workspaces on this machine, and which one to go back to.
 *
 * A workspace is a chapter being worked on: the pages, and in time the blocks,
 * the translations and the people looking at them. It has an id of its own and
 * lives at its own address, which is what makes the second and third of those
 * possible later — a thing without a name cannot be shared, and everything a
 * peer would need to join has to hang off something that is the same for both
 * of them.
 *
 * The id is random rather than a number in a sequence. A workspace's address is
 * the only thing standing between it and anyone who guesses it, so the address
 * has to be unguessable — that is a decision worth making now, while nothing is
 * shared yet, rather than after the first link goes out.
 *
 * This is only the index: what exists, what each is called, when it was last
 * looked at. What is *in* a workspace is `useLibrary`'s business, kept under
 * the same id.
 */
import { WORKSPACE_OWNED } from '~/utils/idbKeys'
import { sweepPreviews } from '~/utils/raster/previews'

export interface Workspace {
  id: string
  /** What the chapter in it is called, for anything listing them. */
  title: string
  /** When it was last opened, in milliseconds, so `/` knows where to go back to. */
  opened: number
  /**
   * The scan hash of its first page, so the list can show what it looks like.
   *
   * A hash rather than a picture: the thumbnail itself is already in OPFS under
   * this name — see `utils/thumbs.ts` — and a second copy in the index would be
   * a second thing to keep in step. It is also why this can be absent, and
   * absent for a while: a page is identified after it is drawn, so a chapter
   * opened a moment ago has no cover yet and the list falls back to an icon.
   */
  cover?: string
  /**
   * Whether this browser last saw it as a cloud workspace.
   *
   * The index is this browser's, and until this it recorded nothing about
   * where a workspace lived — so signed out, when the server's list is not
   * there to say otherwise, every chapter this browser had opened was listed
   * as "Local", cloud ones included. Deleting one then did what deleting a
   * local workspace does: it wiped this browser's copy of the pages, which for
   * a cloud workspace is the only copy of the pictures on this machine, while
   * the workspace itself went on existing in the account. Signing back in found
   * the chapter with no pages to show.
   *
   * Set whenever a workspace is seen with a server record — opening it, or the
   * collection page's signed-in list — and cleared only by moving it back to
   * local. Never cleared for want of an answer: signed out, the server says
   * nothing either way, and nothing is not "local".
   */
  cloud?: boolean
  /**
   * Desktop: the name the reader gave it, where they gave one.
   *
   * `title` is rewritten from the chapter every time it is opened (`note`, from
   * `useLibrary.remember`) — the folder's own name, or "6 pages" for loose files
   * — and in the web build a renamed *local* workspace went back to that on the
   * next load; only a cloud one kept its name, because the server's wins. Every
   * workspace here is local, so a rename lasted one session. Kept apart from
   * `title` so `note` can go on refreshing what the chapter calls itself while
   * the reader's word stands; `title` carries it too, so the list shows it.
   */
  named?: string
}

const INDEX = 'workspaces'

export function useWorkspaces () {
  async function all (): Promise<Workspace[]> {
    return await idb.get<Workspace[]>(INDEX).catch(() => null) ?? []
  }

  /** Where somebody arriving at the front door should be sent. */
  async function latest () {
    const [newest] = (await all()).sort((a, b) => b.opened - a.opened)

    return newest?.id ?? null
  }

  /**
   * A fresh one. Not written down here — an id nobody has opened anything in is
   * an empty room, and the index is for rooms with something in them.
   */
  function create () {
    return crypto.randomUUID()
  }

  /** Record that a workspace exists and has just been used. */
  async function note (id: string, title: string) {
    const held = (await all()).find((workspace) => workspace.id === id)
    const list = (await all()).filter((workspace) => workspace.id !== id)

    // The cover is carried over rather than cleared: this is called on every
    // open, and the hash it would need is not known for a second or two yet.
    // Dropping it here would blank every cover on every visit.
    // Desktop: a name the reader gave wins over what the chapter calls itself —
    // see `Workspace.named`.
    await idb.set(INDEX, [...list, { id, title: held?.named ?? title, opened: Date.now(), cover: held?.cover, cloud: held?.cloud, named: held?.named }]).catch(() => {
      // An index that cannot be written costs the user the front door remembering
      // where they were. The workspace itself is kept separately and is fine.
    })
  }

  /**
   * Remember what a workspace looks like, once its first page has an identity.
   *
   * Quiet when the workspace is not in the index — a chapter open in a
   * workspace nobody has noted yet is one `note` is about to write anyway.
   */
  async function cover (id: string, hash: string) {
    const list = await all()
    const held = list.find((workspace) => workspace.id === id)

    if (!held || held.cover === hash) return

    await idb.set(INDEX, list.map((workspace) =>
      (workspace.id === id ? { ...workspace, cover: hash } : workspace))).catch(() => {})
  }

  /**
   * A new name for a workspace this browser has a row for.
   *
   * Not `note`, which is the other thing that writes a title and would be wrong
   * here twice over: it stamps `opened` with the current time, so renaming a
   * chapter would reorder the front page and claim you had just opened
   * something you had only renamed — and it *adds* a row where there is none,
   * so renaming a workspace you have never opened on this machine would invent
   * a local record of a chapter that is not here.
   *
   * Quiet when there is no row, exactly like `cover`: the name lives on the
   * server, this is only the copy the front page reads before the server
   * answers, and a workspace with nothing here has nothing to correct.
   */
  /** Record which kind a workspace this browser knows is — see `Workspace.cloud`. */
  async function markKind (id: string, cloud: boolean) {
    const list = await all()
    const held = list.find((workspace) => workspace.id === id)

    if (!held || Boolean(held.cloud) === cloud) return

    await idb.set(INDEX, list.map((workspace) =>
      (workspace.id === id ? { ...workspace, cloud } : workspace))).catch(() => {})
  }

  async function retitle (id: string, title: string) {
    const list = await all()
    const held = list.find((workspace) => workspace.id === id)

    if (!held || (held.title === title && held.named === title)) return

    // Desktop: written down as the reader's own name as well — see
    // `Workspace.named` — or the next open puts the folder's back.
    await idb.set(INDEX, list.map((workspace) =>
      (workspace.id === id ? { ...workspace, title, named: title } : workspace))).catch(() => {})
  }

  /** Desktop: the name the reader gave a workspace, if they gave one — see `Workspace.named`. */
  async function namedOf (id: string): Promise<string | null> {
    return (await all()).find((workspace) => workspace.id === id)?.named ?? null
  }

  async function drop (id: string) {
    const list = (await all()).filter((workspace) => workspace.id !== id)

    await idb.set(INDEX, list).catch(() => {})
  }

  /**
   * Everything this browser holds about a workspace, gone.
   *
   * Four places, which is exactly why it is one function: the chapter's record,
   * the target language beside it, the copied pages in the private filesystem,
   * and the row in the index. Miss the third and a chapter of scans stays on
   * the disk under an id nothing points at any more — invisible, and counting
   * against the origin's storage for ever.
   *
   * Each step is allowed to fail on its own. Storage that will not answer is
   * the ordinary reason to be removing a workspace in the first place, and a
   * removal that stops at the first refusal leaves more behind than one that
   * carries on.
   *
   * A handle is not touched, and cannot be: it points at a folder of the user's
   * own, and forgetting a workspace is not permission to go near their files.
   */
  /**
   * Everything filed under a workspace's own name, which is not everything it
   * has touched.
   *
   * The prefixes are listed rather than swept for, because "workspace-scoped"
   * and "content-addressed" are the two halves this storage divides into and
   * only the first belongs to the workspace. A thumbnail, a repair, a placed
   * image and a page's retouching are filed under the *scan's* hash on purpose
   * — see `useWorkspaceReset`, which sets out why — and deleting a workspace
   * must not take work that belongs to a chapter the reader still has open
   * somewhere else.
   *
   * `blocks:` and `usage:` were missing and are here now: a reading is scoped to
   * the workspace precisely so a second workspace starts empty, and the AI
   * ledger is kept per chapter because "what did this one cost me" is the
   * question. Both outlived the workspace they were about, invisibly, since
   * nothing ever lists them.
   */
  // `WORKSPACE_OWNED`, kept beside the key builders so the two cannot drift —
  // see `utils/idbKeys.ts`, and the `repairs-shown:` records this missed.

  async function purge (id: string) {
    for (const prefix of WORKSPACE_OWNED) {
      // By prefix rather than by name: `blocks:` and `history:` are one key per
      // page and the workspace record has three of its own, and a list of names
      // is a list somebody adds a fourth to without noticing.
      for (const key of await idb.keys(`${prefix}${id}`).catch(() => [])) {
        await idb.del(key).catch(() => {})
      }
    }

    // The page previews only this workspace used — after its record has gone,
    // which is what says they were only its. See `raster/previews.ts`.
    await sweepPreviews().catch(() => {})

    await clear(id).catch(() => {})
    await drop(id)
  }

  return { all, latest, create, note, retitle, namedOf, cover, drop, purge, markKind }
}
