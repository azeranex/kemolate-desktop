/**
 * Who is signed in — a stand-in for `nuxt-auth-utils`' composable of the same
 * name, because the desktop app has no accounts.
 *
 * Always somebody, since 2026-10-21. The web build's composables keep a
 * workspace's work in the database only when a reader is signed in — signed
 * out, it is a "local" workspace and lives in the browser's IndexedDB, which is
 * where the desktop kept everything until Chromium deleted a corrupt one and a
 * chapter's work went with it. The database is now this machine's own
 * (`electron/database.ts`), and there is one person at it, so the answer is
 * yes. Nothing reads who: there is no user row, and the server code records
 * `null` wherever the web build would have written an id.
 */
const loggedIn = computed(() => true)

export function useUserSession () {
  return { loggedIn }
}
