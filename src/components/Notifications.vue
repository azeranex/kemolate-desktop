<script setup lang="ts">
import {
  BellIcon,
  CircleCheckIcon,
  InfoIcon,
  OctagonXIcon,
  TriangleAlertIcon,
  XIcon,
} from '@lucide/vue'
// Not one of the auto-imported `use*` composables: it is a plain formatter, and
// this list needs one phrase per row rather than a ref per row.
import { formatTimeAgo } from '@vueuse/core'

import type { Component } from 'vue'

/**
 * The bell in the header, and everything the app has said this session under it.
 *
 * It sits beside the color scheme in both shells because it belongs to the app
 * rather than to any page: what a toast said about a folder is still worth
 * reading from the account page, and a chapter being replaced under it must not
 * take the record with it.
 *
 * Dismissing a line takes its toast off the screen too. That is the whole point
 * of keeping sonner's id: bad news lingers, and a toast with something to press
 * waits indefinitely, so a bell that cleared its own list and left them stacked
 * over the canvas would be two piles of the same news.
 *
 * The count clears when the bell is closed rather than when it is opened —
 * marking on the way in takes the highlight off the very lines the eye has just
 * arrived to read.
 */
const { items, unread, markRead, dismiss, clear } = useNotifications()

const open = ref(false)

/**
 * The count, held at nothing until the page is actually running.
 *
 * The server renders an empty bell — it has no session to have been told
 * anything in — and the client's first render has to agree with it or hydration
 * has a disagreement to settle. It very nearly always *did* disagree: another
 * tab answers this one's hello in a millisecond or two, so the list was full
 * before hydration had finished walking the header. Vue patched the badge,
 * which is a node, and left `aria-label` saying "Notifications" over a bell
 * showing five — the attribute is the half of a mismatch it only warns about.
 *
 * One frame later than it could be, and right rather than nearly right.
 */
const mounted = useMounted()

const count = computed(() => (mounted.value ? unread.value : 0))

watch(open, (shown) => {
  if (!shown) markRead()
})

/** The same drawings the toasts themselves use — see `ui/sonner`. */
const ICONS: Record<NotificationLevel, Component> = {
  default: BellIcon,
  success: CircleCheckIcon,
  info: InfoIcon,
  warning: TriangleAlertIcon,
  error: OctagonXIcon,
}

/**
 * A shade lighter in the dark, which is not decoration.
 *
 * Sonner's rich colours are two palettes, and its dark one lifts every kind to
 * around 65% lightness — a mid-weight `-500` beside it reads as a different,
 * dimmer thing rather than the same news filed. `--destructive` already makes
 * that move on its own.
 */
const TONES: Record<NotificationLevel, string> = {
  default: 'text-muted-foreground',
  success: 'text-emerald-600 dark:text-emerald-400',
  info: 'text-sky-600 dark:text-sky-400',
  warning: 'text-amber-600 dark:text-amber-400',
  error: 'text-destructive',
}

/**
 * "4 minutes ago", recomputed on a slow tick.
 *
 * Every half minute, which is as often as any of these phrases can change and
 * still be true. Without the tick a bell left open would freeze at whatever it
 * said when it opened, which is the one place the age actually matters — you
 * open it precisely to find out how long ago something went wrong.
 */
const now = useTimestamp({ interval: 30_000 })

function ago (at: number) {
  return formatTimeAgo(new Date(at), {}, now.value)
}

/**
 * A ring on arrival, so something showing up while the bell is closed is not a
 * number that silently changes in the corner of the eye. Remounted rather than
 * triggered, which is the same trick the color scheme's pulse uses: an element
 * that has just been created plays its animation, with nothing to reset.
 */
const rings = ref(0)

// Watched from mount rather than from setup, so the list a newly opened tab is
// handed by its neighbours does not ring: that window has not been told
// anything, it has caught up. Something arriving in another tab afterwards does
// ring here, which is the point of sharing the record at all.
onMounted(() => {
  watch(() => items.value[0]?.id, (id) => {
    if (id !== undefined) rings.value++
  })
})

// Dismissing takes the toast with it, in whichever window is showing it — the
// store does that itself, so there is nothing to do here but say which line.
</script>

<template>
  <UPopover v-model:open="open">
    <UPopoverTrigger as-child>
      <UButton
        variant="ghost"
        size="icon"
        class="relative flex-none"
        :aria-label="count ? `Notifications, ${count} unread` : 'Notifications'"
        title="Notifications"
      >
        <!--
          Unrung on the way in: a page that opens with a swinging bell is
          announcing nothing, since there is nothing in it yet.
        -->
        <BellIcon :key="rings" :class="['size-4.75', rings && 'bell']" />

        <!--
          A count while there is one, and never a wider button because of it:
          drawn over the corner of the bell rather than beside it, so the header
          does not shift by a few pixels every time something happens.
        -->
        <span
          v-if="count"
          class="bg-primary text-primary-foreground absolute top-0.5 right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] leading-none font-semibold tabular-nums"
        >
          {{ count > 9 ? '9+' : count }}
        </span>
      </UButton>
    </UPopoverTrigger>

    <!--
      `gap-0 p-0`, because the stock content is a `flex flex-col gap-4` meant
      for a header and a paragraph; the rows below carry their own spacing and
      their own dividers, and want the full width to do it in.
    -->
    <UPopoverContent align="end" class="w-88 gap-0 overflow-hidden p-0">
      <div class="border-border flex items-center justify-between gap-2 border-b px-3 py-2">
        <span class="text-muted-foreground text-[10px] tracking-wider uppercase">Notifications</span>

        <UButton
          v-if="items.length"
          variant="ghost"
          size="xs"
          class="text-muted-foreground -my-1"
          @click="clear"
        >
          Clear all
        </UButton>
      </div>

      <!--
        The list scrolls rather than the popover growing past the window: a bad
        run of a chapter can say a dozen things, and a panel taller than the
        screen has its oldest lines somewhere unreachable.
      -->
      <ul v-if="items.length" class="max-h-96 overflow-y-auto">
        <li
          v-for="item in items"
          :key="item.id"
          class="group/row border-border/60 flex gap-2.5 border-b px-3 py-2.5 last:border-b-0"
          :class="!item.read && 'bg-accent/50'"
        >
          <component :is="ICONS[item.level]" :class="cn('mt-0.5 size-4 flex-none', TONES[item.level])" />

          <div class="min-w-0 flex-1">
            <p class="text-[13px] leading-snug font-medium">{{ item.title }}</p>
            <p v-if="item.description" class="text-muted-foreground mt-0.5 text-xs/snug">
              {{ item.description }}
            </p>
            <p class="text-muted-foreground mt-1 text-[10px]">{{ ago(item.at) }}</p>
          </div>

          <!--
            Kept out of the way until the row is under the pointer, but never
            out of reach of a keyboard: `focus-visible` brings it back for
            somebody tabbing through the list.
          -->
          <UButton
            variant="ghost"
            size="icon-xs"
            class="flex-none opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100"
            :aria-label="`Dismiss “${item.title}”`"
            @click="dismiss(item.id)"
          >
            <XIcon class="size-3.5" />
          </UButton>
        </li>
      </ul>

      <p v-else class="text-muted-foreground px-3 py-8 text-center text-xs">
        Nothing has happened yet.
      </p>
    </UPopoverContent>
  </UPopover>
</template>

<style scoped>
/* One swing, from the top of the bell rather than its middle. */
.bell {
  transform-origin: 12px 4px;
  animation: ring 620ms cubic-bezier(0.36, 0.07, 0.19, 0.97);
}

@keyframes ring {
  0%,
  100% {
    rotate: 0deg;
  }

  20% {
    rotate: 11deg;
  }

  45% {
    rotate: -8deg;
  }

  70% {
    rotate: 4deg;
  }
}

@media (prefers-reduced-motion: reduce) {
  .bell {
    animation: none;
  }
}
</style>
