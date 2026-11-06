<script setup lang="ts">
/**
 * The assistant, as the reader talks to it.
 *
 * A model on the reader's own key, working on the chapter through the same
 * tools an agent reaching Kemolate over MCP has — see `useAssistant` for the
 * conversation and `app/utils/agent/loop.ts` for the run. This panel is the
 * conversation, the question when a call wants the reader's yes, and the
 * running bill.
 *
 * New chat puts the open conversation away and keeps it; the clock lists the
 * chapter's kept ones to open again. The line under the input is what this
 * conversation has cost, and opens what the next round will send.
 *
 * What the assistant changes, the page shows as it changes — the tools write
 * through the same services as everything else, and their change notices
 * reach this tab as an agent's always have. So nothing here refreshes
 * anything.
 */
import { BookOpenIcon, HistoryIcon, SendIcon, SquareIcon, SquarePenIcon, Trash2Icon } from '@lucide/vue'

import type { ToolResult, Turn } from '~/utils/agent/messages'

const {
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
  progress,
  kept,
  context,
  say,
  chapter,
  stop,
  newChat,
  open,
  forget,
} = useAssistant()

/** Whether the context breakdown is open. */
const showContext = ref(false)

/** Long enough ago to be worth a date; before that, how long ago — as the Text panel says it. */
function when (at: number) {
  const ago = Date.now() - at

  if (ago < 60_000) return 'just now'
  if (ago < 3_600_000) return `${Math.round(ago / 60_000)}m ago`
  if (ago < 86_400_000) return `${Math.round(ago / 3_600_000)}h ago`

  return new Date(at).toLocaleDateString()
}

const approx = (count: number) => count >= 1000 ? `${(count / 1000).toFixed(count >= 10_000 ? 0 : 1)}k` : String(count)

const money = (cost: number) => `$${cost.toFixed(cost < 0.1 ? 4 : 2)}`

const draft = ref('')

/** The conversation as it is drawn: each model turn with the answers to its calls beside them. */
const shown = computed(() => {
  const answers = new Map<string, ToolResult>()

  for (const turn of turns.value) {
    if (turn.role === 'tool') for (const result of turn.results) answers.set(result.callId, result)
  }

  return turns.value
    .map((turn, index) => ({ turn, index }))
    .filter((entry): entry is { turn: Exclude<Turn, { role: 'tool' }>, index: number } => entry.turn.role !== 'tool')
    .map(({ turn, index }) => ({ turn, index, answers }))
})

function submit () {
  const text = draft.value

  if (!text.trim() || busy.value) return

  draft.value = ''
  say(text)
}

function keydown (event: KeyboardEvent) {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return

  event.preventDefault()
  submit()
}

const cost = computed(() => {
  if (!spent.value.input && !spent.value.output) return ''

  // Cached tokens said apart: they are most of a long run, and billed at a tenth.
  const cached = spent.value.cached ? ` (${spent.value.cached.toLocaleString('en')} cached)` : ''
  const tokens = `${(spent.value.input + spent.value.output).toLocaleString('en')} tokens${cached}`

  return spent.value.unknown && !spent.value.cost ? tokens : `${tokens} · ${money(spent.value.cost)}`
})

/** Scrolled to the newest turn as the conversation grows. */
const list = ref<HTMLElement | null>(null)

watch(() => [turns.value.length, asking.value, running.value], async () => {
  await nextTick()
  list.value?.scrollTo({ top: list.value.scrollHeight })
}, { deep: false })
</script>

<template>
  <UFieldGroup density="panel">
    <p v-if="unavailable" class="text-muted-foreground py-1 text-xs">
      {{ unavailable }}
    </p>

    <template v-else>
      <div class="flex min-w-0 items-center gap-1">
        <USelect :model-value="model.id" @update:model-value="(id) => { chosen = String(id) }">
          <USelectTrigger size="sm" class="min-w-0 flex-1">
            <USelectValue />
          </USelectTrigger>
          <USelectContent position="popper" class="w-(--reka-select-trigger-width)">
            <USelectItem v-for="option in usable" :key="option.id" :value="option.id">
              {{ option.label }}
            </USelectItem>
          </USelectContent>
        </USelect>
        <UDropdownMenu>
          <UDropdownMenuTrigger as-child>
            <UButton variant="ghost" size="icon-sm" :disabled="busy" aria-label="Do the whole chapter" title="Do the whole chapter">
              <BookOpenIcon class="size-3.5" />
            </UButton>
          </UDropdownMenuTrigger>
          <UDropdownMenuContent align="end">
            <UDropdownMenuItem @click="chapter('all')">
              Translate and letter the chapter
            </UDropdownMenuItem>
            <UDropdownMenuItem @click="chapter('translate')">
              Translate the chapter
            </UDropdownMenuItem>
            <UDropdownMenuItem @click="chapter('letter')">
              Review the chapter's lettering
            </UDropdownMenuItem>
          </UDropdownMenuContent>
        </UDropdownMenu>
        <UDropdownMenu>
          <UDropdownMenuTrigger as-child>
            <UButton variant="ghost" size="icon-sm" :disabled="busy || !kept.length" aria-label="Earlier conversations" title="Earlier conversations">
              <HistoryIcon class="size-3.5" />
            </UButton>
          </UDropdownMenuTrigger>
          <UDropdownMenuContent align="end" class="max-h-80 w-72 overflow-y-auto">
            <UDropdownMenuLabel class="text-muted-foreground text-[11px] font-normal">
              This chapter's conversations, kept without their pictures
            </UDropdownMenuLabel>
            <UDropdownMenuItem v-for="one in kept" :key="one.id" class="min-w-0 gap-2" @click="open(one.id)">
              <span class="grid min-w-0 flex-1">
                <span class="truncate text-xs">{{ one.title || 'Untitled' }}</span>
                <span class="text-muted-foreground text-[10px]">
                  {{ when(one.at) }}<template v-if="one.spent.cost"> · {{ money(one.spent.cost) }}</template>
                </span>
              </span>
              <UButton
                variant="ghost"
                size="icon-sm"
                class="shrink-0"
                aria-label="Delete this conversation"
                title="Delete this conversation"
                @click.stop="forget(one.id)"
              >
                <Trash2Icon class="size-3" />
              </UButton>
            </UDropdownMenuItem>
          </UDropdownMenuContent>
        </UDropdownMenu>
        <UButton
          variant="ghost"
          size="icon-sm"
          :disabled="busy || !turns.length"
          aria-label="New chat"
          title="New chat — this one is kept"
          @click="newChat"
        >
          <SquarePenIcon class="size-3.5" />
        </UButton>
      </div>

      <div ref="list" class="grid max-h-[60vh] min-w-0 gap-2 overflow-y-auto">
        <p
          v-if="!turns.length"
          class="text-muted-foreground border-border rounded-md border border-dashed px-3 py-4 text-center text-[11px]"
        >
          Ask about this chapter, or for work on it — "check the reading on this page", "fix the lettering
          that does not fit", "translate the pages that are left". It works through Kemolate's own tools, on your key.
          Conversations are kept for this chapter, without their pictures.
        </p>

        <template v-for="{ turn, index, answers } in shown" :key="index">
          <p
            v-if="turn.role === 'user'"
            class="bg-accent text-accent-foreground ml-6 min-w-0 rounded-md px-2 py-1.5 text-xs wrap-break-word whitespace-pre-wrap"
          >
            {{ turn.text }}
          </p>

          <div v-else class="grid min-w-0 gap-1">
            <p v-if="turn.text" class="min-w-0 text-xs wrap-break-word whitespace-pre-wrap">
              {{ turn.text }}
            </p>
            <PanelAssistantToolRow
              v-for="call in turn.calls"
              :key="call.id"
              :call="call"
              :result="answers.get(call.id)"
              :live="running?.id === call.id"
            />
          </div>
        </template>

        <div v-if="asking" class="border-primary/50 bg-primary/5 grid min-w-0 gap-1.5 rounded-md border p-2 text-xs">
          <p class="min-w-0">
            The assistant wants to run <span class="font-mono">{{ asking.call.name }}</span>, which changes the page in a way
            that is hard to take back.
          </p>
          <pre class="text-muted-foreground max-h-32 min-w-0 overflow-auto font-mono text-[10px] whitespace-pre-wrap">{{ JSON.stringify(asking.call.arguments, null, 2) }}</pre>
          <div class="flex flex-wrap gap-1">
            <UButton size="sm" @click="asking.answer(true)">
              Allow
            </UButton>
            <UButton size="sm" variant="outline" @click="asking.answer(true, true)">
              Allow for this conversation
            </UButton>
            <UButton size="sm" variant="ghost" @click="asking.answer(false)">
              Deny
            </UButton>
          </div>
        </div>

        <p v-if="busy && !asking && !running" class="text-muted-foreground text-[11px]">
          {{ waiting ? `${model.label} asked for a wait — trying again in ${Math.ceil(waiting / 1000)} s…` : 'Thinking…' }}
        </p>

        <p v-if="progress" class="text-muted-foreground text-[11px]">
          {{ progress }} — each page is a conversation of its own, so one page's work is not sent again with the next.
        </p>

        <p v-if="problem" class="text-destructive min-w-0 text-[11px] wrap-break-word">
          {{ problem }}
        </p>
      </div>

      <div class="flex min-w-0 items-end gap-1">
        <UTextarea
          v-model="draft"
          rows="2"
          class="max-h-40 min-h-14 min-w-0 flex-1 resize-none text-xs"
          placeholder="Ask the assistant…"
          aria-label="Message to the assistant"
          @keydown="keydown"
        />
        <UButton
          v-if="busy"
          size="icon-sm"
          variant="outline"
          aria-label="Stop"
          title="Stop"
          @click="stop"
        >
          <SquareIcon class="size-3.5" />
        </UButton>
        <UButton
          v-else
          size="icon-sm"
          :disabled="!draft.trim()"
          aria-label="Send"
          title="Send (Enter)"
          @click="submit"
        >
          <SendIcon class="size-3.5" />
        </UButton>
      </div>

      <button
        v-if="turns.length"
        type="button"
        class="text-muted-foreground hover:text-foreground min-w-0 text-left text-[10px]"
        :aria-expanded="showContext"
        @click="showContext = !showContext"
      >
        <template v-if="cost">
          This conversation: {{ cost }} ·
        </template>
        Next round ≈ {{ approx(context.total) }} tokens {{ showContext ? '▾' : '▸' }}
      </button>

      <div v-if="showContext && turns.length" class="border-border grid min-w-0 gap-1.5 rounded-md border p-2 text-[10px]">
        <div class="bg-muted flex h-1.5 min-w-0 overflow-hidden rounded-full" aria-hidden="true">
          <div
            v-for="row in context.rows"
            :key="row.key"
            class="h-full"
            :class="{
              'bg-chart-1': row.key === 'system',
              'bg-chart-2': row.key === 'tools',
              'bg-chart-3': row.key === 'reader',
              'bg-chart-4': row.key === 'assistant',
              'bg-chart-5': row.key === 'results',
              'bg-primary': row.key === 'pictures',
            }"
            :style="{ width: `${context.total ? (row.tokens / context.total) * 100 : 0}%` }"
          />
        </div>
        <div v-for="row in context.rows" :key="row.key" class="flex min-w-0 items-center gap-1.5">
          <span
            class="size-2 shrink-0 rounded-full"
            :class="{
              'bg-chart-1': row.key === 'system',
              'bg-chart-2': row.key === 'tools',
              'bg-chart-3': row.key === 'reader',
              'bg-chart-4': row.key === 'assistant',
              'bg-chart-5': row.key === 'results',
              'bg-primary': row.key === 'pictures',
            }"
          />
          <span class="min-w-0 flex-1 truncate">{{ row.label }}</span>
          <span class="text-muted-foreground tabular-nums">{{ 'unknown' in row && row.unknown ? '—' : `≈ ${approx(row.tokens)}` }}</span>
        </div>
        <p class="text-muted-foreground">
          Estimated at four characters a token. Everything but the newest turn is normally read from the provider's cache, at
          a tenth of the price.
          <template v-if="context.last">
            The last round sent {{ context.last.input.toLocaleString('en') }} tokens, {{ context.last.cached.toLocaleString('en') }} of
            them from the cache.
          </template>
        </p>
      </div>
    </template>
  </UFieldGroup>
</template>
