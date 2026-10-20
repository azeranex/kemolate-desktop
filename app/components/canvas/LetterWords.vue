<script setup lang="ts">
/**
 * One block's words inside its lettering frame: the plain line a box has
 * always been set in, or the shaped container — two floats carving the shape
 * and a spacer placing the words in it (see `shapeParts`).
 *
 * A component because the board draws the words on two plates, and the
 * exporter and the fitting probe build the same markup out of the same parts;
 * a third hand-written copy on the board would be the one to drift. Kept on one
 * line in the template on purpose: whitespace between the floats and the words
 * would be a text node the fit never measured.
 */
import type { ShapeParts } from '~/utils/letterCss'

import { LINE_BOX } from '~/utils/letterCss'

defineProps<{ text: string, parts: ShapeParts | null }>()
</script>

<template>
  <!-- eslint-disable-next-line vue/singleline-html-element-content-newline -->
  <span v-if="parts" :style="parts.container"><i :style="parts.start" /><i :style="parts.end" /><i :style="parts.spacer" />{{ text }}</span>
  <span v-else :style="LINE_BOX">{{ text }}</span>
</template>
