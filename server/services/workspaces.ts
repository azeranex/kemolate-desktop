/**
 * Workspaces: making them, listing them, and the two facts about one that its
 * owner may change.
 *
 * A workspace is made in the browser before it is made here — the id in the
 * address is minted client-side so that opening a folder works offline and
 * signed out. So `create` takes that id rather than issuing one, and the first
 * time the server hears of a workspace is usually when somebody signs in and it
 * is handed over. That is why this is an upsert on `publicId` and not an
 * insert.
 *
 * Desktop: one person, no accounts — a workspace has no owner row and no
 * contributors (see `schema.ts`). `claim` takes only the draft, the list is
 * every workspace, and `remove` has nobody else's work to protect.
 */
import { desc, eq } from 'drizzle-orm'

import { must } from './access'
import { record } from './logs'

import type { Context } from './access'
import type { NewWorkspace, Workspace } from '~~/server/database'

import { manageWorkspace } from '#shared/utils/abilities'
import { db, workspaces } from '~~/server/database'

/** What a caller may set when a workspace first arrives from a browser. */
export interface WorkspaceDraft {
  publicId: string
  name: string
  direction?: 'ltr' | 'rtl'
  sourceLocale?: string
  targetLocale?: string
}

/**
 * Record a workspace made in the window, or return the one already here.
 *
 * Idempotent by `publicId`, as in the web build: the lookup and the insert share
 * a transaction, so two calls at once cannot make two workspaces, and the second
 * is handed the first's row rather than an error from the unique index.
 */
export async function claim (draft: WorkspaceDraft): Promise<Workspace> {
  const claimed = db.transaction((tx) => {
    const [existing] = tx
      .select()
      .from(workspaces)
      .where(eq(workspaces.publicId, draft.publicId))
      .limit(1)
      .all()

    if (existing) return { workspace: existing, made: false }

    const values: NewWorkspace = { ...draft }
    const [workspace] = tx.insert(workspaces).values(values).returning().all()

    if (!workspace) throw new Error('Workspace could not be created.')

    return { workspace, made: true }
  })

  if (claimed.made) {
    await record({ workspaceId: claimed.workspace.id, userId: null, action: 'workspace.created' })
  }

  return claimed.workspace
}

/**
 * Every workspace, most recently touched first — the web build's `listFor`, for
 * the one person there is, in its shape: each the owner's, last seen when it
 * last changed.
 */
export async function listAll () {
  const rows = await db.select().from(workspaces).orderBy(desc(workspaces.updatedAt))

  return rows.map((workspace) => ({ ...workspace, role: 'owner' as const, lastSeenAt: workspace.updatedAt }))
}

/** What its owner may change about it. Everything else is a page or a person. */
export type WorkspacePatch = {
  name?: string
  direction?: 'ltr' | 'rtl'
  sourceLocale?: string
  targetLocale?: string
  /** How a page is prompted when there is no browser to ask — see the schema. */
  honorifics?: boolean
  wholePage?: boolean
}

export async function update (context: Context, patch: WorkspacePatch): Promise<Workspace> {
  await must(context, manageWorkspace, context)

  const [workspace] = await db
    .update(workspaces)
    .set(patch)
    .where(eq(workspaces.id, context.workspaceId))
    .returning()

  await record({
    workspaceId: context.workspaceId,
    userId: context.actor?.id ?? null,
    action: 'workspace.updated',
    detail: patch,
  })

  return workspace!
}

/**
 * Delete it, and everything filed under it.
 *
 * The cascades in the schema do the work, and they reach every row that is the
 * workspace's rather than somebody's: its pages, and under each page the
 * blocks, their translations and every revision of those, the layer stack, the
 * surfaces and their strokes, and the repairs rows; its glossaries and their
 * terms, the cast, the contributors, the invitations still outstanding, and the
 * log. Which means this is the one call here that cannot be undone.
 *
 * Two things stay, both on purpose. A repair's *file* is named by its hash and
 * may be another workspace's as well, so only the rows go and the files are
 * left for `repairs.sweep` to find unnamed. And an access token is a person's,
 * not a workspace's — one token opens every workspace its holder is in.
 *
 * ## Not while anybody else is in it (the web build)
 *
 * The switch that takes a workspace off the server — `blocked` in
 * `WorkspaceSettings` — refuses while anybody but the owner is a contributor:
 * a destructive control among harmless ones gets pressed by momentum, and
 * removing the other people first is an extra step in a rare case. That rule
 * lived only in the popover. A request that did not come through it — a
 * script, a tool, an older tab — took everybody's work on the owner's
 * standing alone, and even through the popover a check made in the browser is
 * only as good as the list it has read: one that has not arrived yet, or never
 * did, reads as nobody.
 *
 * So the rule is here, asked of every caller, site admins included — it is not
 * a question of who may, which `manageWorkspace` has already answered, but of
 * whether the workspace is in a state to go. Hence a 409, as for an owner who
 * tries to `leave`: the caller is entitled to the act and the workspace is in
 * the way, which is not the 403 an ability gives somebody the act was never
 * theirs to do.
 *
 * ## Unless the owner says "for everybody"
 *
 * The collection page's Delete is the other door, and it is a different act:
 * its dialog says, in so many words, that it deletes the chapter for everybody
 * in it, and the owner reading that and pressing it has decided exactly the
 * thing this rule exists to make sure somebody decided. So `everybody` lets a
 * delete through with other people still in it — and only that dialog sends
 * it. Refusing by default and opting in by name keeps every other caller,
 * "make local" above all, behind the rule; the first version of this refused
 * the dialog too and turned a deliberate act into an error.
 *
 * "Anybody else" is exactly whom the switch counts, `useContributors().guests`:
 * contributors below owner. They are the people whose work would go without
 * their having any say in it, and the only ones "remove them" can be done to —
 * the owner's own row cannot be removed, and a second owner holds
 * `manageWorkspace` already and could have deleted it themselves.
 *
 * The count and the delete share a transaction, so nobody can join between the
 * question and the answer and be deleted along with a workspace that was empty
 * when it was asked.
 */
export async function remove (context: Context, _options: { everybody?: boolean } = {}): Promise<void> {
  await must(context, manageWorkspace, context)

  // Desktop: nobody else's work is in it — see the header.
  await db.delete(workspaces).where(eq(workspaces.id, context.workspaceId))
}
