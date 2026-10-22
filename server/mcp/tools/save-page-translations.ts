/**
 * File what the agent translated, and what the pages taught it.
 *
 * The far half of `prepare_page_translation`. Everything load-bearing about
 * *how* a translation is stored already lives in `translations.putOnPage`, and
 * this deliberately adds nothing to it — the three rules below are that
 * function's, and are restated only because an agent has to be told them:
 *
 * - **A person's wording wins.** A line somebody typed is pinned, and a machine
 *   write records its own wording as a revision without moving the head. The
 *   reply says which lines that happened to, so an agent does not read the
 *   unchanged text back and conclude the write failed.
 * - **Nothing is destroyed.** Every wording a line has ever had is kept, so a
 *   bad run is a revert rather than a loss.
 * - **One press, one batch.** The `batch` in the reply names this run — *all*
 *   of it, across every page — so the Text panel can take the whole thing back
 *   at once. That is the main reason to save several pages in one call rather
 *   than one at a time: a run somebody wants undone is rarely one page.
 *
 * The glossary and the cast are folded in here rather than in a tool of their
 * own, because they are the answer to the same question. `pagePrompt` ends by
 * asking which terms are worth keeping identical later and who these pages
 * turned out to contain, and both merge with *first answer wins* — a page that
 * reads a character wrong cannot rewrite a page that read them right. Sent once
 * for the whole call, since they belong to the chapter and not to a page.
 *
 * **Both are required, and `[]` is a real answer.** They were optional once and
 * that was a hole: the browser forwards what the model replied without anybody
 * deciding to, and an agent has to remember — so it forgot, wrote a page of
 * good translations, and taught the chapter nothing. Nothing failed and nothing
 * said so. Making the fields required does not make an agent thoughtful, but it
 * does mean the omission has to be written down as a claim that the page taught
 * nothing, which is a thing a reader can later disagree with.
 *
 * The work itself is `saveAnswers` in `server/utils/brief.ts`, beside the
 * numbering it has to agree with — which is where to read why only the lines a
 * brief asked about are written, why a one-line brief takes one answer, and why
 * every page is checked before any is filed.
 */
import { z } from 'zod'

import { saveAnswers } from '~~/server/utils/brief'
import { mcpContext, mcpEnabled } from '~~/server/utils/mcp'

export default defineMcpTool({
  name: 'save_page_translations',
  description: [
    'File your translation of one or more pages.',
    'The easy way: send the page\'s `job` from the brief and `translations` as a plain ordered list, as long as the brief\'s `expects` —',
    'the server matches them to blocks itself and refuses if the page has changed since.',
    'Only the lines the brief asked about are written; answers for lines it showed as context are set aside.',
    'Otherwise send `entries` naming each `blockId`. Either way add any `answerAsIs` lines as entries.',
    'Save a whole run in one call — it shares a single `batch`, which lets the run be undone as one thing,',
    'and every page is checked before any is written, so a refused call has changed nothing.',
    'Lines a person typed are pinned: your wording is recorded in their history but does not replace them,',
    'and the reply lists which those were.',
    '`glossary` and `cast` are REQUIRED — send what your answer proposed, or [] if these pages taught nothing.',
    'They are what keeps a name spelled the same way and a character the same person across a volume,',
    'and a run that omits them translates well and leaves the chapter no wiser.',
  ].join(' '),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  enabled: mcpEnabled,
  inputSchema: {
    workspaceId: z.string().describe('The chapter\'s id, from `list_workspaces`.'),
    locale: z.string().trim().min(2).max(16).optional()
      .describe('Language these are in. Defaults to the chapter\'s target language.'),
    model: z.string().max(120).optional()
      .describe('Which model wrote these, for the history — e.g. "claude-opus-5.5". Recorded as written.'),
    pages: z
      .array(z.object({
        pageId: z.number().int().positive(),
        /**
         * The token from this page's brief.
         *
         * Present means `translations` is read positionally against the lines
         * the brief numbered. Absent means `entries` names every block itself.
         */
        job: z.string().min(8).max(64).optional()
          .describe('The `job` from `prepare_page_translation` for this page. Send it with `translations` to save without naming block ids.'),
        translations: z
          .array(z.string().max(4000))
          .max(500)
          .optional()
          .describe('Your answer in the prompt\'s own order: one string per numbered line, or the single line a one-line brief asked for. Needs `job`. Must be exactly as long as the brief\'s `expects`.'),
        entries: z
          .array(z.object({
            blockId: z.number().int().positive(),
            text: z.string().max(4000),
          }))
          .max(500)
          .optional()
          .describe('Lines named by block. Use for `answerAsIs` passthroughs, for corrections, or instead of `job`/`translations`. A block may appear only once.'),
      }).refine(
        (page) => (page.job !== undefined && page.translations !== undefined) || (page.entries?.length ?? 0) > 0,
        'Send either `job` with `translations`, or `entries`.',
      ))
      .min(1)
      .max(20)
      .describe('The pages you translated, each with its lines.'),
    /*
     * Required, and `[]` is a real answer.
     *
     * These were optional and that was the bug: a field an agent can leave out
     * without consequence is one it leaves out, and the run then writes perfect
     * translations while teaching the chapter nothing — so the next page spells
     * the name differently and nobody can see why. The browser has no such
     * failure, because `useTranslate` reads both straight out of the model's
     * reply and forwards them without anybody deciding to.
     *
     * Required-but-empty is the closest thing to that available here. The
     * prompt already ends by asking for both and saying to use `[]` if there
     * are none, so a caller that answered the prompt has them to hand; one that
     * genuinely learned nothing now says so, and forgetting is no longer
     * something that can happen quietly.
     */
    glossary: z
      .array(z.object({
        src: z.string().max(80).describe('The term as the page writes it.'),
        tr: z.string().max(80).describe('How it should read from now on.'),
      }))
      .max(100)
      .describe('Required. Recurring series-specific terms worth keeping identical on later pages — send [] if this page taught none. First answer wins; an existing term is never overwritten here.'),
    cast: z
      .array(z.object({
        name: z.string().max(200).describe('The name as the source writes it.'),
        tr: z.string().max(200).optional().describe('How the name reads in this language.'),
        gender: z.enum(['male', 'female', 'nb', 'unknown']).optional(),
        tags: z.array(z.string().max(200)).max(50).optional().describe('A few words each — role, register, who they are to the others.'),
      }))
      .max(50)
      .describe('Required. Characters these pages named — send [] if they introduced nobody. Give a gender only where the page establishes it; guessing here speaks for every later page.'),
  },
  handler: async ({ workspaceId, locale, model, pages, glossary, cast }) => {
    const context = await mcpContext(workspaceId)

    return mcpJson(await saveAnswers(context, { locale, model, pages, glossary, cast }))
  },
})
