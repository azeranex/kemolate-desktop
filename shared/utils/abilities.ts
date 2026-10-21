/**
 * What someone may do in a workspace — desktop: the names, and nothing to check.
 *
 * The web build's abilities are `nuxt-authorization` rules over a signed-in user
 * and their role in a workspace: viewer, translator, editor, owner. The desktop
 * app is one person on their own machine, with no accounts and no sharing, so
 * there is nobody to refuse. The services carried from the web build still name
 * the ability each write needs — `must(context, editWorkspace, context)` — and
 * keeping the names lets them be carried verbatim; `must` in
 * `server/services/access.ts` allows every one.
 */
import type { WorkspaceRole } from './roles'

/** A workspace and the asker's standing in it — always the owner's here. */
export interface Access {
  workspaceId: number
  role: WorkspaceRole | null
}

/** The name of a rule, as the web build's services pass it to `must`. */
export type Ability = 'view' | 'translate' | 'edit' | 'manage' | 'manageContributors'

export const viewWorkspace: Ability = 'view'
export const translateWorkspace: Ability = 'translate'
export const editWorkspace: Ability = 'edit'
export const manageWorkspace: Ability = 'manage'
export const manageContributors: Ability = 'manageContributors'
