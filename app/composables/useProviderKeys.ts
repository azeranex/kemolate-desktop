/**
 * The reader's provider keys, in the window that is going to spend them.
 *
 * ## Desktop: the web build's composable, with the vault taken out
 *
 * In the web build keys live on the server, sealed in the browser under a
 * passcode before they are sent, and most of that file is the passcode: deriving
 * a key from it, wrapping and unwrapping, asking for it when a run meets a
 * locked vault. All of that existed so a *server* could hold a key it could not
 * read. Here there is no server; the keys are kept by the operating system,
 * encrypted against this user's login (`electron/keys.ts`, through the preload
 * bridge), and the login is the lock. So there is no passcode, nothing is ever
 * locked, and `unlock`, `lock`, `setPasscode`, `removePasscode` and `vault` are
 * gone rather than stubbed — nothing ported calls them; only the web build's
 * `KeyPasscode`, `KeyUnlock` and settings page did.
 *
 * What is kept is what the run and the settings page use, with the web build's
 * meanings: `require` (the key, or a refusal naming which is missing and where
 * to put it), `get`, `save` (absent: left alone; empty: removed), `reload`,
 * `loaded`, `trouble`, `has`. And the web build's rule that a key is held **in
 * memory only** once asked for: it is read from the OS store when a run first
 * wants it and kept for the window's life, never put in any web storage.
 *
 * The one thing new is `status`: which keys are stored and what each ends in,
 * from the main process — the web build's `/api/settings/status`. The key itself
 * is never in it.
 */
import type { Provider } from '#shared/utils/providers'
import type { KeyStatus } from '../../electron/preload'

/** Keys asked for so far — plaintext, in memory only. Module level: one answer for every caller. */
const keys = ref<Partial<Record<Provider, string>>>({})

/** What the OS store says it holds, and whether it can hold anything. Null until asked. */
const status = ref<KeyStatus | null>(null)

/** True once the store has answered, so "no key" and "not asked yet" stay apart. */
const loaded = ref(false)

/** Why the last attempt could not answer — null when it could. See the web build's `trouble`. */
const trouble = ref<string | null>(null)

/** The one status read in flight — see `asking` in the web build. */
let asking: Promise<KeyStatus | null> | null = null

/**
 * The bridge's key store, or null where there is none — a renderer opened in a
 * plain browser, where nothing keeps keys for it.
 */
const store = () => (typeof window === 'undefined' ? null : window.kemolate?.keys ?? null)

export function useProviderKeys () {
  async function load (): Promise<KeyStatus | null> {
    if (loaded.value) return status.value

    asking ??= ask().finally(() => { asking = null })

    return asking
  }

  async function ask (): Promise<KeyStatus | null> {
    const bridge = store()

    if (!bridge) {
      trouble.value = 'Keys are kept by the desktop app, and this page is open outside it.'

      return null
    }

    try {
      status.value = await bridge.status()
    } catch (error) {
      // Nothing written: `loaded` stays false so the next caller asks again,
      // and whatever was known stays known — the web build's rule.
      trouble.value = 'Could not reach your keys just now.'
      console.warn('[kemolate] provider keys not read:', error)

      return status.value
    }

    trouble.value = null
    loaded.value = true

    return status.value
  }

  async function get (provider: Provider): Promise<string | null> {
    const held = keys.value[provider]

    if (held) return held

    const bridge = store()

    if (!bridge) return null

    const key = await bridge.get(provider)

    if (key) keys.value = { ...keys.value, [provider]: key }

    return key
  }

  /**
   * The key, or a refusal naming which one is missing and where to put it —
   * every caller wants the same sentence, and "translate did nothing" is a far
   * worse thing to be told than "there is no OpenRouter key yet".
   */
  async function require (provider: Provider): Promise<string> {
    const key = await get(provider)

    if (key) return key

    throw new Error(`No ${PROVIDERS[provider].label} key yet — add one in Settings (File › Settings…).`)
  }

  /** Ask again, after the settings page has changed something. */
  async function reload () {
    loaded.value = false

    return load()
  }

  /**
   * Write keys: an absent provider is left alone, an empty string removes that
   * key, anything else replaces it. The keys held in memory are dropped for every
   * provider the patch names, so the next run reads what was just written.
   */
  async function save (patch: Partial<Record<Provider, string>>): Promise<void> {
    const bridge = store()

    if (!bridge) throw new Error('Keys are kept by the desktop app, and this page is open outside it.')

    status.value = await bridge.save({ ...patch })
    loaded.value = true
    trouble.value = null

    keys.value = Object.fromEntries(Object.entries(keys.value).filter(([provider]) => !(provider in patch)))
  }

  /** Whether a key is stored for this provider — from the status, so it needs no key in memory. */
  const has = (provider: Provider) => computed(() => Boolean(status.value?.keys.some((key) => key.provider === provider)))

  return {
    keys,
    status,
    loaded,
    trouble,
    load,
    get,
    require,
    reload,
    save,
    has,
  }
}
