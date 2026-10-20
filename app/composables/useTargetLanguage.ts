/**
 * What this chapter is being translated into.
 *
 * A property of the workspace rather than of the panel it is set from, and that
 * is the whole point of it living here. It used to be a field on the translate
 * settings, which meant it was one answer for every chapter in the browser and
 * survived nothing — pick Indonesian, refresh, and you were translating into
 * English again without being told.
 *
 * Local first, like everything else in this app. A workspace is made offline
 * and most of them are never shared, so the answer is kept in this browser
 * under the workspace's own id; the server is asked only when there is one to
 * ask, and when there is, it wins. Two people carrying the same chapter into
 * two different languages is not a difference of preference — it is a chapter
 * translated twice, and neither of them can see it happening.
 *
 * The languages themselves are `shared/utils/prompt.ts`'s, not this file's. It
 * is the list that has to be right — a name from it is what the model is
 * actually asked for — so the picker takes what the prompt knows rather than
 * keeping a second copy to disagree with it.
 */
import { idbKey } from '~/utils/idbKeys'

const FALLBACK = 'en'

export function useTargetLanguage () {
  const route = useRoute()
  const { shared, setTarget: publish } = useShared()

  const workspace = computed(() => String(route.params.workspaceId ?? ''))

  /** Beside the chapter's own record rather than in it — a setting, not a source. */
  const key = computed(() => idbKey.target(workspace.value))

  const target = useState('workspace-target', () => FALLBACK)

  /**
   * What this browser last knew, read once on the way in.
   *
   * Only ever a starting point: the server's answer arrives separately and
   * overrides it, which is why this does not wait for it.
   *
   * It writes the fallback when there is nothing kept, rather than leaving what
   * is there. The state is one value for the app and not one per workspace, so
   * walking from a chapter set to Korean into a fresh one would otherwise show
   * Korean — and go on showing it, because a workspace with nothing stored is
   * exactly the case where the quiet version of this never corrects itself.
   */
  async function restore () {
    if (!workspace.value) return

    const kept = await idb.get<string>(key.value).catch(() => null)

    // The server has already answered for this workspace, and its answer
    // outranks the one in this browser. Which of the two lands first is a race
    // — the page starts both at once — so the loser has to know to stand down.
    if (shared.value?.workspace.targetLocale) return

    target.value = kept && isLanguage(kept) ? kept : FALLBACK
  }

  /**
   * The shared answer, whenever it turns up, and it may turn up after the panel
   * has already drawn this browser's one.
   *
   * A workspace on the server with nothing set is left alone rather than reset
   * to the fallback: it was claimed before anybody chose, and what this browser
   * remembers is a better answer than a default. The next change publishes it.
   *
   * A code this app does not offer is treated the same way, and the column will
   * take one — it is sixteen characters of text, and `claim` accepts whatever a
   * browser sends. Shown, it would empty the picker, because there is no row to
   * put the tick against; turned into English, it would be written back over
   * somebody's real answer at the next change.
   */
  watch(() => shared.value?.workspace.targetLocale, (locale) => {
    if (locale && isLanguage(locale)) target.value = locale
  }, { immediate: true })

  async function set (locale: string) {
    target.value = locale

    // Written here whether or not it reaches the server, so that a workspace
    // which is local today and shared tomorrow does not forget in between.
    await idb.set(key.value, locale).catch(() => {
      // Losing the language costs one press next time. Not worth interrupting
      // anyone over, and `useLibrary` already says when storage is unwell.
    })

    await publish(locale)
  }

  return { target, languages: LANGUAGE_OPTIONS, restore, set }
}
