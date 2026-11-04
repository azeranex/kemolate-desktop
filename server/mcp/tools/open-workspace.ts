/**
 * Open a chapter in a tab of the Kemolate window — desktop only.
 *
 * The image tools and `request_page_read` reach only a chapter that is open in
 * a tab, because only a tab holds its scans (`server/utils/swarm.ts`). Before
 * this tool, an agent working through a volume had to stop at every chapter the
 * reader had not opened and ask them to open it. Asked for by the reader once
 * tabs existed (2026-11-04), as the last step of the tabs plan.
 *
 * **Behind, not in front, unless asked.** An agent opening a chapter is doing
 * its own errand; the reader is looking at something else, and a tab taking the
 * screen from under them is the agent deciding what they look at. A tab behind
 * is open just the same — its pages answer every tool — and `show` is there for
 * "open chapter 3 for me".
 *
 * **One tab per chapter still holds.** A chapter already open in a tab is that
 * tab, not a second one (`Tabs.reveal`, the rule `tabs:claim` keeps for the
 * reader's own choosing).
 *
 * It waits, briefly, for the tab to say it holds the chapter's pages, because
 * the next call an agent makes is nearly always for one of them, and answering
 * "opened" while the tab is still loading would make that call fail. A chapter
 * whose scans are not on this machine opens all the same and holds nothing,
 * which is said once the wait is over.
 */
import { z } from 'zod'

import { mcpContext, mcpEnabled } from '~~/server/utils/mcp'
import { openChapters, swarmState } from '~~/server/utils/swarm'

/** How long a tab is given to open its chapter: a cold app page, then the pages identified. */
const WAIT_MS = 20_000
const POLL_MS = 150

/** What the tab opened for this chapter holds of it, or null while it is not yet in it. */
function held (publicId: string): number | null {
  let most: number | null = null

  for (const record of swarmState.tabs.values()) {
    if (record.publicId === publicId) most = Math.max(most ?? 0, record.have.length)
  }

  return most
}

export default defineMcpTool({
  name: 'open_workspace',
  description: [
    'Open a chapter in a tab of the Kemolate window, so its pages can be shown (`get_page_image`) and read by the app\'s OCR (`request_page_read`).',
    'Only needed for a chapter `list_workspaces` does not mark `open` — text tools work on every chapter without it.',
    'Opens the tab behind the one the reader is looking at; pass `show: true` only when the user asked to see it.',
    'A chapter already open in a tab is not opened twice. Waits until the tab holds the chapter\'s pages, up to 20 seconds.',
  ].join(' '),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  enabled: mcpEnabled,
  inputSchema: {
    workspaceId: z.string().describe('The chapter\'s id, from `list_workspaces`.'),
    show: z.boolean().default(false).describe('Put the tab on screen. Leave false unless the user asked to see the chapter.'),
  },
  handler: async ({ workspaceId, show }) => {
    const context = await mcpContext(workspaceId)
    const { publicId, name } = context.workspace
    const opened = swarmState.opener?.(publicId, show) ?? null

    if (!opened) {
      throw createError({ statusCode: 503, statusMessage: 'Kemolate has no window open to open a tab in. Ask the user to open Kemolate.' })
    }

    const until = Date.now() + WAIT_MS

    // Until the tab is in the chapter and has found its pages. A tab that has
    // found none cannot be told from one still looking, so a chapter with no
    // scans on this machine is waited out to the end, and then said as such.
    while ((held(publicId) ?? 0) === 0 && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, POLL_MS))

    const holding = held(publicId)
    const onScreen = openChapters().find((chapter) => chapter.publicId === publicId)?.focused ?? false

    return mcpJson({
      workspaceId: publicId,
      name,
      opened: !opened.already,
      onScreen,
      held: holding ?? 0,
      note: holding === null
        ? 'The tab is still opening the chapter. Its pages will answer once `list_pages` reports them `reachable`.'
        : holding === 0
          ? 'The chapter is open, but none of its scans are on this machine — text tools work, image tools will not. Ask the user to link the pages.'
          : `The chapter is open in a tab and holds ${holding} page${holding === 1 ? '' : 's'}; image tools and request_page_read now reach them.`,
    })
  },
})
