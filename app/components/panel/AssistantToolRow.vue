<script setup lang="ts">
/**
 * One tool call in the assistant's conversation: what it was, and what it
 * answered.
 *
 * A line of what the assistant did, in the reader's words (`describeCall`) —
 * shimmering while it runs, red if it failed — because a check of a page is a
 * dozen calls and the conversation is the reader's to read, not the calls'.
 * Opened, it shows the tool, the arguments and the answer whole, and any
 * pictures the tool returned, which is what to look at when the assistant says
 * something about a balloon the reader does not believe.
 *
 * Drawn with shadcn-vue's Trace, which is what its AI elements (Tool, Task,
 * Chain of Thought) are built from.
 */
import {
  BookOpenIcon,
  BookTextIcon,
  EyeIcon,
  ImageIcon,
  LanguagesIcon,
  ListIcon,
  MergeIcon,
  PencilIcon,
  ScanTextIcon,
  SparklesIcon,
  TypeIcon,
  WrenchIcon,
} from '@lucide/vue'

import type { Component } from 'vue'
import type { Described } from '~/utils/agent/describe'
import type { ToolCall, ToolResult } from '~/utils/agent/messages'

import { describeCall } from '~/utils/agent/describe'

const props = defineProps<{
  call: ToolCall
  result?: ToolResult
  /** Running now. */
  live?: boolean
}>()

const ICONS: Record<Described['kind'], Component> = {
  look: ListIcon,
  read: ScanTextIcon,
  image: ImageIcon,
  fix: PencilIcon,
  blocks: MergeIcon,
  translate: LanguagesIcon,
  letter: TypeIcon,
  clean: SparklesIcon,
  notes: BookTextIcon,
  playbook: BookOpenIcon,
  other: WrenchIcon,
}

const described = computed(() => describeCall(props.call))
const running = computed(() => props.live || !props.result)
const status = computed(() => (running.value ? 'running' : props.result?.isError ? 'error' : undefined))

/** The arguments as sent, or nothing worth showing. */
const sent = computed(() => {
  const text = JSON.stringify(props.call.arguments, null, 2)

  return text === '{}' ? '' : text
})

/** The answer's text, pretty where it is JSON — which it nearly always is. */
const said = computed(() => {
  const text = (props.result?.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n')

  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
})

const pictures = computed(() => (props.result?.content ?? []).flatMap((part) =>
  part.type === 'image' ? [`data:${part.mimeType};base64,${part.data}`] : []))
</script>

<template>
  <UTraceCollapsible>
    <UTraceCollapsibleTrigger>
      <UTraceLine :status="status" class="text-xs">
        <UTraceIcon>
          <component :is="ICONS[described.kind]" />
        </UTraceIcon>
        <UTraceTitle>{{ running ? described.doing : described.done }}</UTraceTitle>
        <UTraceDescription v-if="described.detail">
          {{ described.detail }}
        </UTraceDescription>
        <UTraceDescription v-if="pictures.length">
          <EyeIcon class="inline size-3" /> {{ pictures.length }}
        </UTraceDescription>
      </UTraceLine>
    </UTraceCollapsibleTrigger>
    <UTraceCollapsibleContent class="grid gap-1.5 text-[11px]">
      <p class="font-mono text-[10px]">
        {{ call.name }}
      </p>
      <UCodeBlock v-if="sent" size="sm">
        <!-- Inline: whitespace round the text would be drawn, this being a <pre>. -->
        <UCodeBlockContent wrap class="max-h-40 text-[10px]">{{ sent }}</UCodeBlockContent>
      </UCodeBlock>
      <UCodeBlock v-if="said" size="sm" :variant="result?.isError ? 'destructive' : 'default'">
        <UCodeBlockContent wrap class="max-h-60 text-[10px]">{{ said }}</UCodeBlockContent>
      </UCodeBlock>
      <div v-if="pictures.length" class="flex flex-wrap gap-1">
        <img
          v-for="(picture, index) in pictures"
          :key="index"
          :src="picture"
          alt=""
          class="border-border max-h-24 rounded-sm border object-contain"
        >
      </div>
    </UTraceCollapsibleContent>
  </UTraceCollapsible>
</template>
