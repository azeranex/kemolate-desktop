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
 * Kept in this browser under the workspace, like the target language before the
 * server had a column for it (`idbKey.target`). That is a stated gap rather
 * than a choice: two people lettering the same cloud chapter can hold different
 * standards, and an export is set at the standard of whoever made it. Moving it
 * to the workspace record is one nullable column and one route.
 *
 * Scan pixels, like every lettering size — see `shared/utils/lettering`.
 */
import { idbKey } from '~/utils/idbKeys'

/** Which workspace the state was last read for, so a walk into another reads its own. */
let readFor: string | null = null

export function useLetteringStandard () {
  const route = useRoute()

  const workspace = computed(() => String(route.params.workspaceId ?? ''))

  const standard = useState<number | null>('lettering-standard', () => null)

  /** Whether this workspace's standard has been read back yet — fitting waits for it. */
  const known = useState('lettering-standard-known', () => false)

  async function restore () {
    const id = workspace.value

    if (!import.meta.client || !id || readFor === id) return

    readFor = id
    known.value = false

    const kept = await idb.get<{ size: number | null }>(idbKey.lettering(id)).catch(() => null)

    // Walked on while this was reading — the newer workspace's answer is the one to keep.
    if (readFor !== id) return

    standard.value = typeof kept?.size === 'number' && kept.size > 0 ? kept.size : null
    known.value = true
  }

  async function set (size: number | null) {
    const id = workspace.value
    const next = size !== null && Number.isFinite(size) && size > 0 ? Math.round(size) : null

    standard.value = next

    if (id) await idb.set(idbKey.lettering(id), { size: next }).catch(() => {})
  }

  if (import.meta.client) restore()

  return { standard, known, restore, set }
}
