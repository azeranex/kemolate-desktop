import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { aWorkspace, reset } from '../server/harness'

import { keepRepairsIn } from '~~/server/utils/repairStore'

/**
 * The window's requests, answered over IPC — `electron/data.ts`.
 *
 * What the window's composables were written against is the web build's HTTP:
 * a JSON answer, or an error with a status and the zod issues. These pin that
 * the dispatcher answers the same way — dates as strings, a 400 for a bad body
 * that carries its issues, a 404 for a workspace or a request it does not know —
 * and that a repair goes in and comes back as bytes, the one answer that is not
 * JSON. Electron itself is stood in for: nothing here is about the channel.
 */

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() }, ipcMain: { handle: () => {} }, shell: {} }))

const { answer, route } = await import('~~/electron/data')

/** A PNG as far as `isPng` asks: its signature, and something after it. */
const PNG = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1F, 0x15, 0xC4, 0x89])

beforeEach(() => {
  reset()
  keepRepairsIn(mkdtempSync(path.join(tmpdir(), 'kemolate-repairs-')))
})

describe('route', () => {
  it('finds the route by method and path, with its parameters decoded', () => {
    const found = route('patch', '/api/workspaces/a%20b/blocks/41')

    expect(found?.params).toEqual({ workspaceId: 'a b', blockId: '41' })
  })

  it('tells a method apart on the same path', () => {
    expect(route('GET', '/api/workspaces/w/glossary')).not.toBeNull()
    expect(route('POST', '/api/workspaces/w/glossary')).not.toBeNull()
    expect(route('PATCH', '/api/workspaces/w/glossary')).toBeNull()
  })
})

describe('answer', () => {
  it('makes a workspace and answers as JSON would — dates as strings', async () => {
    const publicId = crypto.randomUUID()
    const made = await answer({ method: 'POST', path: '/api/workspaces', body: { publicId, name: 'One' } })

    expect(made).toMatchObject({ ok: { publicId, name: 'One' } })
    expect(typeof (made as { ok: { createdAt: unknown } }).ok.createdAt).toBe('string')
  })

  it('answers a body that does not validate with 400 and its issues', async () => {
    const context = await aWorkspace()
    const refused = await answer({ method: 'PUT', path: `/api/workspaces/${context.workspace.publicId}/pages`, body: { pages: 'no' } })

    expect(refused).toMatchObject({ error: { status: 400, message: 'Invalid input', data: { issues: expect.any(Array) } } })
  })

  it('answers a workspace that is not there with 404', async () => {
    expect(await answer({ method: 'GET', path: '/api/workspaces/nobody/pages' })).toMatchObject({ error: { status: 404 } })
  })

  it('answers a request it does not know with 404, naming it', async () => {
    expect(await answer({ method: 'GET', path: '/api/elsewhere' })).toEqual({ error: { status: 404, message: 'GET /api/elsewhere is not something this app answers.' } })
  })

  it('reads the query from the path as well as from `query`', async () => {
    const context = await aWorkspace()
    const at = `/api/workspaces/${context.workspace.publicId}`

    expect(await answer({ method: 'GET', path: `${at}/glossary?locale=en` })).toEqual({ ok: [] })
    expect(await answer({ method: 'GET', path: `${at}/glossary`, query: { locale: 'en' } })).toEqual({ ok: [] })
    expect(await answer({ method: 'GET', path: `${at}/glossary` })).toMatchObject({ error: { status: 400 } })
  })

  it('keeps a repair from bytes and hands the same bytes back', async () => {
    const context = await aWorkspace()
    const at = `/api/workspaces/${context.workspace.publicId}`
    const placed = await answer({ method: 'PUT', path: `${at}/pages`, body: { pages: [{ uid: crypto.randomUUID(), path: '01.png', name: '01', position: 0 }] } })
    const pageId = (placed as { ok: { id: number }[] }).ok[0]!.id

    const kept = await answer({
      method: 'PUT',
      path: `${at}/repairs`,
      query: { pageId: String(pageId), key: '0123456789abcdef-1-2-3-4-aot-m1', from: '0,0,1,1', box: '0,0,1,1' },
      body: PNG,
    })

    expect(kept).toHaveProperty('ok.hash')

    const back = await answer({ method: 'GET', path: `${at}/repairs/${(kept as { ok: { hash: string } }).ok.hash}` })

    expect(back).toHaveProperty('bytes')
    expect([...(back as { bytes: Uint8Array }).bytes]).toEqual([...PNG])
  })
})
