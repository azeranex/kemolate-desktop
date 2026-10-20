/**
 * Who is signed in — a stand-in for `nuxt-auth-utils`' composable of the same
 * name, because the desktop app has no accounts.
 *
 * Nobody is, ever, and that is the whole of it: every web build file that asks
 * already has a signed-out branch, and on that branch a workspace is local, is
 * made with no server row and is listed from this machine alone. What the files
 * read is `loggedIn`, so that is what this answers.
 */
const loggedIn = computed(() => false)

export function useUserSession () {
  return { loggedIn }
}
