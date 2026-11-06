<script setup lang="ts">
/**
 * A model's reply, its Markdown drawn — see `app/utils/agent/markdown.ts` for
 * what is read and why it is read into a tree rather than into HTML. Every
 * piece is an element with the reply's words as its text.
 */
import type { Inline } from '~/utils/agent/markdown'

import { markdown } from '~/utils/agent/markdown'

const props = defineProps<{ text: string }>()

const blocks = computed(() => markdown(props.text))

const INLINE_CLASS: Record<Inline['type'], string> = {
  text: '',
  strong: 'font-semibold text-foreground',
  em: 'italic',
  code: 'bg-muted rounded px-1 py-px font-mono text-[0.92em]',
}

const TAG: Record<Inline['type'], string> = { text: 'span', strong: 'strong', em: 'em', code: 'code' }
</script>

<template>
  <!-- Each part inline: whitespace round it would be drawn between the words. -->
  <div class="grid min-w-0 gap-2 text-xs/relaxed wrap-break-word">
    <template v-for="(block, index) in blocks" :key="index">
      <p v-if="block.type === 'p' || block.type === 'h'" class="whitespace-pre-wrap" :class="block.type === 'h' && 'font-semibold'">
        <component :is="TAG[part.type]" v-for="(part, at) in block.inline" :key="at" :class="INLINE_CLASS[part.type]">{{ part.text }}</component>
      </p>
      <component :is="block.type" v-else-if="block.type === 'ul' || block.type === 'ol'" class="grid gap-1 pl-4" :class="block.type === 'ul' ? 'list-disc' : 'list-decimal'">
        <li v-for="(item, at) in block.items" :key="at">
          <component :is="TAG[part.type]" v-for="(part, place) in item" :key="place" :class="INLINE_CLASS[part.type]">{{ part.text }}</component>
        </li>
      </component>
      <UCodeBlock v-else-if="block.type === 'code'" size="sm">
        <UCodeBlockContent wrap class="text-[10px]">{{ block.text }}</UCodeBlockContent>
      </UCodeBlock>
    </template>
  </div>
</template>
