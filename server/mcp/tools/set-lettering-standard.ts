/**
 * The chapter's standard lettering size — desktop only.
 *
 * The one size every ordinary line of dialogue and every caption is set at, as
 * a lettered book is: squeezed a little where a balloon is tight, never blown
 * up to fill one the artist drew big. Without one, Kemolate fills each balloon,
 * so the sizes on a page follow its balloons rather than its voices — the
 * "text too big in a big balloon" a reader sees. Sound effects keep their own.
 *
 * A line whose original was lettered big (a shout) is set over the standard by
 * its emphasis — measured from the original's characters, or chosen per line
 * with `set_lettering_style`'s `emphasis` — so a standard does not flatten them.
 *
 * Written to the workspace's record (`workspaces.lettering_standard`), the same
 * row the Lettering panel's Standard size writes, and the window re-fits when
 * told. Scan pixels, as every lettering size.
 */
import { z } from 'zod'

import { workspaces } from '~~/server/services'
import { mcpContext, mcpEnabled } from '~~/server/utils/mcp'

export default defineMcpTool({
  name: 'set_lettering_standard',
  description: [
    'Set the chapter\'s standard lettering size: every ordinary line of dialogue and caption is set at it, squeezed where a balloon is tight,',
    'instead of being blown up to fill its balloon. The fix for text that is too big, or that changes size from balloon to balloon.',
    'Lines the original lettered big (shouts) stay louder by their emphasis; sound effects keep their own size. Null turns it off (every balloon filled).',
    'Sizes are in the scan\'s own pixels — `review_lettering` gives the page\'s ordinary size, a good starting value. Check the result with `review_lettering`.',
  ].join(' '),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  enabled: mcpEnabled,
  inputSchema: {
    workspaceId: z.string().describe('The chapter\'s id, from `list_workspaces`.'),
    size: z.number().int().min(1).max(2000).nullable()
      .describe('The standard size in scan pixels, or null to turn the standard off.'),
  },
  handler: async ({ workspaceId, size }) => {
    const context = await mcpContext(workspaceId)
    const before = context.workspace.letteringStandard ?? null
    const changed = await workspaces.update(context, { letteringStandard: size })

    return mcpJson({
      workspaceId: changed.publicId,
      standard: changed.letteringStandard ?? null,
      was: before,
      note: size === null
        ? 'Off: each balloon is filled again.'
        : 'Kemolate re-fits the open chapter now. Lines with a size chosen by hand keep it; `review_lettering` shows the result.',
    })
  },
})
