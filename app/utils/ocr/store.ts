/**
 * Where the OCR models live between visits: the origin's private filesystem.
 *
 * The scans already live there — see `utils/opfs.ts` — and the models now
 * keep them company, in a `models` directory beside the workspaces, one file
 * per fetched URL. OPFS over the Cache API for the same reason the chapters
 * use it: it is the storage this app treats as its disk, it is covered by
 * the one `persist()` request the app already makes, and what is kept there
 * is a file that can be looked at, not an entry inside an opaque cache.
 *
 * Both roads into a model go through here. The raw-session loader in
 * `onnx.ts` reads and writes directly; transformers.js is pointed at the
 * same store through its custom-cache hook, so the manga-ocr weights, the
 * detector, and every tokenizer and config file beside them all land in the
 * one directory.
 *
 * Models already sitting in the old Cache API caches are adopted rather
 * than re-downloaded: a miss here checks there, moves the bytes over, and
 * clears the old entry — several hundred megabytes nobody should have to
 * fetch twice. Browsers without a writable OPFS fall back to the Cache API
 * outright, which is exactly what this replaced and still works.
 */
// By hand rather than auto-imported, so a dev server already running picks up
// helpers it has not seen.
import { transformersOnce } from './onnx'

import { opfsRead, opfsUsable, opfsWrite } from '~/utils/opfs'

/** Beside `workspaces`, per the layout `utils/opfs.ts` established. */
const ROOT = 'models'

/** The Cache API homes models used to live in, kept for the fallback and the move. */
const LEGACY_CACHES = ['kemolate-onnx-v1', 'transformers-cache']

/** One URL, one file — encoded the way the chapter store encodes paths. */
const nameOf = (key: string) => encodeURIComponent(key)

/**
 * The stored bytes for a URL, or null — after first offering the miss to
 * the old caches, so an already-downloaded model moves house instead of
 * downloading again. The old entry is dropped once copied; the same bytes
 * twice is the one thing both stores together should never cost.
 */
export async function readModel (key: string): Promise<Blob | null> {
  if (!opfsUsable()) return readLegacy(key, false)

  const held = await opfsRead(ROOT, nameOf(key))

  if (held) return held

  const moving = await readLegacy(key, true)

  if (moving) await writeModel(key, moving)

  return moving
}

export async function writeModel (key: string, bytes: Blob): Promise<void> {
  if (!opfsUsable()) {
    // The fallback keeps the old arrangement: same cache, same keys.
    await caches.open(LEGACY_CACHES[0]!).then((cache) => cache.put(key, new Response(bytes))).catch(() => {})

    return
  }

  // A store that cannot be written costs a re-download later, not a reading now.
  await opfsWrite(ROOT, nameOf(key), bytes)
}

/** A look through the old homes, optionally clearing what it finds. */
async function readLegacy (key: string, evict: boolean): Promise<Blob | null> {
  for (const name of LEGACY_CACHES) {
    try {
      const cache = await caches.open(name)
      const hit = await cache.match(key)

      if (!hit) continue

      const bytes = await hit.blob()

      if (evict) await cache.delete(key).catch(() => {})

      return bytes
    } catch {
      continue
    }
  }

  return null
}

let pointed = false

/**
 * Point transformers.js at this store, once.
 *
 * Its custom-cache hook speaks the Cache API's shape — `match` and `put`
 * with URLs and Responses — which maps straight onto the files here. Every
 * loader that goes through the library calls this before `from_pretrained`,
 * so nothing depends on which engine happened to load first.
 */
export async function opfsModelCache (): Promise<void> {
  if (pointed) return

  // Through `transformersOnce`, never straight in: this is usually the first
  // thing to import the library, and importing it any other way leaves its
  // inference on the page's thread — see there.
  const { env } = await transformersOnce()

  // Fetched from this install rather than from the Hub — see
  // `server/api/models/[...path]`, which keeps one copy for everybody. The
  // library builds its URLs as `<remoteHost><remotePathTemplate>/<file>`, so
  // pointing the host at our route is enough; the path it appends is exactly
  // the Hub path the route expects.
  env.remoteHost = `${window.location.origin}/api/models/`
  env.remotePathTemplate = '{model}/resolve/{revision}/'

  env.useBrowserCache = false
  env.useCustomCache = true
  env.customCache = {
    match: async (key: string) => {
      const bytes = await readModel(key).catch(() => null)

      // With its length said. A Response made from a Blob carries none, and
      // the library sizes its buffer from `Content-Length` — without one it
      // grows the buffer by copying everything read so far into a larger one,
      // chunk after chunk, in one unbroken task. The 117 MB decoder read that
      // way took 450 ms and held this thread for 415 of them; told its size,
      // 52 ms and never more than 3. The 343 MB encoder held it for 3.8 s.
      return bytes ? new Response(bytes, { headers: { 'Content-Length': String(bytes.size) } }) : undefined
    },
    put: async (key: string, response: Response) => {
      await writeModel(key, await response.blob()).catch(() => {})
    },
  }

  pointed = true
}
