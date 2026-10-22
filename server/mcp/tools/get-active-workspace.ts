/**
 * What the reader has open in Kemolate right now — desktop only.
 *
 * The web build has no such tool, because there is no such thing there: a
 * chapter may be open in a dozen tabs belonging to four people. Here there is
 * one window, and "this chapter" and "this page" mean what it shows — so a
 * reader can say "translate this page" and the agent can find out which, and
 * every other tool takes the open chapter and page when it is not given an id
 * (`server/mcp/index.ts`).
 *
 * The page is the one on screen, by its row id; null until that page has a row
 * (a chapter still being opened), or when nothing is open at all, which is said
 * as such rather than refused — it is an answer, not a failure.
 */
import { blocks } from '~~/server/services'
import { activeChapter, mcpEnabled, requireMcpActor } from '~~/server/utils/mcp'

export default defineMcpTool({
  name: 'get_active_workspace',
  description: [
    'What is open in the Kemolate window right now: the chapter, and the page on screen with its blocks.',
    'Start here when the user talks about "this chapter" or "this page".',
    'Every other tool works on the open chapter, and a tool that takes one `pageId` on the page on screen,',
    'when you leave the id out.',
  ].join(' '),
  annotations: { readOnlyHint: true },
  enabled: mcpEnabled,
  handler: async () => {
    requireMcpActor(useEvent()!)

    const open = await activeChapter()

    if (!open) {
      return mcpJson({
        open: false,
        note: 'No chapter is open in Kemolate. Ask the user to open one, or pick one with `list_workspaces`.',
      })
    }

    const { context, page } = open
    const { workspace } = context

    return mcpJson({
      open: true,
      workspaceId: workspace.publicId,
      name: workspace.name,
      direction: workspace.direction,
      sourceLocale: workspace.sourceLocale,
      targetLocale: workspace.targetLocale,
      page: page
        ? {
            pageId: page.id,
            name: page.name,
            position: page.position,
            width: page.width,
            height: page.height,
            blocks: (await blocks.onPage(context, page.id)).length,
          }
        : null,
    })
  },
})
