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
 *   memory, and the two paths the app can be at: `/` (the collection of
 *   workspaces) and `/w/<id>`. `App.vue` draws whichever one it is.
 * - `useNuxtApp` — a stable object per app. `useComic` keys its view state on
 *   it; nothing reads anything off it.
 * - `useCookie` — a ref kept in local storage, as JSON, under the cookie's name.
 *   The web build used cookies so its server could render with them; here
 *   storage is read synchronously before the first paint, which is the same
 *   guarantee by the plainer route.
 * - `$fetch` — refuses: there is no server, see below.
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

/**
 * Go somewhere. Only the paths the desktop app has are understood — `/` and
 * `/w/<id>` — and anything else (the web build's `/signin`, `/account`) is
 * refused aloud rather than turned into a blank screen.
 */
export async function navigateTo (to: string | { path?: string, query?: Record<string, string | undefined> }) {
  const target = typeof to === 'string' ? to : (to.path ?? route.path)
  const [path = '/', search = ''] = target.split('?')
  const workspace = /^\/w\/([^/]+)$/.exec(path)

  if (path !== '/' && !workspace) {
    console.warn(`[kemolate] No such place in the desktop app: ${target}`)
    return
  }

  route.path = path
  route.fullPath = target
  route.params = workspace ? { workspaceId: decodeURIComponent(workspace[1]!) } : {}
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

/**
 * The web build's server client. There is no server here, so a call that gets
 * this far is a cloud path a local workspace should never have taken — and it
 * fails aloud, naming the endpoint, rather than resolving to nothing and leaving
 * the caller to believe the server agreed.
 */
export async function $fetch<T = unknown> (url: string, _options?: unknown): Promise<T> {
  throw new Error(`The desktop app has no server — nothing answers ${url}.`)
}

export function useHead (head: { title?: string }) {
  if (head.title) document.title = head.title
}

export function onNuxtReady (callback: () => void) {
  onMounted(callback)
}
