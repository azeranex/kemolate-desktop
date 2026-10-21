/**
 * Who is in this comic, and what may not be guessed about them.
 *
 * The glossary keeps a name spelled the same way twice; it cannot say who the
 * name belongs to. A source that drops its pronouns leaves gender to be worked
 * out from the line, and worked out afresh on every page it comes out
 * differently on every page — which is how a character changes sex halfway down
 * a volume. Written down once, it is sent with every page instead of guessed.
 *
 * Translator rather than editor, like the glossary: deciding who a character is
 * is a decision about the words.
 *
 * ## Two ways in, and they are not the same
 *
 * `save` is a person editing the list, and everything it writes is **pinned** —
 * saving is the act of settling something. `merge` is what a page taught while
 * being translated, and it may only fill blanks: it never revises an
 * established fact and never touches a pinned row at all.
 *
 * That asymmetry is the whole feature. The failure it prevents is not "the
 * model does not know who these people are" — it is "the model decides afresh
 * every page, is right most of the time, and wrong differently each time".
 * A guess that can overwrite a better guess is worse than no guess.
 */
import { and, eq, inArray } from 'drizzle-orm'

import { must, notify } from './access'
import { record } from './logs'

import type { CastDraft } from '#shared/utils/cast'
import type { Cast, CastMember as PromptMember } from '#shared/utils/prompt'
import type { Context } from './access'
import type { CastMember } from '~~/server/database'

import { translateWorkspace, viewWorkspace } from '#shared/utils/abilities'
import { foldCast, MAX_CAST, MAX_NOTES, normaliseCast } from '#shared/utils/cast'
import { castMembers, db, workspaces } from '~~/server/database'

// The rules the cast is kept by are shared with a local workspace's, which keeps
// its list in the browser — see `shared/utils/cast.ts`.
export { MAX_CAST, MAX_NOTES }
export type { CastDraft }

/** Everything the prompt needs, in the shape `pagePrompt` already takes. */
export async function forPrompt (context: Context): Promise<Cast> {
  await must(context, viewWorkspace, context)

  const [rows, workspace] = await Promise.all([
    db.query.castMembers.findMany({
      where: { workspaceId: context.workspaceId },
      orderBy: { source: 'asc' },
    }),
    db.query.workspaces.findFirst({
      where: { id: context.workspaceId },
      columns: { castNotes: true },
    }),
  ])

  return {
    members: rows.map(toPrompt),
    notes: workspace?.castNotes ?? '',
  }
}

const toPrompt = (row: CastMember): PromptMember => ({
  source: row.source,
  names: row.names ?? {},
  gender: row.gender,
  tags: row.tags ?? [],
})

/** The list as the panel edits it — the rows, and whether each is settled. */
export async function list (context: Context) {
  await must(context, viewWorkspace, context)

  const [members, workspace] = await Promise.all([
    db.query.castMembers.findMany({
      where: { workspaceId: context.workspaceId },
      orderBy: { source: 'asc' },
    }),
    db.query.workspaces.findFirst({
      where: { id: context.workspaceId },
      columns: { castNotes: true },
    }),
  ])

  return { members, notes: workspace?.castNotes ?? '' }
}

/**
 * The reader's own list, replacing whatever was there.
 *
 * A whole-list write rather than a patch per row, because that is what the
 * panel is: a draft edited as one thing and saved as one thing. Half a cast
 * saved is a prompt that contradicts itself.
 *
 * **Everything saved is pinned**, whether it was typed here or only looked at
 * and left alone. Looking at a row the model proposed and choosing not to
 * change it is a decision, and the whole point of the panel is that decisions
 * made in it are final.
 *
 * Rows absent from the list are deleted — the panel's remove button is the only
 * way a character leaves, and it has to work for a name the model keeps
 * re-proposing.
 */
export async function save (
  context: Context,
  drafts: CastDraft[],
  notes: string,
): Promise<{ members: CastMember[], notes: string }> {
  await must(context, translateWorkspace, context)

  // Cleaned, deduplicated and bounded by the shared rule — see `normaliseCast`.
  const wanted = normaliseCast(drafts)

  const trimmed = String(notes ?? '').slice(0, MAX_NOTES)

  db.transaction((tx) => {
    const existing = tx
      .select({ id: castMembers.id, source: castMembers.source })
      .from(castMembers)
      .where(eq(castMembers.workspaceId, context.workspaceId))
      .all()

    /*
     * Byte-for-byte, not `castKey()`, and the difference bit once: the unique
     * index compares with SQLite's BINARY collation, so a delete-set built
     * case-insensitively disagrees with the conflict target the upsert uses.
     * Correcting "sakura" to "Sakura" then kept the old row (its key matched)
     * *and* inserted a new one (its bytes did not clash) — two rows for one
     * person, both counted against the ceiling. The two sets must share one
     * notion of equality, and the index's is the only one SQLite will enforce;
     * `COLLATE NOCASE` on the index was considered and rejected as ASCII-only,
     * weaker than the `castKey()` the draft above dedupes with. So a case rename
     * is a delete-and-insert, which is exactly what it should read as in the
     * table: the old spelling leaves, the corrected one arrives pinned.
     */
    const keeping = new Set(wanted.map((member) => member.source))
    const going = existing.filter((row) => !keeping.has(row.source)).map((row) => row.id)

    if (going.length) {
      tx.delete(castMembers).where(inArray(castMembers.id, going)).run()
    }

    for (const member of wanted) {
      tx
        .insert(castMembers)
        .values({ ...member, workspaceId: context.workspaceId, pinned: true })
        .onConflictDoUpdate({
          target: [castMembers.workspaceId, castMembers.source],
          set: { ...member, pinned: true },
        })
        .run()
    }

    tx
      .update(workspaces)
      .set({ castNotes: trimmed })
      .where(eq(workspaces.id, context.workspaceId))
      .run()
  })

  await record({
    workspaceId: context.workspaceId,
    userId: context.actor?.id ?? null,
    action: 'cast.saved',
    subject: 'workspaces',
    subjectId: context.workspaceId,
    detail: { members: wanted.length },
  })

  notify(context, { scope: 'cast' })

  return list(context)
}

/**
 * Fold what a page taught into the cast.
 *
 * A pinned entry is left exactly as it stands — that is what pinning is. An
 * unpinned one only has its **blanks** filled: a gender that was `unknown`, a
 * name this language had not been given yet, tags it did not have. Established
 * facts are never revised, for the reason the glossary's first-translation-wins
 * exists — a page that reads a character wrong should not be able to rewrite a
 * page that read them right.
 *
 * Matched on the source name *or* any spelling already recorded for them, so a
 * model that answers with the English name it was given last page does not
 * create a second row for the same person.
 */
export async function merge (
  context: Context,
  locale: string,
  learned: { name?: unknown, tr?: unknown, gender?: unknown, tags?: unknown }[],
): Promise<void> {
  await must(context, translateWorkspace, context)

  if (!learned.length) return

  const rows = await db.query.castMembers.findMany({
    where: { workspaceId: context.workspaceId },
  })

  // Pinned untouched, blanks filled, one person proposed twice still one row —
  // `foldCast`, the same rule a local workspace follows.
  const folded = foldCast(rows, learned, locale)
  const made = folded.made.map((member) => ({ ...member, workspaceId: context.workspaceId }))
  const changed = folded.changed.map(({ row, values }) => ({ id: row.id, values }))

  if (!made.length && !changed.length) return

  db.transaction((tx) => {
    if (made.length) {
      tx.insert(castMembers).values(made).onConflictDoNothing({
        target: [castMembers.workspaceId, castMembers.source],
      }).run()
    }

    for (const { id, values } of changed) {
      // `pinned = false` again, *in the write*: the rows were read across an
      // `await`, and a save can land in the gap. A merge that trusted the
      // earlier read would fill "blanks" on a row a person had just settled —
      // the one thing pinning exists to forbid. The predicate is evaluated at
      // write time, so a row pinned since the read is simply left alone.
      tx
        .update(castMembers)
        .set(values)
        .where(and(eq(castMembers.id, id), eq(castMembers.pinned, false)))
        .run()
    }
  })

  // Not logged, for the reason `glossaries.merge` is not: a run learns a
  // character or two a page, and a hundred entries would bury the log a second
  // person reads to understand what has been happening.
  notify(context, { scope: 'cast' })
}

/** Forget one character — the panel's remove, for a name a model keeps proposing. */
export async function remove (context: Context, id: number): Promise<void> {
  await must(context, translateWorkspace, context)

  await db
    .delete(castMembers)
    .where(and(eq(castMembers.id, id), eq(castMembers.workspaceId, context.workspaceId)))

  notify(context, { scope: 'cast' })
}
