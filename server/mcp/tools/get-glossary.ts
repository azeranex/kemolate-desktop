/**
 * What the chapter has settled on, in one language.
 *
 * `prepare_page_translation` already folds this into every prompt, so this tool
 * is not for translating — it is for arguing with the list. "Why does it keep
 * calling her that" is a question about the glossary, and until it could be
 * read it could only be answered by opening the panel.
 *
 * Row ids come back because they are what a later correction would name. The
 * prompt's copy deliberately has none: an id means nothing to a model, and
 * would be four tokens per term of noise on every page.
 */
import { z } from 'zod'

import { glossaries } from '~~/server/services'
import { mcpContext, mcpEnabled } from '~~/server/utils/mcp'

export default defineMcpTool({
  name: 'get_glossary',
  description: 'The terms this chapter has settled on for one language — names, places, catchphrases — and their row ids.',
  annotations: { readOnlyHint: true },
  enabled: mcpEnabled,
  inputSchema: {
    workspaceId: z.string().describe('The chapter\'s id, from `list_workspaces`.'),
    locale: z.string().trim().min(2).max(16).optional()
      .describe('Which language. Defaults to the chapter\'s target language.'),
  },
  handler: async ({ workspaceId, locale }) => {
    const context = await mcpContext(workspaceId)

    const target = locale ?? context.workspace.targetLocale

    return mcpJson({ locale: target, terms: await glossaries.rows(context, target) })
  },
})
