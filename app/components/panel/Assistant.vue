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
 * Built from shadcn-vue's chat pieces, the ones its AI elements are made of:
 * the Message Scroller keeps the newest turn in view without dragging a reader
 * who has scrolled back to read; the reader's words are a Bubble and the
 * model's are a Message; what it thought, each call it made and a chapter
 * run's plan are Trace lines — one line each, shimmering while they run,
 * opened for the whole of it; a call that waits for a yes is an Item. The
 * model and how hard it thinks are chosen in the input's own bar, as the Model
 * Selector element has them, beside what the next round will send.
 *
 * New chat puts the open conversation away and keeps it; the clock lists the
 * chapter's kept ones to open again.
 *
 * What the assistant changes, the page shows as it changes — the tools write
 * through the same services as everything else, and their change notices
 * reach this tab as an agent's always have. So nothing here refreshes
 * anything.
 */
import {
  ArrowUpIcon,
  BookOpenIcon,
  BotIcon,
  BrainIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleMinusIcon,
  GaugeIcon,
  HistoryIcon,
  ListChecksIcon,
  LoaderCircleIcon,
  ShieldAlertIcon,
  SquareIcon,
  SquarePenIcon,
  Trash2Icon,
} from '@lucide/vue'

import type { Component } from 'vue'
import type { AssistantThinking, RunStep } from '~/composables/useAssistant'
import type { ToolResult, Turn } from '~/utils/agent/messages'

import { ASSISTANT_THINKING } from '~/composables/useAssistant'
import { describeCall } from '~/utils/agent/describe'

const {
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
  plan,
  kept,
  context,
  say,
  chapter,
  stop,
  newChat,
  open,
  forget,
} = useAssistant()

const draft = ref('')

/** The thinking setting's words — see "Thinking" in `useAssistant`. */
const THINKING_LABEL: Record<AssistantThinking, { name: string, note: string }> = {
  none: { name: 'Off', note: 'Calls tools straight away' },
  low: { name: 'Low', note: 'A short plan each round' },
  medium: { name: 'Medium', note: 'More for tangled pages' },
  high: { name: 'High', note: 'Most thought, most cost' },
}

function think (value: unknown) {
  if (ASSISTANT_THINKING.includes(value as AssistantThinking)) thinking.value = value as AssistantThinking
}

function pick (id: unknown) {
  if (typeof id === 'string') chosen.value = id
}

/** What to ask when there is nothing yet — each a button that asks it. */
const SUGGESTIONS = [
  'Check the reading on this page',
  'Fix the lettering that does not fit',
  'Translate the pages that are left',
]

type Shown = Exclude<Turn, { role: 'tool' }>

/** The conversation as it is drawn: each model turn with the answers to its calls beside them. */
const shown = computed(() => {
  const answers = new Map<string, ToolResult>()

  for (const turn of turns.value) {
    if (turn.role === 'tool') for (const result of turn.results) answers.set(result.callId, result)
  }

  return turns.value
    .map((turn, index) => ({ turn, index }))
    .filter((entry): entry is { turn: Shown, index: number } => entry.turn.role !== 'tool')
    .map(({ turn, index }) => ({ turn, index, answers }))
})

/**
 * What the reader is shown of a message: a chapter run's is its instruction,
 * not the playbook chapter and the review it carries for the model.
 */
const said = (turn: Extract<Turn, { role: 'user' }>) => (turn.topics?.length ? turn.text.split('\n\n# The playbook')[0]! : turn.text)

/** Whether the model is being waited on — not a tool, not the reader. */
const thinkingNow = computed(() => busy.value && !asking.value && !running.value)

function submit (text = draft.value) {
  if (!text.trim() || busy.value) return

  if (text === draft.value) draft.value = ''
  say(text)
}

function keydown (event: KeyboardEvent) {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return

  event.preventDefault()
  submit()
}

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

const cost = computed(() => {
  if (!spent.value.input && !spent.value.output) return ''

  return spent.value.unknown && !spent.value.cost ? `${approx(spent.value.input + spent.value.output)} tokens` : money(spent.value.cost)
})

/** A context row's colour, the same in the bar and its key. */
const SWATCH: Record<string, string> = {
  system: 'bg-chart-1',
  tools: 'bg-chart-2',
  reader: 'bg-chart-3',
  assistant: 'bg-chart-4',
  results: 'bg-chart-5',
  pictures: 'bg-primary',
}

const STEP_ICON: Record<RunStep['status'], Component> = {
  pending: CircleDashedIcon,
  running: LoaderCircleIcon,
  done: CircleCheckIcon,
  clean: CircleMinusIcon,
  short: CircleAlertIcon,
}

const finished = computed(() => plan.value?.steps.filter((step) => step.status !== 'pending' && step.status !== 'running').length ?? 0)
</script>

<template>
  <UFieldGroup density="panel">
    <p v-if="unavailable" class="text-muted-foreground py-1 text-xs">
      {{ unavailable }}
    </p>

    <template v-else>
      <div class="flex min-w-0 items-center gap-1">
        <span class="text-muted-foreground min-w-0 flex-1 truncate text-[11px]">
          <template v-if="cost">This conversation · {{ cost }}</template>
        </span>
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

      <UTrace v-if="plan" class="border-border rounded-md border px-2.5 py-2">
        <UTraceCollapsible default-open>
          <UTraceCollapsibleTrigger>
            <UTraceLine :status="busy ? 'running' : undefined" class="text-xs">
              <UTraceIcon>
                <ListChecksIcon />
              </UTraceIcon>
              <UTraceTitle>{{ plan.title }}</UTraceTitle>
              <UTraceDescription>{{ finished }} of {{ plan.steps.length }}</UTraceDescription>
            </UTraceLine>
          </UTraceCollapsibleTrigger>
          <UTraceCollapsibleContent>
            <UTrace class="max-h-40 gap-1 overflow-y-auto">
              <UTraceLine
                v-for="step in plan.steps"
                :key="step.key"
                :status="step.status === 'running' ? 'running' : step.status === 'pending' ? 'pending' : step.status === 'short' ? 'error' : undefined"
                class="text-xs"
              >
                <UTraceIcon>
                  <component :is="STEP_ICON[step.status]" :class="step.status === 'running' && 'animate-spin'" />
                </UTraceIcon>
                <UTraceTitle>{{ step.label }}</UTraceTitle>
                <UTraceDescription v-if="step.note">
                  {{ step.note }}
                </UTraceDescription>
              </UTraceLine>
            </UTrace>
          </UTraceCollapsibleContent>
        </UTraceCollapsible>
      </UTrace>

      <UEmpty v-if="!turns.length" class="border-border gap-3 border p-4">
        <UEmptyHeader>
          <UEmptyMedia variant="icon">
            <BotIcon />
          </UEmptyMedia>
          <UEmptyTitle class="text-sm">
            Ask about this chapter
          </UEmptyTitle>
          <UEmptyDescription class="text-[11px]">
            It works through Kemolate's own tools, on your key. Conversations are kept for this chapter, without
            their pictures.
          </UEmptyDescription>
        </UEmptyHeader>
        <UEmptyContent class="gap-1.5">
          <UButton
            v-for="suggestion in SUGGESTIONS"
            :key="suggestion"
            variant="outline"
            size="xs"
            class="max-w-full"
            :disabled="busy"
            @click="submit(suggestion)"
          >
            <span class="truncate">{{ suggestion }}</span>
          </UButton>
        </UEmptyContent>
      </UEmpty>

      <UMessageScrollerProvider v-else auto-scroll>
        <UMessageScroller class="h-[min(60vh,36rem)] min-h-48">
          <UMessageScrollerViewport>
            <UMessageScrollerContent class="gap-4 pb-2" :aria-busy="busy">
              <UMessageScrollerItem
                v-for="{ turn, index, answers } in shown"
                :key="index"
                :message-id="String(index)"
                :scroll-anchor="turn.role === 'user'"
              >
                <UMessage v-if="turn.role === 'user'" align="end">
                  <UMessageContent>
                    <UBubble align="end" :variant="turn.topics?.length ? 'outline' : 'muted'">
                      <UBubbleContent class="px-2.5 py-1.5 text-xs whitespace-pre-wrap">
                        {{ said(turn) }}
                      </UBubbleContent>
                    </UBubble>
                  </UMessageContent>
                </UMessage>

                <UMessage v-else>
                  <UMessageContent class="gap-2">
                    <UTrace v-if="turn.reasoning" class="gap-1.5">
                      <UTraceCollapsible>
                        <UTraceCollapsibleTrigger>
                          <UTraceLine class="text-xs">
                            <UTraceIcon>
                              <BrainIcon />
                            </UTraceIcon>
                            <UTraceTitle>Thought it through</UTraceTitle>
                          </UTraceLine>
                        </UTraceCollapsibleTrigger>
                        <UTraceCollapsibleContent class="text-[11px] whitespace-pre-wrap">
                          {{ turn.reasoning }}
                        </UTraceCollapsibleContent>
                      </UTraceCollapsible>
                    </UTrace>
                    <!-- What it says, then what it did: a turn's words lead into its calls. -->
                    <PanelAssistantMarkdown v-if="turn.text" :text="turn.text" />
                    <UTrace v-if="turn.calls.length" class="gap-1.5">
                      <PanelAssistantToolRow
                        v-for="call in turn.calls"
                        :key="call.id"
                        :call="call"
                        :result="answers.get(call.id)"
                        :live="running?.id === call.id"
                      />
                    </UTrace>
                  </UMessageContent>
                </UMessage>
              </UMessageScrollerItem>

              <UMessageScrollerItem v-if="asking" message-id="asking">
                <UItem variant="outline" size="sm" class="border-primary/50 bg-primary/5">
                  <UItemMedia variant="icon">
                    <ShieldAlertIcon class="text-primary" />
                  </UItemMedia>
                  <UItemContent class="min-w-0">
                    <UItemTitle class="text-xs">
                      {{ describeCall(asking.call).doing }}?
                    </UItemTitle>
                    <UItemDescription class="text-[11px]">
                      <span class="font-mono">{{ asking.call.name }}</span> changes the page in a way that is hard to take back.
                    </UItemDescription>
                  </UItemContent>
                  <UCodeBlock size="sm" class="basis-full">
                    <UCodeBlockContent wrap class="max-h-32 text-[10px]">{{ JSON.stringify(asking.call.arguments, null, 2) }}</UCodeBlockContent>
                  </UCodeBlock>
                  <UItemActions class="basis-full flex-wrap">
                    <UButton size="xs" @click="asking.answer(true)">
                      Allow
                    </UButton>
                    <UButton size="xs" variant="outline" @click="asking.answer(true, true)">
                      Allow for this conversation
                    </UButton>
                    <UButton size="xs" variant="ghost" @click="asking.answer(false)">
                      Deny
                    </UButton>
                  </UItemActions>
                </UItem>
              </UMessageScrollerItem>

              <UMessageScrollerItem v-if="thinkingNow" message-id="thinking">
                <UTraceLine status="running" class="text-xs">
                  <UTraceIcon>
                    <BrainIcon v-if="thinking !== 'none'" />
                    <LoaderCircleIcon v-else class="animate-spin" />
                  </UTraceIcon>
                  <UTraceTitle>
                    {{ waiting ? `${model.label} asked for a wait — trying again in ${Math.ceil(waiting / 1000)} s` : thinking !== 'none' ? 'Thinking' : 'Working' }}
                  </UTraceTitle>
                </UTraceLine>
              </UMessageScrollerItem>

              <UMessageScrollerItem v-if="problem" message-id="problem">
                <p class="text-destructive min-w-0 text-[11px] wrap-break-word">
                  {{ problem }}
                </p>
              </UMessageScrollerItem>
            </UMessageScrollerContent>
          </UMessageScrollerViewport>
          <UMessageScrollerButton class="absolute bottom-2 left-1/2 -translate-x-1/2" size="icon-xs" />
        </UMessageScroller>
      </UMessageScrollerProvider>

      <UInputGroup class="min-w-0">
        <UInputGroupTextarea
          v-model="draft"
          rows="2"
          class="max-h-40 min-h-14 text-xs"
          placeholder="Ask the assistant…"
          aria-label="Message to the assistant"
          @keydown="keydown"
        />
        <UInputGroupAddon align="block-end" class="min-w-0 gap-0.5">
          <UDropdownMenu>
            <UDropdownMenuTrigger as-child>
              <UInputGroupButton variant="ghost" size="xs" class="min-w-0" title="The model">
                <span class="truncate">{{ model.label }}</span>
                <ChevronDownIcon />
              </UInputGroupButton>
            </UDropdownMenuTrigger>
            <UDropdownMenuContent align="start" side="top" class="max-h-72 w-60 overflow-y-auto">
              <UDropdownMenuLabel class="text-muted-foreground text-[11px] font-normal">
                Models that can use tools
              </UDropdownMenuLabel>
              <UDropdownMenuRadioGroup :model-value="model.id" @update:model-value="pick">
                <UDropdownMenuRadioItem v-for="option in usable" :key="option.id" :value="option.id" class="text-xs">
                  {{ option.label }}
                </UDropdownMenuRadioItem>
              </UDropdownMenuRadioGroup>
            </UDropdownMenuContent>
          </UDropdownMenu>

          <UDropdownMenu>
            <UDropdownMenuTrigger as-child>
              <UInputGroupButton
                variant="ghost"
                size="xs"
                class="shrink-0"
                :class="{ 'text-muted-foreground': thinking === 'none' }"
                :aria-label="`Thinking: ${THINKING_LABEL[thinking].name}`"
                :title="`Thinking before it acts: ${THINKING_LABEL[thinking].name}`"
              >
                <BrainIcon />
                {{ THINKING_LABEL[thinking].name }}
              </UInputGroupButton>
            </UDropdownMenuTrigger>
            <UDropdownMenuContent align="start" side="top" class="w-56">
              <UDropdownMenuLabel class="text-muted-foreground text-[11px] font-normal">
                Thinking before it acts — billed as output
              </UDropdownMenuLabel>
              <UDropdownMenuRadioGroup :model-value="thinking" @update:model-value="think">
                <UDropdownMenuRadioItem v-for="level in ASSISTANT_THINKING" :key="level" :value="level">
                  <span class="grid">
                    <span class="text-xs">{{ THINKING_LABEL[level].name }}</span>
                    <span class="text-muted-foreground text-[10px]">{{ THINKING_LABEL[level].note }}</span>
                  </span>
                </UDropdownMenuRadioItem>
              </UDropdownMenuRadioGroup>
            </UDropdownMenuContent>
          </UDropdownMenu>

          <UPopover>
            <UPopoverTrigger as-child>
              <UInputGroupButton
                variant="ghost"
                size="xs"
                class="ml-auto shrink-0 tabular-nums"
                :disabled="!turns.length"
                aria-label="What the next round sends"
                title="What the next round sends"
              >
                <GaugeIcon />
                {{ turns.length ? `≈ ${approx(context.total)}` : '' }}
              </UInputGroupButton>
            </UPopoverTrigger>
            <UPopoverContent align="end" side="top" class="grid w-64 gap-2 p-3 text-[11px]">
              <p class="font-medium">
                The next round sends ≈ {{ approx(context.total) }} tokens
              </p>
              <div class="bg-muted flex h-1.5 min-w-0 overflow-hidden rounded-full" aria-hidden="true">
                <div
                  v-for="row in context.rows"
                  :key="row.key"
                  class="h-full"
                  :class="SWATCH[row.key]"
                  :style="{ width: `${context.total ? (row.tokens / context.total) * 100 : 0}%` }"
                />
              </div>
              <div class="grid gap-1">
                <div v-for="row in context.rows" :key="row.key" class="flex min-w-0 items-center gap-1.5">
                  <span class="size-2 shrink-0 rounded-full" :class="SWATCH[row.key]" />
                  <span class="min-w-0 flex-1 truncate">{{ row.label }}</span>
                  <span class="text-muted-foreground tabular-nums">{{ 'unknown' in row && row.unknown ? '—' : `≈ ${approx(row.tokens)}` }}</span>
                </div>
              </div>
              <p class="text-muted-foreground">
                Estimated at four characters a token. Everything but the newest turn is normally read from the
                provider's cache, at a tenth of the price.
                <template v-if="context.last">
                  The last round sent {{ context.last.input.toLocaleString('en') }} tokens,
                  {{ context.last.cached.toLocaleString('en') }} of them from the cache.
                </template>
              </p>
              <p v-if="cost" class="text-muted-foreground">
                This conversation so far: {{ cost }}<template v-if="spent.cached">
                  ({{ spent.cached.toLocaleString('en') }} tokens cached)
                </template>.
              </p>
            </UPopoverContent>
          </UPopover>

          <UInputGroupButton
            v-if="busy"
            variant="outline"
            size="icon-xs"
            class="shrink-0"
            aria-label="Stop"
            title="Stop"
            @click="stop"
          >
            <SquareIcon />
          </UInputGroupButton>
          <UInputGroupButton
            v-else
            variant="default"
            size="icon-xs"
            class="shrink-0"
            :disabled="!draft.trim()"
            aria-label="Send"
            title="Send (Enter)"
            @click="submit()"
          >
            <ArrowUpIcon />
          </UInputGroupButton>
        </UInputGroupAddon>
      </UInputGroup>
    </template>
  </UFieldGroup>
</template>
