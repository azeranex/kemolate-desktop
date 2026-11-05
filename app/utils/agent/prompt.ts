/**
 * What the assistant is told before the reader says anything — desktop only.
 *
 * Mostly what an agent reaching Kemolate over MCP is told: the server's
 * instructions (`server/mcp/instructions.ts`) and the playbook `get_guide`
 * serves (`server/mcp/guide.ts`), the same text read from the same files, so
 * a lesson written into the playbook is learned by both. What is the
 * assistant's own is the preface: where it is, who it is talking to, and what
 * the playbook calls "the user's call", which here is a question in the panel
 * rather than in somebody's editor.
 *
 * ## The playbook, by the chapter
 *
 * The system prompt is sent again on every turn of the loop, and the whole
 * playbook is ~20k characters, half of it lettering. A page's lettering run was
 * nineteen turns, so the playbook alone was ~100k tokens of it — most of them
 * sections the task never needed. So the prompt carries the playbook's
 * standing half (`CORE`) and the task chapters (`TOPICS`) are a tool,
 * `read_playbook`, answered here in the window. A chapter read once stays in
 * the conversation, which is cached, so it costs a tenth from then on.
 *
 * The split is by the playbook's own `##` headings, so a section added there
 * is in the core unless it is named below — a lesson is never dropped, at
 * worst it is sent when it need not be.
 */
import type { Tool } from './loop'
import type { Turn } from './messages'

import { GUIDE } from '~~/server/mcp/guide'
import { INSTRUCTIONS } from '~~/server/mcp/instructions'

const PLAYBOOK = 'read_playbook'

/** Which `##` sections of the playbook are a chapter read on demand, by the topic that asks for them. */
const CHAPTERS: Record<string, string[]> = {
  reading: ['Reading a chapter'],
  translating: ['Translating'],
  lettering: ['Lettering', 'Reviewing lettering'],
}

/**
 * The tools each topic brings with it. The tool list is sent on every turn too,
 * and after trimming (`compact` in `loop.ts`) it was still ~29k characters,
 * most of it the tools for fixing a reading, which a lettering run never
 * touches. So a topic's tools are offered once its chapter has been read —
 * which is also the order the playbook wants: know how, then do. Changing the
 * list misses the cache once, at the turn after the read.
 *
 * A tool named in no topic is always offered.
 */
const TOOLS_OF: Record<string, string[]> = {
  reading: ['request_page_read', 'review_page_reading', 'correct_blocks', 'join_blocks', 'split_block', 'save_page_blocks', 'sort_page_blocks'],
  translating: ['prepare_page_translation', 'save_page_translations', 'get_glossary', 'get_cast'],
  lettering: ['review_lettering', 'set_lettering_style', 'set_lettering_standard'],
}

/** The topics whose chapter a successful `read_playbook` has given in these turns. */
function readIn (turns: Turn[]): Set<string> {
  const failed = new Set(turns.flatMap((turn) => (turn.role === 'tool' ? turn.results.filter((result) => result.isError).map((result) => result.callId) : [])))

  return new Set(turns.flatMap((turn) => (turn.role === 'assistant' ? turn.calls : []))
    .filter((call) => call.name === PLAYBOOK && !failed.has(call.id))
    .map((call) => String(call.arguments.topic)))
}

/**
 * Joining is the reader's to ask for, not the assistant's to decide. The
 * playbook tells an agent to join a balloon's columns, and asked to fix
 * lettering the assistant did — merging blocks the reader wanted kept apart,
 * each of which had its own translation and lettering. So `join_blocks` is
 * offered only in a conversation where the reader's own words ask to join,
 * merge or combine; a chapter run's messages never do.
 */
const JOINING = 'join_blocks'
const ASKS_TO_JOIN = /\b(?:join|merge|combine)/i

/** The tools held back from a conversation of these turns: a topic's until it is read, and joining until the reader asks for it. */
export function withheld (turns: Turn[]): Set<string> {
  const read = readIn(turns)
  const held = new Set(Object.entries(TOOLS_OF).filter(([topic]) => !read.has(topic)).flatMap(([, names]) => names))

  if (!turns.some((turn) => turn.role === 'user' && ASKS_TO_JOIN.test(turn.text))) held.add(JOINING)

  return held
}

/** The playbook in `##` sections, keyed by heading; the part before the first is keyed ''. */
function sectionsOf (text: string): Map<string, string> {
  const sections = new Map<string, string>()

  for (const part of text.split(/^(?=## )/m)) {
    const heading = /^## (.+)$/m.exec(part.split('\n')[0] ?? '')?.[1]?.trim() ?? ''

    sections.set(heading, part.trim())
  }

  return sections
}

const sections = sectionsOf(GUIDE)
const onDemand = new Set(Object.values(CHAPTERS).flat())

export const TOPICS: Record<string, string> = Object.fromEntries(Object.entries(CHAPTERS)
  .map(([topic, headings]) => [topic, headings.map((heading) => sections.get(heading) ?? '').filter(Boolean).join('\n\n')]))

const CORE = [...sections].filter(([heading]) => !onDemand.has(heading)).map(([, text]) => text).join('\n\n')

const PREFACE = `You are the assistant inside Kemolate, a desktop app for translating comics and manga. You are in a panel beside the page, talking to the reader, who can see the page and everything your tools change on it as you change it.

Your tools are Kemolate's own MCP tools; the playbook below is written for an agent reaching them over MCP and applies to you unchanged, except that you always work on the chapter open in the reader's tab — there is no other chapter to open or list. Leave \`pageId\` out to mean the page on screen.

- Before a task, call \`read_playbook\` for each of its topics you have not read in this conversation (${Object.keys(CHAPTERS).join(', ')}), all in your first turn. The playbook below is only its standing half, and a topic's tools are offered only once you have read it: ${Object.entries(TOOLS_OF).map(([topic, names]) => `${topic} brings ${names.map((name) => `\`${name}\``).join(', ')}`).join('; ')}.
- Spend few turns: every turn sends the whole conversation again. Make every call you can in one turn, and use each tool for many blocks at once — \`review_lettering\` for the whole page, \`set_lettering_style\` with \`frames\` for several balloons' frames together, one \`save_page_translations\` for every line.
- Keep the blocks as they are. Never join blocks unless the reader asks you to in this conversation — where the playbook says to join a balloon's columns, letter each block on its own instead. \`join_blocks\` is offered only once the reader has asked.
- Do what the reader asks, the way the playbook says. Where it says something is the user's decision, ask the reader here and wait for the answer.
- Some tools wait for the reader's approval before they run. If one comes back declined, do not call it again for the same thing; say what you would have done.
- Be brief. Say what you changed and what is left for the reader's eye. The reader sees each tool call as you make it, so do not narrate them.
- Old pictures, and answers a later call has made out of date, are replaced with a note. Ask again if you need one.`

export const SYSTEM_PROMPT = [PREFACE, '# Server instructions', INSTRUCTIONS, '# The playbook (standing half)', CORE].join('\n\n')

/**
 * A chapter run's messages, each the start of a fresh conversation — see
 * `useAssistant.chapter`. Translation is one conversation in batches, because
 * the tools take twenty pages a call and the glossary wants page order;
 * lettering is one per page, because it is most of the turns and none of them
 * needs another page's.
 */
export const CHAPTER_TRANSLATE = 'Translate every page of this chapter that needs it: `list_pages` with `needs: "translation"` names them. Work in batches of up to 20 pages, in page order — one `prepare_page_translation` in text mode, then one `save_page_translations` with the glossary and cast — until none is left. Do not review lettering; that is done afterwards, page by page. End with one line: how many pages and lines you translated, and anything held by the reader\'s pins.'

export function chapterLetter (page: { pageId: number, name: string }): string {
  return `Review the lettering on page ${page.pageId} ("${page.name}") and fix what needs fixing, as the playbook's lettering chapter says. Pass \`pageId: ${page.pageId}\` to every tool. This is one page of a chapter run, so do not ask the reader anything: leave a decision that is theirs as it is, and say so. End with one line on what you changed.`
}

/** `read_playbook`, the one tool answered in the window — see the header. */
export const PLAYBOOK_TOOL: Tool = {
  name: PLAYBOOK,
  description: 'The playbook\'s chapter on one part of the work, and its tools, which are offered from the next turn. Read each one a task needs, once per conversation, before doing it.',
  inputSchema: {
    type: 'object',
    properties: { topic: { type: 'string', enum: Object.keys(CHAPTERS) } },
    required: ['topic'],
  },
  annotations: { readOnlyHint: true },
}

export function readPlaybook (args: Record<string, unknown>): string {
  const text = TOPICS[String(args.topic)]

  if (!text) throw new Error(`No such topic. Choose one of: ${Object.keys(CHAPTERS).join(', ')}.`)

  return text
}
