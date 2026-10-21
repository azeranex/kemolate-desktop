/**
 * `createError`, as the services carried from the web build expect it — desktop.
 *
 * In the web build it is h3's, auto-imported by Nitro into every server file, and
 * the services call it bare (`throw createError({ statusCode: 404, … })`). Here
 * there is no Nitro and no h3: this is the same shape — an `Error` carrying
 * `statusCode`, `statusMessage` and `data` — made global once, at start, by the
 * main process (`installServerGlobals`) and by the server tests' harness, so the
 * services stay verbatim. The IPC dispatcher (`electron/data.ts`) turns one into
 * the `{ status, message, data }` the window's `$fetch` reads.
 */
export class HttpError extends Error {
  readonly statusCode: number
  readonly statusMessage: string
  readonly data: unknown

  constructor (statusCode: number, statusMessage: string, data?: unknown) {
    super(statusMessage)
    this.statusCode = statusCode
    this.statusMessage = statusMessage
    this.data = data
  }
}

export interface ErrorInput {
  statusCode?: number
  status?: number
  statusMessage?: string
  message?: string
  data?: unknown
}

export function createError (input: ErrorInput | string): HttpError {
  if (typeof input === 'string') return new HttpError(500, input)

  const status = input.statusCode ?? input.status ?? 500

  return new HttpError(status, input.statusMessage ?? input.message ?? `Error ${status}`, input.data)
}

/** What the services reach for without importing it. Called once, before any of them runs. */
export function installServerGlobals () {
  // `useEvent` too: the database's query logger asks it for the request, and there is none.
  Object.assign(globalThis, { createError, useEvent: () => undefined })
}
