/**
 * Who may do what, as an ordered thing rather than a set of flags.
 *
 * Roles in a workspace nest: an owner can do everything an editor can, an
 * editor everything a translator can. Saying that with a rank means a check
 * reads "at least an editor" rather than listing the roles that qualify — and
 * a new role added in the middle does not send anyone hunting for every list it
 * should have joined.
 *
 * Lives in `shared/` because both sides ask the question. The server decides,
 * but the interface has to know too: a button that cannot work should not be
 * offered, and finding out by pressing it is not an answer.
 *
 * The same four names are declared as a column enum in the database schema.
 * That is a deliberate duplication — the schema is read by drizzle-kit outside
 * of Nuxt, where the `#shared` alias does not resolve, so it cannot import
 * this. Change one and change the other.
 */

/** In a workspace, lowest first. */
export const WORKSPACE_ROLES = ['viewer', 'translator', 'editor', 'owner'] as const

export type WorkspaceRole = typeof WORKSPACE_ROLES[number]

/** Across the whole install, and only for what has no workspace to belong to. */
export type SiteRole = 'admin' | 'member'

const RANK = new Map<WorkspaceRole, number>(WORKSPACE_ROLES.map((role, index) => [role, index]))

/**
 * Whether a role reaches a bar — with `null` meaning "not a contributor here",
 * which is a real answer and always no.
 */
export function atLeast (role: WorkspaceRole | null | undefined, bar: WorkspaceRole): boolean {
  if (!role) return false

  return (RANK.get(role) ?? -1) >= (RANK.get(bar) ?? Infinity)
}
