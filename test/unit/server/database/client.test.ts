import { describe, expect, it } from 'vitest'

import { client } from '~~/server/database'

/**
 * The connection is opened with the settings the server depends on.
 *
 * Each one is a decision `client.ts` argues for, and each is one line a later
 * edit could drop without anything else noticing: foreign keys off makes every
 * cascade silently stop cascading, FULL synchronous is a fsync per save, and a
 * long busy wait on a synchronous driver is the whole server standing still.
 * The test project's connection is `:memory:` (see `vitest.config.ts`), so the
 * journal mode is memory's own rather than WAL and is not asserted.
 */
const pragma = (name: string) => Object.values(client.prepare(`PRAGMA ${name}`).get() ?? {})[0]

describe('the database connection', () => {
  it('enforces foreign keys', () => {
    expect(pragma('foreign_keys')).toBe(1)
  })

  it('syncs at NORMAL, not a fsync per commit', () => {
    // 0 OFF, 1 NORMAL, 2 FULL, 3 EXTRA.
    expect(pragma('synchronous')).toBe(1)
  })

  it('waits a second at most for another writer', () => {
    expect(pragma('busy_timeout')).toBe(1000)
  })
})
