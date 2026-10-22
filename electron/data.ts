import { app, ipcMain, shell } from 'electron'
import { z } from 'zod'

import { backup, backupsFolder, databaseFile, listBackups, openingNotice, restoreAtLaunch, written } from './database'

import type { DataAnswer, DataRequest } from './preload'
import type { Context } from '~~/server/services'
import type { FitReport } from '~~/server/utils/fits'
import type { ReadReport } from '~~/server/utils/reading'

import { strokeBatchSchema, strokeDraftSchema } from '#shared/schemas/paint'
import {
  blockPatchesSchema,
  blockPatchSchema,
  blockSyncSchema,
  castMergeSchema,
  castSaveSchema,
  compoundSchema,
  glossaryEditSchema,
  glossaryMergeSchema,
  glossaryTermSchema,
  layerPresetSchema,
  layerSyncSchema,
  pageSyncSchema,
  readReportSchema,
  revisionChoiceSchema,
  revisionRestoreSchema,
  revisionRevertSchema,
  translationSyncSchema,
  workspaceDraftSchema,
  workspacePatchSchema,
} from '#shared/schemas/workspace'
import { PLATES } from '#shared/utils/layers'
import { parseRect } from '#shared/utils/repairs'
import { blocks, cast, contextFor, glossaries, layers, pages, paint, repairs, translations, workspaces } from '~~/server/services'
import { finish } from '~~/server/utils/errand'
import { createError, HttpError } from '~~/server/utils/errors'
import { deliver, MAX_BYTES } from '~~/server/utils/relay'

/**
 * The window's requests for workspace data, answered in the main process.
 *
 * The web build reaches its database through HTTP routes under
 * `server/api/workspaces/**`; its window-side composables are written against
 * those paths. The desktop has no server to listen on and does not want one —
 * so the same method and path come over one IPC channel (`data:call`, see
 * `preload.ts` and the window's `$fetch`) and are matched here, against a table
 * that is those routes' handlers with the h3 taken out. Each entry does what
 * its route did: parse the ids, validate the body with the same zod schema,
 * call the same service. Keep an entry beside the route it copies when one
 * changes, and do not grow logic here — it belongs in the service.
 *
 * What is left out is the web build's people: contributors, invitations,
 * leaving and the swarm ticket. The MCP errands' answers (`reading`, `relay`)
 * are here: the window answers an agent's ask through them as a tab does
 * (`electron/mcp.ts`, `useHolding`).
 *
 * An answer goes back as JSON would have — `answer()` round-trips it, so a
 * `Date` arrives as the ISO string the composables were written for rather than
 * as the `Date` structured clone would carry. A repair's picture is the one
 * answer that is bytes. A failure is a value (`{ error: { status, message,
 * data } }`), never a thrown IPC error, whose message Electron rewrites.
 *
 * Imported only once the database is open (`main.ts`): the services import
 * `server/database`, which opens the file the moment it is loaded.
 */

interface Call {
  params: Record<string, string>
  query: Record<string, unknown>
  body: unknown
}

type Handler = (call: Call) => Promise<unknown>
type InWorkspace = (context: Context, call: Call) => Promise<unknown>

/** Bytes, distinguished from an answer — see `answer()`. */
class Bytes {
  constructor (readonly bytes: Uint8Array) {}
}

function valid<Schema extends z.ZodType> (schema: Schema, body: unknown): z.infer<Schema> {
  const result = schema.safeParse(body)

  if (!result.success) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid input', data: { issues: result.error.issues } })
  }

  return result.data
}

function id (call: Call, name: string, what: string): number {
  const value = Number(call.params[name])

  if (!Number.isInteger(value) || value <= 0) {
    throw createError({ statusCode: 400, statusMessage: `Bad ${what} id.` })
  }

  return value
}

function locale (call: Call): string {
  const value = String(call.query.locale ?? '').trim()

  if (value.length < 2 || value.length > 16) {
    throw createError({ statusCode: 400, statusMessage: 'A locale is required.' })
  }

  return value
}

function inQuery<Schema extends z.ZodType> (schema: Schema, query: Record<string, unknown>): z.infer<Schema> {
  const result = schema.safeParse(query)

  if (!result.success) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid query', data: { issues: result.error.issues } })
  }

  return result.data
}

/** `workspaceContext` in the web build: the workspace in the path, or a 404. */
function workspace (handler: InWorkspace): Handler {
  return async (call) => {
    const context = await contextFor(call.params.workspaceId ?? '')

    if (!context) throw createError({ statusCode: 404, statusMessage: 'No such workspace.' })

    return handler(context, call)
  }
}

const ensureSchema = z.object({ plate: z.enum(PLATES), pageId: z.number().int().positive() })
const paintQuery = z.object({ after: z.coerce.number().int().min(0).default(0), layers: z.enum(['0', '1']).default('1') })
const unpinSchema = z.object({ locale: z.string().trim().min(2).max(16), blockIds: z.array(z.number().int().positive()).max(500) })
const retractSchema = z.object({ retracted: z.boolean() })
const sinceQuery = z.object({ since: z.coerce.number().int().min(0).default(0) })
const surfaceSchema = z.object({
  pageId: z.number().int().positive(),
  layerId: z.number().int().positive(),
  key: z.string().regex(/^[a-z0-9:-]{1,64}$/i),
  blockId: z.number().int().positive().nullish(),
})

/** A window's measurement of a page's lettering — bounded, as every report from the window is. See `FitReport`. */
const fitReportSchema = z.object({
  ok: z.boolean(),
  standard: z.number().min(0).max(5000).nullable().optional(),
  lines: z.array(z.object({
    blockId: z.number().int().positive(),
    size: z.number().min(0).max(5000),
    set: z.enum(['auto', 'standard', 'chosen']),
    capacity: z.number().min(0).max(5000).nullable(),
    over: z.boolean(),
    tight: z.boolean(),
    hyphens: z.boolean(),
  })).max(1000).optional(),
  error: z.string().transform((text) => text.slice(0, 400)).optional(),
})

const W = '/api/workspaces/:workspaceId'

/** Method, path, handler — in the order of `server/api/workspaces/**` in the web build. */
const ROUTES: [string, string, Handler][] = [
  ['GET', '/api/workspaces', async () => workspaces.listAll()],
  ['POST', '/api/workspaces', async ({ body }) => workspaces.claim(valid(workspaceDraftSchema, body))],

  ['GET', W, workspace(async (context) => ({
    workspace: {
      publicId: context.workspace.publicId,
      name: context.workspace.name,
      // Desktop: nobody's row — the one person there is owns everything.
      ownerId: null,
      targetLocale: context.workspace.targetLocale,
    },
    role: context.role,
    owner: true,
    pages: (await pages.list(context)).map((page) => ({
      id: page.id,
      uid: page.uid,
      path: page.path,
      name: page.name,
      position: page.position,
      hash: page.hash,
    })),
    owners: null,
  }))],
  ['PATCH', W, workspace(async (context, { body }) => {
    const changed = await workspaces.update(context, valid(workspacePatchSchema, body))

    return {
      publicId: changed.publicId,
      name: changed.name,
      direction: changed.direction,
      sourceLocale: changed.sourceLocale,
      targetLocale: changed.targetLocale,
      honorifics: changed.honorifics,
      wholePage: changed.wholePage,
    }
  })],
  ['DELETE', W, workspace(async (context) => {
    await workspaces.remove(context)

    return { deleted: context.workspace.publicId }
  })],

  ['GET', `${W}/blocks`, workspace(async (context) => blocks.inChapter(context))],
  ['PATCH', `${W}/blocks/:blockId`, workspace(async (context, call) => blocks.update(context, id(call, 'blockId', 'block'), valid(blockPatchSchema, call.body)))],
  ['DELETE', `${W}/blocks/:blockId`, workspace(async (context, call) => {
    await blocks.remove(context, id(call, 'blockId', 'block'))

    return { ok: true }
  })],
  ['POST', `${W}/blocks/:blockId/release`, workspace(async (context, call) => blocks.release(context, id(call, 'blockId', 'block')))],
  ['GET', `${W}/blocks/:blockId/revisions`, workspace(async (context, call) => translations.revisions(context, id(call, 'blockId', 'block'), locale(call)))],
  ['PUT', `${W}/blocks/:blockId/revisions`, workspace(async (context, call) => {
    const blockId = id(call, 'blockId', 'block')
    const { locale, revisionId } = valid(revisionChoiceSchema, call.body)

    if (revisionId === null) {
      await translations.unpin(context, [blockId], locale)

      return { pinned: false }
    }

    await translations.chooseRevision(context, blockId, locale, revisionId)

    return { pinned: true }
  })],
  ['DELETE', `${W}/blocks/:blockId/revisions/:revisionId`, workspace(async (context, call) => {
    await translations.deleteRevision(context, id(call, 'blockId', 'block'), locale(call), id(call, 'revisionId', 'revision'))

    return { ok: true }
  })],

  ['GET', `${W}/cast`, workspace(async (context) => cast.list(context))],
  ['PUT', `${W}/cast`, workspace(async (context, { body }) => {
    const input = valid(castSaveSchema, body)

    return cast.save(context, input.members, input.notes)
  })],
  ['POST', `${W}/cast/learn`, workspace(async (context, { body }) => {
    const input = valid(castMergeSchema, body)

    await cast.merge(context, input.locale, input.learned)

    return { ok: true }
  })],

  ['GET', `${W}/glossary`, workspace(async (context, call) => call.query.all !== undefined
    ? glossaries.everyLocale(context)
    : glossaries.rows(context, locale(call)))],
  ['POST', `${W}/glossary`, workspace(async (context, { body }) => {
    const { locale, source, target } = valid(glossaryTermSchema, body)

    await glossaries.put(context, locale, { source, target })

    return glossaries.rows(context, locale)
  })],
  ['PUT', `${W}/glossary`, workspace(async (context, { body }) => {
    const input = valid(glossaryMergeSchema, body)

    await glossaries.merge(context, input.locale, input.learned)

    return glossaries.rows(context, input.locale)
  })],
  ['DELETE', `${W}/glossary`, workspace(async (context, call) => {
    await glossaries.clear(context, locale(call))

    return { ok: true }
  })],
  ['PATCH', `${W}/glossary/:termId`, workspace(async (context, call) => {
    const { locale, ...patch } = valid(glossaryEditSchema, call.body)

    await glossaries.edit(context, id(call, 'termId', 'term'), patch)

    return glossaries.rows(context, locale)
  })],
  ['DELETE', `${W}/glossary/:termId`, workspace(async (context, call) => {
    await glossaries.remove(context, id(call, 'termId', 'term'))

    return { ok: true }
  })],

  ['GET', `${W}/layers`, workspace(async (context, call) => {
    const pageId = Number(call.query.pageId)

    if (!Number.isInteger(pageId) || pageId <= 0) throw createError({ statusCode: 400, statusMessage: 'A pageId is required.' })

    return layers.stack(context, pageId)
  })],
  ['PUT', `${W}/layers`, workspace(async (context, { body }) => {
    const input = valid(layerSyncSchema, body)

    return layers.sync(context, input.layers, input.pageId)
  })],
  ['POST', `${W}/layers/ensure`, workspace(async (context, { body }) => {
    const input = valid(ensureSchema, body)

    return layers.ensurePlate(context, input.plate, input.pageId)
  })],
  ['PUT', `${W}/layers/preset`, workspace(async (context, { body }) => {
    const input = valid(layerPresetSchema, body)

    return layers.preset(context, input.rows, input.pageId)
  })],

  ['GET', `${W}/pages`, workspace(async (context) => pages.list(context))],
  ['PUT', `${W}/pages`, workspace(async (context, { body }) => pages.sync(context, valid(pageSyncSchema, body).pages))],
  ['DELETE', `${W}/pages/:pageId`, workspace(async (context, call) => {
    await pages.remove(context, id(call, 'pageId', 'page'))

    return { ok: true }
  })],
  ['GET', `${W}/pages/:pageId/blocks`, workspace(async (context, call) => blocks.onPage(context, id(call, 'pageId', 'page')))],
  ['PATCH', `${W}/pages/:pageId/blocks`, workspace(async (context, call) => blocks.updateOnPage(context, id(call, 'pageId', 'page'), valid(blockPatchesSchema, call.body).blocks))],
  ['POST', `${W}/pages/:pageId/blocks`, workspace(async (context, call) => blocks.append(context, id(call, 'pageId', 'page'), valid(blockSyncSchema, call.body).blocks))],
  ['PUT', `${W}/pages/:pageId/blocks`, workspace(async (context, call) => blocks.replace(context, id(call, 'pageId', 'page'), valid(blockSyncSchema, call.body).blocks))],
  ['POST', `${W}/pages/:pageId/compound`, workspace(async (context, call) => {
    const pageId = id(call, 'pageId', 'page')
    const { children, ...parent } = valid(compoundSchema, call.body)

    return blocks.compound(context, pageId, children, parent)
  })],
  ['GET', `${W}/pages/:pageId/paint`, workspace(async (context, call) => {
    const pageId = id(call, 'pageId', 'page')
    const query = inQuery(paintQuery, call.query)
    const painted = await paint.onPage(context, pageId, query.after)

    return query.layers === '1'
      ? { layers: await layers.stack(context, pageId), ...painted }
      : painted
  })],
  ['POST', `${W}/pages/:pageId/revert`, workspace(async (context, call) => {
    const pageId = id(call, 'pageId', 'page')
    const input = valid(revisionRevertSchema, call.body)

    return { reverted: await translations.revertBatch(context, pageId, input.locale, input.batch) }
  })],
  ['PUT', `${W}/pages/:pageId/translations`, workspace(async (context, call) => {
    const pageId = id(call, 'pageId', 'page')
    const input = valid(translationSyncSchema, call.body)

    return translations.putOnPage(context, pageId, input.locale, input.entries, input.origin)
  })],
  ['POST', `${W}/pages/:pageId/unpin`, workspace(async (context, call) => {
    // Checked as the route checks it, and not otherwise used: the blocks name their own page.
    id(call, 'pageId', 'page')

    const input = valid(unpinSchema, call.body)

    await translations.unpin(context, input.blockIds, input.locale)

    return { ok: true }
  })],

  // The window's report on a reading an agent asked for — the blocks came by `pages/:pageId/blocks`.
  ['POST', `${W}/reading/:requestId`, workspace(async (context, call) => {
    finish<ReadReport>(call.params.requestId ?? '', context.workspace.publicId, valid(readReportSchema, call.body))

    return null
  })],
  // The window's measurement of a page's lettering, for an agent's review — see `server/utils/fits.ts`.
  ['POST', `${W}/fits/:requestId`, workspace(async (context, call) => {
    finish<FitReport>(call.params.requestId ?? '', context.workspace.publicId, valid(fitReportSchema, call.body))

    return null
  })],
  // A rendition an agent asked to be shown, handed straight on and kept nowhere — see
  // `server/utils/relay.ts`. Its type comes as `?type=`, where the web build reads the
  // Content-Type: the window's `$fetch` carries no headers over IPC.
  ['POST', `${W}/relay/:requestId`, workspace(async (context, { params, query, body }) => {
    const type = String(query.type ?? '')

    if (!type.startsWith('image/')) throw createError({ statusCode: 415, statusMessage: 'A rendition is an image.' })
    if (!(body instanceof Uint8Array) || !body.byteLength) throw createError({ statusCode: 400, statusMessage: 'No rendition sent.' })
    if (body.byteLength > MAX_BYTES) throw createError({ statusCode: 413, statusMessage: 'That rendition is too large.' })

    deliver(params.requestId ?? '', context.workspace.publicId, Buffer.from(body), type)

    return null
  })],

  ['GET', `${W}/repairs`, workspace(async (context) => repairs.list(context))],
  ['GET', `${W}/repairs/:hash`, workspace(async (context, call) => new Bytes(await repairs.read(context, call.params.hash ?? '')))],
  ['PUT', `${W}/repairs`, workspace(async (context, { query, body }) => {
    const pageId = Number(query.pageId)
    const blockId = query.blockId === undefined || query.blockId === '' ? null : Number(query.blockId)
    const from = parseRect(String(query.from ?? ''))
    const box = parseRect(String(query.box ?? ''))
    const key = String(query.key ?? '')

    if (!Number.isInteger(pageId) || pageId <= 0 || (blockId !== null && (!Number.isInteger(blockId) || blockId <= 0)) || !from || !box) {
      throw createError({ statusCode: 400, statusMessage: 'A repair needs a page, a place and a name.' })
    }

    if (!(body instanceof Uint8Array)) throw createError({ statusCode: 400, statusMessage: 'No repair sent.' })

    return repairs.keep(context, { pageId, blockId, key, from, box }, body)
  })],
  ['DELETE', `${W}/repairs`, workspace(async (context, { query }) => {
    const blockId = Number(query.blockId)

    if (!Number.isInteger(blockId) || blockId <= 0) throw createError({ statusCode: 400, statusMessage: 'Bad block id.' })

    await repairs.withdraw(context, blockId)

    return null
  })],

  ['GET', `${W}/revisions`, workspace(async (context) => translations.everyRevision(context))],
  ['POST', `${W}/revisions`, workspace(async (context, { body }) => translations.restoreRevisions(context, valid(revisionRestoreSchema, body).entries))],

  ['POST', `${W}/strokes`, workspace(async (context, { body }) => ({ surfaces: await paint.appendMany(context, valid(strokeBatchSchema, body).surfaces) }))],
  ['PATCH', `${W}/strokes/:strokeId`, workspace(async (context, call) => {
    await paint.retract(context, id(call, 'strokeId', 'stroke'), valid(retractSchema, call.body).retracted)

    return { ok: true }
  })],
  ['GET', `${W}/surfaces`, workspace(async (context, { query }) => paint.everything(context, { masks: query.keys === 'mask' }))],
  ['POST', `${W}/surfaces`, workspace(async (context, { body }) => paint.surfaceFor(context, valid(surfaceSchema, body)))],
  ['GET', `${W}/surfaces/:surfaceId/strokes`, workspace(async (context, call) => paint.strokesSince(context, id(call, 'surfaceId', 'surface'), inQuery(sinceQuery, call.query).since))],
  ['POST', `${W}/surfaces/:surfaceId/strokes`, workspace(async (context, call) => paint.append(context, id(call, 'surfaceId', 'surface'), valid(strokeDraftSchema, call.body)))],
]

interface Route {
  method: string
  pattern: RegExp
  names: string[]
  handler: Handler
}

const routes: Route[] = ROUTES.map(([method, path, handler]) => {
  const names: string[] = []
  const pattern = new RegExp(`^${path.replace(/:(\w+)/g, (_, name: string) => {
    names.push(name)

    return '([^/]+)'
  })}/?$`)

  return { method, pattern, names, handler }
})

/** Which route answers this, and its path's parameters — or null for none. */
export function route (method: string, path: string): { handler: Handler, params: Record<string, string> } | null {
  const upper = method.toUpperCase()

  for (const each of routes) {
    if (each.method !== upper) continue

    const match = each.pattern.exec(path)

    if (match) {
      return {
        handler: each.handler,
        params: Object.fromEntries(each.names.map((name, index) => [name, decodeURIComponent(match[index + 1]!)])),
      }
    }
  }

  return null
}

/** One request, answered. Never throws. */
export async function answer (request: DataRequest): Promise<DataAnswer> {
  const [path = '', search = ''] = request.path.split('?')
  const query = { ...Object.fromEntries(new URLSearchParams(search)), ...request.query }
  const found = route(request.method, path)

  if (!found) {
    return { error: { status: 404, message: `${request.method.toUpperCase()} ${path} is not something this app answers.` } }
  }

  try {
    const result = await found.handler({ params: found.params, query, body: request.body })

    // Something may have changed: the next hourly backup has news to keep.
    if (request.method.toUpperCase() !== 'GET') written()

    if (result instanceof Bytes) return { bytes: result.bytes }

    // As JSON would have carried it: dates become strings, undefined goes.
    return { ok: result === undefined || result === null ? null : JSON.parse(JSON.stringify(result)) }
  } catch (error) {
    if (error instanceof HttpError) {
      return { error: { status: error.statusCode, message: error.statusMessage, data: error.data } }
    }

    console.error(`[data] ${request.method} ${path}`, error)

    return { error: { status: 500, message: error instanceof Error ? error.message : String(error) } }
  }
}

/**
 * The channels: `data:call` for the window's `$fetch`, and the few the
 * Settings panel needs to show and use the backups (`SettingsData.vue`).
 * Every one is the app's own page only.
 */
export function serveData (trusted: (event: Electron.IpcMainInvokeEvent) => boolean): void {
  const only = <A extends unknown[], R>(handler: (...args: A) => R) => (event: Electron.IpcMainInvokeEvent, ...args: A) => {
    if (!trusted(event)) throw new Error('Not the app.')

    return handler(...args)
  }

  ipcMain.handle('data:call', only((request: DataRequest) => answer(request)))
  ipcMain.handle('data:notice', only(() => openingNotice()))
  ipcMain.handle('data:about', only(() => ({ file: databaseFile(), backups: listBackups(), folder: backupsFolder() })))
  ipcMain.handle('data:backup', only(() => backup()))
  ipcMain.handle('data:open-backups', only(async () => {
    await shell.openPath(backupsFolder())
  }))
  ipcMain.handle('data:restore', only((name: string) => {
    restoreAtLaunch(name)
    app.relaunch()
    app.quit()
  }))
}
