/**
 * The playbook — the Kemolate skill (`plugins/kemolate/skills/kemolate/SKILL.md`)
 * without its front matter, which is for choosing a skill rather than reading
 * one. Desktop only.
 *
 * One copy for its two readers: `get_guide`, which serves it to an agent over
 * MCP, and the in-app assistant (`app/utils/agent/prompt.ts`), whose system
 * prompt it is. A file of its own and importing nothing else, so the window can
 * read it without loading a tool — and with it the services and the database.
 */
import guide from '~~/plugins/kemolate/skills/kemolate/SKILL.md?raw'

export const GUIDE = guide.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim()
