/**
 * The reader's own API keys — a stand-in, until the desktop's key store exists.
 *
 * In the web build keys are sealed in the browser under a passcode and kept
 * server-side against the account (see the web build's CLAUDE.md, "The one
 * invariant"). The desktop app has no account and no server: its keys will live
 * in the operating system's credential store, behind the preload bridge. That
 * is not built yet, so a key asked for is refused aloud — the caller shows the
 * message — rather than run without one. Today only the Google Vision reader
 * asks; the default readers need no key.
 */
import type { Provider } from '#shared/utils/providers'

export function useProviderKeys () {
  async function require (provider: Provider): Promise<string> {
    throw new Error(`Keys for ${PROVIDERS[provider].label} are not available in the desktop app yet.`)
  }

  return { require }
}
