/*
 * Desktop: the web build's schema, its workspace tables word for word, made by
 * dropping what exists for accounts and sharing — `users`, `accounts`,
 * `passkeys`, `user_settings`, `user_keys`, `key_vaults`, `api_tokens`,
 * `site_settings`, `contributors`, `invites`. The desktop app is one person on
 * one machine: `workspaces` has no owner, and the `author_id`/`user_id` columns
 * are kept, as plain nullable integers with no foreign key, and are always null.
 * Keeping them keeps every service that writes them verbatim, and the shape of a
 * row the same as the web build's. The migrations are the desktop's own, made by
 * drizzle-kit from this file — see `drizzle.config.ts`.
 */
import { sql } from 'drizzle-orm'
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

// Relative rather than `#shared`: drizzle-kit loads this file on its own, with
// none of Nuxt's aliases to hand.
import { PLATES } from '../../shared/utils/layers'

import type { Adjustment } from '../../shared/utils/adjust'
import type { PlacedImage } from '../../shared/utils/layers'
import type { Lettering } from '../../shared/utils/lettering'
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core'

/**
 * Mirrors `AuthenticatorTransportFuture` from `@simplewebauthn/types`, declared
 * locally so the schema does not depend on the optional WebAuthn peer packages.
 */
export type AuthenticatorTransport =
  | 'ble'
  | 'cable'
  | 'hybrid'
  | 'internal'
  | 'nfc'
  | 'smart-card'
  | 'usb'

/** What someone may do across the whole install, as opposed to in one workspace. */
export type UserRole = 'admin' | 'member'

/*
 * ---------------------------------------------------------------------------
 * The comic
 * ---------------------------------------------------------------------------
 *
 * One thing shapes every table below: **the scans never come here.** Pages are
 * read off the user's own machine and stay there — see `app/utils/images.ts` —
 * and the plan is for them to reach a collaborator peer-to-peer rather than by
 * way of this database. So what is stored is everything *about* a comic that a
 * second person needs in order to work on it: where the text is, what it says,
 * what it should say, what the layers are called, who did what.
 *
 * That is why `pages` has a path and a size but no bytes, and why `layers`
 * describes a stack without holding a single pixel of one. A row here is a
 * shared opinion about an image both people already have.
 *
 * The other shape is `publicId`. A workspace is made in the browser, offline,
 * before anyone has signed in — so its id is minted there and this is the
 * column that agrees with it. It is also what appears in the address, which is
 * why it is a random uuid rather than the row number: an address that counts
 * upwards invites reading somebody else's.
 */

/*
 * Not modelled yet, and deliberately — three things the earlier single-user
 * build (comic-translator) had that have no home here. Recorded so they are a
 * decision rather than an oversight:
 *
 * (**Cast** was the fourth and is now `cast_members`, below, in exactly the
 * shape this note predicted for it — a table beside `glossaries` with the
 * per-language spellings as json. The standing note about the work went to
 * `workspaces.castNotes`, there being only ever one of it.)
 *
 * - **Prep stage.** Source blocks shown for the reader to correct, filter and
 *   merge *before* anything is translated. Probably a status on `blocks`
 *   rather than a table of its own.
 * - **Edits.** Which blocks were hidden, and which were merged into which —
 *   the reader's corrections to what the detector found. Merges are the awkward
 *   part: they are a relation between blocks, not a field on one.
 * - **Ignore boxes.** Regions where detection is disregarded entirely, as
 *   fractions of the page. A small table on `pages`, or a block kind that means
 *   "not text" — the second is tempting and probably wrong, since an ignore box
 *   is drawn before there is anything to call a block.
 */

/*
 * Handing pages between people, and why there is no table for it.
 *
 * Scans move peer-to-peer, borrowing the one idea from BitTorrent that earns
 * its keep at this size: **content-addressed pieces**. A page is already a
 * piece — a megabyte or so, with a SHA-256 of its own in `pages.hash` — and the
 * page list is already the manifest. That gives resume, per-piece verification
 * and "send me only the two I am missing" without a chunking layer, a tracker
 * or a wire protocol.
 *
 * The rest of BitTorrent is for strangers at scale and does not apply. Rarest-
 * first keeps pieces alive in a large swarm; tit-for-tat polices freeloaders.
 * These are named contributors somebody invited, and there are four of them.
 *
 * The piece worth taking early is a **have-map** — who is holding which hashes
 * — because it is what lets a peer fetch from anyone who already has a page
 * rather than only from whoever opened the folder. Without it the feature works
 * only while the owner is awake with the chapter open.
 *
 * And that have-map is deliberately **not a table**. It is true only while a
 * peer is connected: a row saying somebody holds page forty is a claim that
 * expires the moment they close the tab, and a database full of expired claims
 * is worse than no claims at all. It belongs in the socket layer's memory,
 * published on connect and dropped on disconnect.
 *
 * The line this draws: **immutable content is distributed, mutable content is
 * replicated.** A scan never changes, so it can be addressed by its hash and
 * come from anywhere. Cleanup, lettering and translations do change, are
 * ordered, and are merged — they are `strokes` and `translations`, and they go
 * through here. Getting that boundary wrong in either direction is expensive.
 */

/** What a contributor may do in one workspace. */
export type ContributorRole = 'owner' | 'editor' | 'translator' | 'viewer'

/**
 * How a piece of lettering is set: a block's own settings over the app's
 * defaults, and nothing besides. Everything is optional, and absent means "as
 * the app would letter it anyway" — so a line nobody has styled keeps the
 * automatic choice between the dialogue and sound-effect faces.
 *
 * `Partial<Lettering>` rather than a shape of its own, which is the second
 * answer to this question and the right one. The first was an interface written
 * out here, before there was an editor to write into it: it carried a `font`
 * nothing ever chose and an `upper` nobody ever set, and — the part that would
 * have hurt — it said `align`/`valign` in logical terms (`start`/`center`/`end`)
 * where the editor's are physical. The canvas is emphatic that they are
 * physical: the anchor puts the words at the top, middle or bottom of the
 * balloon in *both* writing modes and the alignment puts them left, centre or
 * right in both. Storing them logically would have meant turning them back by
 * guessing which way the block was set — and which way a block is set is the
 * very thing this column exists to record.
 *
 * Being literally the browser's own shape is what makes the column round-trip.
 * What `letteringOf` reads back is what was written, `null` and absent included,
 * and that distinction is load-bearing — see `verticalOf`. Absent means "work it
 * out", which is emphatically not the same answer as a direction somebody chose,
 * and a mapping layer between two shapes is exactly where that difference goes
 * missing.
 */
export type TextStyle = Partial<Lettering>

/** Whatever one tool needs remembering about one mark — see `strokes`. */
export interface StrokeParams {
  /** Radius in page pixels. */
  size?: number
  /** Edge softness, nought (crisp) to one (no edge at all). */
  softness?: number
  /** #rrggbb, for the tools that lay down a colour. */
  colour?: string
  /** Brush-to-source vector, fixed at the start of a clone stroke. */
  cloneOffset?: { x: number, y: number }
  /** The region a drag tool worked on, for patch and heal. */
  region?: { x: number, y: number, w: number, h: number }
  /**
   * What heal sampled, one `#rrggbb` per dab, recorded at paint time.
   *
   * Heal reads a ring-median off the page as it looks *now* — and "now" is the
   * one thing a replay cannot have. A concurrent stroke that orders under this
   * one changes what the ring would read, so a replayed heal would paint
   * different colours than the painter saw. Recording the samples turns the
   * stroke into "lay these colours along this path", which replays exactly,
   * whatever landed underneath it since.
   */
  colours?: string[]
  /**
   * Which automatic mask a correction was drawn against — `MASK_RECIPE`.
   *
   * Only on mask strokes, and one letter because it is written on every one of
   * them. The automatic half of a mask is recomputed rather than stored, so
   * changing the threshold or the dilation leaves every saved correction
   * sitting over a different base; the stamp is what lets an old one be
   * recognised individually rather than the whole lot being distrusted.
   *
   * Declared here because it is written here. The mask brush was building its
   * request body by hand and this key rode along untyped — which is exactly the
   * sort of thing that stops being true quietly.
   */
  m?: number
}

export const workspaces = sqliteTable('workspaces', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** The uuid in the address, minted by the browser that made the workspace. */
  publicId: text('public_id').notNull().unique(),
  /** What the chapter is called — the folder it was opened from, usually. */
  name: text('name').notNull(),
  /** Which way round the pages read, for the page strip and the reading order. */
  direction: text('direction', { enum: ['ltr', 'rtl'] }).notNull().default('rtl'),
  sourceLocale: text('source_locale').notNull().default('ja'),
  targetLocale: text('target_locale').notNull().default('en'),
  /**
   * A standing instruction about the work as a whole, sent with every page —
   * setting, register, how these people speak to each other.
   *
   * A column here rather than a row in `cast_members`, because it is not about
   * a member: it is the one thing said about the comic itself, there is exactly
   * one of it, and a table whose every row but one described a person would
   * need a discriminator to say which was which.
   *
   * Nullable, which is also what makes it an in-place `ADD COLUMN` on a table
   * that already has rows — see the `layers` note about SQLite rebuilds.
   */
  castNotes: text('cast_notes'),

  /*
   * How this comic gets translated — settings of the *workspace*, not of the
   * person or the browser.
   *
   * That placement is the whole point and was learned the hard way in the
   * earlier build: these choose what a page is translated with, and therefore
   * whether an existing translation still counts as one. Two people with
   * different models selected are two people looking at different answers to
   * the same page, and a setting kept per browser makes that invisible. Kept
   * here, everyone in the workspace is translating the same comic the same way.
   */

  /** 'google', 'ai-text', 'ai-image' — what does the translating. */
  engine: text('engine').notNull().default('ai-text'),
  /** Which model, when the engine is one that has models. */
  model: text('model'),
  /** How hard it is asked to think — the interface's three, not the provider's five. */
  effort: text('effort', { enum: ['fast', 'balanced', 'thorough'] }).notNull().default('fast'),
  /** Leave -san, -kun and the rest as written. */
  honorifics: integer('honorifics', { mode: 'boolean' }).notNull().default(true),
  /** Read the whole page before doing any line of it. */
  wholePage: integer('whole_page', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`)
    .$onUpdate(() => new Date()),
})

/**
 * A page of the comic: which scan, in what order, how big — and nothing of the
 * image itself.
 *
 * `path` is the file's place inside the folder that was opened, which is what
 * both the ordering and the peer-to-peer handover key off: two people who
 * opened the same chapter have the same paths, and that is what lets a block
 * drawn on one machine land on the right page of the other. `hash` is the
 * stronger version of the same promise, for telling apart two scans that happen
 * to share a name.
 */
export const pages = sqliteTable('pages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  workspaceId: integer('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  /**
   * The page's identity, and the only thing that is.
   *
   * Minted by whichever browser first put the page in the chapter, and adopted
   * by every other one from the reply — so a page keeps one name across
   * renames, reorders, re-downloads and both people's copies.
   *
   * It exists because the alternatives were each an identity that could be two
   * things at once. `path` changes whenever a folder is renamed. `hash` was the
   * page's identity until it turned out that two pages can honestly share one:
   * add a blank page twice and the bytes are the same bytes, which the unique
   * index below used to forbid outright and which now simply means two pages
   * that look alike. A hash still joins one person's copy of a chapter to
   * another's — it is the only thing two folders reliably share — but it is a
   * *hint for matching*, not a name.
   */
  uid: text('uid').notNull(),
  /** Relative to the opened folder, sub-folders and all. */
  path: text('path').notNull(),
  name: text('name').notNull(),
  /** Reading order, which is not always the order the paths sort in. */
  position: integer('position').notNull(),
  /** The scan's own size, once something has drawn it. */
  width: integer('width'),
  height: integer('height'),
  byteSize: integer('byte_size'),
  /**
   * Content hash of the image — how two people's copies find each other, and
   * how a page is asked for over the wire.
   *
   * It was the page's identity until `uid` above took that over, and the reason
   * for the demotion is worth keeping: a hash answers "which bytes are these",
   * which is a different question from "which page is this". Usually the two
   * agree. They do not when a chapter honestly holds the same image twice — two
   * blank pages are byte-identical — and an identity that is occasionally
   * shared by two things is not an identity. It was doing real damage: one row
   * for two pages meant a block re-read landing on the wrong one, and deleting
   * one page discarding the other.
   *
   * Still the key for fetching a page from a peer, still what a cache is filed
   * under, and still what matches one folder to another. Just not a name.
   *
   * Nullable only because it is not known until the file has been read.
   */
  hash: text('hash'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`)
    .$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex('pages_workspace_uid_idx').on(table.workspaceId, table.uid),
  uniqueIndex('pages_workspace_path_idx').on(table.workspaceId, table.path),
  /*
   * Not unique any more, and that is the change rather than an oversight.
   *
   * It read "the same scan cannot be two pages of one workspace, whatever it is
   * called", which sounds obviously right and is not: adding a blank page twice
   * produces the same bytes twice, and so did anyone dropping a duplicate on
   * purpose. The constraint did not prevent the confusion, it prevented the
   * second page — the insert simply failed — while the rows that slipped in
   * before their hashes were known went on to collide anyway.
   *
   * So duplicates are allowed and told apart by `uid`, and this stays as a
   * plain index because matching one folder against another still starts here.
   */
  index('pages_workspace_hash_idx').on(table.workspaceId, table.hash),
  index('pages_workspace_position_idx').on(table.workspaceId, table.position),
])

/**
 * The layer stack, as a tree.
 *
 * A row is either a group or a plate: a group has children and draws nothing
 * itself, a plate has a `plate` key naming what it draws and no children. That
 * is the same split `useComic` already makes, and `parent_id` is what carries
 * it — a self-reference, because the stack nests to whatever depth the user
 * drags it into.
 *
 * Per workspace rather than per page: the stack is a property of the document,
 * and a translator who hides the cleaned plate means it hidden while they read
 * the whole chapter, not on page four only.
 */
export const layers = sqliteTable('layers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  workspaceId: integer('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  /**
   * The row's name in the stack the canvas draws — `StackLayer.id`.
   *
   * The client's own string rather than a number minted here, and that is the
   * direction the identity has to flow: the stack is derived on the client from
   * `DEFAULT_STACK` before any workspace exists to file it under, its five
   * plates are named by what they are (`dialogue`, `clean`, `art`…), and every
   * surface a stroke lands on is keyed by this id. Numbering the rows here
   * instead would mean a browser that has painted for an hour discovering its
   * layers were called something else all along.
   *
   * It is also what makes syncing a stack an upsert rather than a replacement,
   * which `surfaces.layer_id` makes non-negotiable: that reference cascades, so
   * deleting a row to write it back destroys every stroke filed under it.
   */
  uid: text('uid').notNull(),
  /**
   * The page this row belongs to. Every row belongs to one.
   *
   * The stack used to be the chapter's — one set of rows for the whole
   * workspace — and the trouble with that was not that it was shared but that
   * it was *only* shared: a sheet added to sketch over one awkward panel
   * appeared on all three hundred pages, and there was no way to say otherwise.
   *
   * So a page owns its stack outright, and the sharing that was worth keeping
   * is a gesture rather than a shape: `layers.sync` will write the same stack to
   * every page of the chapter when the browser asks it to — see `everywhere`,
   * and the switch in the layers panel that raises it. That way "these five
   * plates look the same everywhere" stays true because somebody keeps saying
   * so, not because the rows cannot be told apart.
   *
   * The cascade is what makes deleting a page take its stack, and every stroke
   * on it, rather than leaving rows pointing at nothing.
   *
   * ## Nullable in SQL, never null in fact
   *
   * It should be `NOT NULL` and it is not, and the reason is worth writing down
   * because the obvious "fix" destroys the database.
   *
   * SQLite cannot alter a column, so drizzle-kit implements `NOT NULL` by
   * rebuilding the table: create `__new_layers`, copy, `DROP TABLE layers`,
   * rename. It guards that with `PRAGMA foreign_keys=OFF` — which SQLite
   * **ignores inside a transaction**, and the migrator runs every migration in
   * one. So the `DROP TABLE` executes with foreign keys live, `surfaces.layer_id`
   * cascades, `strokes.surface_id` cascades after it, and the chapter loses
   * every mark anybody has ever painted. That is not a hypothetical: it is what
   * happened here, twice, before the cause was understood.
   *
   * So the constraint lives in the code instead. `layers.sync` and `found` are
   * the only writers and both always supply a page, the service reads by page,
   * and `LayerDraft` has no way to express a row without one. If a `NOT NULL` is
   * ever wanted badly enough, it needs a migration that rebuilds `layers`,
   * `surfaces` and `strokes` together with foreign keys genuinely off — not a
   * regenerated schema diff.
   */
  pageId: integer('page_id').references(() => pages.id, { onDelete: 'cascade' }),
  parentId: integer('parent_id').references((): AnySQLiteColumn => layers.id, { onDelete: 'cascade' }),
  /**
   * What it draws, for a plate. Null on a group, which draws nothing.
   *
   * The list is `PLATES`, from the same module the client derives the stack
   * with: a plate the canvas cannot draw is not one the database should be
   * willing to file a row under.
   */
  plate: text('plate', { enum: PLATES }),
  label: text('label').notNull(),
  hint: text('hint'),
  visible: integer('visible', { mode: 'boolean' }).notNull().default(true),
  /** Nought to a hundred, and multiplied by every group above it. */
  opacity: integer('opacity').notNull().default(100),
  locked: integer('locked', { mode: 'boolean' }).notNull().default(false),
  /**
   * A blank sheet somebody added to draw on — see `StackLayer.paint`.
   *
   * Stored rather than inferred from the absence of a plate, because a group
   * has no plate either and the two behave nothing alike.
   */
  paint: integer('paint', { mode: 'boolean' }).notNull().default(false),
  /**
   * A row of the page itself, whose lock is not the reader's to open.
   *
   * `locked` says the tools are shut out; this says the reader may not open
   * them. The scan as it arrived is the one thing with no earlier version to go
   * back to — see `StackLayer.fixed`.
   */
  fixed: integer('fixed', { mode: 'boolean' }).notNull().default(false),
  /** Clipped to the row below rather than everything under it. Adjustments only. */
  clipped: integer('clipped', { mode: 'boolean' }).notNull().default(false),
  /**
   * What this row does to everything below it, as `shared/utils/adjust.ts`
   * describes one. JSON because an adjustment is a small object of its own
   * whose shape belongs to that module rather than to this table — the database
   * stores the instruction, it does not interpret it.
   */
  adjust: text('adjust', { mode: 'json' }).$type<Adjustment>(),
  /**
   * A picture the reader placed on this page — see `StackLayer.image`.
   *
   * The **reference only**, and that is the whole reason this column can exist
   * at all: a hash, a type, a name and a size. The bytes stay in the browser's
   * own filesystem, keyed by that hash, exactly as a scan does. A column that
   * held the picture would be the one thing this schema has never had, and the
   * promise the app is built on.
   *
   * What it buys is the row surviving a round trip. A stack is written up and
   * read back whole, and `useLayerSync.build` reconstructs it from these
   * columns — so a placed image with nowhere to be stored here would come back
   * from the server as an ordinary empty row, and the reference would be gone
   * on the next reload of a shared workspace.
   *
   * JSON for the reason `adjust` is: the shape belongs to `shared/utils/layers`
   * and the database stores it rather than interpreting it. Nullable, which is
   * also what keeps this an in-place `ADD COLUMN` — see the note on `pageId`
   * for what a rebuild of this table costs.
   */
  image: text('image', { mode: 'json' }).$type<PlacedImage>(),
  /** Order within the parent, top to bottom. */
  position: integer('position').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`)
    .$onUpdate(() => new Date()),
}, (table) => [
  index('layers_workspace_idx').on(table.workspaceId),
  // Every read of a stack is "one page's rows", which is the only shape asked
  // for and so the only one indexed.
  index('layers_page_idx').on(table.pageId),
  // One row per name per *page*, which is what makes a stack an upsert.
  //
  // It was per workspace, and it had to move: every page now carries a row
  // called `dialogue`, so the old index would let the first page of a chapter
  // have a stack and refuse one to the second.
  uniqueIndex('layers_page_uid_idx').on(table.pageId, table.uid),
  index('layers_parent_position_idx').on(table.parentId, table.position),
])

/**
 * A box on a page with text in it — what the reader found, before anybody has
 * decided what it should say.
 *
 * Not in the list of tables this was asked for, and worth saying why it is
 * here: a translation has to be a translation *of* somewhere, and the somewhere
 * has a shape, a type and a confidence that belong to the reading rather than
 * to any one rendering of it. Keeping them apart is also what lets a block hold
 * a machine draft and a human revision at once, which is most of what two
 * people working on the same chapter are doing.
 *
 * Coordinates are percentages of the page, not pixels — the same numbers place
 * a block on a thumbnail and on a page filling the window.
 */
export const blocks = sqliteTable('blocks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  pageId: integer('page_id')
    .notNull()
    .references(() => pages.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['bubble', 'caption', 'sfx', 'garbage'] })
    .notNull()
    .default('bubble'),
  /**
   * An oriented box, not an upright one — centre, size, and the angles it is
   * turned and slanted by. Lettering in comics is rarely square to the page and
   * sound effects almost never are, so an upright rectangle cannot say where
   * most of the text on a page actually sits.
   *
   * `quad` is the escape hatch: rotation, skew and scale can only ever make a
   * parallelogram, and a box whose one corner has been dragged is not one. Eight
   * numbers, `dx dy` per corner, north-west first and clockwise. Null means the
   * plain oriented rectangle the other columns describe.
   *
   * All of it is normalised by the page's **width**, on both axes — so `cy` and
   * `h` run past one on a page taller than it is wide, and that is correct.
   * Dividing y by the height instead squashes the space unevenly, and in a
   * squashed space a rotation is not a rotation: a tilted sound effect comes
   * back at the wrong angle with the wrong proportions. See `shared/utils/ocr.ts`,
   * which produces these.
   */
  cx: real('cx').notNull(),
  cy: real('cy').notNull(),
  w: real('w').notNull(),
  h: real('h').notNull(),
  angle: real('angle').notNull().default(0),
  skewX: real('skew_x').notNull().default(0),
  skewY: real('skew_y').notNull().default(0),
  quad: text('quad', { mode: 'json' }).$type<number[]>(),
  /**
   * The room inside the balloon this lettering sits in — where a translation
   * gets set when nobody has placed it by hand.
   *
   * The box above is the shape of the *original* lettering: a 40-pixel column
   * of Japanese, a two-syllable Korean shout. English set into that either
   * drops to the smallest size or overflows, and the balloon it belongs in is
   * usually two or three times the room. This is that room, measured once from
   * the scan when the page is read (`balloonIn`, fenced by the balloon the
   * detector drew) and kept here because it is a fact about the page like the
   * box is: a collaborator without the scan, or a project file opened
   * elsewhere, letters into the same room.
   *
   * An upright rectangle in the same width-normalised space as the box. Null
   * where there is no balloon to measure — lettering on artwork, a tilted
   * block, a fill that escaped, a reading from a detector that draws no
   * balloons — and the lettering then sits on the block, as it always did.
   * Nothing in the cleaning path reads it, for the reason nothing there reads a
   * lettering frame: see `Block.letter` in `useComic`.
   */
  room: text('room', { mode: 'json' }).$type<{ cx: number, cy: number, w: number, h: number, round?: boolean }>(),
  /** What was read off the page, in the original language. */
  source: text('source').notNull().default(''),
  /** How sure the reader was, nought to a hundred. */
  confidence: integer('confidence').notNull().default(0),
  /** Kept out of the render without being thrown away. */
  hidden: integer('hidden', { mode: 'boolean' }).notNull().default(false),
  /** Reading order on the page. */
  position: integer('position').notNull(),
  /**
   * The block this one is a part of, where somebody has joined several into a
   * balloon — Illustrator's compound path, and the same bargain.
   *
   * A line detector finds *lines*, so a balloon of three columns arrives as
   * three blocks each saying a third of a sentence. Joining them makes a fourth
   * block that the three point at, and from then on the parent is the object:
   * it holds the translation, the lettering and the kind, and it is what the
   * list shows, what gets translated and what gets cleaned. The children keep
   * only their own `source` — the per-column reading — and their boxes.
   *
   * Which is why this is a pointer and not the join table it replaces. That
   * table was right that a merge of N members has no natural head to elect, and
   * wrong about the conclusion: the answer is not to avoid a head but to *make*
   * one. A parent row is a real head, so nothing is promoted and nothing is
   * overwritten. Releasing a balloon deletes the parent, and the children are
   * exactly as they were found.
   *
   * The parent's own `cx`/`cy`/`w`/`h` are the union of its children's, written
   * down because the column cannot be null but never authored — recomputed from
   * the children whenever they move, the way a compound path has no geometry of
   * its own beyond its subpaths.
   *
   * One level deep in practice. Nothing forbids a parent having a parent, and
   * nothing needs it: a balloon inside a balloon is not a thing a page has.
   */
  parentId: integer('parent_id').references((): AnySQLiteColumn => blocks.id, { onDelete: 'cascade' }),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`)
    .$onUpdate(() => new Date()),
}, (table) => [
  index('blocks_page_position_idx').on(table.pageId, table.position),
  // A parent's children are this index. It used to say the top-level reads
  // were too, and SQLite agreed: asked for `page_id IN (…) AND parent_id IS
  // NULL`, it walked every top-level block in the install through here rather
  // than the chapter's — the chapter-wide read every open makes.
  index('blocks_parent_idx').on(table.parentId),
  // Which is what this one is for: a page's top-level blocks, in order. A new
  // index under a new name rather than a column added to one above, because
  // that would be a drop and a create for drizzle-kit to get wrong.
  index('blocks_page_parent_position_idx').on(table.pageId, table.parentId, table.position),
])

/**
 * What a block should say, in one language.
 *
 * One row per block per language, replaced rather than accumulated — the trail
 * of what it used to say is `logs`, which is the table that exists for keeping
 * history and is better at it than a pile of superseded rows would be.
 *
 * `engine` and `model` are kept beside the text because "who wrote this" is a
 * question with three real answers — a person, a machine translator, a model —
 * and a reviewer deciding how hard to look needs to know which.
 */
export const translations = sqliteTable('translations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  blockId: integer('block_id')
    .notNull()
    .references(() => blocks.id, { onDelete: 'cascade' }),
  locale: text('locale').notNull(),
  text: text('text').notNull().default(''),
  /** 'human', or the machine that drafted it — 'ai-text', 'google', … */
  engine: text('engine').notNull().default('human'),
  /** Which model, when the engine is one that has models. */
  model: text('model'),
  status: text('status', { enum: ['draft', 'review', 'final'] })
    .notNull()
    .default('draft'),
  /** How it is set. Absent means lettered the way the app would letter it. */
  style: text('style', { mode: 'json' }).$type<TextStyle>(),
  /**
   * Where the lettering sits, when the typesetter has moved it off the block.
   * The block stays where the text was found — that is a fact about the scan —
   * and this is where the replacement goes, which is often not the same place.
   * Same eight-number `quad` convention as a block.
   *
   * The whole of a block's box shape, and it has to be: the canvas drags a
   * lettering frame through the same `toOriented`/`toBoxed` arithmetic it drags
   * a block through, so a frame can be turned, leant and pulled about in every
   * way a block can. `skewX`/`skewY` are here for that reason and not for
   * symmetry — `toBoxed` writes `quad` only when a corner has actually been
   * pulled (`isDistorted`), so a *lean* leaves no corner offsets behind and is
   * unrecoverable from the other six. Without these two a letterer could lean an
   * SFX frame, watch it hold locally, and have it come back upright for
   * everybody else on a shared chapter.
   *
   * All nullable, and none of them defaulted, which is the shape that let them
   * be added to a table that already had rows — the same reasoning `pinned`
   * below sets out at length, and the same plain `ALTER TABLE … ADD` it got.
   *
   * **Null and nought are not the same claim**, and a query that treats them
   * alike will be wrong. All-null is "this lettering sits on its block"; a row
   * of numbers with zeroes among them is "this lettering has a frame of its own,
   * which happens to be square and level". A frame that exists writes `0` for a
   * turn or a lean nobody applied, because the client sends the whole shape
   * every time — so the question "has this been moved off its block?" is
   * `cx IS NOT NULL`, never `cx != 0`, and a stored `0` is not evidence that
   * somebody straightened something. The service reads the two as one only where
   * it is writing (`boxOf` collapses a missing field to null, since a browser is
   * handed these values and sends them back, so absent can only mean "no frame")
   * — never where it is deciding what a row means.
   */
  cx: real('cx'),
  cy: real('cy'),
  w: real('w'),
  h: real('h'),
  angle: real('angle'),
  skewX: real('skew_x'),
  skewY: real('skew_y'),
  quad: text('quad', { mode: 'json' }).$type<number[]>(),
  /** Who put it there. Null when nothing but a machine has touched it. */
  authorId: integer('author_id'),
  /**
   * Which of the block's revisions these words are — see `translationRevisions`.
   *
   * **No foreign key, deliberately.** Adding a referencing column to a table
   * that already exists is the migration shape that makes drizzle-kit rebuild
   * it: `CREATE __new_translations` → copy → `DROP TABLE translations` →
   * rename. The migrator runs inside a transaction and SQLite ignores
   * `PRAGMA foreign_keys` there, so the drop would fire the cascade on
   * `translation_revisions` and delete every revision in the database while
   * reporting success. That is the failure the `layers` note in this file was
   * written about, and this is the same answer it reached: keep the constraint
   * in the service and say so on the column.
   *
   * Null means "nothing has been written here yet, or the head predates
   * revisions" — the head is then just `text`, which is what it always was.
   */
  revisionId: integer('revision_id'),
  /**
   * Whether a person chose these words, as opposed to a machine leaving them.
   *
   * The whole of the resolution rule. A machine run always *records* a
   * revision, but it only moves the head when this is false — so typing a line
   * quietly protects it from every later pass, without anybody having to think
   * about pinning. Selecting a revision by hand sets it too, and pressing
   * "Translate page again" is the one thing that clears it, because that press
   * is precisely the ask to be given the model's answer instead.
   *
   * Nullable rather than `NOT NULL DEFAULT 0` for the reason above: this column
   * is being added to a table that already has rows, and a nullable add is the
   * one shape SQLite performs in place. Read null as false, which is what every
   * reader does — `row?.pinned === true`, never a bare truthiness check.
   */
  pinned: integer('pinned', { mode: 'boolean' }),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`)
    .$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex('translations_block_locale_idx').on(table.blockId, table.locale),
])

/**
 * Every wording a line has ever had, and what produced each one.
 *
 * `translations` holds what a balloon says *now*; this holds how it got there.
 * The two are kept apart rather than folded into one append-only table because
 * they are read at completely different rates: drawing a page reads the head of
 * every block on it and must stay a single indexed lookup, while the history is
 * opened for one block at a time, by somebody who has decided to look.
 *
 * ## Wording only
 *
 * No `style`, and that is not an omission. A revision answers "what does this
 * line say", and the lettering answers "how is it set" — they are changed by
 * different people at different stages, and a typesetter who has spent ten
 * minutes fitting a balloon should not have that undone by somebody switching
 * to a better translation of it. Style stays on `translations`, where switching
 * revisions leaves it exactly alone.
 *
 * ## `batch`
 *
 * One press writes a page of lines, and "undo that run" is the thing anybody
 * actually wants — per-block reverting cannot express it, and asking somebody
 * to do thirty of them is not an answer. Every revision from one run carries
 * the same batch, minted by the browser that made it.
 *
 * Text rather than a table of runs: a run has no properties of its own worth
 * recording that its revisions do not already carry between them, and a `runs`
 * table would be a row per press whose only job was to be pointed at.
 */
export const translationRevisions = sqliteTable('translation_revisions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  translationId: integer('translation_id')
    .notNull()
    .references(() => translations.id, { onDelete: 'cascade' }),
  text: text('text').notNull().default(''),
  /** 'human', or the machine that drafted it — 'ai-text', 'ai-image', 'google'. */
  engine: text('engine').notNull().default('human'),
  /** Which model, when the engine is one that has models. */
  model: text('model'),
  /** The run this came from, where a machine made it. Null for a typed line. */
  batch: text('batch'),
  authorId: integer('author_id'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`)
    .$onUpdate(() => new Date()),
}, (table) => [
  // The one hot read: this line's history, newest first.
  index('translation_revisions_translation_idx').on(table.translationId, table.createdAt),
  // And the other: everything one press wrote, so it can be taken back.
  index('translation_revisions_batch_idx').on(table.batch),
])

/**
 * A surface on one page that paint can land on.
 *
 * The stack in `layers` says what rows there are and what order they draw in;
 * this is where the pixels of one of those rows, on one page, actually live.
 * Every surface belongs to a stack row, and most of them also belong to a
 * *block* — which is the one idea worth taking wholesale from the earlier
 * build: the retouching that covers one speech bubble is its own surface, so
 * two people cleaning two balloons on the same page are not editing the same
 * thing at all. `key` is `bg` for the retouching that belongs to no block.
 *
 * `hash` and `width`/`height` describe a flattened bitmap that is *not* here.
 * The strokes below are what the surface is; the bitmap is a cache of replaying
 * them, kept on the machines that need it and passed between peers like the
 * scans are. Nothing in this database is ever the only copy of a pixel.
 */
export const surfaces = sqliteTable('surfaces', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  pageId: integer('page_id')
    .notNull()
    .references(() => pages.id, { onDelete: 'cascade' }),
  /** Which row of the stack this paints into. */
  layerId: integer('layer_id')
    .notNull()
    .references(() => layers.id, { onDelete: 'cascade' }),
  /** The block whose cleanup this is, where it is one. */
  blockId: integer('block_id').references(() => blocks.id, { onDelete: 'cascade' }),
  /** `bg`, a block's key, or a spare raster's — unique within the page. */
  key: text('key').notNull(),
  /** Content hash of the flattened bitmap, when one has been rendered. */
  hash: text('hash'),
  width: integer('width'),
  height: integer('height'),
  /**
   * How much of the log the bitmap already contains: every stroke at or below
   * this `seq` has been baked in and is not replayed again.
   *
   * This is the column that lets a raster and a log be combined at all. Without
   * it, a peer holding both cannot tell whether stroke 42 is still to be drawn
   * or is already under the paint, and the two ways of being wrong are a mark
   * that vanishes and a mark that is laid down twice.
   *
   * It only ever moves forward, and only past strokes nobody can still insert
   * before — see the note on `strokes`. A peer whose own mark falls below
   * someone else's watermark has lost the place it was going to go: the mark is
   * kept and re-based onto the end rather than dropped, which is the right
   * trade for paint, where landing on top of the right spot is nearly always
   * indistinguishable from landing under it.
   */
  bakedSeq: integer('baked_seq').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`)
    .$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex('surfaces_page_key_idx').on(table.pageId, table.key),
  index('surfaces_page_layer_idx').on(table.pageId, table.layerId),
  // The layer on its own, for the cascade. Deleting a layer — and so a page, or
  // a workspace, which delete their layers — finds its surfaces by `layer_id`,
  // which is only the second column above, so each deleted layer scanned every
  // surface in the install: 712 ms to delete a fifty-page workspace on a copy
  // grown to 32k surfaces, 4.7 ms with this. All of it synchronous, on the
  // server's one thread.
  index('surfaces_layer_idx').on(table.layerId),
  /**
   * One surface per block, and the database has to be the one saying so:
   * `blocks.surface` is declared as a to-one relation, and a to-one over a
   * column that permits duplicates does not fail — it quietly picks whichever
   * row comes back first. Nulls repeat freely, which is what lets `bg` and the
   * spare rasters share the column.
   */
  uniqueIndex('surfaces_block_idx').on(table.blockId),
])

/**
 * A cleaned balloon, kept for a cloud workspace — the one picture from a page
 * this database is allowed to know about.
 *
 * The rule used to be that no pixel of a page ever reached the server, and for
 * the page itself it still is. A repair is the artwork under one block with the
 * lettering painted out: made in the browser, seconds of inference behind a
 * download of tens of megabytes, and kept only on the machine that made it — so
 * a cloud workspace opened anywhere else came back uncleaned, and one opened
 * here came back uncleaned whenever the name it was filed under stopped
 * matching. For a cloud workspace everything but the page is kept here now, and
 * a repair is part of that "everything". See CLAUDE.md, whose invariant section
 * says where the line moved and why.
 *
 * The bytes are not in this table. They are a file under the `repairs` storage
 * mount named by their SHA-256 (`hash`), so the same repair made twice is kept
 * once, and they are only ever served through a workspace that has a row naming
 * them — see `repairs.read`.
 *
 * `from` and `box` are what make a row more than a filename. A browser used to
 * find a repair only by rebuilding its name from the block's box *as it now
 * stands*, so a block moved or resized after cleaning asked for a name nobody
 * had made and came back bare. The row says which block the repair belongs to
 * and where it is laid, so the newest one for a block is found whatever the box
 * has become, and drawn over the artwork it was cut from.
 */
export const repairs = sqliteTable('repairs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  pageId: integer('page_id')
    .notNull()
    .references(() => pages.id, { onDelete: 'cascade' }),
  /** The block it was made for. A deleted block takes its repairs with it. */
  blockId: integer('block_id').references(() => blocks.id, { onDelete: 'cascade' }),
  /** The recipe — `patchKey` — which is also what the browser files it under. */
  key: text('key').notNull(),
  /** SHA-256 of the PNG, hex: the name of the file holding it. */
  hash: text('hash').notNull(),
  /** The block's box when it was made, in page pixels. */
  from: text('from', { mode: 'json' }).notNull().$type<{ x: number, y: number, w: number, h: number }>(),
  /** Where the image is laid — `from` padded — in page pixels. */
  box: text('box', { mode: 'json' }).notNull().$type<{ x: number, y: number, w: number, h: number }>(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
}, (table) => [
  // One row per recipe on a page. Made again from the same inputs is the same
  // repair, and replaces the row rather than adding one.
  uniqueIndex('repairs_page_key_idx').on(table.pageId, table.key),
  index('repairs_block_idx').on(table.blockId),
  index('repairs_hash_idx').on(table.hash),
])

/**
 * One mark, and the whole reason this is a table rather than a picture.
 *
 * The earlier build kept retouching as a transparent PNG per layer per page and
 * a forty-step undo stack in one browser. That is the right shape for one
 * person and the wrong shape for two: a bitmap is a single value, so two people
 * painting the same page produce two whole images and the second one saved
 * silently erases the first. There is no merge rule for a flattened raster, and
 * that is exactly why the earlier build's own note said sending changes would
 * "make this a replication protocol".
 *
 * So the marks are kept instead of the picture. Appending commutes — two people
 * painting at once produce two sets of rows and both survive, in an order
 * everyone agrees on because `seq` and `clientId` decide it and neither depends
 * on who heard about it first. The bitmap is then something anybody can compute
 * and nobody has to reconcile.
 *
 * Three things fall out of that for free: undo that merges (a retraction is
 * another row, not a deletion), a history that is already the log `logs` would
 * otherwise have to duplicate, and export at any resolution, because a stroke
 * has no pixel size until something draws it.
 *
 * ## Keeping the log short
 *
 * A log nobody prunes is a log that replays a thousand marks to open a page, so
 * the tail is periodically baked into `surfaces.hash` and dropped. Three rules
 * decide what may be baked, and each of them is a way of not losing work:
 *
 * 1. **Below the watermark only.** Baking is destructive — once a mark is in
 *    the bitmap there is no getting under it — so a stroke may only be baked
 *    once no peer can still produce one that ordered before it. Bake eagerly
 *    and a collaborator who was offline finds their marks re-based on top of
 *    paint that should have covered them.
 * 2. **Outside undo reach.** A baked stroke cannot be un-baked, so retracting
 *    one would mean re-rendering from an older bitmap that no longer exists.
 *    Whatever depth undo offers, the live window has to be comfortably longer.
 * 3. **In batches, not one at a time.** Baking re-encodes the whole bitmap.
 *    Doing that per stroke past a hard cap costs an image write per mark, for
 *    ever. Letting the log run to a high-water mark and then cutting it back to
 *    a low one spends the same encode across many strokes.
 *
 * Retracted strokes below the watermark are simply dropped: they contributed
 * nothing to the bitmap and there is nothing left to redo them onto.
 *
 * The window sizes are a tuning constant rather than a schema decision, so they
 * live with the code that bakes. Note that surfaces are per block, so the
 * counts here are per balloon and stay small on their own; it is `bg` — the
 * retouching belonging to no block — that ever gets long.
 */
export const strokes = sqliteTable('strokes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  surfaceId: integer('surface_id')
    .notNull()
    .references(() => surfaces.id, { onDelete: 'cascade' }),
  /**
   * A logical clock, not a timestamp. Wall clocks on two machines disagree by
   * more than the gap between two strokes, and the order marks were laid in is
   * what a painting *is* — so ordering on the clock would let one person's
   * stroke slide under another's on a re-render.
   */
  seq: integer('seq').notNull(),
  /** Breaks a tie in `seq` the same way on every machine. */
  clientId: text('client_id').notNull(),
  authorId: integer('author_id'),
  tool: text('tool', { enum: ['brush', 'eraser', 'clone', 'heal', 'patch'] }).notNull(),
  /** Paint-over when absent — an eraser is the one that mostly sets this. */
  composite: text('composite'),
  params: text('params', { mode: 'json' }).$type<StrokeParams>().notNull(),
  /**
   * The path, as flat `x y` pairs in page pixels. Flat rather than objects
   * because a long stroke is a few thousand numbers and the shape of the JSON
   * is most of the bytes.
   */
  points: text('points', { mode: 'json' }).$type<number[]>().notNull(),
  /** What it touched, so a re-render can skip strokes outside the tile it wants. */
  x: real('x').notNull(),
  y: real('y').notNull(),
  w: real('w').notNull(),
  h: real('h').notNull(),
  /**
   * Undone rather than deleted. A row that disappears cannot be merged with a
   * peer who never saw it go, and redo would have nothing to bring back.
   */
  retracted: integer('retracted', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
}, (table) => [
  // The one read that matters: every live mark on a surface, in painting order.
  index('strokes_surface_seq_idx').on(table.surfaceId, table.seq, table.clientId),
  uniqueIndex('strokes_surface_client_seq_idx').on(table.surfaceId, table.clientId, table.seq),
])

/**
 * Terms fixed in advance, so a name is the same name on every page.
 *
 * A workspace's own, for now. Reusing one across the chapters of a series is
 * the obvious next want and the obvious next table — this one only has to not
 * stand in the way of it.
 *
 * One per language, which is what `locale` is for. A glossary is a list of
 * *renderings* — the target half of every row is written in one language — so a
 * workspace carried into Korean and then into Spanish has two of them, and
 * feeding a Spanish prompt the Korean list would instruct the model to keep
 * spellings it cannot use. The alternative was a locale on `glossary_terms`,
 * which puts the language on the row rather than on the book it belongs to and
 * would have made the unique index a three-part thing.
 */
export const glossaries = sqliteTable('glossaries', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  workspaceId: integer('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  /**
   * The language its terms are written in. Nullable, and null means "before
   * anybody asked": nothing had written to this table when the column arrived,
   * so there is no back-fill to get wrong — and a null is left alone by
   * `glossaries.primary`, which finds by locale and makes what it does not find.
   */
  locale: text('locale'),
  name: text('name').notNull().default('Glossary'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`)
    .$onUpdate(() => new Date()),
}, (table) => [
  /*
   * The workspace alone, deliberately, though every read is by workspace *and*
   * locale.
   *
   * Widening it to both looked free and is not: drizzle-kit records the wider
   * index in its snapshot and emits no `DROP`/`CREATE INDEX` to go with it, so
   * the database keeps the narrow one while every later diff believes it is
   * wide — drift that no subsequent `generate` will ever notice or repair. The
   * narrow index is anyway the whole of the win here: it finds the workspace's
   * glossaries, of which there is one per language a chapter has been carried
   * into, and picking the right one out of two is not a scan worth indexing.
   */
  index('glossaries_workspace_idx').on(table.workspaceId),
  /*
   * One glossary per language per workspace — a *new* index under its own
   * name, which drizzle-kit emits cleanly, not a widening of the one above.
   *
   * Integrity, not speed: `glossaries.primary` is find-or-make across an
   * `await`, and two pages translated at once both found nothing and both
   * made one. Two glossaries for one language split the chapter's terms
   * between them, and first-translation-wins stopped holding because each
   * half enforced it alone. With the index, the loser's insert is a no-op it
   * can read past (`onConflictDoNothing` and a re-select).
   *
   * The legacy null-locale rows need no carve-out: SQLite treats NULLs as
   * distinct in a unique index, so the rows from before the column existed
   * coexist untouched — which is right, since `primary` never matches them
   * anyway.
   */
  uniqueIndex('glossaries_workspace_locale_idx').on(table.workspaceId, table.locale),
])

export const glossaryTerms = sqliteTable('glossary_terms', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  glossaryId: integer('glossary_id')
    .notNull()
    .references(() => glossaries.id, { onDelete: 'cascade' }),
  source: text('source').notNull(),
  target: text('target').notNull(),
  /*
   * There was a `notes` here — "why it is what it is, the argument that stops
   * it being changed back" — and it is gone because it was never anything but
   * an intention. Nothing supplied it, no schema let it over the wire, nothing
   * read it back, and every row held null; the only code touching it was an
   * upsert that set it to null again.
   *
   * The shape this table actually needs is the earlier build's, which carried
   * `{src, tr}` and no more: the list is written by the model, a term is a name
   * or a catchphrase, and there is nowhere in a two-column strip for prose
   * about one. If hand-editing ever makes the argument worth recording — a
   * collaborator "correcting" a deliberate override is the case — it comes back
   * as a nullable column, which is an in-place add.
   */
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`)
    .$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex('glossary_terms_glossary_source_idx').on(table.glossaryId, table.source),
])

/**
 * Who is in this comic, and what may not be guessed about them.
 *
 * The glossary keeps a name spelled the same way twice; it cannot say who the
 * name belongs to. A source that drops its pronouns — Japanese, Chinese, Thai,
 * Korean — leaves gender to be worked out from the line, and worked out afresh
 * on every page it comes out differently on every page. That is how a character
 * changes sex halfway down a volume, and it is the failure this table exists to
 * prevent: the answer is written down once and sent with every page.
 *
 * ## Per comic, not per language
 *
 * The one structural difference from `glossaries`, and it is the whole reason
 * this is a table of its own rather than more rows over there. A character's
 * gender is a fact about the person and does not change with the language they
 * are read in; only the *spelling* of their name does. So the row is shared
 * across every target language and `names` carries the per-language part as
 * json — which is what the note at the top of this file predicted, and it still
 * looks right.
 *
 * ## `pinned` is the same idea as on `translations`
 *
 * A model proposal is provisional and a person's decision is final. An entry
 * the model filled in while translating arrives unpinned and later pages may
 * still correct its blanks; anything saved from the panel is pinned and no page
 * may argue with it again. `cast.merge` fills gaps and never revises, for the
 * reason the glossary's first-translation-wins exists: a page that reads a
 * character wrong must not be able to rewrite a page that read them right.
 */
export const castMembers = sqliteTable('cast_members', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  workspaceId: integer('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  /** The name as the source writes it. */
  source: text('source').notNull(),
  /** How it reads in each target language, keyed by locale. */
  names: text('names', { mode: 'json' }).$type<Record<string, string>>(),
  gender: text('gender', { enum: ['male', 'female', 'nb', 'unknown'] })
    .notNull()
    .default('unknown'),
  /** Short descriptors — role, register, who they are to the others. */
  tags: text('tags', { mode: 'json' }).$type<string[]>(),
  /** Whether a person settled this, as opposed to a model proposing it. */
  pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`)
    .$onUpdate(() => new Date()),
}, (table) => [
  // One entry per name per comic — which is also what makes a learned entry
  // idempotent, the same way the glossary's unique index does.
  uniqueIndex('cast_members_workspace_source_idx').on(table.workspaceId, table.source),
])

/**
 * What happened in a workspace, in order.
 *
 * The one append-only table. It is what a second person needs in order to walk
 * in on work already in progress and understand it — and it is also where the
 * history of a translation lives, since `translations` holds only what a line
 * says now.
 *
 * `userId` is nullable and cleared rather than cascaded: a contributor leaving
 * does not unmake the work they did, and a log that deletes itself when someone
 * goes is no use for the one question it exists to answer.
 */
export const logs = sqliteTable('logs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  workspaceId: integer('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: integer('user_id'),
  /** Dotted and past-tense: 'page.added', 'block.translated', … */
  action: text('action').notNull(),
  /** What it happened to, by table name and row — no foreign key, on purpose. */
  subject: text('subject'),
  subjectId: integer('subject_id'),
  /** Whatever that action needs remembering about it, including former values. */
  detail: text('detail', { mode: 'json' }).$type<Record<string, unknown>>(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
}, (table) => [
  index('logs_workspace_created_at_idx').on(table.workspaceId, table.createdAt),
])

export type Workspace = typeof workspaces.$inferSelect
export type NewWorkspace = typeof workspaces.$inferInsert
export type Page = typeof pages.$inferSelect
export type NewPage = typeof pages.$inferInsert
export type Layer = typeof layers.$inferSelect
export type NewLayer = typeof layers.$inferInsert
export type Block = typeof blocks.$inferSelect
export type NewBlock = typeof blocks.$inferInsert
export type Translation = typeof translations.$inferSelect
export type NewTranslation = typeof translations.$inferInsert
export type TranslationRevision = typeof translationRevisions.$inferSelect
export type NewTranslationRevision = typeof translationRevisions.$inferInsert
export type Glossary = typeof glossaries.$inferSelect
export type NewGlossary = typeof glossaries.$inferInsert
export type CastMember = typeof castMembers.$inferSelect
export type NewCastMember = typeof castMembers.$inferInsert
export type GlossaryTerm = typeof glossaryTerms.$inferSelect
export type NewGlossaryTerm = typeof glossaryTerms.$inferInsert
export type Log = typeof logs.$inferSelect
export type NewLog = typeof logs.$inferInsert
export type Surface = typeof surfaces.$inferSelect
export type NewSurface = typeof surfaces.$inferInsert
export type Stroke = typeof strokes.$inferSelect
export type NewStroke = typeof strokes.$inferInsert
