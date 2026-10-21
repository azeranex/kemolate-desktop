import { describe, it } from 'vitest'

/**
 * The switch that moves a workspace between this browser and an account.
 *
 * **Needs the nuxt project** and a stubbed server; nothing here should touch a
 * real record.
 *
 * The two directions are not mirror images, and the tests should not read as
 * though they are. Going to the cloud is **additive**: a record is created and
 * the watchers that were waiting on it push what is already on the page. There
 * is nothing to warn about and nothing to lose.
 *
 * Coming back is a **deletion**, and the file's own header says why it is a
 * refusal rather than a confirmation — this popover is otherwise full of
 * harmless controls, and a destructive one among them gets pressed by momentum.
 * So the cases below are mostly about *not* doing it: not while somebody else
 * is in the workspace, not for a member who is not the owner, and not silently
 * when the server says no.
 *
 * The last group is the one that matters most to a reader. Whatever the switch
 * does to the server, the pages, the reading and the paint are this browser's
 * and must survive both directions untouched. A promote that moved them, or a
 * demote that cleared them, would be the app breaking its own promise about
 * where the work lives.
 *
 * Seam: `useWorkspaceName`'s returned surface — `keeping`, `because`,
 * `renameable`, `rename`, `toCloud`, `toLocal`.
 */

describe('which it is now', () => {
  it.todo('reads cloud when the workspace has a record')
  it.todo('reads local when it has none')
  it.todo('says a signed-out reader cannot promote, and why')
  it.todo('says a signed-in reader with no record simply has not promoted yet')
})

describe('renaming', () => {
  it.todo('lets anybody rename a local workspace')
  it.todo('lets an editor rename a cloud one')
  it.todo('refuses a viewer')
  it.todo('prefers the open chapter\'s title to the stored name')
})

describe('promoting — additive, and nothing to lose', () => {
  it.todo('creates the record and reads it back rather than assuming it')
  it.todo('does nothing when the workspace is already in the cloud')
  it.todo('refuses when nobody is signed in')
  it.todo('leaves keeping local when the server could not be reached')
  it.todo('says so rather than appearing to have worked')
  it.todo('can be pressed twice without making two workspaces')
})

describe('demoting — a deletion wearing a toggle', () => {
  it.todo('refuses while anybody else is a contributor')
  it.todo('refuses a member who is not the owner')
  it.todo('refuses a signed-out caller')
  it.todo('deletes the record when the owner asks and is alone in it')
  it.todo('leaves keeping cloud when the server refused')
  it.todo('does not report success on a refusal')
})

describe('what a reader keeps, whichever way the switch goes', () => {
  it.todo('keeps the open chapter\'s pages through a promote')
  it.todo('keeps the reading and the paint through a promote')
  it.todo('keeps all of it through a demote, which is what the panel promises')
  it.todo('leaves the browser with a workspace it can still work in')
})
