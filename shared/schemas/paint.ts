import { z } from 'zod'

import { PLATES } from '../utils/layers'

/**
 * What a browser may say about a mark — one stroke, or a run of them.
 *
 * Two routes take strokes: the single one the mask brush still posts to, and
 * the batch the paint canvas sends. They share this rather than each spelling
 * a stroke out, because a stroke that one of them accepts and the other
 * refuses is a mark that saves from one tool and silently stays local from the
 * other — the exact drift `app/utils/strokes.ts` was written to end.
 */

/**
 * A surface's name on its page: `bg`, a block's key, or a sheet's stack id.
 *
 * The colon is load-bearing — see `surfaces/index.post.ts`, where a pattern
 * written for `mask-<block>` quietly refused every sheet's `paint:<id>`.
 */
export const SURFACE_KEY = /^[a-z0-9:-]{1,64}$/i

/**
 * How many strokes one batch may carry, and how many coordinates between them.
 *
 * The count is what a burst of painting fills; the points are what keep the
 * body a size the server can parse without thinking about it. A stroke is at
 * most 40,000 numbers, so the cap on points is ten of the longest there can be
 * — around four megabytes of JSON — and the browser splits a longer queue
 * across requests rather than hitting it.
 */
export const MAX_BATCH_STROKES = 200
export const MAX_BATCH_POINTS = 400_000

export const strokeDraftSchema = z.object({
  seq: z.number().int().positive(),
  clientId: z.string().min(1).max(64),
  tool: z.enum(['brush', 'eraser', 'clone', 'heal', 'patch']),
  composite: z.string().max(40).nullish(),
  params: z.object({
    size: z.number().positive().max(2000).optional(),
    softness: z.number().min(0).max(1).optional(),
    colour: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
    cloneOffset: z.object({ x: z.number(), y: z.number() }).optional(),
    region: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).optional(),
    /** Heal's ring samples, one per dab — see `StrokeParams`. */
    colours: z.array(z.string().regex(/^#[0-9a-f]{6}$/i)).max(5000).optional(),
  }),
  // Flat x/y pairs, so the length has to be even — a stroke with half a
  // coordinate is a parse bug on the way in, not data.
  points: z.array(z.number()).max(40_000).refine((p) => p.length % 2 === 0, 'points must be x,y pairs'),
  x: z.number(),
  y: z.number(),
  w: z.number().min(0),
  h: z.number().min(0),
})

/**
 * A run of marks, grouped by the surface each lands on — see `paint.appendMany`.
 *
 * A surface is named the way the canvas names it, by page and key, rather than
 * by row id: the point of the batch is that the first stroke on a surface is
 * what makes it, so a browser that has only ever looked at a page has no id to
 * give. `plate` or `layer` says which stack row files it — the plate's own row
 * for the retouching, the sheet's row by its stack id for a sheet — and exactly
 * one of them, because a sheet claiming a plate is the bug that filed every
 * blank layer's marks under the cleaned plate.
 *
 * `retracted` travels with each stroke. A mark taken back before its batch
 * landed is still this browser's to describe, and the batch is how it says so:
 * the server's copy is brought into line rather than written live and left for
 * an undo that has already happened.
 */
export const strokeBatchSchema = z.object({
  surfaces: z.array(z.object({
    pageId: z.number().int().positive(),
    key: z.string().regex(SURFACE_KEY),
    plate: z.enum(PLATES).nullish(),
    layer: z.string().trim().min(1).max(64).nullish(),
    strokes: z.array(strokeDraftSchema.extend({ retracted: z.boolean().optional() })).min(1).max(MAX_BATCH_STROKES),
  }).refine((one) => Boolean(one.plate) !== Boolean(one.layer), 'A surface is filed under a plate or a layer, and only one.'))
    .min(1)
    .max(50),
})
  .refine(
    (batch) => batch.surfaces.reduce((sum, one) => sum + one.strokes.length, 0) <= MAX_BATCH_STROKES,
    `At most ${MAX_BATCH_STROKES} strokes a request.`,
  )
  .refine(
    (batch) => batch.surfaces.reduce((sum, one) => sum + one.strokes.reduce((all, row) => all + row.points.length, 0), 0) <= MAX_BATCH_POINTS,
    `At most ${MAX_BATCH_POINTS} coordinates a request.`,
  )
