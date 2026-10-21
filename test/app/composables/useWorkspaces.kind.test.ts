import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useWorkspaces } from '~/composables/useWorkspaces'

/**
 * Which kind this browser remembers a workspace as.
 *
 * The report: signed out, a cloud workspace was listed as "Local" — the index
 * recorded nothing about where a workspace lived, and without the server's list
 * there was nothing else to ask. Deleting it wiped this browser's copy of the
 * pages while the workspace went on existing in the account, and signing back
 * in found the chapter with no pictures. The flag is what the list reads now,
 * and it has to survive the one thing that rewrites an entry on every open.
 */
const { memory } = vi.hoisted(() => ({ memory: new Map<string, unknown>() }))

mockNuxtImport('idb', () => ({
  get: async (key: string) => memory.get(key),
  set: async (key: string, value: unknown) => { memory.set(key, structuredClone(value)) },
  del: async (key: string) => { memory.delete(key) },
  keys: async (prefix: string) => [...memory.keys()].filter((key) => key.startsWith(prefix)),
  getMany: async (keys: string[]) => keys.map((key) => memory.get(key)),
}))

describe('Workspace.cloud', () => {
  beforeEach(() => memory.clear())

  it('is set when the workspace is seen with a server record', async () => {
    const { note, markKind, all } = useWorkspaces()

    await note('ws-a', 'Chapter one')
    await markKind('ws-a', true)

    expect((await all())[0]?.cloud).toBe(true)
  })

  it('survives the chapter being opened again', async () => {
    // `note` rewrites the entry on every open, signed in or out — and signed out
    // is exactly when nothing else is there to put the flag back.
    const { note, markKind, all } = useWorkspaces()

    await note('ws-a', 'Chapter one')
    await markKind('ws-a', true)
    await note('ws-a', 'Chapter one')

    expect((await all())[0]?.cloud).toBe(true)
  })

  it('is cleared by moving the workspace back to local', async () => {
    const { note, markKind, all } = useWorkspaces()

    await note('ws-a', 'Chapter one')
    await markKind('ws-a', true)
    await markKind('ws-a', false)

    expect((await all())[0]?.cloud).toBe(false)
  })

  it('does not invent an entry for a workspace this browser never opened', async () => {
    await useWorkspaces().markKind('ws-unknown', true)

    expect(await useWorkspaces().all()).toEqual([])
  })
})
