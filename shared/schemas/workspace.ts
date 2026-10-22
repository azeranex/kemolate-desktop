import { z } from 'zod'

import { PLACED_EXTENSIONS, PLATES } from '../utils/layers'

import type { Adjustment } from '../utils/adjust'
import type { Lettering } from '../utils/lettering'

/**
 * What a browser may say about a workspace and its pages.
 *
 * The ids and paths come from a machine we do not control, so everything that
 * will end up in a database row or a directory name is bounded here rather than
 * trusted. `publicId` is a uuid because that is what the browser mints.
 */
export const workspaceDraftSchema = z.object({
  publicId: z.uuid('A workspace id must be a uuid.'),
  name: z.string().trim().min(1).max(200),
  direction: z.enum(['ltr', 'rtl']).optional(),
  sourceLocale: z.string().trim().min(2).max(16).optional(),
  targetLocale: z.string().trim().min(2).max(16).optional(),
})

/**
 * What its owner may change afterwards.
 *
 * Every field optional, because a patch says only what moved — but not *all* of
 * them absent: an empty body would write nothing and still log a change, which
 * is a lie in the one table that exists to be believed.
 */
export const workspacePatchSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    direction: z.enum(['ltr', 'rtl']).optional(),
    sourceLocale: z.string().trim().min(2).max(16).optional(),
    targetLocale: z.string().trim().min(2).max(16).optional(),
    /*
     * The two prompt settings, and why they are here rather than only in the
     * Translate panel.
     *
     * The panel keeps its own copy in the browser — see `TranslateSettings` in
     * `useComic` — because that is where a reader's press builds its prompt.
     * The columns behind these are the record for a prompt built *without* a
     * browser, which today means the MCP server: an agent has no localStorage
     * to read a preference out of, and a page prompted with honorifics on for
     * one collaborator and off for another is a chapter that reads two ways.
     *
     * So they are settings of the chapter, exactly as the comment on the
     * columns says they should be, and the browser copy is the one that is out
     * of step. Anything that unifies the two should move the panel onto these
     * and not the other way about.
     */
    honorifics: z.boolean().optional(),
    wholePage: z.boolean().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, 'Nothing to change.')

export const pageDraftSchema = z.object({
  /**
   * The chapter's own name for this page, where the browser has been told it.
   *
   * A uuid rather than anything derived, because it has to survive a rename, a
   * reorder and a re-download — and because the two things it replaced could
   * each be two pages at once: a path changes, and a hash is shared by every
   * blank page of the same size.
   *
   * Absent when a browser is holding a folder up to be recognised, which is a
   * page's first mention read off a disk; the reply carries one back. Present
   * and unknown to the workspace when the browser is *asserting* a page — one
   * dropped onto an open chapter, or a blank added by hand — which the service
   * files under the name it was given rather than matching to anything. See
   * `rowFor` in `services/pages.ts`.
   */
  uid: z.uuid().nullish(),
  path: z.string().trim().min(1).max(1024),
  name: z.string().trim().min(1).max(255),
  position: z.number().int().min(0),
  hash: z.string().trim().min(8).max(128).nullish(),
  width: z.number().int().positive().nullish(),
  height: z.number().int().positive().nullish(),
  byteSize: z.number().int().nonnegative().nullish(),
})

/**
 * A cap, because this arrives in one request and a folder is whatever the
 * reader dragged. Two thousand pages is several volumes; anything past it is a
 * mistake or an attack, and both are better refused than absorbed.
 */
export const pageSyncSchema = z.object({
  pages: z.array(pageDraftSchema).max(2000),
})

/**
 * What one row of the layer stack looks like on its way to the server.
 *
 * The tree is sent flat, each row naming its parent by *uid* rather than by a
 * row id: the browser has never seen a row id for a group it made a moment ago,
 * and a stack is written in one request. The server resolves the names once
 * every row exists — see `layers.sync`.
 *
 * The adjustment is passed through rather than described here. Its shape lives
 * in `shared/utils/adjust.ts` and belongs to the code that applies it; spelling
 * it out again in a schema would be a second definition to keep in step, and
 * the one thing this layer has to guarantee is that the row is a row.
 */
export const layerDraftSchema = z.object({
  uid: z.string().trim().min(1).max(64),
  parentUid: z.string().trim().min(1).max(64).nullish(),
  position: z.number().int().min(0),
  label: z.string().trim().min(1).max(200),
  hint: z.string().trim().max(500).nullish(),
  plate: z.enum(PLATES).nullish(),
  visible: z.boolean(),
  /** Nought to a hundred, and multiplied by every group above it. */
  opacity: z.number().int().min(0).max(100),
  locked: z.boolean().optional(),
  paint: z.boolean().optional(),
  fixed: z.boolean().optional(),
  clipped: z.boolean().optional(),
  adjust: z.custom<Adjustment>().nullish(),
  /**
   * A picture placed on the page — the reference, never the bytes.
   *
   * Spelled out here rather than passed through the way the adjustment above
   * is, and the difference is where each of them ends up. An adjustment is a
   * few numbers that a filter reads; this becomes a **filename on somebody
   * else's machine**, built out of `hash` and `ext` by a browser that did not
   * place it. A shape arriving from off this machine that is going to be a
   * name is worth insisting on, and `PLACED_EXTENSIONS` is the same list the
   * client keeps files under, so the two cannot drift.
   *
   * The bound on `name` is the label a row wears; the bounds on the sizes are
   * there to refuse a number that is not a picture's, since the canvas divides
   * by them.
   */
  image: z.object({
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    ext: z.enum(PLACED_EXTENSIONS),
    name: z.string().trim().min(1).max(255),
    width: z.number().int().positive().max(100_000),
    height: z.number().int().positive().max(100_000),
  }).nullish(),
})

export const layerSyncSchema = z.object({
  // A stack is a dozen rows. The bound is here to refuse something absurd
  // rather than to express a limit anybody could reach by working.
  layers: z.array(layerDraftSchema).max(200),
  /** Which page's stack this is. A stack always belongs to one. */
  pageId: z.number().int().positive(),
})

/**
 * A stage of the work, as an arrangement of the standard plates — see
 * `LAYER_PRESETS`.
 *
 * Only ever the rows `DEFAULT_STACK` founds a page with, and the service checks
 * that rather than taking this schema's word for it: what makes a preset safe
 * to apply to every page at once is that it cannot reach a sheet somebody
 * added. The cap is the size of the default stack with room to grow.
 */
export const layerPresetSchema = z.object({
  rows: z.array(z.object({
    uid: z.string().trim().min(1).max(64),
    visible: z.boolean(),
    opacity: z.number().int().min(0).max(100).optional(),
    locked: z.boolean().optional(),
  })).max(50),
  /** The page to hand back afterwards, so the browser gets its own stack. */
  pageId: z.number().int().positive(),
})

/**
 * The room inside a block's balloon — see `blocks.room`. An upright rectangle
 * in the block's own width-normalised space, bounded as the box is.
 */
const roomSchema = z.object({
  cx: z.number().min(-10).max(10),
  cy: z.number().min(-10).max(10),
  w: z.number().min(0).max(10),
  h: z.number().min(0).max(10),
  // Desktop: the room is the balloon's oval, not a rectangle in it — see `RoomBox`.
  round: z.boolean().optional(),
})

/**
 * One block, as a reading produces it.
 *
 * The coordinates are the width-normalised oriented box the `blocks` table
 * keeps and `shared/utils/ocr.ts` produces — not the percentages the canvas
 * draws in. Normalised by width on *both* axes, so `cy` and `h` legitimately
 * run past one on a page taller than it is wide; the bounds here are loose
 * enough to allow that and tight enough to refuse a number that can only be
 * a mistake. Negative positions are allowed on the same grounds: lettering
 * can bleed off the edge of a scan.
 */
export const blockDraftSchema = z.object({
  kind: z.enum(['bubble', 'caption', 'sfx', 'garbage']).default('bubble'),
  cx: z.number().min(-10).max(10),
  cy: z.number().min(-10).max(10),
  w: z.number().min(0).max(10),
  h: z.number().min(0).max(10),
  angle: z.number().min(-360).max(360).default(0),
  skewX: z.number().min(-360).max(360).default(0),
  skewY: z.number().min(-360).max(360).default(0),
  quad: z.array(z.number()).length(8).nullish(),
  room: roomSchema.nullish(),
  source: z.string().max(4000).default(''),
  confidence: z.number().int().min(0).max(100).default(0),
  hidden: z.boolean().default(false),
})

/**
 * A page's blocks, all of them, in reading order.
 *
 * Whole-page rather than one at a time because that is what a reading is:
 * the engine hands back everything it found, and the page's previous blocks
 * are not a thing to be merged with — they were a reading of the same scan.
 * The cap is generous for a dense page and far under what a mistake looks
 * like.
 */
export const blockSyncSchema = z.object({
  blocks: z.array(blockDraftSchema).max(500),
})

/**
 * A balloon to make: the blocks it is made of, and the block it becomes.
 *
 * `children` are in the order they read, two at least because a balloon of one
 * is not a balloon, and capped at the five hundred a page's blocks are — so it
 * can never name more blocks than a page can hold. The rest is the parent, and
 * its box is the union of the children's, measured by whoever could see them.
 */
export const compoundSchema = z.object({
  children: z.array(z.number().int().positive()).min(2).max(500),
  kind: z.enum(['bubble', 'caption', 'sfx', 'garbage']).default('bubble'),
  cx: z.number().min(-10).max(10),
  cy: z.number().min(-10).max(10),
  w: z.number().min(0).max(10),
  h: z.number().min(0).max(10),
  source: z.string().max(4000).default(''),
  confidence: z.number().int().min(0).max(100).default(0),
})

/**
 * How one block's lettering is set — the `Lettering` shape, bounded.
 *
 * Nullable exactly where the editor's is, and that is the whole reason this is
 * written out rather than derived from anything. `size`, `line` and `vertical`
 * each mean "work it out" when they are null, which is a *different* answer from
 * a number or a direction somebody chose — see `verticalOf`. A schema that
 * collapsed the two would turn every deliberate H into a guess on the next
 * reload, which is the bug this whole path exists to fix.
 *
 * The bounds are looser than `letteringRange`. That range is how far a slider
 * goes; this is what a row may hold, and Fit writes a size measured against the
 * balloon on the scan's own pixels rather than against the slider. Loose enough
 * for a big scan, tight enough to refuse a number that can only be a mistake.
 *
 * The four enums are spelled out rather than imported, the same deliberate
 * duplication `WORKSPACE_ROLES` carries and for a weaker version of the same
 * reason: a schema reads better as a statement of what is accepted than as a
 * reference to somewhere else. The test beside this file compares its keys with
 * `LETTERING`'s, so a setting added there and forgotten here is a red test
 * rather than a control that silently stops being saved.
 */
/** `#rrggbb`, which is the one form a native colour input ever produces. */
const HEX_COLOUR = /^#[0-9a-f]{6}$/i

export const letteringStyleSchema = z.object({
  /**
   * A key from `FONTS`, never a CSS family — a stack arriving off the wire
   * would be a font name from a machine we do not control going straight into
   * a `font-family`, and an enum is the whole of the defence against that.
   */
  font: z.enum([
    'dialogue', 'sfx', 'retro', 'casual', 'marker', 'hand', 'poster', 'sans', 'serif', 'mono',
  ]).nullish(),
  size: z.number().min(0).max(2000).nullish(),
  line: z.number().min(0).max(10).nullish(),
  spacing: z.number().min(-500).max(500).optional(),
  stroke: z.number().min(0).max(500).optional(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  align: z.enum(['left', 'center', 'right', 'justify']).optional(),
  anchor: z.enum(['top', 'middle', 'bottom']).optional(),
  vertical: z.boolean().nullish(),
  /**
   * Six hex digits and nothing else, for the same reason `font` is an enum: a
   * colour arriving off the wire is written straight into a CSS `color`, and a
   * `string` there would accept `url(...)` and every other thing CSS will take
   * from a machine we do not control. Null is Auto — see `inking`, and note
   * that a schema collapsing that to a default would freeze the automatic
   * choice at whatever the page happened to be when it was saved.
   */
  color: z.string().regex(HEX_COLOUR).nullish(),
  outline: z.string().regex(HEX_COLOUR).nullish(),
  /** What the lines wrap into — see `LetterShape`. Null is the block's own default. */
  shape: z.enum(['box', 'soft', 'oval', 'diamond', 'custom']).nullish(),
  /**
   * A custom shape's polygon, `[x0, y0, x1, y1, …]` as shares of the frame.
   * Bounded both ways: three corners at least, and few enough that a stored
   * style stays a small thing to send with every page.
   */
  points: z.array(z.number().min(0).max(1)).min(6).max(64)
    .refine((points) => points.length % 2 === 0, 'A shape\'s points come in pairs.')
    .nullish(),
}) satisfies z.ZodType<Partial<Lettering>>

/**
 * What a page's blocks say, and how they are set — one language, one request.
 *
 * A page at a time rather than a block at a time, which is what makes the
 * ordinary case free. A browser opening a chapter has just been handed every
 * translation on the page and will re-send all of them at the first settle; as
 * one request that is one round trip the server answers by writing nothing (see
 * `putOnPage`), where a block at a time would have been thirty.
 *
 * `text` and `style` travel together because the row holds both and the write is
 * an upsert: a style sent on its own would have to invent a `text` to go with
 * it, and the only value it could invent is the empty string that wipes the
 * line. The browser has both to hand and is the authority on both.
 *
 * The lettering's own box rides along for the same reason, and is a different
 * thing from the block's box. A block says where the original lettering was
 * *found*, which is what the cleaning under it was measured against; resizing it
 * to fit a translation therefore orphans the patch. So the typeset text gets
 * geometry of its own, on the row that holds the typeset text.
 *
 * Capped where a page's blocks are, so this can never name more than a page can
 * hold.
 */
export const translationSyncSchema = z.object({
  locale: z.string().trim().min(2).max(16),
  entries: z
    .array(z.object({
      blockId: z.number().int().positive(),
      text: z.string().max(4000),
      /** Null is "set it the way the app would" — the Reset button's answer. */
      style: letteringStyleSchema.nullish(),
      /*
       * Where the lettering sits, when it has been moved off the block.
       *
       * Absent — and null, which is the same answer said out loud — means it
       * sits on the block, which is what every row written before this existed
       * means and what the browser sends until somebody drags something. The two
       * are deliberately not told apart: a browser is handed these values with
       * the page and sends them back with it, so "the field is missing" can only
       * mean the lettering has no box of its own, exactly as it does for
       * `style`. Treating absence as "leave it alone" instead would make a
       * balloon impossible to put back on its block.
       *
       * The same bounds and the same grid as `blockDraftSchema` above, because
       * this is the same measurement of the same page: normalised by the scan's
       * *width* on both axes, so `cy` and `h` run past one on a tall page, and
       * negative is allowed because lettering can bleed off the edge. `quad` is
       * eight numbers — four corners, x and y — which is the block convention
       * and what `translations.quad` is documented to hold.
       *
       * The whole box shape and not a subset of it, `skewX`/`skewY` included.
       * The canvas drags a lettering frame through the same `toOriented`/
       * `toBoxed` arithmetic it drags a block through, so a frame can lean; and
       * `toBoxed` writes `quad` only where a corner has actually been pulled, so
       * a lean leaves no corner offsets to be recovered from. Six fields would
       * have been a frame that quietly came back upright.
       *
       * Bounded at the block's `-360..360` rather than at what a drag can
       * produce. `clampDeg` stops a lean at ±75 because past that a box is
       * edge-on and unreadable, but that is a rule about a gesture and belongs
       * where the gesture is; restating it here would give the same quantity a
       * third bound and refuse a lean a *block* accepts.
       */
      cx: z.number().min(-10).max(10).nullish(),
      cy: z.number().min(-10).max(10).nullish(),
      w: z.number().min(0).max(10).nullish(),
      h: z.number().min(0).max(10).nullish(),
      angle: z.number().min(-360).max(360).nullish(),
      skewX: z.number().min(-360).max(360).nullish(),
      skewY: z.number().min(-360).max(360).nullish(),
      quad: z.array(z.number()).length(8).nullish(),
    }))
    .max(500),
  /**
   * What produced these words, when it was not a person.
   *
   * Absent is the ordinary case and means somebody typed — which is also what
   * pins the line against later runs, so this field is the whole of how the
   * server tells the two apart. See `translations.putOnPage`.
   *
   * It is not something a browser can be trusted about, and does not need to
   * be: the worst a forged `origin` achieves is filing your own typing under a
   * model's name in your own workspace, and refusing to pin a line you are
   * about to be able to pin by hand anyway.
   */
  origin: z
    .object({
      /**
       * `agent` is something outside this app writing through the MCP server —
       * see `server/mcp/tools/save-page-translations.ts`. Listed here even
       * though no browser sends it, because this enum is where the app says
       * what an engine can be, and a value in the column that is missing from
       * the list is a value the next reader will take for a mistake.
       */
      engine: z.enum(['google', 'ai-text', 'ai-image', 'agent']),
      model: z.string().max(120).nullish(),
      /** One run, so its lines can be taken back together. */
      batch: z.string().max(64).nullish(),
    })
    .nullish(),
})

/**
 * One term, typed by a person.
 *
 * Stricter than `glossaryMergeSchema` next to it, and the asymmetry is the
 * point: that one carries a language model's JSON and has to survive whatever
 * it invents, where this carries two fields out of two inputs and can say what
 * it wants. `min(1)` here is a form telling somebody they left a box empty; the
 * same rule there would turn one bad row into a failed page.
 */
export const glossaryTermSchema = z.object({
  locale: z.string().trim().min(2).max(16),
  source: z.string().trim().min(1).max(80),
  target: z.string().trim().min(1).max(80),
})

/** A correction to a term already on the list — either half, or both. */
export const glossaryEditSchema = z
  .object({
    locale: z.string().trim().min(2).max(16),
    source: z.string().trim().min(1).max(80).optional(),
    target: z.string().trim().min(1).max(80).optional(),
  })
  .refine(
    (patch) => patch.source !== undefined || patch.target !== undefined,
    'Nothing to change.',
  )

/**
 * The cast as a person edits it — the whole list, saved as one thing.
 *
 * Whole-list rather than a patch per row, because that is what the panel is: a
 * draft edited together and saved together. Half a cast saved is a prompt that
 * contradicts itself.
 *
 * Loose about what is *inside* a member for the reason the glossary merge is
 * loose: the service clips every length, drops the nameless rows and enforces
 * the ceiling anyway, because it has to do all of that for what a model
 * proposes as well. A second, stricter copy of those rules here would be a
 * second place for them to drift.
 */
export const castSaveSchema = z.object({
  members: z
    .array(z.object({
      source: z.string().max(200),
      /** How the name reads in each target language, keyed by locale. */
      names: z.record(z.string().max(16), z.string().max(200)).nullish(),
      gender: z.enum(['male', 'female', 'nb', 'unknown']).optional(),
      tags: z.array(z.string().max(200)).max(50).nullish(),
    }))
    .max(100),
  /** A standing instruction about the work as a whole. */
  notes: z.string().max(4000).default(''),
})

/** What a page taught the model about who is in it. */
export const castMergeSchema = z.object({
  locale: z.string().trim().min(2).max(16),
  learned: z
    .array(z.object({
      name: z.unknown(),
      tr: z.unknown(),
      gender: z.unknown(),
      tags: z.unknown(),
    }))
    .max(50),
})

/** Choosing one of a line's earlier wordings, or letting it follow the newest. */
export const revisionChoiceSchema = z.object({
  locale: z.string().trim().min(2).max(16),
  /**
   * Which wording to put back, or null to un-pin and follow the newest again.
   *
   * One field rather than two endpoints because they are one decision made in
   * one control — the list in the Text panel, where "follow the newest" is a
   * row like any other.
   */
  revisionId: z.number().int().positive().nullable(),
})

/** Taking back everything one press wrote. */
export const revisionRevertSchema = z.object({
  locale: z.string().trim().min(2).max(16),
  batch: z.string().min(1).max(64),
})

/**
 * Terms a page taught the model, on their way into the chapter's glossary.
 *
 * `src`/`tr` rather than `source`/`target`, which is the one place this app
 * speaks the prompt's vocabulary instead of the database's. The model is asked
 * for those two keys by name — see `pagePrompt` — and the browser forwards what
 * it was handed rather than renaming it in flight, so there is exactly one
 * place (`glossaries.merge`) where a model's answer is turned into a row and
 * exactly one shape to check when it comes out wrong.
 *
 * Everything is loose on purpose: this is a language model's JSON, not a form.
 * The service clips lengths, drops the empties and enforces the ceiling, and it
 * has to do that anyway for the terms it reads back out of the database. A
 * strict schema here would only turn a bad row into a failed page.
 */
export const glossaryMergeSchema = z.object({
  locale: z.string().trim().min(2).max(16),
  learned: z
    .array(z.object({
      src: z.unknown(),
      tr: z.unknown(),
    }))
    .max(100),
})

/**
 * One block, changed.
 *
 * Every field optional, and written out rather than derived from the draft
 * above: a patch has to be able to say "only this moved", and a schema built by
 * making the draft's fields optional would keep their defaults and quietly
 * rewrite an angle to nought every time somebody dragged a corner.
 *
 * `confidence` is absent on purpose. It is how sure the *reader* was, a fact
 * about a reading that already happened, and nothing a letterer does to a block
 * afterwards makes it more or less true.
 */
export const blockPatchSchema = z.object({
  kind: z.enum(['bubble', 'caption', 'sfx', 'garbage']).optional(),
  cx: z.number().min(-10).max(10).optional(),
  cy: z.number().min(-10).max(10).optional(),
  w: z.number().min(0).max(10).optional(),
  h: z.number().min(0).max(10).optional(),
  angle: z.number().min(-360).max(360).optional(),
  skewX: z.number().min(-360).max(360).optional(),
  skewY: z.number().min(-360).max(360).optional(),
  quad: z.array(z.number()).length(8).nullish(),
  room: roomSchema.nullish(),
  source: z.string().max(4000).optional(),
  hidden: z.boolean().optional(),
  position: z.number().int().min(0).max(500).optional(),
})

/**
 * Several blocks on one page, changed — `blockPatchSchema` a page at a time,
 * each patch naming the row it is for.
 *
 * What a settle of `useBlockSync` sends, and a room measured across a page.
 * One patch per block per request was three to five hundred requests for a
 * chapter's worth of edits, each resolving the same workspace over again and
 * raising a change notice of its own for every other tab to act on.
 *
 * Each entry is exactly the single patch plus its `id`, so a field is bounded
 * in one place whichever door it comes through.
 *
 * A block may be named once. Two patches for one row in one request would be
 * applied in order and the second would win — a request that argues with
 * itself is a mistake, and refusing it is cheaper than guessing which half was
 * meant.
 *
 * The cap is twice what a page's reading may hold, because the rows a page
 * holds are more than its blocks: every column inside a balloon is a row of its
 * own and the balloon is another over them (see `blocks.parentId`), and the
 * sync sends them all.
 */
export const blockPatchesSchema = z.object({
  blocks: z
    .array(blockPatchSchema.extend({ id: z.number().int().positive() }))
    .min(1)
    .max(1000)
    .refine(
      (list) => new Set(list.map((entry) => entry.id)).size === list.length,
      'Each block may be named once.',
    ),
})

/**
 * A line's history, on its way back in from a project file.
 *
 * Bounded at both ends because this is the one write in the app that inserts a
 * *list* of rows per line rather than one: fifty wordings is far past what any
 * balloon accumulates, and the cap on entries keeps one request to a page's
 * worth rather than a chapter's.
 *
 * No `authorId` and no ids, and neither is an omission. A revision's id names a
 * row on the install the file came from, and its author names a user there —
 * see `restoreRevisions`, which writes null rather than attributing somebody's
 * translation to whoever happens to hold that number here.
 */
export const revisionRestoreSchema = z.object({
  entries: z
    .array(z.object({
      blockId: z.number().int().positive(),
      locale: z.string().trim().min(2).max(16),
      pinned: z.boolean(),
      /** Which wording the page should show, as an index into the list below. */
      head: z.number().int().min(-1),
      revisions: z
        .array(z.object({
          text: z.string().max(4000),
          engine: z.string().trim().min(1).max(32),
          model: z.string().max(200).nullish(),
          batch: z.string().max(64).nullish(),
          /** When it was written, in milliseconds — the dates are the history. */
          at: z.number().int().min(0).nullish(),
        }))
        .max(50),
    }))
    .max(500),
})

/**
 * A browser's account of a reading it was asked for — see
 * `reading/[requestId].post`, and `ReadReport` in `server/utils/reading.ts`.
 *
 * It was read with a bare `readBody` and coerced field by field, which also
 * quietly dropped `read`: every agent that asked for a reading was told no
 * page had been read. The error is clipped rather than refused, because it
 * ends up in a tool reply and a report that arrives is worth more than its
 * last few hundred characters.
 */
export const readReportSchema = z.object({
  ok: z.boolean(),
  read: z.number().int().min(0).max(10_000).optional(),
  blocks: z.number().int().min(0).max(1_000_000).optional(),
  error: z.string().transform((text) => text.slice(0, 400)).optional(),
})
