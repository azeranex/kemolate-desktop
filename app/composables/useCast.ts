/**
 * Who is in this comic, in the browser that sends it with every page.
 *
 * `useGlossary`'s sibling, and the division between them is worth stating: the
 * glossary keeps a *name* spelled the same way twice, and this keeps track of
 * who the name belongs to. A source that drops its pronouns leaves gender to be
 * inferred from each line, inferred afresh on every page, and differently on
 * every page — which is how a character changes sex halfway down a volume.
 *
 * Server-held on a cloud workspace for the reason the glossary is: this is the
 * chapter's answer, not this browser's, and two collaborators who disagreed
 * about a character's gender would be producing two different translations of
 * the same book. A local workspace keeps its cast in this browser under
 * `cast:<workspace>` — it used to have none — and both stores follow the same
 * rules, in `shared/utils/cast.ts`.
 *
 * ## Not per language
 *
 * The one difference from the glossary, and it decides the shape of everything
 * here: a character's gender is a fact about the person and does not change
 * with the language they are read in. Only the *spelling* of their name does,
 * and that lives inside the entry as `names[locale]`. So this list is fetched
 * once per chapter rather than once per chapter per language, and switching
 * target language leaves it alone.
 */
import type { CastDraft } from '#shared/utils/cast'
import type { Cast } from '#shared/utils/prompt'

import { idbKey } from '~/utils/idbKeys'

/** One member as the panel edits them — the server's row, plus its id. */
export interface CastRow {
  id: number
  source: string
  names: Record<string, string> | null
  gender: 'male' | 'female' | 'nb' | 'unknown'
  tags: string[] | null
  /** Whether a person settled this, as opposed to a model proposing it. */
  pinned: boolean
}

/** A local workspace's cast, from this browser — module-level for the reason `localGlossaries` is. */
export async function localCast (workspace: string): Promise<{ members: CastRow[], notes: string }> {
  const held = await idb.get<{ v: 1, members: CastRow[], notes: string }>(idbKey.cast(workspace)).catch(() => undefined)

  return held?.v === 1 ? { members: held.members, notes: held.notes } : { members: [], notes: '' }
}

/**
 * Keep a cast as a local workspace's, whole — every member pinned, as a saved
 * cast always is — and tell this browser's other tabs.
 */
export async function keepCastLocally (workspace: string, drafts: CastDraft[], notes: string): Promise<void> {
  let id = 1

  await idb.set(idbKey.cast(workspace), {
    v: 1,
    members: normaliseCast(drafts).map((member) => ({ ...member, id: id++, pinned: true })),
    notes: String(notes ?? '').slice(0, MAX_NOTES),
  })
  announceLocal(workspace, 'cast')
}

/** A cloud workspace's cast, from the server. */
export async function serverCast (workspace: string): Promise<{ members: CastRow[], notes: string } | null> {
  return $fetch<{ members: CastRow[], notes: string }>(`/api/workspaces/${workspace}/cast`).catch(() => null)
}

/** Save a cast into a cloud workspace, whole — which pins every member. */
export async function sendCast (workspace: string, drafts: CastDraft[], notes: string): Promise<void> {
  await $fetch(`/api/workspaces/${workspace}/cast`, {
    method: 'PUT',
    body: { members: drafts, notes },
  }).catch(() => null)
}

export function useCast () {
  const route = useRoute()
  const { shared } = useShared()

  const workspace = computed(() => String(route.params.workspaceId ?? ''))

  const members = useState<CastRow[]>('cast-members', () => [])
  const notes = useState('cast-notes', () => '')

  /** Which chapter the list in hand belongs to — see `useGlossary.held`. */
  const held = useState<string | null>('cast-held', () => null)

  /** Whether there is a chapter on the server to have a cast at all. */
  const claimed = computed(() => Boolean(workspace.value && shared.value?.workspace))

  /** A local workspace, whose cast is this browser's — see the header. */
  const local = computed(() => Boolean(workspace.value && !shared.value))

  /** Whether there is a cast here at all, wherever it is kept. */
  const available = computed(() => claimed.value || local.value)

  const writable = computed(() => local.value || (claimed.value && atLeast(shared.value?.role, 'translator')))

  const localKey = () => idbKey.cast(workspace.value)

  async function readLocal (): Promise<{ members: CastRow[], notes: string }> {
    const held = await idb.get<{ v: 1, members: CastRow[], notes: string }>(localKey()).catch(() => undefined)

    return held?.v === 1 ? { members: held.members, notes: held.notes } : { members: [], notes: '' }
  }

  /** Keep the local cast, show it, and tell this browser's other tabs. Plain copies for IndexedDB. */
  async function writeLocal (next: { members: CastRow[], notes: string }) {
    const plain = JSON.parse(JSON.stringify(next)) as { members: CastRow[], notes: string }

    await idb.set(localKey(), { v: 1, ...plain })
    announceLocal(workspace.value, 'cast')

    members.value = plain.members
    notes.value = plain.notes
    held.value = workspace.value
  }

  const nextId = (list: CastRow[]) => list.reduce((most, row) => Math.max(most, row.id), 0) + 1

  async function load () {
    if (local.value) {
      const asked = workspace.value
      const found = await readLocal()

      if (asked !== workspace.value) return

      members.value = found.members
      notes.value = found.notes
      held.value = asked

      return
    }

    if (!claimed.value) {
      members.value = []
      notes.value = ''
      held.value = null

      return
    }

    const asked = workspace.value

    const found = await $fetch<{ members: CastRow[], notes: string }>(
      `/api/workspaces/${workspace.value}/cast`,
    ).catch(() => null)

    // The chapter changed while this was in the air.
    if (asked !== workspace.value || !found) return

    members.value = found.members
    notes.value = found.notes
    held.value = asked
  }

  /**
   * The list, fetched if what is in hand is not this chapter's.
   *
   * What a run calls: it is the one caller that must not send a stale cast, and
   * also the one that would otherwise refetch an unchanged list once per page.
   */
  async function ready (): Promise<Cast> {
    if (held.value !== workspace.value) await load()

    return forPrompt()
  }

  /** The cast in the shape `pagePrompt` takes. */
  function forPrompt (): Cast {
    return {
      members: members.value.map((row) => ({
        source: row.source,
        names: row.names ?? {},
        gender: row.gender,
        tags: row.tags ?? [],
      })),
      notes: notes.value,
    }
  }

  /**
   * Save the list as it stands. Everything saved comes back pinned — the reader
   * has looked at these entries, so no later page may argue with them — and the
   * server's answer replaces the local list rather than the draft staying on
   * screen, so what is shown is what will actually be sent.
   */
  async function save (drafts: { source: string, names?: Record<string, string> | null, gender?: string, tags?: string[] | null }[], standing: string) {
    if (!writable.value) return

    if (local.value) {
      const current = (await readLocal()).members
      let id = nextId(current)

      await writeLocal({
        members: normaliseCast(drafts).map((member) => ({
          ...member,
          // The same row keeps its id, so a panel mid-edit does not lose its place.
          id: current.find((row) => row.source === member.source)?.id ?? id++,
          pinned: true,
        })),
        notes: String(standing ?? '').slice(0, MAX_NOTES),
      })

      return
    }

    const saved = await $fetch<{ members: CastRow[], notes: string }>(
      `/api/workspaces/${workspace.value}/cast`,
      {
        method: 'PUT',
        body: { members: drafts, notes: standing },
        headers: peerHeader(workspace.value),
      },
    )

    members.value = saved.members
    notes.value = saved.notes
    held.value = workspace.value
  }

  /**
   * Fold what a page taught into the cast.
   *
   * Sent up rather than merged here, because the rules that make it safe — a
   * pinned entry untouched, an unpinned one only having its blanks filled — are
   * the server's and have to hold against two browsers at once.
   */
  async function learn (learned: { name?: unknown, tr?: unknown, gender?: unknown, tags?: unknown }[], locale: string) {
    if (!writable.value || !learned.length) return

    if (local.value) {
      const current = await readLocal()
      const { made, changed } = foldCast(current.members, learned, locale)

      if (!made.length && !changed.length) return

      let id = nextId(current.members)
      const updated = current.members.map((row) => {
        const change = changed.find((entry) => entry.row === row)

        return change ? { ...row, ...change.values } as CastRow : row
      })

      await writeLocal({
        members: [...updated, ...made.map((member) => ({ ...member, id: id++ }) as CastRow)],
        notes: current.notes,
      })

      return
    }

    await $fetch(`/api/workspaces/${workspace.value}/cast/learn`, {
      method: 'POST',
      body: { locale, learned },
      headers: peerHeader(workspace.value),
    }).catch(() => {
      // Failing to record what a page met costs consistency on later pages and
      // nothing on this one, which is not worth ending a run over.
    })

    await load()
  }

  // Somebody else — or this person in another tab — changed the cast. The
  // notice carries nothing but its scope, because the whole list is one small
  // request; see `SwarmChange`.
  onSwarmChange((room, change) => {
    if (room === workspace.value && change.scope === 'cast') load()
  })

  // And from another tab on a local workspace — see `useLocalChanges`.
  onLocalChange((room, scope) => {
    if (room === workspace.value && scope === 'cast') load()
  })

  // A different chapter is a different cast, and the old one must not sit on
  // screen — or in a prompt — while this one is read back.
  watch(workspace, () => {
    members.value = []
    notes.value = ''
    held.value = null
    load()
  })

  return { members, notes, claimed, available, writable, load, ready, forPrompt, save, learn }
}
