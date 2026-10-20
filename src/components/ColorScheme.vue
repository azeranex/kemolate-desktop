<script setup lang="ts">
/**
 * Change color scheme component
 *
 * This component is used to change app color scheme and save persistent to cookie
 * using useCookie. This cookie is also being watched so the change affect other tab.
 *
 * One button, three states, cycled System → Light → Dark. The icon is a single
 * drawing rather than three swapped ones: the same disc is a sun when the mask
 * circle is parked off it and a moon when it slides over, the rays spiral in
 * and out around it, and System draws its ring around the whole thing. Nothing
 * slides from A to B, so there is no travel to bounce at the end of.
 *
 * Only `.auto` is bound from Vue — sun-or-moon follows the `.dark` class on
 * `<html>`, which is settled before hydration. See `useColorScheme` for why.
 */
const { preference, set } = useColorScheme()

const LABELS: Record<ColorScheme, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
}

const NEXT: Record<ColorScheme, ColorScheme> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
}

const next = computed(() => NEXT[preference.value])

// Drawn once pointing up and rotated into place; the index is the stagger, so
// the eight of them retract in sequence rather than all at once.
const rays = Array.from({ length: 8 }, (_, i) => i * 45)

// A four-pointed sparkle around its own origin, so it can be dropped anywhere
// by a translate and still scale from its middle.
const STAR = 'M0-2.1C.25-.8.8-.25 2.1 0 .8.25.25.8 0 2.1-.25.8-.8.25-2.1 0-.8-.25-.25-.8 0-2.1Z'

const stars = [
  { x: 18.9, y: 5.4, size: 0.95, delay: 120 },
  { x: 5.6, y: 17.8, size: 0.6, delay: 210 },
]

// The mask has to be addressed by id, and ids are global to the document.
const maskId = useId()

// Remounting the ring replays its animation, which is the only feedback for a
// switch that changes the icon but not the theme (System → Dark, at night).
const pulses = ref(0)

async function change (event: MouseEvent) {
  // Read before awaiting: `currentTarget` is gone once the event finishes. The
  // wipe opens from the button rather than the pointer, so a keyboard press —
  // which reports (0, 0) — starts from the same place a click does.
  const box = (event.currentTarget as HTMLElement).getBoundingClientRect()

  pulses.value++

  await set(next.value, { x: box.left + box.width / 2, y: box.top + box.height / 2 })
}
</script>

<template>
  <UButton
    variant="ghost"
    size="icon"
    class="flex-none"
    :aria-label="`Color scheme: ${LABELS[preference]}. Switch to ${LABELS[next]}.`"
    :title="`Color scheme: ${LABELS[preference]}`"
    @click="change"
  >
    <svg
      class="scheme size-5"
      :class="{ auto: preference === 'system' }"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <defs>
        <mask
          :id="maskId"
          maskUnits="userSpaceOnUse"
          x="0"
          y="0"
          width="24"
          height="24"
        >
          <rect width="24" height="24" fill="#fff" />
          <circle class="eclipse" cx="12" cy="12" r="6" fill="#000" />
        </mask>
      </defs>

      <!-- "whatever the machine says": a ring the disc sits inside of -->
      <g class="orbit">
        <circle
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          stroke-width="1.1"
          stroke-opacity="0.7"
          stroke-dasharray="1.4 3.1"
          stroke-linecap="round"
        />
        <circle cx="12" cy="2" r="1.35" fill="currentColor" fill-opacity="0.75" />
      </g>

      <g class="core">
        <g class="rays" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
          <!--
            The rotation sits on a wrapper rather than on the line: `rotate()`
            with a centre and a CSS `transform-origin` on the same element
            compound into a rotation about (24, 24), and the line needs the
            origin for its own scale.
          -->
          <g v-for="(angle, i) in rays" :key="angle" :transform="`rotate(${angle} 12 12)`">
            <line
              class="ray"
              x1="12"
              y1="4.4"
              x2="12"
              y2="2.1"
              :style="{ '--delay': `${i * 24}ms` }"
            />
          </g>
        </g>

        <circle
          class="disc"
          cx="12"
          cy="12"
          r="5"
          fill="currentColor"
          :mask="`url(#${maskId})`"
        />

        <path
          v-for="star in stars"
          :key="star.x"
          class="star"
          :d="STAR"
          fill="currentColor"
          :transform="`translate(${star.x} ${star.y}) scale(${star.size})`"
          :style="{ '--delay': `${star.delay}ms` }"
        />
      </g>

      <circle
        v-if="pulses"
        :key="pulses"
        class="pulse"
        cx="12"
        cy="12"
        r="6"
        stroke="currentColor"
        stroke-width="1.4"
      />
    </svg>
  </UButton>
</template>

<style scoped>
.scheme {
  /* No overshoot anywhere: at nineteen pixels a bounce reads as a wobble. */
  --ease: cubic-bezier(0.65, 0, 0.35, 1);
  --delay: 0ms;

  /* The pulse finishes outside the viewBox. */
  overflow: visible;
}

/* System closes the disc down to make room for the ring drawn around it. */
.core {
  transform-origin: 12px 12px;
  transition: scale 480ms var(--ease);
}

.scheme.auto .core {
  scale: 0.76;
}

/*
 * Parked off the disc, the mask circle takes nothing away and the disc is a
 * full sun; slid over it, it bites out the crescent. One circle, one moving
 * value — the sun is never swapped for a moon, it is eclipsed into one.
 */
.eclipse {
  translate: 11px -10px;
  transition: translate 520ms var(--ease);
}

.dark .eclipse {
  translate: 4.6px -4.2px;
}

/* The rays spiral rather than fade: the group twists while each line is drawn
   back into the disc behind the advancing shadow. */
.rays {
  transform-origin: 12px 12px;
  transition: rotate 560ms var(--ease);
}

.ray {
  transform-origin: 12px 12px;
  transition:
    scale 400ms var(--ease) var(--delay),
    opacity 240ms linear var(--delay);
}

.dark .rays {
  rotate: -52deg;
}

.dark .ray {
  scale: 0.3;
  opacity: 0;
}

/* Only for a night the user picked: under System the ring is the decoration,
   and both together is a crowd. */
.star {
  transform-box: fill-box;
  transform-origin: center;
  scale: 0;
  opacity: 0;
  transition:
    scale 420ms var(--ease) var(--delay),
    opacity 280ms linear var(--delay);
}

.dark .scheme:not(.auto) .star {
  scale: 1;
  opacity: 1;
}

/* Off-state is one size too big, so leaving System lets the ring go rather
   than shrinking it away. */
.orbit {
  transform-origin: 12px 12px;
  scale: 1.28;
  opacity: 0;
  transition:
    scale 520ms var(--ease),
    opacity 300ms linear;
}

.scheme.auto .orbit {
  scale: 1;
  opacity: 1;
  /* Slow enough to be noticed only once: it is a sign of life, not a spinner. */
  animation: orbit 20s linear infinite;
}

.pulse {
  transform-origin: 12px 12px;
  opacity: 0;
  animation: pulse 620ms var(--ease) forwards;
}

@keyframes orbit {
  to {
    rotate: 360deg;
  }
}

@keyframes pulse {
  from {
    scale: 0.55;
    opacity: 0.5;
  }

  to {
    scale: 2.1;
    opacity: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .scheme,
  .scheme * {
    transition-duration: 1ms !important;
    animation: none !important;
  }
}
</style>
