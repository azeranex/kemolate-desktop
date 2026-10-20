/**
 * The reader's provider keys, kept by the operating system.
 *
 * In the web build a key is sealed in the browser under a passcode and stored
 * against the reader's account on a server that cannot read it (see the web
 * build's `useProviderKeys` and `server/services/keys.ts`). The desktop app has
 * neither an account nor a server, and it does not need the passcode for the
 * job the passcode did there: keeping the key unreadable to whoever holds the
 * storage. Here that is the OS's own credential protection, through Electron's
 * `safeStorage` — DPAPI on Windows, the Keychain on macOS, the desktop's secret
 * service on Linux — which ties the encrypted file to this user's login. Copied
 * to another machine or read by another account, it is noise.
 *
 * ## The file
 *
 * `keys.json` in the app's profile: one entry per provider, each the base64 of
 * what `safeStorage.encryptString` returned. Nothing else is in it — not the
 * hint, which is worked out from the key whenever it is asked for, so there is
 * no second copy of any part of a key to forget to update.
 *
 * ## Never in the clear, which is the web build's rule kept
 *
 * There is no write that accepts a key the OS cannot encrypt. Where
 * `safeStorage` is unavailable — or on Linux, where it falls back to the
 * `basic_text` backend, which is a fixed, published password and so no
 * protection at all — `save` refuses and says why, rather than writing a key
 * readable by anything that can read the profile. The web build's settings
 * page refuses on the same principle when there is no vault: "this install has
 * no way to store one it could read" is the sentence there.
 *
 * ## Who may ask
 *
 * Only the app's own page. A key leaves here in the clear — the renderer calls
 * OpenRouter and Vision itself, as the browser does in the web build — so every
 * handler checks that the frame asking is the app's origin, and a provider name
 * that is not one of `PROVIDER_IDS` is refused rather than becoming a key in the
 * file.
 */
import type { IpcMainInvokeEvent } from 'electron'

import type { Provider } from '../shared/utils/providers'
import type { KeyStatus } from './preload'

import { app, ipcMain, safeStorage } from 'electron'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { PROVIDER_IDS } from '../shared/utils/providers'

/** A key longer than this is not a key; it is a paste gone wrong. */
const MAX_KEY = 1024

const file = () => path.join(app.getPath('userData'), 'keys.json')

function availability (): { available: boolean, reason: string | null } {
  if (!safeStorage.isEncryptionAvailable()) {
    return { available: false, reason: 'This system offers no encryption the app could keep a key under.' }
  }

  // Linux only: the fallback when no secret service is running. A hard-coded
  // password, so encrypting with it hides nothing from anyone who looks.
  if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') {
    return { available: false, reason: 'No keyring is running, so a key could only be stored readable. Start your desktop’s keyring (GNOME Keyring or KWallet) and reopen the app.' }
  }

  return { available: true, reason: null }
}

function readAll (): Partial<Record<Provider, string>> {
  if (!existsSync(file())) return {}

  try {
    const parsed: unknown = JSON.parse(readFileSync(file(), 'utf8'))

    if (!parsed || typeof parsed !== 'object') return {}

    return Object.fromEntries(Object.entries(parsed).filter(([provider, value]) =>
      PROVIDER_IDS.includes(provider as Provider) && typeof value === 'string')) as Partial<Record<Provider, string>>
  } catch {
    // An unreadable file is no keys, not a crash at start — and it is left on
    // disk rather than overwritten until somebody saves.
    return {}
  }
}

/** Written beside and renamed over, so a crash mid-write cannot leave half a file. */
function writeAll (sealed: Partial<Record<Provider, string>>) {
  const target = file()
  const temporary = `${target}.tmp`

  writeFileSync(temporary, JSON.stringify(sealed, null, 2), { mode: 0o600 })
  renameSync(temporary, target)
}

function open (sealed: string): string | null {
  try {
    return safeStorage.decryptString(Buffer.from(sealed, 'base64'))
  } catch {
    // Sealed under another login or another machine — the file was copied.
    return null
  }
}

/** Ends in, the way every provider prints them — never the key itself. */
const hintOf = (key: string) => (key.length <= 4 ? '••••' : `••••${key.slice(-4)}`)

function status (): KeyStatus {
  const keys: KeyStatus['keys'] = []

  for (const [provider, sealed] of Object.entries(readAll())) {
    const plain = sealed ? open(sealed) : null

    if (plain) keys.push({ provider: provider as Provider, hint: hintOf(plain) })
  }

  return { ...availability(), keys }
}

const isProvider = (value: unknown): value is Provider =>
  typeof value === 'string' && PROVIDER_IDS.includes(value as Provider)

/**
 * Register the handlers. `trusted` says whether an IPC call came from the app's
 * own page — see "Who may ask" above.
 */
export function serveKeys (trusted: (event: IpcMainInvokeEvent) => boolean) {
  ipcMain.handle('keys:status', (event) => {
    if (!trusted(event)) throw new Error('Not the app.')

    return status()
  })

  ipcMain.handle('keys:get', (event, provider: unknown) => {
    if (!trusted(event)) throw new Error('Not the app.')

    if (!isProvider(provider)) return null

    const sealed = readAll()[provider]

    return sealed ? open(sealed) : null
  })

  /**
   * The web build's patch semantics: an absent provider is left alone, an empty
   * string removes that key, anything else replaces it.
   */
  ipcMain.handle('keys:save', (event, patch: unknown) => {
    if (!trusted(event)) throw new Error('Not the app.')

    if (!patch || typeof patch !== 'object') throw new Error('Nothing to save.')

    const { available, reason } = availability()

    if (!available) throw new Error(reason ?? 'Keys cannot be stored on this system.')

    const sealed = readAll()

    for (const [provider, value] of Object.entries(patch)) {
      if (!isProvider(provider) || typeof value !== 'string') continue

      const key = value.trim()

      if (key.length > MAX_KEY) throw new Error(`That ${provider} key is too long to be a key.`)

      if (key) sealed[provider] = safeStorage.encryptString(key).toString('base64')
      else delete sealed[provider]
    }

    writeAll(sealed)

    return status()
  })
}
