<script setup lang="ts">
/**
 * One tool call in the assistant's conversation: what it was, and what it
 * answered.
 *
 * Folded by default to a line — the tool, a glance at its arguments, and
 * whether it worked — because a check of a page is a dozen calls and the
 * conversation is the reader's to read, not the calls'. Opened, it shows the
 * arguments and the answer whole, and any pictures the tool returned, which
 * is what to look at when the assistant says something about a balloon the
 * reader does not believe.
 */
import { CheckIcon, ChevronRightIcon, LoaderCircleIcon, XIcon } from '@lucide/vue'

import type { ToolCall, ToolResult } from '~/utils/agent/messages'

const props = defineProps<{
  call: ToolCall
  result?: ToolResult
  /** Running now. */
  live?: boolean
}>()

const open = ref(false)

/** The arguments in a line, for the folded row. */
const glance = computed(() => {
  const text = JSON.stringify(props.call.arguments)

  return text === '{}' ? '' : text.length > 80 ? `${text.slice(0, 79)}…` : text
})

const said = computed(() => (props.result?.content ?? [])
  .filter((part) => part.type === 'text')
  .map((part) => part.text)
  .join('\n'))

const pictures = computed(() => (props.result?.content ?? []).flatMap((part) =>
  part.type === 'image' ? [`data:${part.mimeType};base64,${part.data}`] : []))
</script>

<template>
  <div class="border-border min-w-0 rounded-md border text-[11px]">
    <button
      type="button"
      class="hover:bg-accent/50 flex w-full min-w-0 items-center gap-1.5 px-2 py-1 text-left"
      :aria-expanded="open"
      @click="open = !open"
    >
      <ChevronRightIcon class="text-muted-foreground size-3 shrink-0 transition-transform" :class="open && 'rotate-90'" />
      <span class="shrink-0 font-mono">{{ call.name }}</span>
      <span class="text-muted-foreground min-w-0 truncate font-mono">{{ glance }}</span>
      <span class="ml-auto shrink-0">
        <LoaderCircleIcon v-if="live || !result" class="text-muted-foreground size-3 animate-spin" />
        <XIcon v-else-if="result.isError" class="text-destructive size-3" />
        <CheckIcon v-else class="text-muted-foreground size-3" />
      </span>
    </button>

    <div v-if="open" class="border-border grid min-w-0 gap-1.5 border-t px-2 py-1.5">
      <pre class="text-muted-foreground max-h-40 min-w-0 overflow-auto font-mono text-[10px] whitespace-pre-wrap">{{ JSON.stringify(call.arguments, null, 2) }}</pre>
      <pre
        v-if="said"
        class="max-h-60 min-w-0 overflow-auto font-mono text-[10px] whitespace-pre-wrap"
        :class="result?.isError && 'text-destructive'"
      >{{ said }}</pre>
      <div v-if="pictures.length" class="flex flex-wrap gap-1">
        <img
          v-for="(picture, index) in pictures"
          :key="index"
          :src="picture"
          alt=""
          class="border-border max-h-24 rounded-sm border object-contain"
        >
      </div>
    </div>
  </div>
</template>
