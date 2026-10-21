/**
 * The parts of Nuxt's runtime the web build's files call, recreated so those
 * files can be carried across verbatim.
 *
 * Not in the web build, and not a port of Nuxt: each function here does the
 * one thing the app actually asks of its namesake, on a single-window desktop
 * app with no server render. They are auto-imported like everything else in
 * `composables/`, so a ported file that says `useState(...)` or
 * `useRoute().params.workspaceId` means here what it meant there.
 *
 * - `useState` — one shared ref per key, made once. The app leans on it 160
 *   times as its way of saying "module-level, but created lazily".
 * - `useRoute` / `useRouter` / `navigateTo` — the desktop app has no URLs, but
 *   it still has *which workspace is open*, and the web build reads that off the
 *   route (`route.params.workspaceId`, 34 times). So there is one route, held in
 *   memory, and the paths the app can be at: `/` (the collection of
 *   workspaces), `/settings` and `/w/<id>`. `App.vue` draws whichever one it is.
 * - `useNuxtApp` — a stable object per app. `useComic` keys its view state on
 *   it; nothing reads anything off it.
 * - `useCookie` — a ref kept in local storage, as JSON, under the cookie's name.
 *   The web build used cookies so its server could render with them; here
 *   storage is read synchronously before the first paint, which is the same
 *   guarantee by the plainer route.
 * - `$fetch` — the web build's requests to its server, answered by the main
 *   process over IPC (`electron/data.ts`); see below.
 * - `useHead` and `onNuxtReady` — the title, and "once the app is up".
 *
 * `import.meta.client`, `.server` and `.dev` are defined at build time in
 * `vite.config.ts`, next to the auto-imports, for the same reason.
 */
import type { Ref } from 'vue'

const states = new Map<string, Ref<unknown>>()

export function useState<T> (key: string, init?: () => T): Ref<T> {
  let state = states.get(key) as Ref<T> | undefined

  if (!state) {
    state = ref(init ? init() : undefined) as Ref<T>
    states.set(key, state as Ref<unknown>)
  }

  return state
}

/** Forget a `useState` key, as Nuxt's `clearNuxtState` does. */
export function clearNuxtState (key?: string) {
  if (key === undefined) states.clear()
  else states.delete(key)
}

const app = Object.freeze({ name: 'kemolate-desktop' })

export function useNuxtApp () {
  return app
}

export interface DesktopRoute {
  path: string
  fullPath: string
  params: { workspaceId?: string }
  query: Record<string, string | undefined>
}

const route = reactive<DesktopRoute>({ path: '/', fullPath: '/', params: {}, query: {} })

/** Where the app is. Reactive, and the same object every time it is asked for. */
export function useRoute (): DesktopRoute {
  return route
}

/** The paths the desktop app has besides a workspace. */
const PLACES = new Set(['/', '/settings', '/ocr-lab'])

/**
 * The places drawn *over* the open workspace (see `App.vue`), which therefore
 * leave its id on the route — Settings, and the OCR lab.
 */
const OVER = new Set(['/settings', '/ocr-lab'])

/**
 * Go somewhere. Only the paths the desktop app has are understood — `/`,
 * `/settings` and `/w/<id>` — and anything else (the web build's `/signin`,
 * `/account`) is refused aloud rather than turned into a blank screen.
 */
export async function navigateTo (to: string | { path?: string, query?: Record<string, string | undefined> }) {
  const target = typeof to === 'string' ? to : (to.path ?? route.path)
  const [path = '/', search = ''] = target.split('?')
  const workspace = /^\/w\/([^/]+)$/.exec(path)

  if (!PLACES.has(path) && !workspace) {
    console.warn(`[kemolate] No such place in the desktop app: ${target}`)
    return
  }

  route.path = path
  route.fullPath = target
  // Settings is drawn *over* the open workspace (see `App.vue`), so the
  // workspace it covers is still the one open: its id stays on the route. Taken
  // off, every composable that watches `route.params.workspaceId` would read a
  // look at Settings as the workspace closing — and resetting.
  if (!OVER.has(path)) route.params = workspace ? { workspaceId: decodeURIComponent(workspace[1]!) } : {}
  route.query = typeof to === 'string'
    ? Object.fromEntries(new URLSearchParams(search))
    : { ...(to.query ?? {}) }
}

export function useRouter () {
  return {
    currentRoute: computed(() => route),
    push: navigateTo,
    replace: (to: string | { path?: string, query?: Record<string, string | undefined> }) =>
      navigateTo(typeof to === 'string' ? to : { path: to.path ?? route.path, query: to.query }),
  }
}

const cookies = new Map<string, Ref<unknown>>()

export function useCookie<T> (name: string, options: { default?: () => T } = {}): Ref<T> {
  let cookie = cookies.get(name) as Ref<T> | undefined

  if (!cookie) {
    cookie = useLocalStorage<T>(`cookie:${name}`, options.default ? options.default() : (null as T), {
      serializer: { read: (raw) => JSON.parse(raw) as T, write: (value) => JSON.stringify(value) },
    }) as Ref<T>
    cookies.set(name, cookie as Ref<unknown>)
  }

  return cookie
}

export interface FetchOptions {
  method?: string
  /** JSON, or the bytes of a repair (a `Blob`). */
  body?: unknown
  query?: Record<string, unknown>
  params?: Record<string, unknown>
  headers?: Record<string, string>
  responseType?: 'json' | 'blob' | 'arrayBuffer' | 'text'
  signal?: AbortSignal | null
}

/**
 * A refused request, shaped as ofetch's `FetchError` is — the composables read
 * `statusCode`, and `data.data` for what the handler attached (`useBlockSync`
 * reads `data.data.missing` off a 409).
 */
export class FetchError extends Error {
  readonly status: number
  readonly statusCode: number
  readonly statusMessage: string
  readonly data: { statusCode: number, statusMessage: string, message: string, data?: unknown }

  constructor (method: string, url: string, status: number, message: string, data?: unknown) {
    super(`[${method}] "${url}": ${status} ${message}`)
    this.name = 'FetchError'
    this.status = status
    this.statusCode = status
    this.statusMessage = message
    this.data = { statusCode: status, statusMessage: message, message, data }
  }
}

/** A query as a URL would carry it: strings, with nothing for `undefined`. */
function queryOf (options: FetchOptions): Record<string, string> {
  const query: Record<string, string> = {}

  for (const [key, value] of Object.entries(options.query ?? options.params ?? {})) {
    if (value !== undefined && value !== null) query[key] = String(value)
  }

  return query
}

/** Rejects when the signal does, as an aborted `fetch` does — the IPC call itself cannot be taken back. */
function untilAborted (signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason)
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}

async function overIpc<T> (bridge: NonNullable<Window['kemolate']>['data'], url: string, options: FetchOptions): Promise<T> {
  const method = (options.method ?? 'GET').toUpperCase()
  const raw = options.body
  // Bytes as bytes; anything else as JSON would carry it — which is also what
  // makes a reactive proxy something IPC can copy.
  const body = raw instanceof Blob
    ? new Uint8Array(await raw.arrayBuffer())
    : raw instanceof ArrayBuffer
      ? new Uint8Array(raw)
      : raw instanceof Uint8Array || raw === undefined
        ? raw
        : JSON.parse(JSON.stringify(raw))

  options.signal?.throwIfAborted()

  const call = bridge.call({ method, path: url, query: queryOf(options), body })
  const answer = await (options.signal ? Promise.race([call, untilAborted(options.signal)]) : call)

  if ('error' in answer) throw new FetchError(method, url, answer.error.status, answer.error.message, answer.error.data)

  if ('bytes' in answer) {
    const bytes = answer.bytes

    return (options.responseType === 'arrayBuffer'
      ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      : new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/png' })) as T
  }

  return answer.ok as T
}

/** The same request over `fetch` — where there is no bridge, which is the app tests (`registerEndpoint`). */
async function overFetch<T> (url: string, options: FetchOptions): Promise<T> {
  const method = (options.method ?? 'GET').toUpperCase()
  const search = new URLSearchParams(queryOf(options)).toString()
  const target = search ? `${url}${url.includes('?') ? '&' : '?'}${search}` : url
  const raw = options.body
  const binary = raw instanceof Blob || raw instanceof ArrayBuffer || raw instanceof Uint8Array
  const response = await fetch(target, {
    method,
    headers: { ...(binary || raw === undefined ? {} : { 'content-type': 'application/json' }), ...options.headers },
    body: raw === undefined ? undefined : binary ? raw as BodyInit : JSON.stringify(raw),
    signal: options.signal ?? undefined,
  })

  if (!response.ok) {
    const said = await response.json().catch(() => ({})) as { message?: string, statusMessage?: string, data?: unknown }

    throw new FetchError(method, url, response.status, said.statusMessage ?? said.message ?? response.statusText, said.data)
  }

  if (options.responseType === 'blob') return await response.blob() as T
  if (options.responseType === 'arrayBuffer') return await response.arrayBuffer() as T

  const text = await response.text()

  if (options.responseType === 'text') return text as T

  return (text ? JSON.parse(text) : undefined) as T
}

/**
 * The web build's server client, answered by this machine.
 *
 * The web build's composables keep a workspace's work through `$fetch` calls
 * on `/api/workspaces/**`. Here the same method, path, query and body go to the
 * main process (`window.kemolate.data`, see `electron/data.ts`), which runs the
 * same services against the app's own database, and the answer comes back as
 * ofetch would have parsed it: JSON as JSON, a repair as a `Blob`, a refusal as
 * a thrown `FetchError`. Nothing leaves the machine.
 */
export async function $fetch<T = unknown> (url: string, options: FetchOptions = {}): Promise<T> {
  const bridge = typeof window === 'undefined' ? undefined : window.kemolate?.data

  return bridge ? overIpc<T>(bridge, url, options) : overFetch<T>(url, options)
}

/**
 * The web build's runtime config. Read in one place (`utils/ocr/lab.ts`, for an
 * optional address of the OCR bench server) and already guarded there; nothing
 * is configured here, so it is empty.
 */
export function useRuntimeConfig () {
  return { public: {} as Record<string, unknown> }
}

/**
 * A page's metadata. The web build's pages set their layout and key with it; here
 * `App.vue` decides both for every page it draws, so it is taken and ignored —
 * which keeps a page that calls it (`pages/ocr-lab.vue`) verbatim.
 */
export function definePageMeta (_meta: { layout?: string | false, key?: unknown }) {}

export function useHead (head: { title?: string }) {
  if (head.title) document.title = head.title
}

/**
 * Once the app is up — Nuxt's meaning, not a component's.
 *
 * Nuxt runs these after the app has mounted, on an idle callback, outside any
 * component, and the two callers lean on all three: `remember` and
 * `usePaintSettings` read a saved setting in and then *watch* it to save it
 * again, for as long as the app lives. This was `onMounted(callback)`, which
 * tied both halves to whichever component happened to ask first — called
 * outside a setup it never ran at all (and the caller had already marked itself
 * wired, so it never asked again), and when it did run its watcher was that
 * component's and stopped when it unmounted, which a brush cursor or a tool bar
 * does whenever the tool changes. A brush size scrubbed to 108 came back as 28
 * on the next launch.
 *
 * `main.ts` says when the app is up (`nuxtReady`); a callback asked for after
 * that runs on the next idle moment, as Nuxt's does.
 */
let up = false
const waiting: (() => void)[] = []

const whenIdle = (callback: () => void) => {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(() => callback())
  else setTimeout(callback, 0)
}

export function onNuxtReady (callback: () => void) {
  if (up) whenIdle(callback)
  else waiting.push(callback)
}

/** Called once by `main.ts`, after the app has mounted. */
export function nuxtReady () {
  up = true

  for (const callback of waiting.splice(0)) whenIdle(callback)
}
