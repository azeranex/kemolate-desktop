/**
 * Model weights, fetched once per machine and kept on disk — the web build's
 * `server/api/models/[...path].get.ts`, which there kept them once per install.
 *
 * The renderer asks for `/api/models/<Hub path>` on its own origin, exactly as
 * in the web build: `localModel()` rewrites Hub URLs to it, and transformers.js
 * is pointed at it (`utils/ocr/store.ts`). Answered here — by the `app://`
 * handler in the built app (`electron/protocol.ts`) and by the dev server's
 * middleware in development (`vite.config.ts`) — so those files are carried
 * across unchanged. The rules are the web build's:
 *
 * - A path must look like a Hub path and nothing else: no `..`, no odd
 *   characters. It is a file name on this disk.
 * - A file is kept under its Hub path, so a model is found again by the same
 *   address it was asked for. transformers.js 4.2 asks for an `onnx/` folder
 *   whether or not the repo has one, so a trailing `onnx/` is also tried
 *   without it — see `candidates`.
 * - `kemolate/…` is this project's own models (the fp16 detector, Kemolate OCR).
 *   They are never asked of the Hub, whose namespace that is not. In the web
 *   build they are placed on disk by hand and a miss is a 404.
 *
 *   Desktop: Kemolate OCR is the default reader here, and an install that had
 *   to have it copied in by hand could not read a page. So a miss is fetched
 *   from **our own address** (`OWN_MODELS`) when one is set — `kemolate/<name>/…`
 *   from `<OWN_MODELS>/<name>/…`, which a Hugging Face account's repos of the
 *   same names answer as written — and kept like any other model. Unset, a
 *   miss is the 404 it was, saying why.
 *
 * Whole files, not ranges, as in the web build: transformers.js and the model
 * store read a file at once, and the store needs its length (see `store.ts`).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const UPSTREAM = 'https://huggingface.co'

/**
 * Where this project's own models are downloaded from — the base a model's
 * name and file are put after, e.g. `https://huggingface.co/<account>`. Not
 * decided yet, so empty; `KEMOLATE_MODELS_URL` in the environment overrides it,
 * for trying an address before it is written in here.
 */
const OWN_MODELS = (process.env.KEMOLATE_MODELS_URL ?? '').replace(/\/+$/, '')

const OURS = /^kemolate\//

const SAFE = /^[\w.-]+(?:\/[\w.-]+)*$/

/** The path as asked, then — for a file asked for under `onnx/` — without that folder. */
function candidates (asked: string): string[] {
  const flattened = asked.replace(/\/onnx\/(?=[^/]+$)/, '/')

  return flattened === asked ? [asked] : [asked, flattened]
}

export interface ModelAnswer {
  status: number
  body?: Uint8Array
  message?: string
}

/** Answer one `/api/models/<path>` request from `root`, fetching from the Hub on a miss. */
export async function answerModel (root: string, requested: string): Promise<ModelAnswer> {
  const asked = decodeURIComponent(requested).replace(/^\/+/, '')

  if (!asked || !SAFE.test(asked) || asked.includes('..')) return { status: 400, message: 'Bad model path.' }

  const tries = candidates(asked)

  for (const each of tries) {
    const held = await readFile(path.join(root, ...each.split('/'))).catch(() => null)

    if (held) return { status: 200, body: held }
  }

  const ours = OURS.test(asked)

  if (ours && !OWN_MODELS) {
    return { status: 404, message: 'Kemolate’s own models are not on this computer, and no address to download them from is set.' }
  }

  let upstream: Response | null = null

  for (const each of tries) {
    const from = ours ? `${OWN_MODELS}/${each.slice('kemolate/'.length)}` : `${UPSTREAM}/${each}`

    upstream = await fetch(from).catch(() => null)

    if (upstream?.ok) break
  }

  if (!upstream?.ok) {
    return {
      status: upstream?.status === 404 ? 404 : 502,
      message: `The model could not be fetched (${upstream?.status ?? 'offline'}).`,
    }
  }

  const bytes = new Uint8Array(await upstream.arrayBuffer())
  const file = path.join(root, ...asked.split('/'))

  // Best effort: a disk that will not take it costs the next run another
  // fetch, not this one its model.
  await mkdir(path.dirname(file), { recursive: true })
    .then(() => writeFile(file, bytes))
    .catch((error: unknown) => { console.warn('[kemolate] model not cached:', asked, error) })

  return { status: 200, body: bytes }
}

/** The headers every model answer carries. Immutable: a different model is a different path. */
export const MODEL_HEADERS = {
  'Content-Type': 'application/octet-stream',
  'Cache-Control': 'public, max-age=31536000, immutable',
} as const
