/**
 * The built app, served from `https://app.kemolate.invalid/` rather than opened
 * as files.
 *
 * Loaded from `file://`, the page would sit at an origin Chromium treats as
 * opaque and unprivileged, and what the app keeps on this machine leans on the
 * web platform's storage: OPFS for thumbnails, previews and a chapter copied in
 * (`utils/opfs.ts`), IndexedDB for the workspace records. So it is served from
 * an ordinary, stable, secure origin — and stable matters: a store is keyed by
 * its origin, so moving the app between origins loses everything kept under the
 * old one. **Do not change `APP_ORIGIN`.**
 *
 * `https`, not a scheme of the app's own. It was `app://kemolate` for a while,
 * and transformers.js would not load a tokenizer from it: before fetching one it
 * checks the file exists, and that check answers "no" for any URL that is not
 * `http:` or `https:` (`fetch_file_head` in its `get_file_metadata.js`) — so
 * manga-ocr's tokenizer came back `undefined` with no request ever made. The
 * detector loaded only because weights skip that check.
 *
 * Only this one host is answered here; every other `https` request goes on to
 * the network untouched. The host is under `.invalid`, which is reserved never
 * to resolve (RFC 2606), so nothing meant for the app can reach a real server
 * even if this handler were ever missing.
 *
 * Every response carries the cross-origin-isolation headers the web build sends
 * from `routeRules` (COOP `same-origin`, COEP `credentialless`), so wasm gets
 * `SharedArrayBuffer` and onnxruntime its threads, as there.
 *
 * Only files inside `dist/` are served; anything that resolves outside it is a
 * 404, so a crafted path cannot read the rest of the disk through the page.
 */
import { net, protocol } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { answerModel, MODEL_HEADERS } from '../server/models'
import { openedFile } from './opening'

const APP_HOST = 'app.kemolate.invalid'

export const APP_ORIGIN = `https://${APP_HOST}`

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
}

const ISOLATION = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
} as const

/**
 * Once the app is ready: answer the app's host from `dist`, and its
 * `/api/models/...` from the model store in `models` — the web build's model
 * route, at the same path on the page's own origin (see `server/models.ts`).
 * The ONNX runtime's own files are in `dist/ort/`, put there by the build so
 * wasm loads from here rather than a CDN. Any other host is passed through.
 */
export function serveApp (dist: string, models: string) {
  const root = path.resolve(dist)

  protocol.handle('https', async (request) => {
    const { host, pathname } = new URL(request.url)

    if (host !== APP_HOST) return net.fetch(request, { bypassCustomProtocolHandlers: true })

    // A project file the operating system handed the app — see `opening.ts`.
    // Readable from any origin because the dev server's page is another one;
    // what makes that safe is the token, which is unguessable and spent once.
    if (pathname.startsWith('/opened/')) {
      const answer = await openedFile(decodeURIComponent(pathname.slice('/opened/'.length)))

      if (!answer?.ok) return new Response('Not found', { status: 404 })

      return new Response(answer.body, {
        status: 200,
        headers: { 'Content-Type': 'application/zip', 'Access-Control-Allow-Origin': '*', ...ISOLATION },
      })
    }

    if (pathname.startsWith('/api/models/')) {
      const answer = await answerModel(models, pathname.slice('/api/models/'.length))

      if (!answer.body) return new Response(answer.message ?? '', { status: answer.status })

      return new Response(answer.body, {
        status: 200,
        // Content-Length outright: the model store hands transformers.js a
        // response whose length it can read, or it re-copies its whole buffer
        // per chunk — see `utils/ocr/store.ts`.
        headers: { ...MODEL_HEADERS, ...ISOLATION, 'Content-Length': String(answer.body.byteLength) },
      })
    }
    const file = path.resolve(root, `.${decodeURIComponent(pathname === '/' ? '/index.html' : pathname)}`)

    if (file !== root && !file.startsWith(root + path.sep)) return new Response('Not found', { status: 404 })

    const response = await net.fetch(pathToFileURL(file).toString()).catch(() => null)

    if (!response?.ok) return new Response('Not found', { status: 404 })

    return new Response(response.body, {
      status: 200,
      headers: {
        'Content-Type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        ...ISOLATION,
      },
    })
  })
}
