/**
 * The whole playbook for working through this server — desktop only.
 *
 * It is the Kemolate skill (`plugins/kemolate/skills/kemolate/SKILL.md`), read
 * in at build time, so it is the same text whichever way an agent reaches the
 * app, and always the one for the tools this build has. A skill has to be
 * installed, and differently in every client — uploaded in Claude Desktop's
 * chat, a plugin in Claude Code, not possible at all from the MCP bundle — and
 * the server's instructions every client does get are cut short past a few
 * thousand characters. A tool is the one thing every MCP client hands the model
 * as it is, so the guide is one.
 *
 * Read-only and free of the workspace: it needs no chapter open.
 */
import guide from '~~/plugins/kemolate/skills/kemolate/SKILL.md?raw'
import { mcpEnabled, requireMcpActor } from '~~/server/utils/mcp'

/** The skill without its front matter — the description is for choosing a skill, not for reading. */
const body = guide.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim()

export default defineMcpTool({
  name: 'get_guide',
  description: [
    'The playbook for working in Kemolate: the order that saves images, which tool for which job,',
    'the coordinate and pinning rules, and how to fix lettering. Read it once before any job of more',
    'than a step or two — reading or translating pages, fixing a balloon — unless the Kemolate skill is already loaded.',
  ].join(' '),
  annotations: { readOnlyHint: true },
  enabled: mcpEnabled,
  handler: async () => {
    requireMcpActor(useEvent()!)

    return { content: [{ type: 'text' as const, text: body }] }
  },
})
