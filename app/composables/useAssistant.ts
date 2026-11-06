/**
 * The assistant: a conversation with a model on the reader's own key, which
 * works on the chapter through Kemolate's MCP tools — desktop only.
 *
 * What a run does is `app/utils/agent/loop.ts`, and what it may do is the MCP
 * server's (`electron/assistant.ts`). This composable is the part the panel
 * holds: the conversation, the model, the key, the Stop, the question the
 * reader is being asked, and the bill.
 *
 * ## Conversations, and the ones kept
 *
 * One conversation is open per tab, in module state, so the panel can be
 * closed and opened again, or moved to another column, without losing it —
 * and since a tab is its own page, each tab has its own.
 *
 * "New chat" starts another and keeps the last, and every conversation is kept
 * per chapter in IndexedDB (`assistant:<workspaceId>`, the newest `KEPT`), so
 * one can be read again or carried on after a reload. Kept **without its
 * pictures**: a review is a dozen crops, and a chapter's worth of base64 in the
 * store is exactly what `idb.ts` says it is not for. A conversation opened
 * again has a line where each was — which is what the model is sent for an old
 * picture anyway (`forSending`) — and its permissions are not kept: "Allow for
 * this conversation" meant the conversation as it was running.
 *
 * ## The model
 *
 * The Translate panel's until the reader picks another here, because that is
 * the model whose key they have already shown they hold. Only models that can
 * call tools are offered (`AiModel.tools`). A model that cannot see is
 * allowed — most of the work is text — and is told when a tool's picture was
 * kept from it.
 *
 * ## Thinking
 *
 * The assistant's own setting (`thinking`), kept in this browser, Low until
 * changed. It used to follow the Translate panel's speed, whose default, Fast,
 * is no thinking at all — right for a page sent in one pass, wrong for a run
 * that chooses among twenty tools and works through a page in several steps,
 * where a call made without a plan is a round, and the conversation sent
 * again, spent on finding that out. Low is ~2k tokens a round at the output
 * price; Off is still offered for a reader who would rather pay in rounds.
 *
 * ## Spend, and what it is spent on
 *
 * Every provider round is a row on the AI ledger, `what: 'assistant'`, filed
 * under the page on screen — like a region's, so a table of a chapter's costs
 * says what the assistant cost beside what its pages did.
 *
 * `context` is what the next round will send, broken down — the system
 * prompt, the tool list, and the conversation by kind — so a reader can see
 * why a turn costs what it does. Estimated at four characters a token and a
 * flat price per picture, since nothing local counts tokens the provider's way;
 * the last round's real count and its cached share sit beside it.
 */
import type { PricedModel } from '~/composables/useModels'
import type { Ending, Tool } from '~/utils/agent/loop'
import type { Part, ToolCall, Turn } from '~/utils/agent/messages'

import { asksFirst, forSending, MAX_CALLS, offered, runLoop } from '~/utils/agent/loop'
import { CHAPTER_TRANSLATE, chapterLetter, PLAYBOOK_TOOL, readPlaybook, SYSTEM_PROMPT, unlisted, withheld, withTopic } from '~/utils/agent/prompt'
import { idb } from '~/utils/idb'
import { send } from '~/utils/openrouter'

/** What the reader is being asked: may this call run? */
export interface Approval {
  call: ToolCall
  tool: Tool
  answer: (allowed: boolean, always?: boolean) => void
}

type UserTurn = Extract<Turn, { role: 'user' }>

/** What one conversation has cost, where the provider said. */
interface Spent { input: number, output: number, cached: number, cost: number, unknown: boolean }

/** One conversation, as kept and as listed. */
export interface Conversation {
  id: string
  /** The reader's first words, or the chapter run it was. */
  title: string
  /** When it was last added to. */
  at: number
  turns: Turn[]
  spent: Spent
  /** Where what the model is sent begins — see `since` in `loop.ts`. */
  since: number
}

/** How many conversations a chapter keeps. */
const KEPT = 30

/** Characters to a token, for the estimate — see "Spend, and what it is spent on". */
const PER_TOKEN = 4

/** What a picture is reckoned at in the estimate: a lettering crop at the size the relay sends it. */
const PER_PICTURE = 1_500

const nothingSpent = (): Spent => ({ input: 0, output: 0, cached: 0, cost: 0, unknown: false })
const fresh = (): Conversation => ({ id: crypto.randomUUID(), title: '', at: Date.now(), turns: [], spent: nothingSpent(), since: 0 })

const current = ref<Conversation>(fresh())
/** Kept conversations of the chapter open here, newest first — without the one open. */
const kept = ref<Conversation[]>([])
/** Which chapter `kept` is of. */
let keptFor = ''

const busy = ref(false)
const problem = ref<string | null>(null)
/** Said while a provider has asked for a wait — see `RateGate` in `openrouter.ts`. */
const waiting = ref<number | null>(null)
const asking = ref<Approval | null>(null)
const running = ref<ToolCall | null>(null)
/** The model chosen here, or null to follow the Translate panel's. */
const chosen = ref<string | null>(null)
/** The last round's real count, for the context breakdown. */
const lastRound = ref<{ input: number, cached: number } | null>(null)
/** Tools the reader has said yes to for the rest of this conversation. */
const always = new Set<string>()

/** One step of a chapter run, as the panel shows it. `clean` is a page passed over with nothing flagged. */
export interface RunStep {
  key: string
  label: string
  status: 'pending' | 'running' | 'done' | 'clean' | 'short'
  note?: string
}

/**
 * The chapter run's plan: its steps and where each stands, kept once the run
 * ends so the reader can see what was done and what was passed over, until a
 * new chat or another run.
 */
const plan = ref<{ title: string, steps: RunStep[] } | null>(null)

/** The server's tools, as `tools/list` gave them — once per tab. */
const tools = shallowRef<Tool[] | null>(null)
let stopping: AbortController | null = null

/** How much the model thinks before each round's calls — see "Thinking". */
export type AssistantThinking = 'none' | 'low' | 'medium' | 'high'

export const ASSISTANT_THINKING: AssistantThinking[] = ['none', 'low', 'medium', 'high']

const THINKING_STORE = 'kemolate:assistant-thinking'
const thinking = ref<AssistantThinking>('low')
let thinkingWired = false

/** What a chapter run does: translate then letter, or one of the two. */
export type ChapterRun = 'all' | 'translate' | 'letter'

/** The calls one page's lettering may take in a chapter run: a page that needs more wants the reader's eye. */
const PAGE_CALLS = 20

const bridge = () => (typeof window === 'undefined' ? null : window.kemolate?.assistant ?? null)

/** The running message's Stop — only asked for inside `busyWith`, which made it. */
function signal (): AbortSignal {
  if (!stopping) throw new Error('Nothing is running.')

  return stopping.signal
}

type Bridge = NonNullable<ReturnType<typeof bridge>>

const storeKey = (workspaceId: string) => `assistant:${workspaceId}`

const PICTURE_KEPT_OUT: Part = { type: 'text', text: '[A picture was shown here; pictures are not kept with a saved conversation.]' }
const bare = (parts: Part[]) => parts.map((part) => (part.type === 'image' ? PICTURE_KEPT_OUT : part))

/** A conversation as it is stored: its pictures out, and nothing reactive. */
function forKeeping (conversation: Conversation): Conversation {
  return {
    ...toRaw(conversation),
    spent: { ...conversation.spent },
    turns: toRaw(conversation.turns).map((turn) => {
      if (turn.role === 'tool') return { ...turn, results: turn.results.map((result) => ({ ...result, content: bare(result.content) })) }
      if (turn.role === 'user' && turn.parts) return { ...turn, parts: bare(turn.parts) }

      return turn
    }),
  }
}

/** The title a conversation is listed under: its first message, cut short. */
function titleOf (turns: Turn[]): string {
  const first = turns.find((turn): turn is UserTurn => turn.role === 'user')?.text.trim() ?? ''
  const line = first.split('\n')[0] ?? ''

  return line.length > 60 ? `${line.slice(0, 57)}…` : line
}

export function useAssistant () {
  const { page, translate } = useComic()
  const { models, byId } = useModels()
  const { require } = useProviderKeys()
  const { record } = useAiUsage()
  const route = useRoute()

  const workspaceId = computed(() => String(route.params.workspaceId ?? ''))

  // Restored after hydration and written on change, as the brush's settings are (`usePaintSettings`).
  if (import.meta.client && !thinkingWired) {
    thinkingWired = true

    onNuxtReady(() => {
      try {
        const held = localStorage.getItem(THINKING_STORE)

        if (ASSISTANT_THINKING.includes(held as AssistantThinking)) thinking.value = held as AssistantThinking
      } catch {
        // No storage, or a broken entry: Low, and the next change rewrites it.
      }

      watch(thinking, (value) => {
        try {
          localStorage.setItem(THINKING_STORE, value)
        } catch {
          // Kept for this session only.
        }
      })
    })
  }

  /** Every model the assistant can drive. */
  const usable = computed(() => models.value.filter((model) => model.tools !== false))

  const model = computed<PricedModel>(() => {
    const picked = byId(chosen.value ?? translate.value.model)

    return picked.tools === false ? (usable.value[0] ?? picked) : picked
  })

  /** Why the assistant cannot be used here at all, or null. */
  const unavailable = computed(() => (bridge() ? null : 'The assistant needs the Kemolate desktop app.'))

  const turns = computed(() => current.value.turns)
  const spent = computed(() => current.value.spent)

  /** This chapter's kept conversations, read once per chapter. */
  async function loadKept () {
    const id = workspaceId.value

    if (!id || keptFor === id) return

    keptFor = id
    const stored = await idb.get<Conversation[]>(storeKey(id)).catch(() => undefined)

    if (keptFor === id) kept.value = (stored ?? []).filter((one) => one.id !== current.value.id)
  }

  /** The open conversation written into the chapter's list, newest first. An empty one is not kept. */
  async function keep () {
    const id = workspaceId.value

    if (!id) return

    await loadKept()

    const open = current.value
    const others = kept.value.filter((one) => one.id !== open.id)
    const all = open.turns.length ? [forKeeping(open), ...others] : others

    await idb.set(storeKey(id), all.slice(0, KEPT)).catch(() => {})
  }

  if (import.meta.client) watch(workspaceId, () => { loadKept().catch(() => {}) }, { immediate: true })

  function approve (call: ToolCall, tool: Tool): Promise<boolean> {
    if (always.has(tool.name)) return Promise.resolve(true)

    return new Promise((resolve) => {
      asking.value = {
        call,
        tool,
        answer: (allowed, keep) => {
          if (allowed && keep) always.add(tool.name)

          asking.value = null
          resolve(allowed)
        },
      }

      // Stopped while asking is a no, and the question goes away.
      stopping?.signal.addEventListener('abort', () => {
        if (asking.value?.call.id !== call.id) return

        asking.value = null
        resolve(false)
      }, { once: true })
    })
  }

  /** What the model is offered this turn of the open conversation, as the loop works it out. */
  function offeredNow (): Tool[] {
    const all = [...offered(tools.value ?? [], model.value), PLAYBOOK_TOOL]
    const hidden = unlisted(current.value.turns.slice(current.value.since))

    return all.filter((tool) => !hidden.has(tool.name))
  }

  /**
   * One message and the run it leads to. `fresh` starts a conversation of its
   * own after whatever the panel already shows — see `since` in `loop.ts`.
   */
  async function round (tab: Bridge, key: string, message: string | UserTurn, options: { fresh?: boolean, maxCalls?: number } = {}): Promise<Ending> {
    const using = model.value
    const open = current.value

    if (options.fresh) open.since = open.turns.length

    open.turns.push(typeof message === 'string' ? { role: 'user', text: message } : message)
    open.title ||= titleOf(open.turns)
    open.at = Date.now()
    tools.value ??= await tab.tools()

    try {
      return await runLoop({
        model: using,
        system: SYSTEM_PROMPT,
        local: [{ tool: PLAYBOOK_TOOL, run: readPlaybook }],
        withheld,
        unlisted,
        tools: tools.value,
        turns: open.turns,
        since: open.since,
        maxCalls: options.maxCalls,
        effort: thinking.value,
        signal: signal(),
        ask: (body, sending) => send(key, using, body, sending),
        call: (name, args) => tab.call(name, toRaw(args)),
        approve,
        spent: (usage) => {
          open.spent = {
            input: open.spent.input + usage.input,
            output: open.spent.output + usage.output,
            cached: open.spent.cached + (usage.cached ?? 0),
            cost: open.spent.cost + (usage.cost ?? 0),
            unknown: open.spent.unknown || usage.cost === null,
          }
          lastRound.value = { input: usage.input, cached: usage.cached ?? 0 }

          const here = page.value

          record({
            at: Date.now(),
            pageId: here?.id ?? '',
            page: here?.name ?? 'No page',
            model: using.label,
            what: 'assistant',
            input: usage.input,
            output: usage.output,
            reasoning: usage.reasoning,
            cost: usage.cost,
          }).catch(() => {})
        },
        retrying: (wait) => {
          waiting.value = wait
          setTimeout(() => { waiting.value = null }, wait)
        },
        running: (call) => { running.value = call },
      })
    } finally {
      open.at = Date.now()
      keep().catch(() => {})
    }
  }

  /** Busy for the length of `work`, whose failure is said in the panel rather than thrown. */
  async function busyWith (work: (tab: Bridge, key: string) => Promise<void>) {
    const tab = bridge()

    if (busy.value || !tab) return

    problem.value = null
    busy.value = true
    stopping = new AbortController()

    try {
      await work(tab, await require('openrouter', model.value))
    } catch (error) {
      problem.value = stopping.signal.aborted ? null : error instanceof Error ? error.message : String(error)
    } finally {
      busy.value = false
      running.value = null
      asking.value = null
      stopping = null
    }
  }

  function ended (ending: Ending, maxCalls = MAX_CALLS): string | null {
    if (ending === 'out-of-calls') return `Stopped after ${maxCalls} tool calls for one message. Say "carry on" to let it continue.`
    if (ending === 'cut-off') return `${model.value.label}'s answer was cut off at its token limit.`

    return null
  }

  function say (text: string) {
    const said = text.trim()

    if (!said) return Promise.resolve()

    return busyWith(async (tab, key) => {
      problem.value = ended(await round(tab, key, said))
    })
  }

  /**
   * One page's lettering, looked at before the model is asked: `review_lettering`
   * run here, and the page passed over if nothing on it is flagged — most pages
   * of a chapter lettered by Kemolate need nothing, and asking a model to find
   * that out cost a review and a turn or two each (2026-11-06).
   */
  async function reviewed (tab: Bridge, pageId: number): Promise<{ flagged: number, parts: Part[] } | { error: string }> {
    const answer = await tab.call('review_lettering', { pageId })
    const text = answer.content.find((part) => part.type === 'text')?.text ?? ''

    if (answer.isError) return { error: text || 'the review failed' }

    const flagged = Number((JSON.parse(text || '{}') as { flagged?: number }).flagged ?? 0)

    return {
      flagged,
      parts: [
        { type: 'text', text: `# \`review_lettering\` for this page, run just now\n\n${text}` },
        ...answer.content.filter((part) => part.type === 'image'),
      ],
    }
  }

  /**
   * The chapter, in the shape that keeps it cheap: its translation as one
   * conversation in batches of twenty pages, then each translated page's
   * lettering as a conversation of its own. One conversation for the lot ran
   * out of calls by the second page and resent every page's work on every
   * turn after it. A page that runs out of calls is said and passed, not the
   * end of the run; Stop is.
   */
  function chapter (what: ChapterRun) {
    return busyWith(async (tab, key) => {
      const steps: RunStep[] = what === 'letter' ? [] : [{ key: 'translate', label: 'Translate the pages that need it', status: 'running' }]
      const mark = (step: RunStep | undefined, status: RunStep['status'], note?: string) => {
        if (!step) return

        step.status = status
        if (note) step.note = note
        plan.value = { title: plan.value?.title ?? '', steps: [...steps] }
      }

      plan.value = { title: what === 'translate' ? 'Translating the chapter' : what === 'letter' ? 'Lettering the chapter' : 'Translating and lettering the chapter', steps: [...steps] }

      if (what !== 'letter') {
        const ending = await round(tab, key, withTopic(CHAPTER_TRANSLATE, 'translating'), { fresh: true })

        problem.value = ended(ending)
        mark(steps[0], ending === 'answered' ? 'done' : 'short')
      }

      if (what === 'translate') return

      const listed = await tab.call('list_pages', {})
      const text = listed.content.find((part) => part.type === 'text')
      const pages = (JSON.parse(text?.type === 'text' ? text.text : '{}') as { pages?: { pageId: number, name: string, translated: number }[] }).pages ?? []
      const lettered = pages.filter((page) => page.translated > 0)

      steps.push(...lettered.map((page): RunStep => ({ key: `page-${page.pageId}`, label: `Letter ${page.name}`, status: 'pending' })))
      plan.value = { title: plan.value?.title ?? '', steps: [...steps] }

      for (const page of lettered) {
        signal().throwIfAborted()

        const step = steps.find((one) => one.key === `page-${page.pageId}`)

        mark(step, 'running', 'checking')

        const review = await reviewed(tab, page.pageId)

        if ('error' in review) {
          mark(step, 'short', review.error)
          continue
        }

        if (!review.flagged) {
          mark(step, 'clean', 'nothing flagged')
          continue
        }

        mark(step, 'running', `${review.flagged} flagged`)

        const message: UserTurn = { ...withTopic(chapterLetter(page), 'lettering'), parts: review.parts }
        const ending = await round(tab, key, message, { fresh: true, maxCalls: PAGE_CALLS })

        mark(step, ending === 'answered' ? 'done' : 'short', ending === 'answered' ? undefined : 'not finished')
      }

      const short = steps.filter((step) => step.key.startsWith('page-') && step.status === 'short').map((step) => step.label.replace(/^Letter /, ''))

      if (!lettered.length) problem.value = 'No page has a translation to letter yet.'
      else if (short.length) problem.value = `Not finished on ${short.join(', ')} — open the page and ask the assistant to carry on.`
    })
  }

  function stop () {
    stopping?.abort(new DOMException('Stopped.', 'AbortError'))
  }

  /** Put the open conversation away, keeping it, and start another. */
  async function newChat () {
    if (busy.value) return

    await keep()

    if (current.value.turns.length) kept.value = [forKeeping(current.value), ...kept.value.filter((one) => one.id !== current.value.id)].slice(0, KEPT)

    current.value = fresh()
    problem.value = null
    lastRound.value = null
    plan.value = null
    always.clear()
  }

  /** Carry on a kept conversation, putting the open one away first. */
  async function open (id: string) {
    const wanted = kept.value.find((one) => one.id === id)

    if (busy.value || !wanted) return

    await newChat()
    kept.value = kept.value.filter((one) => one.id !== id)
    current.value = { ...wanted, turns: [...wanted.turns], spent: { ...wanted.spent } }
  }

  /** Delete a kept conversation, or the open one. */
  async function forget (id: string) {
    if (current.value.id === id) {
      if (busy.value) return

      current.value = fresh()
      problem.value = null
      lastRound.value = null
      plan.value = null
      always.clear()
    }

    kept.value = kept.value.filter((one) => one.id !== id)
    await keep()
  }

  /**
   * What the next round would send — see "Spend, and what it is spent on". The
   * conversation as `forSending` will send it, so an old picture counts as the
   * line that replaced it.
   */
  const context = computed(() => {
    const est = (text: string) => Math.ceil(text.length / PER_TOKEN)
    const sending = forSending(current.value.turns.slice(current.value.since), model.value)
    const parts = { reader: 0, assistant: 0, results: 0, pictures: 0 }
    let pictures = 0

    const count = (content: Part[], into: 'reader' | 'results') => {
      for (const part of content) {
        if (part.type === 'image') {
          parts.pictures += PER_PICTURE
          pictures += 1
        } else {
          parts[into] += est(part.text)
        }
      }
    }

    for (const turn of sending) {
      if (turn.role === 'user') {
        parts.reader += est(turn.text)
        count(turn.parts ?? [], 'reader')
      } else if (turn.role === 'assistant') {
        parts.assistant += est(turn.text) + turn.calls.reduce((sum, call) => sum + est(call.name) + est(JSON.stringify(call.arguments)), 0)
      } else {
        for (const result of turn.results) count(result.content, 'results')
      }
    }

    const toolList = tools.value ? est(JSON.stringify(offeredNow().map(({ name, description, inputSchema }) => ({ name, description, inputSchema })))) : null
    const rows = [
      { key: 'system', label: 'Instructions and playbook', tokens: est(SYSTEM_PROMPT) },
      { key: 'tools', label: 'Tool list', tokens: toolList ?? 0, unknown: toolList === null },
      { key: 'reader', label: 'Your messages', tokens: parts.reader },
      { key: 'assistant', label: 'Its replies and calls', tokens: parts.assistant },
      { key: 'results', label: 'Tool answers', tokens: parts.results },
      { key: 'pictures', label: pictures === 1 ? '1 picture' : `${pictures} pictures`, tokens: parts.pictures },
    ]

    return {
      rows,
      total: rows.reduce((sum, row) => sum + row.tokens, 0),
      last: lastRound.value,
      turns: sending.length,
    }
  })

  return {
    turns,
    busy,
    problem,
    waiting,
    asking,
    running,
    spent,
    chosen,
    thinking,
    model,
    usable,
    unavailable,
    asksFirst,
    plan,
    current,
    kept,
    context,
    say,
    chapter,
    stop,
    newChat,
    open,
    forget,
  }
}
