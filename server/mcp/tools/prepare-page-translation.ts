/**
 * Hand the agent the job of translating a page — the same job kemolate's own
 * engines are given, built from the same prompt.
 *
 * This is the half of the loop that asks; `save_page_translations` is the half
 * that files the answer. Splitting them that way is what makes an MCP client a
 * translation engine rather than a chat window: the model doing the work is the
 * one the reader is already talking to, on their own subscription, and no
 * provider key is involved anywhere.
 *
 * ## Why the prompt comes from `shared/utils/prompt.ts`
 *
 * Because the prompt is the whole of what makes a translation good or wrong. A
 * second one written here would drift from the one the app uses, and a chapter
 * would then read differently depending on which door its pages came through —
 * which is the exact failure `pagePrompt` exists as one function to prevent. It
 * already carries the glossary, the cast, the honorifics rule and the shape of
 * the reply; all this does is fill it in from rows instead of from a browser's
 * state. **A caller never needs `get_glossary` or `get_cast` first** — both are
 * already inside every batch, in its `instructions`.
 *
 * ## Said once, not twenty times
 *
 * A reply is `instructions` — the standing half of the prompt: what to do, the
 * shape to answer in, the glossary and the cast — and then each page with a
 * `prompt` of its own lines and nothing else. Every page used to carry the
 * whole prompt, so a twenty-page batch said the same standing text twenty
 * times: about 25k tokens on a real chapter, now about 9k. See `batchFor` in
 * `server/utils/brief.ts`.
 *
 * ## The job token
 *
 * Each brief carries one, and handing it back with a plain ordered list of
 * translations is the cheap way to save: no copying block ids across, and no
 * chance of an answer landing one balloon out. See `server/utils/brief.ts`,
 * which owns the numbering, the token and the brief itself (`briefFor`), so
 * this tool and the save cannot disagree about them. The token names the
 * question as well as the lines — filling gaps, asking again, or one block —
 * because the save has to know which lines were asked and which were context.
 *
 * ## Text, image, and paying for the picture once
 *
 * `text` sends the lines and nothing else, and is the cheap ordinary case.
 * `image` attaches the page as well, which is what lets the model see who is
 * speaking, what is happening behind them, and where a line breaks off. It
 * costs a relay from somebody's open tab — see `get_page_image` — so a caller
 * that has *already* looked at the page should ask for `text` and not buy the
 * same picture twice.
 *
 * ## What is deliberately not sent
 *
 * Rubbish, hidden and empty blocks, and — the one that saves real money — any
 * block already in the target's script on a page written in another. A shirt
 * logo, a rating stamp, a bare `!?`. Those come back in `answerAsIs`, ready to
 * be passed to the save unchanged.
 */
import { z } from 'zod'

import { batchFor } from '~~/server/utils/brief'
import { mcpContext, mcpEnabled, mcpPage } from '~~/server/utils/mcp'
import { requestRender } from '~~/server/utils/relay'

/**
 * How many pages may carry an image in one call.
 *
 * Each one is a browser round trip and a picture in the reply. Four is a
 * spread's worth — enough to read a scene, few enough that a careless
 * `pageIds` of forty does not ask somebody's laptop to upload forty pages.
 */
const IMAGE_PAGES = 4

export default defineMcpTool({
  name: 'prepare_page_translation',
  description: [
    'Get the translation job for one or more pages: the prompt kemolate would send, in two halves.',
    '`instructions` is said once for the whole batch and applies to every page — how to translate,',
    'the shape to answer in, and the chapter\'s glossary, cast and honorifics rule;',
    'you do not need `get_glossary` or `get_cast` first.',
    'Each page\'s `prompt` holds only its own numbered lines and how many answers it wants.',
    'Answer each page\'s prompt the way `instructions` say, then call `save_page_translations` with its `job` and your',
    'translations in the same order, as many as its `expects` — no copying block ids across.',
    'Mode "image" also attaches each page scan, relayed from a reader\'s open tab; use mode "text"',
    'if you have already looked at the page, so the image is not fetched twice.',
    `Batch pages in one call — up to 20 in text mode, ${IMAGE_PAGES} in image mode.`,
  ].join(' '),
  annotations: { readOnlyHint: true, openWorldHint: true },
  enabled: mcpEnabled,
  inputSchema: {
    workspaceId: z.string().describe('The chapter\'s id, from `list_workspaces`.'),
    pageIds: z.array(z.number().int().positive()).min(1).max(20)
      .describe('The pages to prepare, from `list_pages`, in the order you mean to work through them.'),
    mode: z.enum(['text', 'image']).default('text')
      .describe('"text" sends the lines only. "image" also attaches each page scan, which needs the chapter open in a browser.'),
    locale: z.string().trim().min(2).max(16).optional()
      .describe('Language to translate into. Defaults to the chapter\'s target language.'),
    force: z.boolean().default(false)
      .describe('Ask again for lines that already have a translation. Off by default, so a run fills in the gaps and leaves finished work alone.'),
    blockId: z.number().int().positive().optional()
      .describe('Translate only this one block, with the rest of its page as context. Only meaningful with a single page.'),
  },
  handler: async ({ workspaceId, pageIds, mode, locale, force, blockId }) => {
    const context = await mcpContext(workspaceId)

    if (blockId !== undefined && pageIds.length > 1) {
      throw createError({
        statusCode: 400,
        statusMessage: 'A single block belongs to a single page — name one page with `blockId`.',
      })
    }

    if (mode === 'image' && pageIds.length > IMAGE_PAGES) {
      throw createError({
        statusCode: 400,
        statusMessage: `Image mode relays a scan out of somebody's browser per page — ${IMAGE_PAGES} at a time at most.`,
      })
    }

    const target = locale ?? context.workspace.targetLocale

    const pages = []

    for (const pageId of pageIds) pages.push(await mcpPage(context, pageId))

    const { instructions, pages: briefs } = await batchFor(context, pages, target, {
      force,
      blockId,
      hasImage: mode === 'image',
    })

    const images: { type: 'image', data: string, mimeType: string }[] = []

    for (const page of mode === 'image' ? pages : []) {
      if (!page.hash) {
        throw createError({
          statusCode: 409,
          statusMessage: `Page ${page.id} has not been hashed yet, so its image cannot be asked for. Use mode "text", or open the chapter in kemolate once.`,
        })
      }

      const { bytes, type } = await requestRender(context.workspace.publicId, page.hash, context.workspace.name)

      images.push({ type: 'image', data: bytes.toString('base64'), mimeType: type })
    }

    const summary = {
      locale: target,
      mode,
      // Named in order, so a reply carrying several images says which page each
      // one is. The images follow the text block in the same order.
      imagesFor: mode === 'image' ? briefs.map((brief) => brief.pageId) : [],
      // Before the pages, because it is read before them.
      instructions,
      pages: briefs,
    }

    return {
      content: [
        { type: 'text' as const, text: JSON.stringify(summary) },
        ...images,
      ],
    }
  },
})
