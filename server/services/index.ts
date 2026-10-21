/**
 * The services, as one import.
 *
 * Namespaced rather than flattened: half of these have a `list`, a `put` and a
 * `remove`, and `blocks.remove(...)` beside `layers.remove(...)` says which is
 * which where two bare `remove`s would not.
 *
 * Desktop: without `contributors`, `invites`, `tokens` and `vault` — accounts and
 * sharing, which the desktop app does not have.
 */
export * as blocks from './blocks'
export * as cast from './cast'
export * as glossaries from './glossaries'
export * as layers from './layers'
export * as logs from './logs'
export * as paint from './paint'
export * as pages from './pages'
export * as repairs from './repairs'
export * as translations from './translations'
export * as workspaces from './workspaces'

export { contextFor, must, notify } from './access'
export type { Context } from './access'
