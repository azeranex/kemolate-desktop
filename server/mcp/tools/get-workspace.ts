/**
 * What a chapter is set to — the facts that decide how every page of it is read
 * and written.
 *
 * These belong to the chapter rather than to the person looking at it, which is
 * the whole reason they are worth a tool: two people translating one comic into
 * different languages is not a preference, it is a bug neither of them can see.
 */
import { z } from 'zod'

import { mcpContext, mcpEnabled } from '~~/server/utils/mcp'

export default defineMcpTool({
  name: 'get_workspace',
  description: 'The settings of one chapter: its languages, reading direction, and the standing note its translator left about the work.',
  annotations: { readOnlyHint: true },
  enabled: mcpEnabled,
  inputSchema: {
    workspaceId: z.string().describe('The chapter\'s id, from `list_workspaces`.'),
  },
  handler: async ({ workspaceId }) => {
    const { workspace, role } = await mcpContext(workspaceId)

    return mcpJson({
      workspaceId: workspace.publicId,
      name: workspace.name,
      yourRole: role,
      direction: workspace.direction,
      sourceLocale: workspace.sourceLocale,
      targetLocale: workspace.targetLocale,
      honorifics: workspace.honorifics,
      wholePage: workspace.wholePage,
      /*
       * Read-only here on purpose. The cast note is written from the Cast panel
       * beside the characters it is about, under translator rights, and the
       * settings tool is owner-only — exposing one field through the other's
       * door would be two abilities governing one column.
       */
      castNotes: workspace.castNotes,
    })
  },
})
