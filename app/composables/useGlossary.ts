/**
 * The terms this chapter has settled on, in the language it is being carried
 * into.
 *
 * Small, because the interesting half is the server's — see
 * `server/services/glossaries.ts`, which holds the rules that make the list
 * worth having. This is the browser's end of the loop: hand the list to every
 * page prompt, take back whatever that page taught, and send it up.
 *
 * ## Where it lives
 *
 * A cloud workspace's glossary lives on the server, which is where two people
 * translating the same chapter can agree on a spelling — a copy per browser
 * would give a chapter as many spellings of a name as it has translators.
 *
 * A local workspace has nobody to agree with, and keeps its glossary in this
 * browser under `glossary:<workspace>:<locale>`. It used to have none at all:
 * the list lived only on the server, and a local chapter got one by being
 * claimed on its first translation, which the reader never chose. Both stores
 * grow by the same rule — `foldTerms`, first translation wins — so a run builds
 * the same list wherever the chapter is kept.
 *
 * ## One list per language
 *
 * Held under the target language, and dropped when it changes. The target half
 * of every row is written in one language, so a chapter carried into Korean and
 * then into Spanish has two glossaries and neither is any use to the other.
 */
import type { Term } from '#shared/utils/prompt'
import type { ProjectGlossary } from '~/utils/project'

import { idbKey, idbPrefix } from '~/utils/idbKeys'

/** A term as the list shows it — the row, so one of them can be removed. */
export interface GlossaryRow extends Term {
  id: number
}

/**
 * A local workspace's glossaries, one per language it has been carried into.
 *
 * Module-level rather than on the composable, like the three below: moving a
 * workspace between kinds and packing a project file both need the lists, and
 * `useGlossary()` registers listeners every time it is called — reaching for it
 * from those places would leave a copy of each behind per call.
 */
export async function localGlossaries (workspace: string): Promise<ProjectGlossary[]> {
  const keys = await idb.keys(idbPrefix.glossaries(workspace)).catch(() => [] as string[])
  const out: ProjectGlossary[] = []

  for (const key of keys) {
    const held = await idb.get<{ v: 1, terms: GlossaryRow[] }>(key).catch(() => undefined)

    if (held?.v === 1 && held.terms.length) {
      out.push({ locale: key.slice(idbPrefix.glossaries(workspace).length), terms: held.terms.map(({ source, target }) => ({ source, target })) })
    }
  }

  return out
}

/**
 * Fold terms into a local workspace's glossary for one language — first
 * translation wins, as everywhere — and tell this browser's other tabs.
 */
export async function keepGlossaryLocally (workspace: string, glossary: ProjectGlossary): Promise<number> {
  const key = idbKey.glossary(workspace, glossary.locale)
  const held = await idb.get<{ v: 1, terms: GlossaryRow[] }>(key).catch(() => undefined)
  const current = held?.v === 1 ? held.terms : []
  const rows = foldTerms(current, glossary.terms.map(({ source, target }) => ({ src: source, tr: target })))

  if (!rows.length) return 0

  let id = current.reduce((most, term) => Math.max(most, term.id), 0) + 1

  await idb.set(key, { v: 1, terms: [...current.map(({ id: at, source, target }) => ({ id: at, source, target })), ...rows.map((row) => ({ ...row, id: id++ }))] })
  announceLocal(workspace, 'glossary')

  return rows.length
}

/** A cloud workspace's glossary for one language, from the server. */
export async function serverGlossary (workspace: string, locale: string): Promise<ProjectGlossary | null> {
  const rows = await $fetch<GlossaryRow[]>(`/api/workspaces/${workspace}/glossary`, { query: { locale } }).catch(() => null)

  return rows?.length ? { locale, terms: rows.map(({ source, target }) => ({ source, target })) } : null
}

/**
 * Every language's glossary a cloud workspace keeps — see `glossaries.everyLocale`.
 * Null when the server would not say, which a caller about to delete the
 * server's copy must read as "stop", not as "none".
 */
export async function serverGlossaries (workspace: string): Promise<ProjectGlossary[] | null> {
  return $fetch<ProjectGlossary[]>(`/api/workspaces/${workspace}/glossary`, { query: { all: 1 } }).catch(() => null)
}

/**
 * Merge terms into a cloud workspace's glossary — `glossaries.merge`, first
 * translation wins — a hundred at a time, the bound one request is allowed.
 */
export async function sendGlossary (workspace: string, glossary: ProjectGlossary): Promise<number> {
  let sent = 0

  for (let at = 0; at < glossary.terms.length; at += 100) {
    const slice = glossary.terms.slice(at, at + 100)

    await $fetch(`/api/workspaces/${workspace}/glossary`, {
      method: 'PUT',
      body: { locale: glossary.locale, learned: slice.map(({ source, target }) => ({ src: source, tr: target })) },
      // Left out of its own change notice: this tab is the one importing them.
      headers: peerHeader(workspace),
    }).catch(() => null)

    sent += slice.length
  }

  return sent
}

export function useGlossary () {
  const route = useRoute()
  const { shared } = useShared()
  const { target } = useTargetLanguage()

  const workspace = computed(() => String(route.params.workspaceId ?? ''))

  const terms = useState<GlossaryRow[]>('glossary-terms', () => [])

  /**
   * Which workspace and language the list in hand belongs to.
   *
   * Without it, walking from a chapter translated into Korean into one being
   * carried into Spanish shows the Korean terms until the fetch lands — and,
   * far worse, a run started in that window would send them.
   */
  const held = useState<string | null>('glossary-held', () => null)

  const scope = computed(() => `${workspace.value}:${target.value}`)

  /** Whether there is a chapter on the server to have a glossary at all. */
  const claimed = computed(() => Boolean(workspace.value && shared.value?.workspace))

  /** A local workspace, whose glossary is this browser's — see the header. */
  const local = computed(() => Boolean(workspace.value && !shared.value))

  /** Whether there is a glossary here at all, wherever it is kept. */
  const available = computed(() => claimed.value || local.value)

  /** Whether this reader may change it: anyone on a local one, a translator on a cloud one. */
  const writable = computed(() => local.value || (claimed.value && atLeast(shared.value?.role, 'translator')))

  /** Where a local workspace keeps the list for the language in hand. */
  const localKey = () => idbKey.glossary(workspace.value, target.value)

  /** The local list, read from this browser. */
  async function readLocal (): Promise<GlossaryRow[]> {
    const held = await idb.get<{ v: 1, terms: GlossaryRow[] }>(localKey()).catch(() => undefined)

    return held?.v === 1 ? held.terms : []
  }

  /**
   * Keep the local list, and tell this browser's other tabs.
   *
   * Plain copies, because IndexedDB will not take Vue's proxies.
   */
  async function writeLocal (next: GlossaryRow[]): Promise<GlossaryRow[]> {
    const plain = next.map((term) => ({ id: term.id, source: term.source, target: term.target }))

    await idb.set(localKey(), { v: 1, terms: plain })
    announceLocal(workspace.value, 'glossary')

    terms.value = plain
    held.value = scope.value

    return plain
  }

  /** The next id in a local list — ids only have to be unique within it. */
  const nextId = (list: GlossaryRow[]) => list.reduce((most, term) => Math.max(most, term.id), 0) + 1

  async function load (): Promise<GlossaryRow[]> {
    if (local.value) {
      const asked = scope.value
      const found = await readLocal()

      if (asked !== scope.value) return terms.value

      terms.value = found
      held.value = asked

      return found
    }

    if (!claimed.value) {
      terms.value = []
      held.value = null

      return []
    }

    const asked = scope.value

    const found = await $fetch<GlossaryRow[]>(`/api/workspaces/${workspace.value}/glossary`, {
      query: { locale: target.value },
    }).catch(() => {
      // A viewer, a signed-out reader, or a server having a moment. An empty
      // glossary costs consistency across pages and nothing else, and saying so
      // in a toast would interrupt a run to report the absence of a nicety.
      return null
    })

    // The language or the chapter changed while this was in the air. Landing it
    // now would file one language's terms under another's name.
    if (asked !== scope.value) return terms.value

    if (found) {
      terms.value = found
      held.value = asked
    }

    return terms.value
  }

  /**
   * Send up what a page taught, and keep what comes back.
   *
   * The reply is the whole list, so the next page of the same run is prompted
   * with the term this one just settled — which is the point of doing this
   * per page rather than at the end of a chapter.
   */
  async function learn (learned: { src?: unknown, tr?: unknown }[]): Promise<GlossaryRow[]> {
    if (!learned.length) return terms.value

    if (local.value) {
      const current = await readLocal()
      const rows = foldTerms(current, learned)

      if (!rows.length) return current

      let id = nextId(current)

      return writeLocal([...current, ...rows.map((row) => ({ ...row, id: id++ }))])
    }

    if (!claimed.value) return terms.value

    const asked = scope.value

    const merged = await $fetch<GlossaryRow[]>(`/api/workspaces/${workspace.value}/glossary`, {
      method: 'PUT',
      body: { locale: target.value, learned },
      // Left out of its own change notice, like every other write here: the
      // reply is the new list, and without this the tab that taught the terms
      // heard about them too and fetched the list again, once per listener,
      // after every page a run translated.
      headers: peerHeader(workspace.value),
    }).catch(() => null)

    if (asked !== scope.value || !merged) return terms.value

    terms.value = merged
    held.value = asked

    return merged
  }

  /**
   * Write a term by hand — new, or replacing the rendering of one already on
   * the list.
   *
   * The one door that overwrites. `learn` above is the model's and holds to
   * first-translation-wins; this is a person's and does not, because somebody
   * typing the right rendering is not guessing.
   *
   * Errors are thrown rather than swallowed, unlike `learn`: a term the model
   * failed to record costs consistency on later pages and nothing you can see,
   * where a term *you* typed failing to save is a thing you will believe is
   * saved and rely on.
   */
  async function set (source: string, rendering: string): Promise<void> {
    if (local.value) {
      const current = await readLocal()
      const clean = { source: cleanTerm(source), target: cleanTerm(rendering) }

      if (!clean.source || !clean.target) throw new Error('A term needs both halves.')

      const found = current.find((term) => term.source === clean.source)

      if (!found && current.length >= MAX_TERMS) {
        throw new Error(`This glossary is full at ${MAX_TERMS} terms - remove one first.`)
      }

      await writeLocal(found
        ? current.map((term) => (term === found ? { ...term, target: clean.target } : term))
        : [...current, { ...clean, id: nextId(current) }])

      return
    }

    if (!claimed.value) return

    // `rendering` rather than `target`, which is what this was called and which
    // shadowed the target-language ref of the same name — so `target.value` on
    // the line below read `undefined` off a string, and every hand-written term
    // would have gone to a glossary filed under no language at all.
    terms.value = await $fetch<GlossaryRow[]>(`/api/workspaces/${workspace.value}/glossary`, {
      method: 'POST',
      body: { locale: target.value, source, target: rendering },
      headers: peerHeader(workspace.value),
    })
    held.value = scope.value
  }

  /** Correct a term already on the list — either half of it. */
  async function amend (id: number, patch: { source?: string, target?: string }): Promise<void> {
    if (local.value) {
      const current = await readLocal()
      const source = patch.source === undefined ? undefined : cleanTerm(patch.source)
      const rendering = patch.target === undefined ? undefined : cleanTerm(patch.target)

      if (source === '' || rendering === '') throw new Error('A term needs both halves.')
      if (source && current.some((term) => term.id !== id && term.source === source)) {
        throw new Error('That name is already on the list.')
      }

      await writeLocal(current.map((term) => (term.id === id
        ? { ...term, ...(source ? { source } : {}), ...(rendering ? { target: rendering } : {}) }
        : term)))

      return
    }

    if (!claimed.value) return

    terms.value = await $fetch<GlossaryRow[]>(
      `/api/workspaces/${workspace.value}/glossary/${id}`,
      {
        method: 'PATCH',
        body: { locale: target.value, ...patch },
        headers: peerHeader(workspace.value),
      },
    )
    held.value = scope.value
  }

  /**
   * Forget one term.
   *
   * The common fault is not "this list is wrong" but "one row in it is wrong" —
   * a name the first page read badly, now teaching every later page to read it
   * the same way, because first-translation-wins protects a bad first answer
   * exactly as well as a good one. Throwing away forty good terms to be rid of
   * one was the only remedy the earlier build offered, and it is not one
   * anybody should have to accept.
   */
  async function forget (id: number): Promise<void> {
    if (local.value) {
      await writeLocal((await readLocal()).filter((term) => term.id !== id))

      return
    }

    if (!claimed.value) return

    await $fetch(`/api/workspaces/${workspace.value}/glossary/${id}`, {
      method: 'DELETE',
      headers: peerHeader(workspace.value),
    })

    terms.value = terms.value.filter((term) => term.id !== id)
  }

  /** Throw the list away and start it again — see the endpoint for when. */
  async function clear (): Promise<void> {
    if (local.value) {
      await writeLocal([])

      return
    }

    if (!claimed.value) return

    await $fetch(`/api/workspaces/${workspace.value}/glossary`, {
      method: 'DELETE',
      query: { locale: target.value },
      headers: peerHeader(workspace.value),
    })

    terms.value = []
    held.value = scope.value
  }

  /**
   * The list, fetched if what is in hand is not this chapter's in this language.
   *
   * What a run calls, rather than `load`: it is the one caller that must not
   * proceed on a stale list, and it is also the one that would otherwise refetch
   * an unchanged glossary once per page.
   */
  async function ready (): Promise<GlossaryRow[]> {
    if (held.value === scope.value) return terms.value

    return load()
  }

  // A chapter opened in a different language is a different glossary, and the
  // old one must not sit on screen — or in a prompt — while the new one is
  // fetched. Cleared rather than left: `held` going null is what makes `ready`
  // fetch before the next page goes out.
  watch(scope, () => {
    terms.value = []
    held.value = null
  })

  // Somebody else learned or removed a term — or this person did, in another
  // tab. The whole list is one small request, so it is simply re-read; see
  // `SwarmChange`, which carries the scope and nothing else for that reason.
  // Without this a collaborator's glossary count sat stale until a reload,
  // which is the gap the earlier build closed with its own `emit`.
  onSwarmChange((room, change) => {
    if (room === workspace.value && change.scope === 'glossary') load()
  })

  // And the same from another tab on a local workspace, which has no swarm to
  // say so — see `useLocalChanges`.
  onLocalChange((room, scope) => {
    if (room === workspace.value && scope === 'glossary') load()
  })

  return { terms, available, writable, load, ready, learn, set, amend, forget, clear }
}
