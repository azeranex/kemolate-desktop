/**
 * How much room this browser is giving us, and whether it has promised to keep
 * what is in it.
 *
 * Both halves of one question, and it is a question this app has more at stake
 * in than most. Storage is evictable by default — the browser may drop it under
 * pressure, without asking and without telling — and for a workspace with no
 * server record, what it would drop is the only copy of an evening's work.
 *
 * `opfs.persist()` already asks, once, when a chapter is copied in. Nothing has
 * ever shown the *answer*, so a reader has had no way to tell a chapter the
 * browser has undertaken to keep from one it may quietly bin. This is that
 * answer, and a way to ask again where it was not granted.
 *
 * Everything here is origin-wide rather than per workspace. The browser does
 * not account for storage by what it is for, and pretending otherwise — a
 * figure next to one chapter that is really the total of all of them — would be
 * a more confident lie than saying nothing.
 */
export function useStorageStanding () {
  /** Null until asked, and on any browser that will not say. */
  const persisted = ref<boolean | null>(null)
  const used = ref<number | null>(null)
  const quota = ref<number | null>(null)
  const asking = ref(false)

  async function look () {
    if (!import.meta.client || !navigator.storage) return

    persisted.value = await navigator.storage.persisted?.().catch(() => null) ?? null

    const estimate = await navigator.storage.estimate?.().catch(() => null)

    used.value = estimate?.usage ?? null
    quota.value = estimate?.quota ?? null
  }

  /**
   * Ask the browser to stop treating this as disposable.
   *
   * It may simply say no — Chromium decides on engagement and installation
   * rather than on asking, and Safari grants it on its own terms — so the
   * answer is read back rather than assumed. A refusal is not an error and gets
   * no toast: the button was a request, the state below it is the outcome, and
   * that is the whole conversation.
   */
  async function ask () {
    asking.value = true

    await persist()
    await look()

    asking.value = false
  }

  return { persisted, used, quota, asking, look, ask }
}
