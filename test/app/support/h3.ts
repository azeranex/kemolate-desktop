import type { EndpointEvent } from './test-utils'

import { EndpointError } from './test-utils'

/**
 * The few h3 helpers the web build's endpoint handlers call, over the event
 * `registerEndpoint` hands them (`test-utils.ts`). Aliased as `h3` for the app
 * tests only — the desktop app has no server and no h3.
 */
export const defineEventHandler = <T>(handler: (event: EndpointEvent) => T) => handler

export const readBody = <T = any>(event: EndpointEvent) => event.body as Promise<T>

export const getQuery = (event: EndpointEvent) => Object.fromEntries(event.url.searchParams)

export function createError (input: { statusCode?: number, status?: number, statusMessage?: string, message?: string, data?: unknown }) {
  const status = input.statusCode ?? input.status ?? 500

  return new EndpointError(status, input.message ?? input.statusMessage ?? `HTTP ${status}`, input.data)
}
