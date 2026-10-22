/**
 * Change what a chapter is set to. Owner only, through the same ability the
 * PATCH route uses.
 *
 * Not destructive, but not read-only either, and the annotation says so: moving
 * the target language changes what every later page is translated into and
 * which glossary those pages are prompted with. A client that asks before
 * non-read-only tools should ask before this one.
 */
import { z } from 'zod'

import { workspacePatchSchema } from '#shared/schemas/workspace'
import { workspaces } from '~~/server/services'
import { mcpContext, mcpEnabled } from '~~/server/utils/mcp'

export default defineMcpTool({
  name: 'update_workspace',
  description: [
    'Change a chapter\'s settings. Only the fields you send are changed.',
    'Owner rights are required.',
  ].join(' '),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  enabled: mcpEnabled,
  inputSchema: {
    workspaceId: z.string().describe('The chapter\'s id, from `list_workspaces`.'),
    name: z.string().trim().min(1).max(200).optional().describe('What the chapter is called.'),
    direction: z.enum(['ltr', 'rtl']).optional().describe('Which way round the pages read.'),
    sourceLocale: z.string().trim().min(2).max(16).optional().describe('The language the comic is written in.'),
    targetLocale: z.string().trim().min(2).max(16).optional().describe('The language it is being translated into. Changing this switches which glossary later pages are prompted with.'),
    honorifics: z.boolean().optional().describe('Whether -san, -kun, -senpai and the rest survive the move.'),
    wholePage: z.boolean().optional().describe('Whether a page is read as a whole before any one line of it is translated.'),
  },
  handler: async ({ workspaceId, ...patch }) => {
    const context = await mcpContext(workspaceId)

    // Through the shared schema rather than trusting the tool's own shape. The
    // two say the same thing today; parsing here is what stops them saying
    // different things after somebody edits one of them.
    const result = workspacePatchSchema.safeParse(patch)

    if (!result.success) {
      throw createError({
        statusCode: 400,
        statusMessage: result.error.issues[0]?.message ?? 'Nothing to change.',
      })
    }

    const workspace = await workspaces.update(context, result.data)

    return mcpJson({
      workspaceId: workspace.publicId,
      name: workspace.name,
      direction: workspace.direction,
      sourceLocale: workspace.sourceLocale,
      targetLocale: workspace.targetLocale,
      honorifics: workspace.honorifics,
      wholePage: workspace.wholePage,
    })
  },
})
