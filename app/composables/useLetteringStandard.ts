/**
 * The chapter's standard lettering size — the one size every ordinary line of
 * dialogue is set at, which is how a professionally lettered book looks.
 *
 * Fitting each balloon to the largest size it would hold gave one page three
 * lines at 64, 82 and 86 pixels, which a reader sees as three different voices
 * and a letterer sees as the unmistakable mark of a machine. With a standard,
 * a line is set at it, squeezed a little where a balloon is tight, and flagged
 * where it will not go — see `fitStandard`. Null keeps the old behaviour, which
 * is still the right one for a rough first pass.
 *
 * Desktop: kept in the workspace's record (`workspaces.lettering_standard`),
 * the gap the web build's note named — "one nullable column and one route" —
 * closed, so an agent can read and set it (`set_lettering_standard`) and an
 * export is set at the chapter's standard rather than the window's. The
 * window's IndexedDB still holds a copy: it is the answer for a workspace not
 * moved into the database yet, and the first answer while the record is on its
 * way. A standard kept only there, from before the column, is carried up the
 * first time the record arrives without one (`moved` says it has been).
 *
 * Scan pixels, like every lettering size — see `shared/utils/lettering`.
 */
import type { SharedState } from '~/composables/useShared'

import { idbKey } from '~/utils/idbKeys'

/** What the window keeps: the size, and whether the database has been given it. */
interface Kept { size: number | null, moved?: boolean }

/** Which workspace the state was last read for, so a walk into another reads its own. */
let readFor: string | null = null

/** What the window had kept for `readFor`, once read. */
let kept: Kept | null = null

/** The database half is wired once for the app, not once per component that asks. */
let wired = false

const valid = (size: unknown): number | null =>
  typeof size === 'number' && Number.isFinite(size) && size > 0 ? Math.round(size) : null

export function useLetteringStandard () {
  const route = useRoute()

  const workspace = computed(() => String(route.params.workspaceId ?? ''))

  const standard = useState<number | null>('lettering-standard', () => null)

  /** Whether this workspace's standard has been read back yet — fitting waits for it. */
  const known = useState('lettering-standard-known', () => false)

  /** The workspace's record, where it is in the database — `useShared` fetches it. */
  const shared = useState<SharedState | null>('workspace-shared', () => null)

  async function restore () {
    const id = workspace.value

    if (!import.meta.client || !id || readFor === id) return

    readFor = id
    kept = null
    known.value = false

    const held = await idb.get<Kept>(idbKey.lettering(id)).catch(() => null)

    // Walked on while this was reading — the newer workspace's answer is the one to keep.
    if (readFor !== id) return

    kept = { size: valid(held?.size), moved: Boolean(held?.moved) }

    // The record may have landed first; it outranks this copy.
    if (!adopt()) standard.value = kept.size

    known.value = true
  }

  /** The record of the open workspace, where it has a say. */
  function record () {
    const found = shared.value?.workspace

    return found && found.publicId === workspace.value && found.letteringStandard !== undefined ? found : null
  }

  /**
   * Take the database's answer, or give it the window's where it has never had
   * one. False where there is no record to take an answer from, or the window's
   * copy has not been read yet.
   */
  function adopt (): boolean {
    const found = record()

    if (!found || !kept || readFor !== workspace.value) return false

    const stored = valid(found.letteringStandard)

    if (stored === null && !kept.moved && kept.size !== null) {
      // From before the column: carried up once, then the record's from here on.
      publish(kept.size).catch(() => {})

      return true
    }

    standard.value = stored

    if (!kept.moved || kept.size !== stored) {
      kept = { size: stored, moved: true }
      idb.set(idbKey.lettering(workspace.value), kept).catch(() => {})
    }

    return true
  }

  /** Write the standard into the workspace's record, and keep the window's copy beside it. */
  async function publish (size: number | null) {
    const id = workspace.value

    standard.value = size
    kept = { size, moved: Boolean(record()) }

    await idb.set(idbKey.lettering(id), kept).catch(() => {})

    if (!record()) return

    try {
      await $fetch(`/api/workspaces/${id}`, { method: 'PATCH', body: { letteringStandard: size } })

      if (shared.value && shared.value.workspace.publicId === id) {
        shared.value = { ...shared.value, workspace: { ...shared.value.workspace, letteringStandard: size } }
      }
    } catch {
      // Kept in this window; the next change tries the record again.
      kept = { size, moved: false }
      await idb.set(idbKey.lettering(id), kept).catch(() => {})
    }
  }

  async function set (size: number | null) {
    await publish(valid(size))
  }

  if (import.meta.client && !wired) {
    wired = true

    // Detached: this outlives whichever component happened to ask first.
    effectScope(true).run(() => {
      watch(() => record()?.letteringStandard, () => { adopt() })

      // An agent set it (`set_lettering_standard`): read the record's answer back.
      onSwarmChange((room, change) => {
        if (change.scope !== 'workspace' || room !== workspace.value) return

        $fetch<SharedState>(`/api/workspaces/${room}`).then((fresh) => {
          const current = shared.value

          if (!current || current.workspace.publicId !== room) return

          shared.value = {
            ...current,
            workspace: { ...current.workspace, letteringStandard: fresh.workspace.letteringStandard ?? null },
          }
        }).catch(() => {})
      })
    })
  }

  if (import.meta.client) restore()

  return { standard, known, restore, set }
}
