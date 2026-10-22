/**
 * Which lines of a page go out to be translated, the token that lets an answer
 * come back without repeating them, and the filing of that answer.
 *
 * Extracted from `prepare_page_translation` because two tools now need the
 * *same* answer and must not be able to disagree about it. The brief numbers
 * the lines; the save may be given a bare list of translations in that
 * numbering and has to work out which block each belongs to. If the two ever
 * computed the list differently — one filtering a hidden block the other kept —
 * a whole page of lettering would land one balloon out, silently, and read as a
 * translation that had gone mad rather than as an off-by-one.
 *
 * Both tools are thin wrappers now: `batchFor` is the brief and `saveAnswers`
 * the save, here beside the numbering they share, so that the whole round trip
 * can be tested against a real schema without an MCP session in the way.
 *
 * ## What a batch says once
 *
 * A brief used to carry the whole page prompt, every time: the instructions,
 * the reply's shape, the glossary and the cast, said again for each of twenty
 * pages when only the numbered lines differed between them. Measured on a real
 * twenty-page batch — a Chinese chapter with sixteen glossary terms and six
 * cast members — the reply was about 25k tokens by `estimateTokens`, some 850
 * of them repeated on every page; it is now about 9k. A batch opens with
 * `instructions`, the standing half (`standingPrompt`), and each page's
 * `prompt` is its own half only (`batchPagePrompt`): the same sentences, from
 * the same pieces `pagePrompt` is built from, said once. The numbering, the
 * token and the question are untouched — the page half is where all three live.
 *
 * ## The job token
 *
 * A digest of exactly what the numbering depended on: the page, the language,
 * the question asked, and the ordered block ids. The save recomputes it and
 * refuses if it differs, which turns the one dangerous failure into an error
 * message. That matters because the page can move underneath an agent —
 * somebody joins two balloons, a re-read replaces the blocks — between asking
 * for a brief and answering it, and positional writing has no way to notice on
 * its own.
 *
 * **The question is carried in the clear**, as the part before the dot: `gaps`,
 * `all`, or `b` and a block id. It is the one thing the save cannot recompute —
 * the ids are the page's, but whether the brief was filling gaps or asking
 * again is not written anywhere else — and a save that guessed got it wrong
 * both ways at once. It re-derived every brief as "again", so a gap-filling
 * answer rewrote the finished lines it had only been shown as context, and on a
 * chapter whose whole-page setting is off it numbered a different list from the
 * brief and refused every positional save as "changed". The digest covers the
 * question too, so the readable half cannot be edited into a different ask.
 *
 * It is not a secret and does not need to be. It is a checksum against
 * accident, not a capability: every id in it is one the caller was just handed.
 */
import { createHash } from 'node:crypto'

import type { Cast, Term } from '#shared/utils/prompt'
import type { Block, Page, Translation } from '~~/server/database'
import type { Context } from '~~/server/services'

import { translateWorkspace } from '#shared/utils/abilities'
import { needsTranslation, pageScript } from '#shared/utils/lang'
import { batchPagePrompt, standingPrompt } from '#shared/utils/prompt'
import { db } from '~~/server/database'
import { blocks, cast, glossaries, must, translations } from '~~/server/services'
import { mcpPage } from '~~/server/utils/mcp'

/** A block as `blocks.onPage` returns it — with its translations attached. */
type Read = Block & { translations: Translation[] }

export interface PageLines {
  /** Every block that would be lettered: not rubbish, not hidden, not empty. */
  shown: Read[]
  /** Of those, the ones a machine could have something to say about. */
  worth: Read[]
  /** Blocks that read the same in any language and cost nothing to answer. */
  spare: Read[]
  /** The blocks an answer is actually wanted for. */
  pending: Read[]
  /** What the prompt numbers, in its order — context included. */
  sent: Read[]
  /** Which of `sent` is the single line being asked about, or -1. */
  only: number
  /** What this page already says in the target language. */
  saidIn: (block: Read) => Translation | undefined
}

/** Which question is being asked of a page. Neither means "fill the gaps". */
export interface LineOptions {
  /** Every line again, whatever it says now. */
  force?: boolean
  /** One block by name, with the rest of its page as context. */
  blockId?: number
}

/**
 * Work out what a page would send.
 *
 * The three filters are `planPage`'s, restated here rather than imported
 * because that function takes the canvas's `Block` — a different shape, with
 * `type` for `kind` and the translation flattened onto it — and lives in
 * `app/`, where the server cannot reach. What is shared is the part that
 * matters and the part that is subtle: `pageScript` and `needsTranslation`,
 * which decide what is worth sending at all. If these ever disagree with
 * `planPage`'s, that one is right.
 */
export async function linesFor (
  context: Context,
  page: Page,
  target: string,
  { force = false, blockId }: LineOptions = {},
): Promise<PageLines> {
  const rows = await blocks.onPage(context, page.id) as Read[]

  const saidIn = (block: Read) => block.translations.find((row) => row.locale === target)

  const shown = rows.filter((block) =>
    block.kind !== 'garbage' && !block.hidden && block.source.trim())

  const script = pageScript(shown.map((block) => block.source))
  const worth = shown.filter((block) => needsTranslation(block.source, target, script))
  const spare = shown.filter((block) => !worth.includes(block))

  const pending = blockId !== undefined
    ? worth.filter((block) => block.id === blockId)
    : force
      ? worth
      : worth.filter((block) => !saidIn(block)?.text.trim())

  /*
   * The model is shown the whole page when the chapter says so, already
   * translated lines and all, because a comic's lines lean on each other —
   * `怎...` alone is a standalone "what?", but beside the sentence it breaks
   * off from it is the "H—" of "How could I...". The answers for lines that
   * were not being asked about are read and thrown away — by `saveAnswers`,
   * which is where that promise is kept.
   */
  const sent = context.workspace.wholePage || blockId !== undefined ? worth : pending

  const only = pending.length === 1 && sent.length > 1
    ? sent.findIndex((block) => block.id === pending[0]!.id)
    : -1

  return { shown, worth, spare, pending, sent, only, saidIn }
}

/** The question, as the token spells it — see the header. */
function askName ({ force = false, blockId }: LineOptions): string {
  if (blockId !== undefined) return `b${blockId}`

  return force ? 'all' : 'gaps'
}

/**
 * The token a brief hands out and a positional save hands back.
 *
 * The digest is short on purpose — sixteen hex characters is far past what a
 * collision needs to be implausible here, and it travels in every brief and
 * every save. The question rides in front of it, readable, because the save has
 * to know which one it is answering before it can check anything else.
 */
export function jobToken (pageId: number, locale: string, ids: number[], ask: LineOptions = {}): string {
  const name = askName(ask)

  const digest = createHash('sha256')
    .update(`${pageId}:${locale}:${name}:${ids.join(',')}`)
    .digest('hex')
    .slice(0, 16)

  return `${name}.${digest}`
}

/**
 * The question a token was handed out for, or null for one this server did not
 * write — a token from before the question was in it, or a string an agent made
 * up. Null is refused as a changed page would be, since either way the answer
 * cannot be placed.
 */
export function askOf (job: string): LineOptions | null {
  const match = /^(gaps|all|b(\d+))\.[0-9a-f]{16}$/.exec(job)

  if (!match) return null
  if (match[2] !== undefined) return { blockId: Number(match[2]) }

  return { force: match[1] === 'all' }
}

/** Which question a batch asks of its pages, and whether the scans travel with it. */
export interface BriefOptions {
  force: boolean
  blockId?: number
  hasImage: boolean
}

/**
 * One page's translation job, exactly as `prepare_page_translation` hands it
 * out inside a batch — see that tool for what each field is for.
 *
 * Its `prompt` is the page's own half and nothing else: the standing half is
 * the batch's `instructions` (see `batchFor`, and "What a batch says once").
 */
export async function briefFor (
  context: Context,
  page: Page,
  target: string,
  { force, blockId, hasImage }: BriefOptions,
) {
  const { shown, spare, pending, sent, only, saidIn } = await linesFor(
    context,
    page,
    target,
    { force, blockId },
  )

  if (blockId !== undefined && !pending.length) {
    throw createError({
      statusCode: 404,
      statusMessage: 'That block is not on this page, or is one that needs no translation.',
    })
  }

  /*
   * A brief whose prompt asks about one line names that line in its token,
   * whichever press narrowed it to one. The prompt then asks the model for
   * exactly one answer, and the save has to know which block that answer is
   * for *as the brief saw it*: re-derived from the page at save time, a gap
   * filled meanwhile — or another one opened — would turn "the one line" into
   * none or two, and the well-behaved reply would be refused as miscounted.
   * The numbering is the same either way, since a narrowed brief is only ever
   * one with the whole page in it.
   */
  const ask = only >= 0 ? { blockId: sent[only]!.id } : { force, blockId }

  return {
    pageId: page.id,
    name: page.name,
    /**
     * Hand this back to `save_page_translations` with a plain ordered list of
     * translations and it will match them to blocks itself — and refuse if the
     * page has changed since, which is the failure positional writing cannot
     * otherwise see.
     */
    job: jobToken(page.id, target, sent.map((block) => block.id), ask),
    /**
     * How many strings the save wants in `translations`: one per numbered
     * line, or one where the prompt asks about a single line.
     */
    expects: only >= 0 ? 1 : sent.length,
    /** Nothing to do here. A batch run should skip this page entirely. */
    done: pending.length === 0,
    /**
     * The blocks the prompt numbers, in its order. Only needed if you mean to
     * save by `blockId` rather than by `job` — one entry per line either way.
     */
    lines: sent.map((block, index) => ({
      number: index + 1,
      blockId: block.id,
      alreadySays: saidIn(block)?.text ?? null,
      /** Whether an answer for this line is actually wanted, or it is context. */
      asked: pending.some((row) => row.id === block.id),
    })),
    /**
     * Lines that read the same in any language — a logo, a rating stamp, a
     * bare "!?". Nothing was asked about them; pass them to the save as they
     * are, or leave them out and they stay empty.
     */
    answerAsIs: (blockId === undefined ? spare : [])
      .filter((block) => force || !saidIn(block)?.text.trim())
      .map((block) => ({ blockId: block.id, text: block.source })),
    /** Lines a person wrote. Writing over one records your wording without moving the line. */
    pinned: shown.filter((block) => saidIn(block)?.pinned).map((block) => block.id),
    /*
     * The sources are in here and not repeated in `lines`. Numbered once is
     * enough — the prompt is what the model answers, and a second copy
     * alongside it is the same text charged twice. The same bargain as the
     * batch's `instructions`, one level up.
     */
    prompt: batchPagePrompt({
      blocks: sent.map((block) => block.source),
      target,
      hasImage,
      only: only >= 0 ? only : undefined,
    }),
  }
}

/**
 * A batch of briefs: what every page shares, said once, and each page's own.
 *
 * The glossary and the cast are read once here rather than per page: they
 * belong to the chapter, and re-reading them for every page of a run was the
 * clearest waste in the per-page shape this replaced — as repeating them in
 * every page's prompt was the next clearest.
 */
export async function batchFor (context: Context, pages: Page[], target: string, options: BriefOptions) {
  const [terms, players] = await Promise.all([
    glossaries.terms(context, target),
    cast.forPrompt(context),
  ])

  const briefs = []

  for (const page of pages) briefs.push(await briefFor(context, page, target, options))

  return {
    /** Read before any page's `prompt`: the instructions, the reply's shape, the glossary and the cast. */
    instructions: standingFor(context, target, terms, players, options.hasImage),
    pages: briefs,
  }
}

/** The standing half of a batch's prompt, in this workspace's terms — see `standingPrompt`. */
function standingFor (context: Context, target: string, terms: Term[], players: Cast, hasImage: boolean): string {
  return standingPrompt({
    target,
    glossary: terms,
    cast: players,
    hasImage,
    honorifics: context.workspace.honorifics,
  })
}

/** One page of an answer, as `save_page_translations` receives it. */
export interface PageAnswer {
  pageId: number
  job?: string
  translations?: string[]
  entries?: { blockId: number, text: string }[]
}

/** The whole of a save — see `save_page_translations`. */
export interface SaveInput {
  locale?: string
  model?: string
  pages: PageAnswer[]
  glossary: { src: string, tr: string }[]
  cast: { name: string, tr?: string, gender?: 'male' | 'female' | 'nb' | 'unknown', tags?: string[] }[]
}

/** One page, checked and put into block names, and not yet written. */
interface Resolved {
  page: Page
  lines: { blockId: number, text: string }[]
  /** Answers for lines the brief showed only as context. */
  setAside: number
  /** Lines the brief asked about whose answer came back empty. */
  unanswered: number[]
}

/**
 * Turn one page's answer into lines named by block — or refuse it, having
 * written nothing.
 *
 * **Only what was asked is kept.** A brief numbers the whole page when the
 * chapter prompts that way, and the model answers for every number; the
 * answers for lines it was shown as context are read and set aside, which is
 * exactly what `useTranslate` does with the same reply in the browser. Writing
 * them was a gap-filling run rewriting finished lines — an unpinned line moved,
 * and a revision filed against each of the rest — and a chapter would read
 * differently depending on which door its pages came through.
 *
 * "Asked" is judged against the page as it is now, under the question the
 * token names: a gap somebody filled between the brief and the answer is
 * finished work by the time the answer arrives, whoever finished it.
 *
 * **An empty answer is no answer.** The browser leaves such a line a gap, and
 * so does this: an empty string written over a line that had words would be
 * the one machine write here that destroys something.
 *
 * **One answer for a one-line brief.** The prompt asks for exactly one then, so
 * a reply holding exactly one is taken as that line's. One per numbered line
 * is accepted too, and read positionally like any other — the two cannot be
 * mistaken for each other, since a brief narrowed to one line always numbers
 * more than one.
 */
async function resolve (context: Context, target: string, answer: PageAnswer): Promise<Resolved> {
  const { pageId, job, translations: positional, entries } = answer

  const page = await mcpPage(context, pageId)

  const lines: { blockId: number, text: string }[] = []
  const unanswered: number[] = []
  let setAside = 0

  if (positional && job === undefined) {
    throw createError({
      statusCode: 400,
      statusMessage: `Page ${page.id}: a plain list of translations needs the page's \`job\` from its brief, or nothing says which block each line is for.`,
    })
  }

  if (job !== undefined && positional) {
    const ask = askOf(job)

    if (!ask) {
      throw createError({
        statusCode: 409,
        statusMessage: `Page ${page.id}'s \`job\` is not one this server handed out. Call \`prepare_page_translation\` again and send the new one.`,
      })
    }

    const { sent, pending, only } = await linesFor(context, page, target, ask)
    const ids = sent.map((block) => block.id)

    if (jobToken(page.id, target, ids, ask) !== job) {
      throw createError({
        statusCode: 409,
        statusMessage: `Page ${page.id} has changed since you asked for its brief, so a positional save would put lines on the wrong blocks. Call \`prepare_page_translation\` again.`,
      })
    }

    const single = only >= 0 && positional.length === 1

    if (!single && positional.length !== ids.length) {
      throw createError({
        statusCode: 400,
        statusMessage: only >= 0
          ? `Page ${page.id}'s brief asked about line ${only + 1} alone, and you sent ${positional.length} translations. Send that one line's, or one per numbered line (${ids.length}).`
          : `Page ${page.id} was numbered ${ids.length} lines and you sent ${positional.length}. Send exactly one translation per numbered line.`,
      })
    }

    const answered = single
      ? [{ block: sent[only]!, text: positional[0]! }]
      : sent.map((block, index) => ({ block, text: positional[index]! }))

    for (const { block, text } of answered) {
      if (!pending.includes(block)) setAside += 1
      else if (!text.trim()) unanswered.push(block.id)
      else lines.push({ blockId: block.id, text })
    }
  }

  /*
   * `entries` are added on top rather than instead, so a caller can save the
   * numbered lines positionally *and* pass the `answerAsIs` blocks through in
   * the same breath — which is the ordinary shape of a page. Written as sent:
   * a line named by block is a deliberate write, not an answer to a numbering.
   */
  if (entries?.length) lines.push(...entries)

  /*
   * The two refusals `putOnPage` would make, made here instead — a block named
   * twice, and a block that is not on this page — because by the time that
   * function makes them, every page before this one has been written.
   */
  const named = lines.map((line) => line.blockId)

  if (new Set(named).size !== named.length) {
    throw createError({
      statusCode: 400,
      statusMessage: `Page ${page.id} names a block twice — check \`entries\` against the numbered lines. A block can only be translated once per save.`,
    })
  }

  if (named.length) {
    const here = await db.query.blocks.findMany({
      where: { id: { in: named }, pageId: page.id },
      columns: { id: true },
    })

    if (here.length !== named.length) {
      const found = new Set(here.map((row) => row.id))

      throw createError({
        statusCode: 404,
        statusMessage: `No block ${named.find((id) => !found.has(id))} on page ${page.id}.`,
      })
    }
  }

  return { page, lines, setAside, unanswered }
}

/**
 * File an agent's answer: every page's words, then what the pages taught.
 *
 * **Every page is checked before any is written.** A call is one run — one
 * `batch`, so the Text panel can take it back as one thing — and it used to be
 * checked a page at a time as it was written, so a stale token on the seventh
 * page left six pages filed and the glossary unmerged: half a run on the
 * record, and the half that teaches the next page thrown away. Everything a
 * caller can get wrong is found by `resolve` first, so a refusal now leaves the
 * chapter exactly as it was. What remains possible is the server failing
 * part-way through the writes themselves, which no amount of checking removes.
 *
 * **The glossary and the cast go last**, after the words: a term learned from a
 * page whose translation was refused would go on prompting every later page
 * with it. Both merge *first answer wins* — see `glossaries.merge` and
 * `cast.merge`.
 */
export async function saveAnswers (context: Context, { locale, model, pages, glossary, cast: learned }: SaveInput) {
  // Before anything is read on the caller's behalf. `putOnPage` would refuse a
  // viewer too, but only at the first write, which is now the last step.
  await must(context, translateWorkspace, context)

  const target = locale ?? context.workspace.targetLocale

  const seen = new Set<number>()
  const resolved: Resolved[] = []

  for (const answer of pages) {
    // Two answers for one page would be written one over the other, and the
    // second numbered against a page the first had already changed.
    if (seen.has(answer.pageId)) {
      throw createError({
        statusCode: 400,
        statusMessage: `Page ${answer.pageId} appears twice. Send each page once.`,
      })
    }

    seen.add(answer.pageId)
    resolved.push(await resolve(context, target, answer))
  }

  // One run, whatever it spans, so the Text panel can take the whole press
  // back at once.
  const batch = crypto.randomUUID()

  const filed = []

  for (const { page, lines, setAside, unanswered } of resolved) {
    /*
     * Which of these lines a person had already claimed, read before the write
     * rather than inferred after it. `putOnPage` holds a pinned line back
     * silently — correctly, since it still files the revision — and an agent
     * given no answer at all would read the page back, find its words absent,
     * and write them again.
     */
    const before = lines.length
      ? await db.query.translations.findMany({
          where: { blockId: { in: lines.map((line) => line.blockId) }, locale: target },
          columns: { blockId: true, pinned: true },
        })
      : []

    const saved = lines.length
      ? await translations.putOnPage(context, page.id, target, lines, {
          engine: 'agent',
          model: model ?? null,
          batch,
        })
      : []

    filed.push({
      pageId: page.id,
      /** Lines actually changed. A line already saying this is not rewritten. */
      written: saved.length,
      /**
       * Lines whose wording is now in the history but not on the page, because
       * a person had written them. This is the expected outcome for those
       * lines, not a failure — do not send them again.
       */
      heldByHuman: before.filter((row) => row.pinned).map((row) => row.blockId),
      /**
       * Answers for lines the brief showed only as context, read and set
       * aside as kemolate's own engines set them aside. Not a failure.
       */
      setAside,
      /** Lines the brief asked about whose answer was empty. Still gaps. */
      unanswered,
    })
  }

  /*
   * The list is read before the merge as well as after so the reply can say
   * how many terms were *new*. That costs one query and answers the question
   * an agent actually has — it proposed six and two were kept, because
   * `merge` is first-wins and drops anything the chapter had already settled,
   * anything that translates to itself, and everything past `MAX_TERMS`.
   */
  const had = await glossaries.terms(context, target)
  const terms = glossary.length ? await glossaries.merge(context, target, glossary) : had

  if (learned.length) await cast.merge(context, target, learned)

  return {
    locale: target,
    batch,
    pages: filed,
    /**
     * `offered` is what was sent, `learned` what the chapter kept, `terms`
     * what it now knows in total. All three, because a bare count cannot
     * distinguish "you proposed nothing" from "nothing you proposed was new",
     * and those call for opposite responses next page.
     */
    glossary: { offered: glossary.length, learned: terms.length - had.length, terms: terms.length },
    cast: { offered: learned.length },
  }
}
