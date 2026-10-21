import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, reactive, Suspense } from 'vue'

import type { VueWrapper } from '@vue/test-utils'
import type { Component } from 'vue'

/**
 * `@nuxt/test-utils/runtime`, as far as the web build's app tests use it — the
 * tests import it by that name (an alias in `vitest.config.ts`), so they are
 * carried across unchanged.
 *
 * - `mockNuxtImport` is a transform, not a function: see `mockNuxtImport.ts`.
 *   Reaching this one means the transform missed a call, which is said aloud.
 * - `mountSuspended` mounts under `<Suspense>` and waits for it, as Nuxt's does,
 *   so a component with an async setup is ready when the test gets it, and
 *   hands back the component's own wrapper — with `setProps` working on it,
 *   which a child wrapper's does not.
 * - `registerEndpoint` answers `fetch` for one path. In the app `$fetch` goes
 *   to the main process over IPC (`composables/nuxt.ts`); with no bridge, which
 *   is a test, it goes over `fetch` instead — so an endpoint registered here
 *   answers `$fetch` as it does in the web build's tests.
 */
export function mockNuxtImport<T = any> (name: string, _factory: () => T | Promise<T>): void {
  throw new Error(`mockNuxtImport('${name}') was not rewritten — it must be a top-level call with a string literal name`)
}

/** `mount`'s options, with props as loose as a component's own props type. */
type MountOptions = Record<string, unknown> & { props?: object, attrs?: object, slots?: object }

export async function mountSuspended<T extends Component> (component: T, options: MountOptions = {}): Promise<VueWrapper<any>> {
  const { props = {}, attrs = {}, slots, ...rest } = options
  const live = reactive<Record<string, unknown>>({ ...props })

  const host = defineComponent({
    name: 'MountSuspendedHost',
    setup: () => () => h(Suspense, null, {
      default: () => h(component as Component, { ...attrs, ...live }, slots as never),
    }),
  })

  const wrapper = mount(host, rest as never)

  await flushPromises()

  const inner = wrapper.findComponent(component as never) as VueWrapper<any>

  return Object.assign(inner, {
    async setProps (next: Record<string, unknown>) {
      Object.assign(live, next)
      await nextTick()
    },
    unmount: () => wrapper.unmount(),
  })
}

export interface EndpointEvent {
  method: string
  path: string
  url: URL
  request: Request
  body: Promise<unknown>
}

type Handler = (event: EndpointEvent) => unknown

const endpoints = new Map<string, { method?: string, handler: Handler }[]>()

/** Answers `fetch` for `path` from now on; the function it returns takes the answer away again, as Nuxt's does. */
export function registerEndpoint (path: string, options: Handler | { method?: string, handler: Handler }) {
  const entry = typeof options === 'function' ? { handler: options } : options

  endpoints.set(path, [...(endpoints.get(path) ?? []).filter((each) => each.method !== entry.method), entry])

  return () => {
    endpoints.set(path, (endpoints.get(path) ?? []).filter((each) => each !== entry))
  }
}

/** HTTP errors as `createError` makes them — see `h3.ts`. */
export class EndpointError extends Error {
  constructor (readonly statusCode: number, message: string, readonly data?: unknown) {
    super(message)
  }
}

const realFetch = globalThis.fetch.bind(globalThis)

/** Installed by `setup.ts`. */
export async function fetchWithEndpoints (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(typeof input === 'string' && input.startsWith('/') ? `http://localhost${input}` : input, init)
  const url = new URL(request.url)
  const entry = endpoints.get(url.pathname)?.find((each) => !each.method || each.method.toUpperCase() === request.method)

  // The app's own requests that no test answered are a 404, as Nuxt's test
  // environment makes them — not a connection to whatever holds port 3000.
  if (!entry && url.pathname.startsWith('/api/')) {
    return Response.json({ statusCode: 404, message: `No endpoint registered for ${url.pathname}` }, { status: 404 })
  }

  if (!entry) return realFetch(input, init)

  const body = request.clone().text().then((text) => {
    if (!text) return undefined
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  })

  try {
    const answer = await entry.handler({ method: request.method, path: url.pathname + url.search, url, request, body })

    if (answer instanceof Response) return answer
    if (answer instanceof Uint8Array || answer instanceof ArrayBuffer || answer instanceof Blob) return new Response(answer as BodyInit)

    return Response.json(answer ?? null)
  } catch (error) {
    if (error instanceof EndpointError) return Response.json({ statusCode: error.statusCode, message: error.message, data: error.data }, { status: error.statusCode })
    throw error
  }
}
