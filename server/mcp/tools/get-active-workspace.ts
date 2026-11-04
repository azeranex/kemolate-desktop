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
import { blocks, contextFor } from '~~/server/services'
import { activeChapter, mcpEnabled, requireMcpActor } from '~~/server/utils/mcp'
import { openChapters } from '~~/server/utils/swarm'

/** Every chapter open in a tab, by name — the ones whose pages can be shown and read. */
async function tabbed () {
  const named = await Promise.all(openChapters().map(async (chapter) => {
    const context = await contextFor(chapter.publicId)

    return context ? { workspaceId: chapter.publicId, name: context.workspace.name, onScreen: chapter.focused } : null
  }))

  return named.filter((chapter) => chapter !== null)
}

export default defineMcpTool({
  name: 'get_active_workspace',
  description: [
    'What is open in the Kemolate window right now: the chapter on screen, and the page on screen with its blocks —',
    'and `openTabs`, every chapter open in a tab, on screen or behind it, all of which can have their pages shown and read.',
    'Start here when the user talks about "this chapter" or "this page".',
    'Every other tool works on the chapter on screen, and a tool that takes one `pageId` on the page on screen,',
    'when you leave the id out.',
  ].join(' '),
  annotations: { readOnlyHint: true },
  enabled: mcpEnabled,
  handler: async () => {
    requireMcpActor(useEvent()!)

    const open = await activeChapter()
    const openTabs = await tabbed()

    if (!open) {
      return mcpJson({
        open: false,
        openTabs,
        note: openTabs.length
          ? 'No chapter is on screen in Kemolate, but the chapters in `openTabs` are open in its tabs — name one by `workspaceId`.'
          : 'No chapter is open in Kemolate. Ask the user to open one, or pick one with `list_workspaces`.',
      })
    }

    const { context, page } = open
    const { workspace } = context

    return mcpJson({
      open: true,
      openTabs,
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
