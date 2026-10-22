/**
 * A chapter's work, as one file somebody can keep.
 *
 * Everything this app makes lives somewhere a browser can lose: IndexedDB for
 * the reading and the paint, OPFS for the scans and the placed images, and the
 * server only for a workspace somebody has shared. Clearing site data takes all
 * of it, a second computer has none of it, and "share the workspace" is an
 * answer that requires an account and a collaborator nobody asked for. A
 * project file is the answer that requires neither: one thing to copy, mail or
 * back up, holding the pages and everything anybody has decided about them.
 *
 * ## What travels
 *
 * The pages, the reading, what each balloon says and how it is set, the layer
 * stack of every page, the retouching, the **cleaned balloons**, the pictures
 * the reader placed, and the chapter's glossary and cast. That is the whole of
 * the current state.
 *
 * ## What does not, and why each is a decision rather than an oversight
 *
 * - **Revision history.** `translation_revisions` is a server table and a
 *   local-only chapter has never had one, so a format that carried it would be
 *   full of it for one workspace and empty for another — and an import that
 *   restored somebody's superseded wordings as though they were live is worse
 *   than one that plainly restores the current text. What a line says now is
 *   what a project file is about.
 * - **Other target languages.** The browser holds one translation per block —
 *   the language the chapter is being carried into — because that is what
 *   `Block.translation` is. Reaching for the rest would mean a request per
 *   locale against a server that may not have heard of this workspace.
 * - **Thumbnails.** Derived, content-addressed, and cheap: throwing one away
 *   costs the milliseconds to draw it again from a scan that is in here.
 *   Cleaned patches were on this list on the same reasoning and have been taken
 *   off it — see `PATCHES_DIR`, which is where that argument is answered.
 * - **Contributors, invites and the workspace log.** They are facts about an
 *   arrangement between people rather than about the chapter, and they mean
 *   nothing in the workspace this gets imported into.
 *
 * ## The shapes are the app's own, deliberately
 *
 * `blocks` is `Block[]` and `stack` is `StackLayer[]` — the very arrays the
 * canvas draws, written out as they stand. That is already how `useBlockCache`
 * keeps a reading between reloads, and the alternative is a second description
 * of a block that has to be mapped both ways and kept in step with the first.
 * What stops that becoming a shape nobody can rely on is `projectSchema` below:
 * the schema is the contract, and a field the app renames without changing it
 * is a test that goes red rather than an import that silently drops something.
 *
 * The one shape written out longhand is the stroke, because a stored stroke
 * must *not* carry its id — see `ProjectStroke`.
 */
import { z } from 'zod'

import type { Adjustment } from '#shared/utils/adjust'
import type { Lettering } from '#shared/utils/lettering'
import type { StrokeParams } from '~~/server/database'

import { PLACED_EXTENSIONS, PLATES } from '#shared/utils/layers'

/**
 * The format's version, and the only thing an importer checks before deciding
 * it understands the file.
 *
 * Bumped when a change would make an older reader wrong rather than merely
 * incomplete — an optional field added is not one, since every reader here
 * ignores what it does not know.
 */
export const PROJECT_VERSION = 1

/** What the file is called. Its type is stamped by `zip`, which makes it. */
export const PROJECT_EXTENSION = '.kemolate'

/** Where each thing sits inside the archive. */
export const MANIFEST = 'project.json'
export const PAGES_DIR = 'pages/'
export const IMAGES_DIR = 'images/'

/**
 * Cleaned balloons, filed under the key that names them — see `patchKey`.
 *
 * These are *derived*, and were left out of the format on exactly that ground:
 * given the scan, the box, the mask and the model, a repair can always be made
 * again. That reasoning was wrong twice over.
 *
 * It is wrong about **cost**. Cleaning is the expensive step in the whole
 * pipeline — seconds a balloon, behind a model download of tens of megabytes —
 * so "recomputable" here means an evening's work is recomputable, on a machine
 * that may not have the weights. Every other derived thing left out of this
 * file costs milliseconds.
 *
 * And it is wrong about **reproducibility**, which `patches.ts` says outright:
 * the key names the inputs, not the pixels, and across machines two people
 * cleaning the same balloon get the same picture and different bytes. A repair
 * that cannot be reproduced byte for byte is not derived data at the other end;
 * it is work, and work belongs in the file.
 *
 * The size objection dies the moment the scans are in here too: a page's worth
 * of patches is a fraction of the page.
 */
export const PATCHES_DIR = 'patches/'

/**
 * One mark, as a project file keeps it.
 *
 * `LocalStroke` minus its id, and the subtraction is the point. A local id is
 * negative and minted by a counter in the browser that drew it; a server id is
 * a row somewhere else entirely. Neither means anything in the workspace this
 * is imported into, and carrying one over would hand undo two strokes with the
 * same name — the failure `usePaintCache` describes at length. So the id is
 * dropped on the way out and minted fresh on the way in.
 *
 * `seq` and `clientId` do travel, and must: they are what put the marks back in
 * the order they were laid in, and a repaint that loses that order is a
 * different picture rather than a lesser one.
 */
export interface ProjectStroke {
  seq: number
  clientId: string
  tool: string
  composite: string | null
  /**
   * The tool's own settings, exactly as `strokes.params` keeps them. Borrowed
   * from the server's shape rather than restated, the way `usePaintCache` does
   * — a mark that replays differently from how it was painted is not a lesser
   * copy of the page, it is a different page.
   */
  params: StrokeParams
  /** Flat `x y` pairs in page pixels. */
  points: number[]
  x: number
  y: number
  w: number
  h: number
  retracted: boolean
}

export interface ProjectPage {
  /** The chapter's own name for the page, where it has one — see `pages.uid`. */
  uid?: string
  /** Its place in the folder, which is also its name inside the archive. */
  path: string
  name: string
  position: number
  /** The scan's SHA-256, which is what everything derived is filed under. */
  hash?: string
  width?: number
  height?: number
  /**
   * The archive entry holding this page's scan, or absent.
   *
   * Absent is a real answer rather than a failure: a chapter can be exported
   * from a browser that holds the record of a page and not its file — the
   * ordinary state of a workspace somebody joined — and the page still carries
   * its blocks, its stack and its size. It arrives at the other end exactly as
   * it left, which is a page waiting for its picture.
   */
  file?: string
  blocks: Block[]
  /**
   * What each line on this page used to say, by the block's place in `blocks`
   * above.
   *
   * Beside the blocks rather than inside them, which is the one place this
   * format departs from "the shapes are the app's own". A `Block` has no
   * `revisions` field and should not grow one: the canvas draws a block, and
   * history is not something a canvas has any use for. Putting it here keeps
   * `blocks` assignable to what `setBlocks` wants without anything having to be
   * stripped off on the way in.
   *
   * Keyed by index because a block has no name that survives the journey — its
   * `id` is `block:41` where a server row existed, and `localise` rewrites
   * exactly those on import. The index is the one thing both ends agree on,
   * and it is why `blocks` must never be reordered between writing these and
   * writing that.
   */
  revisions?: Record<number, ProjectLine[]>
  stack?: StackLayer[]
  /**
   * The retouching, keyed by surface — `bg` for what belongs to no block, a
   * block's own key, or the uid of a sheet somebody added.
   *
   * Keyed rather than flattened into one list because a surface is the unit the
   * canvas replays: two people cleaning two balloons are not editing the same
   * thing, and a single list would have to carry the key on every mark to say
   * so.
   */
  paint?: Record<string, ProjectStroke[]>
}

/** One wording a line has had, and what produced it. */
export interface ProjectRevision {
  text: string
  /** 'human', or the machine that drafted it — 'ai-text', 'ai-image', 'google'. */
  engine: string
  model?: string | null
  /** The run this came from, so taking a whole press back still works. */
  batch?: string | null
  /** When it was written, in milliseconds. The dates are the history. */
  at?: number | null
}

/**
 * One line's history, in one language.
 *
 * `head` is an **index** into `revisions` rather than an id, for the reason
 * everything else in this format avoids ids: the id names a row on the install
 * the file came from. "The third wording" survives the journey where "revision
 * 412" cannot.
 */
export interface ProjectLine {
  locale: string
  pinned: boolean
  head: number
  revisions: ProjectRevision[]
}

/**
 * What the models have been asked and what it came to — `useAiUsage`'s ledger,
 * carried whole.
 *
 * Worth stating what this is, because it is the one thing in the file that is
 * about the *reader* rather than about the chapter. It is a record of what this
 * person spent on their own key, and it is included because "what did this
 * chapter cost me" is a question that should survive moving to another machine,
 * which is most of what a project file is for.
 *
 * The consequence is worth being plain about rather than discovering: a file
 * sent to somebody else carries your spend to them, and importing it adopts it.
 * There is nothing in a token count that leaks a page or a key — see the
 * ledger's own note on why it is not a server table — but it is your bill, and
 * a collaborator's chapter total will include it.
 *
 * `carried` is per page and cannot be folded into one number; the ledger says
 * at length why. Both halves travel or the totals stop adding up.
 */
export interface ProjectUsage {
  entries: AiUse[]
  carried: Record<string, AiTotals>
}

/** The two settings a repair's name is built from — see `Project.clean`. */
export interface ProjectClean {
  /** Which inpainter filled the hole: `aot`, `lama`, `migan`, or `none`. */
  model: string
  /** Whether the learned mask decided where the hole was, or the threshold. */
  segmenter: boolean
}

export interface ProjectGlossary {
  locale: string
  terms: { source: string, target: string }[]
}

export interface ProjectCastMember {
  source: string
  names?: Record<string, string> | null
  gender: 'male' | 'female' | 'nb' | 'unknown'
  tags?: string[] | null
  pinned?: boolean
}

export interface Project {
  v: number
  /** So a file that is a zip but not one of ours is refused by name. */
  app: 'kemolate'
  /** When it was written, in milliseconds. */
  exported: number
  title: string
  /** What the chapter was being carried into, where anybody had said. */
  targetLocale?: string | null
  direction?: 'ltr' | 'rtl' | null
  pages: ProjectPage[]
  glossaries?: ProjectGlossary[]
  cast?: ProjectCastMember[]
  /** What the models cost the reader who exported this — see `ProjectUsage`. */
  usage?: ProjectUsage
  /**
   * How the chapter was cleaned, which is part of what its repairs are *named*.
   *
   * `patchKey` stamps the inpainter and the mask source into every key, so a
   * browser that opens this with a different cleaner selected would compute
   * different keys and find none of the repairs in the archive — they would be
   * there, on disk, under names nothing asks for. Carrying the two settings is
   * what makes the patches findable rather than merely present.
   */
  clean?: ProjectClean
}

/**
 * A box, in the percentages every coordinate in the app is in.
 *
 * The bounds are generous on purpose: a block dragged past the edge of the page
 * is a thing a letterer does, and refusing to import one would be enforcing a
 * rule the editor itself does not.
 */
const coordinate = z.number().finite().min(-100).max(100)

const boxFields = {
  x: coordinate,
  y: coordinate,
  w: coordinate,
  h: coordinate,
  angle: z.number().finite().optional(),
  skewX: z.number().finite().optional(),
  skewY: z.number().finite().optional(),
  /** Eight numbers, `dx dy` per corner — see `Block.quad`. */
  quad: z.array(z.number().finite()).length(8).optional(),
}

/**
 * A block, and its children.
 *
 * `z.lazy` with the annotation spelled out, because a self-referencing schema
 * has no type TypeScript can infer on its own — it would be `any`, which is the
 * one outcome that would make writing this schema pointless. Annotating it as
 * `Block` also buys the thing worth having: if a field of `Block` is renamed
 * and this is not, the file stops compiling rather than quietly importing a
 * page of blocks with a piece missing.
 *
 * One level deep in practice, since a balloon inside a balloon is not a thing a
 * page has. Nothing caps the depth: the tree came out of an archive somebody
 * exported rather than off a wire, and `.max` on each array is the bound that
 * actually does the refusing.
 */
const blockSchema: z.ZodType<Block> = z.lazy(() => z.object({
  id: z.string().min(1).max(200),
  type: z.enum(['bubble', 'caption', 'sfx', 'garbage']),
  ...boxFields,
  source: z.string(),
  translation: z.string(),
  confidence: z.number().finite().min(0).max(100),
  hidden: z.boolean(),
  /**
   * Passed through, for the reason `layerDraftSchema` passes an adjustment
   * through: the shape is `Partial<Lettering>` and belongs to the module that
   * letters with it. Describing it again here would be a second definition to
   * keep in step, and every field of it is optional anyway.
   */
  style: z.custom<Partial<Lettering>>().optional(),
  letter: z.object(boxFields).optional(),
  /** The balloon's room — see `Block.room`. Upright, so the four numbers, and whether it is the balloon's oval. */
  room: z.object({ x: coordinate, y: coordinate, w: coordinate, h: coordinate, round: z.boolean().optional() }).optional(),
  children: z.array(blockSchema).max(500).optional(),
}))

const stackSchema: z.ZodType<StackLayer> = z.lazy(() => z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(200),
  hint: z.string().max(500).optional(),
  visible: z.boolean(),
  opacity: z.number().int().min(0).max(100),
  locked: z.boolean().optional(),
  fixed: z.boolean().optional(),
  paint: z.boolean().optional(),
  clipped: z.boolean().optional(),
  open: z.boolean().optional(),
  plate: z.enum(PLATES).optional(),
  adjust: z.custom<Adjustment>().optional(),
  /**
   * Spelled out rather than passed through, exactly as `layerDraftSchema` does
   * and for the same reason: `hash` and `ext` are built into a **filename** by
   * the browser that opens this, and a shape arriving from another machine that
   * is going to be a name is worth insisting on.
   */
  image: z.object({
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    ext: z.enum(PLACED_EXTENSIONS),
    name: z.string().min(1).max(255),
    width: z.number().int().positive().max(100_000),
    height: z.number().int().positive().max(100_000),
  }).optional(),
  children: z.array(stackSchema).max(200).optional(),
}))

const strokeSchema = z.object({
  seq: z.number().int().min(0),
  clientId: z.string().min(1).max(64),
  tool: z.string().min(1).max(32),
  composite: z.string().max(32).nullable(),
  params: z.custom<StrokeParams>(),
  /**
   * A long stroke is a few thousand numbers, and a page of them is the biggest
   * thing in the manifest. The cap refuses something absurd rather than
   * expressing a limit a hand could reach.
   */
  points: z.array(z.number().finite()).max(200_000),
  x: z.number().finite(),
  y: z.number().finite(),
  w: z.number().finite(),
  h: z.number().finite(),
  retracted: z.boolean(),
})

const lineSchema = z.object({
  locale: z.string().min(2).max(16),
  pinned: z.boolean(),
  /**
   * `-1` is a real answer and means "the newest", which is what a head written
   * before `revisionId` existed resolves to everywhere else. Anything past the
   * end resolves the same way rather than refusing, since a head nobody can
   * find is still a line that has to show something.
   */
  head: z.number().int().min(-1),
  revisions: z.array(z.object({
    text: z.string().max(4000),
    engine: z.string().min(1).max(32),
    model: z.string().max(200).nullish(),
    batch: z.string().max(64).nullish(),
    at: z.number().int().min(0).nullish(),
  })).max(50),
})

/**
 * The AI ledger, passed through rather than described.
 *
 * The same call `layerDraftSchema` makes about an adjustment, and for the same
 * reason: the shape belongs to `useAiUsage` and this format stores it rather
 * than interpreting it. Nothing here reads a field of it — it is written to one
 * IndexedDB key and read back from it — so a second description would be a
 * second thing to keep in step for no gain. The rows are capped because an
 * unbounded list in a file somebody was sent is worth refusing.
 */
const usageSchema = z.object({
  entries: z.array(z.custom<AiUse>()).max(20_000),
  carried: z.record(z.string().max(1024), z.custom<AiTotals>()),
})

const pageSchema = z.object({
  /**
   * A uuid, and anything else is dropped rather than carried or refused.
   *
   * The same shape `pageDraftSchema` insists on, and it has to be the same:
   * a uid goes straight back out in the page sync, which rejects the **whole
   * request** if one page's is not a uuid. So a single odd name in a file — a
   * hand-edited manifest, a build that minted them differently — would stop
   * every page of the chapter reaching the server, on every retry, for ever,
   * with nothing on screen to say why.
   *
   * `.catch` rather than a refusal because a uid is a *hint*: it lets a
   * collaborator's copy of the same chapter match page for page, and losing it
   * costs matching by hash and path instead, which `rowFor` does anyway. That
   * is a poor reason to reject a file whose pages, reading and paint are all
   * perfectly good — and a page with no uid is a shape the server already
   * understands, since it is what a folder held up to be recognised looks
   * like.
   */
  uid: z.uuid().optional().catch(undefined),
  path: z.string().min(1).max(1024),
  name: z.string().min(1).max(255),
  position: z.number().int().min(0),
  hash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  width: z.number().int().positive().max(100_000).optional(),
  height: z.number().int().positive().max(100_000).optional(),
  file: z.string().min(1).max(1024).optional(),
  blocks: z.array(blockSchema).max(2000),
  // Keyed by the block's index in `blocks` above — see `ProjectPage.revisions`.
  // `z.coerce` because JSON object keys are strings and these are indices.
  revisions: z.record(z.coerce.number().int().min(0), z.array(lineSchema).max(20)).optional(),
  stack: z.array(stackSchema).max(200).optional(),
  paint: z.record(z.string().min(1).max(200), z.array(strokeSchema).max(5000)).optional(),
})

export const projectSchema = z.object({
  v: z.number().int().positive(),
  app: z.literal('kemolate'),
  exported: z.number().int().min(0),
  title: z.string().max(255),
  targetLocale: z.string().max(32).nullish(),
  direction: z.enum(['ltr', 'rtl']).nullish(),
  pages: z.array(pageSchema).max(2000),
  glossaries: z.array(z.object({
    locale: z.string().min(1).max(32),
    terms: z.array(z.object({
      source: z.string().min(1).max(500),
      target: z.string().max(500),
    })).max(2000),
  })).max(50).optional(),
  cast: z.array(z.object({
    source: z.string().min(1).max(500),
    names: z.record(z.string().max(32), z.string().max(500)).nullish(),
    gender: z.enum(['male', 'female', 'nb', 'unknown']),
    tags: z.array(z.string().max(200)).max(50).nullish(),
    pinned: z.boolean().optional(),
  })).max(2000).optional(),
  usage: usageSchema.optional(),
  clean: z.object({
    model: z.string().min(1).max(32),
    segmenter: z.boolean(),
  }).optional(),
})

/**
 * Read a manifest, and say why not in words somebody can act on.
 *
 * A thrown `ZodError` is the wrong answer here: this is a file the reader
 * picked out of their own downloads, and "invalid_type at pages.3.blocks.12.w"
 * tells them nothing about which of the two files they meant. So the failure
 * comes back as a sentence, with the detail left in the console for whoever has
 * to work out why.
 */
export function readManifest (text: string): { project: Project } | { refused: string } {
  let raw: unknown

  try {
    raw = JSON.parse(text)
  } catch {
    return { refused: 'That project file’s manifest could not be read.' }
  }

  const parsed = projectSchema.safeParse(raw)

  if (!parsed.success) {
    console.warn('[kemolate] project manifest refused:', parsed.error.issues)

    return { refused: 'That file is not a project this version can open.' }
  }

  // Ahead of us rather than behind: a file from a later build may hold fields
  // this one would drop on the floor, and dropping a reader's lettering without
  // telling them is the failure worth refusing over. Older is fine — every
  // field added since is optional, which is what `PROJECT_VERSION` is for.
  if (parsed.data.v > PROJECT_VERSION) {
    return { refused: 'That project was saved by a newer version of the app.' }
  }

  return { project: parsed.data as Project }
}

/**
 * Whether a dropped file is one of ours, by its name.
 *
 * By name and not by contents, because this answers a question asked *during* a
 * drag — the pointer is still moving, there is nothing to read yet, and a
 * `DataTransfer` mid-drag will not give up a file's bytes at all. It is a sort,
 * not a check: whether the archive is really a project is settled by
 * `readManifest`, which is where the refusal a reader can act on comes from.
 *
 * A folder dropped alongside arrives as an entry with no extension and is
 * rightly no match, which is what keeps "drop a chapter" and "drop a project"
 * from being the same gesture.
 */
export function isProjectFile (file: { name?: string }): boolean {
  return (file.name ?? '').toLowerCase().endsWith(PROJECT_EXTENSION)
}

/**
 * What to call the file, from what the chapter is called.
 *
 * Not a slug: a chapter's name is often the only Japanese or Korean in the
 * whole workspace, and transliterating it would make a file the reader cannot
 * recognise in their own downloads folder. Only the characters a filesystem
 * genuinely refuses are replaced.
 */
export function projectFilename (title: string): string {
  const cleaned = title
    // What a filesystem refuses. Everything else — spaces, full stops, kanji —
    // is left as the reader wrote it.
    .replace(/[/\\?%*:|"<>]/g, '-')
    // The control range and delete, which some archivers will happily put in a
    // name. The rule below guards against matching these by accident; here it
    // is the whole job.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    // A run of dashes and the spaces among them becomes one dash. `Ch 3/4: "x"`
    // otherwise comes out as `Ch 3-4- -x-`, which is every refused character
    // faithfully replaced and not a name anybody would recognise. Spaces on
    // their own are left alone — they are not the problem.
    .replace(/\s*-[\s-]*/g, '-')
    // Only after the collapse, so a title that was nothing but refused
    // characters ends up empty and takes the fallback below rather than
    // answering with a bare dash.
    .replace(/^[-\s]+|[-\s]+$/g, '')
    .slice(0, 120)
    .trim()

  return `${cleaned || 'chapter'}${PROJECT_EXTENSION}`
}
