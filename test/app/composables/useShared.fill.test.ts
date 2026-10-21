import { mockNuxtImport, registerEndpoint } from '@nuxt/test-utils/runtime'
import { readBody } from 'h3'
import { beforeEach, describe, expect, it } from 'vitest'

import type { RemotePage } from '~/composables/useShared'

import { useComic } from '~/composables/useComic'
import { useShared } from '~/composables/useShared'

/**
 * A page's size reaches the workspace once this browser has measured it.
 *
 * Every row in every workspace was founded without one — a chapter is pushed
 * the moment it is on screen, before any page has been drawn — and nothing sent
 * one later, so `pages.width` and `pages.height` were null everywhere. A page
 * opened on a machine without its file then had no shape to be laid out in:
 * `dims` came out nought and its lettering was never set at all.
 *
 * Seam: what `fill` asks the server to write, answered by `registerEndpoint`.
 */

mockNuxtImport('useRoute', () => () => ({ params: { workspaceId: 'ws' }, fullPath: '/w/ws' }))

function row (over: Partial<RemotePage> & { id: number, uid: string }): RemotePage {
  return {
    path: `${over.uid}.png`,
    name: `${over.uid}.png`,
    position: over.id,
    hash: `hash-${over.uid}`,
    width: null,
    height: null,
    ...over,
  }
}

function held (id: string, uid: string, size: { width: number, height: number }, hash: string | null): ComicPage {
  return {
    id,
    uid,
    name: id,
    blocks: [],
    scan: { url: 'blob:x', file: new File([], 'x'), ...size, hash },
  }
}

const puts: { pages: Record<string, unknown>[] }[] = []

registerEndpoint('/api/workspaces/ws/pages', {
  method: 'PUT',
  handler: async (event) => {
    const body = await readBody<{ pages: Record<string, unknown>[] }>(event)

    puts.push(body)

    return []
  },
})

describe('fill', () => {
  beforeEach(() => {
    puts.length = 0
  })

  it('sends a measured size for a row that has none, and nothing else of this browser\'s', async () => {
    const { shared, fill } = useShared()
    const { pages } = useComic()

    // The row is second in the chapter; this browser holds it first.
    shared.value = { role: 'editor', pages: [row({ id: 7, uid: 'a', position: 1 })] } as never
    pages.value = [held('scan:a.png', 'a', { width: 1600, height: 2400 }, 'hash-a')]

    await fill()

    expect(puts).toHaveLength(1)
    expect(puts[0]!.pages).toEqual([
      expect.objectContaining({ uid: 'a', path: 'a.png', position: 1, width: 1600, height: 2400 }),
    ])
  })

  it('sends nothing for a row that already has its size and hash', async () => {
    const { shared, fill } = useShared()
    const { pages } = useComic()

    shared.value = { role: 'editor', pages: [row({ id: 7, uid: 'a', width: 1600, height: 2400 })] } as never
    pages.value = [held('scan:a.png', 'a', { width: 1600, height: 2400 }, 'hash-a')]

    await fill()

    expect(puts).toEqual([])
  })

  it('waits for a page that has not been measured yet', async () => {
    const { shared, fill } = useShared()
    const { pages } = useComic()

    shared.value = { role: 'editor', pages: [row({ id: 7, uid: 'a' })] } as never
    pages.value = [held('scan:a.png', 'a', { width: 0, height: 0 }, 'hash-a')]

    await fill()

    expect(puts).toEqual([])
  })

  it('sends nothing for somebody who may not amend the chapter', async () => {
    const { shared, fill } = useShared()
    const { pages } = useComic()

    shared.value = { role: 'viewer', pages: [row({ id: 7, uid: 'a' })] } as never
    pages.value = [held('scan:a.png', 'a', { width: 1600, height: 2400 }, 'hash-a')]

    await fill()

    expect(puts).toEqual([])
  })
})
