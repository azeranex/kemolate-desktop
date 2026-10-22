/**
 * Who is in this comic.
 *
 * The glossary's other half, and the reason a character does not change sex
 * halfway down a volume: the glossary keeps a *name* spelled the same way
 * twice, and this keeps track of who the name belongs to. Per comic rather than
 * per language — gender is a fact about the person, and only the spelling is
 * per-language.
 *
 * `pinned` is the field worth reading. A pinned row was settled by a person and
 * no later page revises it; an unpinned one is what some page proposed and is
 * still open to correction.
 */
import { z } from 'zod'

import { cast } from '~~/server/services'
import { mcpContext, mcpEnabled } from '~~/server/utils/mcp'

export default defineMcpTool({
  name: 'get_cast',
  description: [
    'The characters this chapter knows about — how each name is spelled in each language,',
    'their gender where the comic has established it, and the standing note its translator left about the work.',
  ].join(' '),
  annotations: { readOnlyHint: true },
  enabled: mcpEnabled,
  inputSchema: {
    workspaceId: z.string().describe('The chapter\'s id, from `list_workspaces`.'),
  },
  handler: async ({ workspaceId }) => {
    const context = await mcpContext(workspaceId)

    const { members, notes } = await cast.list(context)

    return mcpJson({
      notes,
      members: members.map((member) => ({
        id: member.id,
        source: member.source,
        names: member.names ?? {},
        gender: member.gender,
        tags: member.tags ?? [],
        pinned: member.pinned,
      })),
    })
  },
})
