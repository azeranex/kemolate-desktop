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
import type { Tool } from '~/utils/agent/loop'
import type { ToolCall, Turn } from '~/utils/agent/messages'

import { asksFirst, runLoop } from '~/utils/agent/loop'
import { SYSTEM_PROMPT } from '~/utils/agent/prompt'
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
const spent = ref({ input: 0, output: 0, cost: 0, unknown: false })
/** Tools the reader has said yes to for the rest of this conversation. */
const always = new Set<string>()

let tools: Tool[] | null = null
let stopping: AbortController | null = null

const bridge = () => (typeof window === 'undefined' ? null : window.kemolate?.assistant ?? null)

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

  async function say (text: string) {
    const said = text.trim()
    const tab = bridge()

    if (!said || busy.value || !tab) return

    problem.value = null
    busy.value = true
    stopping = new AbortController()
    turns.value.push({ role: 'user', text: said })

    const using = model.value

    try {
      const key = await require('openrouter', using)

      tools ??= await tab.tools()

      const ending = await runLoop({
        model: using,
        system: SYSTEM_PROMPT,
        tools,
        turns: turns.value,
        effort: REASONING_FOR[translate.value.effort],
        signal: stopping.signal,
        ask: (body, options) => send(key, using, body, options),
        call: (name, args) => tab.call(name, toRaw(args)),
        approve,
        spent: (usage) => {
          spent.value = {
            input: spent.value.input + usage.input,
            output: spent.value.output + usage.output,
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

      if (ending === 'out-of-calls') problem.value = 'Stopped after 40 tool calls for one message. Say "carry on" to let it continue.'
      if (ending === 'cut-off') problem.value = `${using.label}'s answer was cut off at its token limit.`
    } catch (error) {
      problem.value = stopping.signal.aborted ? null : error instanceof Error ? error.message : String(error)
    } finally {
      busy.value = false
      running.value = null
      asking.value = null
      stopping = null
    }
  }

  function stop () {
    stopping?.abort(new DOMException('Stopped.', 'AbortError'))
  }

  /** Start again: the conversation, its permissions and its tally. */
  function clear () {
    stop()
    turns.value = []
    problem.value = null
    spent.value = { input: 0, output: 0, cost: 0, unknown: false }
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
    say,
    stop,
    clear,
  }
}
