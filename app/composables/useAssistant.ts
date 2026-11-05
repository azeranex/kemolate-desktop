/**
 * The assistant: a conversation with a model on the reader's own key, which
 * works on the chapter through Kemolate's MCP tools — desktop only.
 *
 * What a run does is `app/utils/agent/loop.ts`, and what it may do is the MCP
 * server's (`electron/assistant.ts`). This composable is the part the panel
 * holds: the conversation, the model, the key, the Stop, the question the
 * reader is being asked, and the bill.
 *
 * ## One conversation per tab, in memory
 *
 * Module state, so the panel can be closed and opened again, or moved to
 * another column, without losing the conversation — and since a tab is its own
 * page, each tab has its own. It does not outlive a reload, and the panel says
 * so; keeping it would mean deciding what a conversation about a page that has
 * since been re-read is worth, which is a later question.
 *
 * ## The model
 *
 * The Translate panel's until the reader picks another here, because that is
 * the model whose key they have already shown they hold. Only models that can
 * call tools are offered (`AiModel.tools`). A model that cannot see is
 * allowed — most of the work is text — and is told when a tool's picture was
 * kept from it.
 *
 * ## Spend
 *
 * Every provider round is a row on the AI ledger, `what: 'assistant'`, filed
 * under the page on screen — like a region's, so a table of a chapter's costs
 * says what the assistant cost beside what its pages did.
 */
import type { PricedModel } from '~/composables/useModels'
import type { Ending, Tool } from '~/utils/agent/loop'
import type { ToolCall, Turn } from '~/utils/agent/messages'

import { asksFirst, MAX_CALLS, runLoop } from '~/utils/agent/loop'
import { CHAPTER_TRANSLATE, chapterLetter, PLAYBOOK_TOOL, readPlaybook, SYSTEM_PROMPT, withheld } from '~/utils/agent/prompt'
import { send } from '~/utils/openrouter'

/** What the reader is being asked: may this call run? */
export interface Approval {
  call: ToolCall
  tool: Tool
  answer: (allowed: boolean, always?: boolean) => void
}

const turns = ref<Turn[]>([])
const busy = ref(false)
const problem = ref<string | null>(null)
/** Said while a provider has asked for a wait — see `RateGate` in `openrouter.ts`. */
const waiting = ref<number | null>(null)
const asking = ref<Approval | null>(null)
const running = ref<ToolCall | null>(null)
/** The model chosen here, or null to follow the Translate panel's. */
const chosen = ref<string | null>(null)
/** This conversation's spend so far, where the provider said. */
const spent = ref({ input: 0, output: 0, cached: 0, cost: 0, unknown: false })
/** Tools the reader has said yes to for the rest of this conversation. */
const always = new Set<string>()

/** Which step of a chapter run is going, for the panel. */
const progress = ref<string | null>(null)

let tools: Tool[] | null = null
let stopping: AbortController | null = null
/** Where the conversation the model is sent begins — see `since` in `loop.ts`. */
let since = 0

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

export function useAssistant () {
  const { page, translate } = useComic()
  const { models, byId } = useModels()
  const { require } = useProviderKeys()
  const { record } = useAiUsage()

  /** Every model the assistant can drive. */
  const usable = computed(() => models.value.filter((model) => model.tools !== false))

  const model = computed<PricedModel>(() => {
    const picked = byId(chosen.value ?? translate.value.model)

    return picked.tools === false ? (usable.value[0] ?? picked) : picked
  })

  /** Why the assistant cannot be used here at all, or null. */
  const unavailable = computed(() => (bridge() ? null : 'The assistant needs the Kemolate desktop app.'))

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

  /**
   * One message and the run it leads to. `fresh` starts a conversation of its
   * own after whatever the panel already shows — see `since` in `loop.ts`.
   */
  async function round (tab: Bridge, key: string, text: string, options: { fresh?: boolean, maxCalls?: number } = {}): Promise<Ending> {
    const using = model.value

    if (options.fresh) since = turns.value.length

    turns.value.push({ role: 'user', text })
    tools ??= await tab.tools()

    return runLoop({
      model: using,
      system: SYSTEM_PROMPT,
      local: [{ tool: PLAYBOOK_TOOL, run: readPlaybook }],
      withheld,
      tools,
      turns: turns.value,
      since,
      maxCalls: options.maxCalls,
      effort: REASONING_FOR[translate.value.effort],
      signal: signal(),
      ask: (body, sending) => send(key, using, body, sending),
      call: (name, args) => tab.call(name, toRaw(args)),
      approve,
      spent: (usage) => {
        spent.value = {
          input: spent.value.input + usage.input,
          output: spent.value.output + usage.output,
          cached: spent.value.cached + (usage.cached ?? 0),
          cost: spent.value.cost + (usage.cost ?? 0),
          unknown: spent.value.unknown || usage.cost === null,
        }

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
      progress.value = null
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
   * The chapter, in the shape that keeps it cheap: its translation as one
   * conversation in batches of twenty pages, then each translated page's
   * lettering as a conversation of its own. One conversation for the lot ran
   * out of calls by the second page and resent every page's work on every
   * turn after it. A page that runs out of calls is said and passed, not the
   * end of the run; Stop is.
   */
  function chapter (what: ChapterRun) {
    return busyWith(async (tab, key) => {
      if (what !== 'letter') {
        progress.value = 'Translating the chapter'
        problem.value = ended(await round(tab, key, CHAPTER_TRANSLATE, { fresh: true }))
      }

      if (what === 'translate') return

      const listed = await tab.call('list_pages', {})
      const text = listed.content.find((part) => part.type === 'text')
      const pages = (JSON.parse(text?.type === 'text' ? text.text : '{}') as { pages?: { pageId: number, name: string, translated: number }[] }).pages ?? []
      const lettered = pages.filter((page) => page.translated > 0)
      const short: string[] = []

      for (const [at, page] of lettered.entries()) {
        progress.value = `Lettering page ${at + 1} of ${lettered.length}`

        if (await round(tab, key, chapterLetter(page), { fresh: true, maxCalls: PAGE_CALLS }) !== 'answered') short.push(page.name)
      }

      if (!lettered.length) problem.value = 'No page has a translation to letter yet.'
      else if (short.length) problem.value = `Not finished on ${short.join(', ')} — open the page and ask the assistant to carry on.`
    })
  }

  function stop () {
    stopping?.abort(new DOMException('Stopped.', 'AbortError'))
  }

  /** Start again: the conversation, its permissions and its tally. */
  function clear () {
    stop()
    turns.value = []
    problem.value = null
    spent.value = { input: 0, output: 0, cached: 0, cost: 0, unknown: false }
    since = 0
    always.clear()
    tools = null
  }

  return {
    turns,
    busy,
    problem,
    waiting,
    asking,
    running,
    spent,
    chosen,
    model,
    usable,
    unavailable,
    asksFirst,
    progress,
    say,
    chapter,
    stop,
    clear,
  }
}
