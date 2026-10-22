/**
 * The whole workflow, as something a person can pick out of a menu.
 *
 * Every tool here is reachable without this, and an agent that reads the server
 * instructions and the tool descriptions will find its way. What it will not do
 * reliably is find the *order*, and the order is where the savings are: read
 * with the pipeline rather than by eye, check the characters before trusting
 * them, sort before lettering, batch everything, and hand the glossary back at
 * the end. Explaining that once per conversation is exactly the sort of thing a
 * prompt exists to stop.
 *
 * A prompt rather than a tool because the audience is different. A tool is for
 * the model; this is for the reader — it appears in their client's own menu,
 * they pick a chapter, and the agent is briefed. Nothing here can be called by
 * a model on its own initiative, which is right: starting a run over forty
 * pages is a decision somebody should make deliberately.
 *
 * Kept to the shape of the work and free of anything the tools already say.
 * Repeating the coordinate rule or the pinning rule here would be a second copy
 * to drift, and both are in `mcp.instructions` and in the tools that need them.
 */
import { z } from 'zod'

import { mcpEnabled } from '~~/server/utils/mcp'

export default defineMcpPrompt({
  name: 'translate_chapter',
  title: 'Translate a chapter',
  description: 'Work through a kemolate chapter: read the pages with the app\'s own OCR, check what it read, then translate and file it.',
  enabled: mcpEnabled,
  inputSchema: {
    workspaceId: z.string().describe('The chapter to work on. Ask `list_workspaces` if you do not have it.').optional(),
    pages: z.string().describe('Which pages, e.g. "1-10" or "all". Defaults to everything with work left.').optional(),
  },
  handler: ({ workspaceId, pages }) => [
    workspaceId
      ? `Translate the kemolate chapter \`${workspaceId}\`${pages ? `, pages ${pages}` : ''}.`
      : 'Translate a kemolate chapter. Start with `list_workspaces` and ask me which one if it is not obvious.',
    '',
    'Work in this order. It matters — most of it exists to stop you paying for pictures you do not need.',
    '',
    '1. `list_pages` with `needs: "anything"` to see what is left, and whether the pages are',
    '   `reachable` (a browser has the chapter open). Everything except the image tools works either way.',
    '2. For pages with no blocks, `request_page_read` with ALL of them in one call. Do not read pages',
    '   by eye: the app\'s detector is better at box shapes than you are, and costs no image.',
    '   It will probably answer "working" — poll `list_pages` rather than calling it again.',
    '3. `review_page_reading` on each page that was read. It returns every block beside a close crop',
    '   of itself, in one call. The recogniser is trained on Japanese; on a Chinese page it returns',
    '   plausible characters with full confidence, so you cannot tell from the text alone.',
    '   Fix what is wrong with `correct_blocks` — including a box that is the wrong shape.',
    '4. `sort_page_blocks` if the block list is out of sequence. Skip it on a page somebody has',
    '   arranged by hand, because it overwrites that.',
    '5. `prepare_page_translation` — batch the pages, `text` mode unless the dialogue leans on the',
    '   artwork. The glossary and the cast are already in the prompt; do not fetch them separately.',
    '6. Answer each prompt, then `save_page_translations` with each page\'s `job` and your',
    '   translations in the same order. Send `glossary` and `cast` from your answers — `[]` if a page',
    '   genuinely taught nothing. That is what keeps a name spelled the same way across a volume.',
    '',
    'Tell me what you could not do rather than guessing: a reading you are unsure of, a sound effect',
    'with no block, a line where the source itself is ambiguous. I would rather fix six things than',
    'find them later.',
  ].join('\n'),
})
