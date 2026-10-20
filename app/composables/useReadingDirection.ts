/**
 * Which way round this chapter reads.
 *
 * `useTargetLanguage`'s twin in every respect — read its header for the
 * argument, which applies here word for word: local first, because a workspace
 * is made offline and most are never shared; the server's answer wins when
 * there is one, because two people reading the same chapter in two directions
 * is not a difference of preference but a chapter being worked on two ways at
 * once, and neither of them can see it happening.
 *
 * ## It is not a preference, and that is why it lives here
 *
 * A reader who prefers left-to-right does not thereby make a manga read that
 * way. Which end a page starts at is a fact about the *book* — settled by
 * whoever opened it and true for everybody afterwards — so it belongs beside
 * the target language on the workspace, not beside the model and the effort in
 * `translate`, which are the things that genuinely are one person's way of
 * working.
 *
 * ## What it actually changes
 *
 * The order the blocks on a page are in, which is a much bigger claim than it
 * sounds. `pagePrompt` numbers them and tells the model they are "in reading
 * order", so on a Japanese page sorted left-to-right the model is handed the
 * conversation backwards and answers a reply before the line it replies to.
 * Sorting is also what a merge relies on to join a split balloon's columns the
 * right way round — see `useBlockMerge`.
 *
 * The column has existed since the schema was written (`workspaces.direction`,
 * default `rtl`) and `readingOrder` has always taken a direction. What was
 * missing was any way to say it: the Blocks panel stood in with a hidden
 * Shift-click for "the other way", which nobody would find and which lasted
 * exactly as long as the press.
 */
import { idbKey } from '~/utils/idbKeys'

/** Manga is the common case here, so right-to-left is the default. */
const FALLBACK: 'ltr' | 'rtl' = 'rtl'

// Manhwa is named under left-to-right on purpose: Korean sets horizontally and
// reads the Western way round, and an earlier draft of these notes filed it
// under right-to-left — steering exactly the readers it named into feeding the
// model the conversation backwards, the failure this setting exists to prevent.
export const DIRECTIONS = [
  { value: 'rtl' as const, label: 'Right to left', note: 'Japanese and Chinese comics.' },
  { value: 'ltr' as const, label: 'Left to right', note: 'Western comics, manhwa, and anything laid out for the web.' },
]

const isDirection = (value: unknown): value is 'ltr' | 'rtl' => value === 'ltr' || value === 'rtl'

export function useReadingDirection () {
  const route = useRoute()
  const { shared, setDirection: publish } = useShared()

  const workspace = computed(() => String(route.params.workspaceId ?? ''))

  /** Beside the chapter's own record rather than in it — a setting, not a source. */
  const key = computed(() => idbKey.direction(workspace.value))

  const direction = useState<'ltr' | 'rtl'>('workspace-direction', () => FALLBACK)

  /**
   * What this browser last knew, read once on the way in — and only ever a
   * starting point, for the reason `useTargetLanguage.restore` sets out at
   * length: the server's answer arrives separately and outranks it, so the
   * loser of that race has to know to stand down.
   */
  async function restore () {
    if (!workspace.value) return

    const kept = await idb.get<string>(key.value).catch(() => null)

    if (shared.value?.workspace.direction) return

    direction.value = isDirection(kept) ? kept : FALLBACK
  }

  // The shared answer, whenever it turns up, which may be after the panel has
  // drawn this browser's. A workspace with nothing set is left alone rather
  // than reset: it was claimed before anybody chose, and what this browser
  // remembers is a better answer than a default.
  watch(() => shared.value?.workspace.direction, (value) => {
    if (isDirection(value)) direction.value = value
  }, { immediate: true })

  async function set (next: 'ltr' | 'rtl') {
    direction.value = next

    // Written whether or not it reaches the server, so a workspace that is
    // local today and shared tomorrow does not forget in between.
    await idb.set(key.value, next).catch(() => {
      // Losing it costs one press next time, which is not worth a toast.
    })

    await publish(next)
  }

  return { direction, directions: DIRECTIONS, restore, set }
}
