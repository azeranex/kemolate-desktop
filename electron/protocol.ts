/**
 * The built app, served from `app://kemolate/` rather than opened as files.
 *
 * Loaded from `file://`, the page would sit at an origin Chromium treats as
 * opaque and unprivileged, and what the app keeps on this machine leans on the
 * web platform's storage: OPFS for thumbnails, previews and a chapter copied in
 * (`utils/opfs.ts`), IndexedDB for the workspace records. A registered scheme
 * marked `standard` and `secure` is an ordinary, stable origin for all of it —
 * and stable matters: a store is keyed by its origin, so moving the app between
 * origins would lose everything kept under the old one.
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

export const APP_ORIGIN = 'app://kemolate'

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

/** Before the app is ready: the scheme's privileges are fixed at startup. */
export function registerAppScheme () {
  protocol.registerSchemesAsPrivileged([{
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true },
  }])
}

/** Once the app is ready: answer `app://kemolate/...` from `dist`. */
export function serveApp (dist: string) {
  const root = path.resolve(dist)

  protocol.handle('app', async (request) => {
    const { pathname } = new URL(request.url)
    const file = path.resolve(root, `.${decodeURIComponent(pathname === '/' ? '/index.html' : pathname)}`)

    if (file !== root && !file.startsWith(root + path.sep)) return new Response('Not found', { status: 404 })

    const response = await net.fetch(pathToFileURL(file).toString()).catch(() => null)

    if (!response?.ok) return new Response('Not found', { status: 404 })

    return new Response(response.body, {
      status: 200,
      headers: {
        'Content-Type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'credentialless',
      },
    })
  })
}
