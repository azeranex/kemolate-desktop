/**
 * A settings object that outlives the tab, kept on this machine.
 *
 * Which engine reads a page, which model translates it and how hard it thinks
 * are facts about the person, not about the chapter: they are the same next
 * Tuesday and for the next volume, and having to set them again on every
 * reload made the defaults look like the app's opinion rather than a starting
 * point. They stay in `localStorage` and never go to the server — a setting
 * that synced would have two collaborators fighting over one dial, which is
 * the reasoning `usePaintSettings` sets out at greater length for the brush.
 * (That one keeps three loose refs rather than one object and so does its own
 * reading and writing; everything shaped like a settings *object* comes here.)
 *
 * Restored after hydration rather than during it, because the server has
 * already rendered the defaults into the panel — swapping values mid-hydrate
 * is a mismatch warning for every control that shows one. Wired once per key,
 * however many components ask for the state behind it.
 *
 * `accept` is where a stored value is let back in, and it is the caller's
 * because only the caller knows the vocabulary: a detector that has since
 * been dropped from the list, a model a provider has retired or a plain
 * hand-edited entry must read as the default rather than as a setting nothing
 * downstream can honour. Everything in the object is written out; only what
 * `accept` returns is read back, so a field that is a *count* rather than a
 * choice can sit in the same object without coming back stale.
 */
const wired = new Set<string>()

/**
 * The moment each key's stored value has been let back in, by key.
 *
 * Most settings are only ever *read by a control*, and for those the moment
 * does not matter: the control redraws when the value arrives. One is not. The
 * cleaner's model and mask source are part of every repair's name (`patchKey`),
 * and `useClean.restore` looks every repair of a chapter up by that name once,
 * as the chapter opens. `onNuxtReady` is an idle callback with no timeout, so
 * on a busy page — a chapter being hashed and thumbnailed — or in a tab that is
 * not in front, where the browser hands out idle time grudgingly, the chapter
 * opened first and the lookup ran under the *defaults*. A reader cleaning with
 * anything but those found every page bare, with every repair still on disk
 * and pressing Clean putting them all back at once as cache hits.
 *
 * So a caller that names things by a setting can wait for it. Resolved at once
 * on the server, and for a key nothing has wired, which is a key with nothing
 * to wait for.
 */
const settled = new Map<string, { done: Promise<void>, resolve: () => void }>()

function settling (key: string) {
  let entry = settled.get(key)

  if (!entry) {
    let settle!: () => void
    const done = new Promise<void>((resolve) => { settle = resolve })

    entry = { done, resolve: settle }
    settled.set(key, entry)
  }

  return entry
}

/** Resolves once `key`'s stored value is in the state — see `settled`. */
export function remembered (key: string): Promise<void> {
  if (!import.meta.client || !wired.has(key)) return Promise.resolve()

  return settling(key).done
}

export function remember<T extends object> (
  key: string,
  state: Ref<T>,
  accept: (held: Record<string, unknown>) => Partial<T>,
): void {
  if (!import.meta.client || wired.has(key)) return

  wired.add(key)
  settling(key)

  onNuxtReady(() => {
    try {
      const held: unknown = JSON.parse(localStorage.getItem(key) ?? '{}')

      if (held && typeof held === 'object') {
        Object.assign(state.value, accept(held as Record<string, unknown>))
      }
    } catch {
      // A broken entry reads as the defaults, and the next change rewrites it.
    } finally {
      settling(key).resolve()
    }

    watch(state, () => {
      try {
        localStorage.setItem(key, JSON.stringify(state.value))
      } catch {
        // Full, or a browser that refuses storage. Nothing here is worth an
        // error somebody has to dismiss mid-page.
      }
    }, { deep: true })
  })
}
