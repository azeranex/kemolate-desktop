import { mockNuxtImport, registerEndpoint } from '@nuxt/test-utils/runtime'
import { readBody } from 'h3'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'

import { useReadErrands } from '~/composables/useReadErrands'

/**
 * A reading is done for the chapter open here, and only for it.
 *
 * The report: a `request_page_read` could land in a tab showing another
 * workspace. That tab was in the asking workspace's room as a holder of its
 * files, `readScans` found the pages by hash in whatever chapter was open, and
 * the reading was written over that chapter's blocks — translations and all —
 * then reported as done for the workspace that asked.
 *
 * Seam: the errand as the socket hands it over (`onSwarmErrand`, captured), the
 * reader (`useOcr`, a spy) and the report the server is sent.
 */

const { hand, readScans, error } = await vi.hoisted(async () => {
  const { ref } = await import('vue')

  return {
    hand: ref<((workspace: string, errand: { request: string, hashes: string[] }) => Promise<void>) | null>(null),
    readScans: vi.fn(async () => ({ read: 1, blocks: 3 })),
    error: ref<string | null>(null),
  }
})

mockNuxtImport('useRoute', () => () => ({ params: { workspaceId: 'ws-open' }, fullPath: '/w/ws-open' }))
mockNuxtImport('onSwarmErrand', () => (listener: typeof hand.value) => {
  hand.value = listener

  return () => {}
})
mockNuxtImport('useOcr', () => () => ({ readScans, running: { value: false }, error }))

const reports: { workspace: string, body: { ok: boolean, error?: string } }[] = []

for (const workspace of ['ws-open', 'ws-other']) {
  registerEndpoint(`/api/workspaces/${workspace}/reading/r1`, {
    method: 'POST',
    handler: async (event) => {
      reports.push({ workspace, body: await readBody(event) })

      return { ok: true }
    },
  })
}

describe('a reading asked of this browser', () => {
  beforeEach(() => {
    reports.length = 0
    readScans.mockClear()
    error.value = null
    effectScope().run(() => useReadErrands())
  })

  it('reads the pages of the chapter open here', async () => {
    await hand.value!('ws-open', { request: 'r1', hashes: ['h'] })

    expect(readScans).toHaveBeenCalledWith(['h'])
    expect(reports).toEqual([{ workspace: 'ws-open', body: expect.objectContaining({ ok: true }) }])
  })

  /*
   * A reading taken but not saved is one the asker cannot use: what it reads
   * back through the API is the old reading, or nothing. `persist` says so in
   * `error` without stopping the run, and the errand used to report the run as
   * done — an agent told `ok` went on to translate blocks that were not there.
   */
  it('says so when the pages were read but the reading could not be saved', async () => {
    readScans.mockImplementationOnce(async () => {
      error.value = 'The reading is on the page but was not saved: 503'

      return { read: 1, blocks: 3 }
    })

    await hand.value!('ws-open', { request: 'r1', hashes: ['h'] })

    expect(reports).toEqual([{
      workspace: 'ws-open',
      body: expect.objectContaining({ ok: false, error: 'The reading is on the page but was not saved: 503' }),
    }])
  })

  it('refuses a workspace that is not the one open, and reads nothing', async () => {
    await hand.value!('ws-other', { request: 'r1', hashes: ['h'] })

    expect(readScans).not.toHaveBeenCalled()
    expect(reports).toEqual([{ workspace: 'ws-other', body: expect.objectContaining({ ok: false }) }])
  })
})
