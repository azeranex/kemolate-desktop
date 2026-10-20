<script setup lang="ts">
/**
 * Drawing the shape a block's lines wrap into — a polygon in its frame.
 *
 * In the panel rather than on the page. The page already has two sets of grips
 * on a translated block (the frame's, and the reading's on `F`), and a third
 * set of points inside the frame would fight both for the same few pixels —
 * which is the reason `Framing` gives for not putting two sets on screen at
 * once. Here the frame is drawn at its real proportions, large enough to aim
 * at, and the page shows the result as soon as a point is let go.
 *
 * One change per drag, not per pointer move: a shape dragged across twenty
 * frames is one step to undo, and the fit behind it re-measures once.
 *
 * Drag a corner to move it; double-click an edge to add one there; right-click
 * a corner to take it away (never below three).
 */
const props = defineProps<{
  /** `[x0, y0, x1, y1, …]`, shares of the frame. */
  points: number[]
  /** The frame's width over its height, so the square here is the shape there. */
  aspect: number
}>()

const emit = defineEmits<{ 'update:points': [points: number[]] }>()

/** The drawing's size: the frame's proportions inside a fixed box. */
const W = 200
const size = computed(() => {
  const aspect = Number.isFinite(props.aspect) && props.aspect > 0 ? props.aspect : 1

  return aspect >= 1 ? { w: W, h: Math.max(40, W / aspect) } : { w: Math.max(40, W * aspect), h: W }
})

/** The points being shown — the prop, or the drag's working copy while one is under way. */
const working = ref<number[] | null>(null)
const shown = computed(() => working.value ?? props.points)

const corners = computed(() => {
  const out: { x: number, y: number, i: number }[] = []

  for (let i = 0; i < shown.value.length; i += 2) {
    out.push({ x: shown.value[i]! * size.value.w, y: shown.value[i + 1]! * size.value.h, i: i / 2 })
  }

  return out
})

const outline = computed(() => corners.value.map((c) => `${c.x},${c.y}`).join(' '))

const svg = useTemplateRef<SVGSVGElement>('svg')

/** A pointer's place as shares of the frame, held inside it. */
function at (event: PointerEvent | MouseEvent) {
  const rect = svg.value!.getBoundingClientRect()
  const clamp = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000

  return { x: clamp((event.clientX - rect.left) / rect.width), y: clamp((event.clientY - rect.top) / rect.height) }
}

let dragging: number | null = null

function grab (index: number, event: PointerEvent) {
  if (event.button !== 0) return

  dragging = index
  working.value = [...props.points]
  ;(event.target as Element).setPointerCapture(event.pointerId)
}

function move (event: PointerEvent) {
  if (dragging === null || !working.value) return

  const p = at(event)
  const next = [...working.value]

  next[dragging * 2] = p.x
  next[dragging * 2 + 1] = p.y
  working.value = next
}

function drop () {
  if (dragging === null) return

  dragging = null

  const next = working.value

  working.value = null

  if (next && next.some((v, i) => v !== props.points[i])) emit('update:points', next)
}

/** A corner added on the edge nearest the double-click, between the two it joins. */
function add (event: MouseEvent) {
  const p = at(event)
  const count = props.points.length / 2

  if (count >= 32) return

  let best = 0
  let bestDistance = Infinity

  for (let i = 0; i < count; i++) {
    const a = { x: props.points[i * 2]!, y: props.points[i * 2 + 1]! }
    const b = { x: props.points[((i + 1) % count) * 2]!, y: props.points[((i + 1) % count) * 2 + 1]! }
    const dx = b.x - a.x
    const dy = b.y - a.y
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)))
    const distance = Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y)

    if (distance < bestDistance) {
      bestDistance = distance
      best = i
    }
  }

  const next = [...props.points]

  next.splice((best + 1) * 2, 0, p.x, p.y)
  emit('update:points', next)
}

function remove (index: number) {
  if (props.points.length <= 6) return

  const next = [...props.points]

  next.splice(index * 2, 2)
  emit('update:points', next)
}
</script>

<template>
  <div class="grid justify-items-center gap-1">
    <svg
      ref="svg"
      :width="size.w"
      :height="size.h"
      :viewBox="`0 0 ${size.w} ${size.h}`"
      class="bg-muted/40 border-border touch-none overflow-visible rounded-sm border"
      role="img"
      aria-label="The shape the lines wrap into. Drag a corner to move it, double-click an edge to add one, right-click a corner to remove it."
      @pointermove="move"
      @pointerup="drop"
      @pointercancel="drop"
      @dblclick="add"
    >
      <polygon :points="outline" class="fill-primary/15 stroke-primary" stroke-width="1.5" />
      <circle
        v-for="corner in corners"
        :key="corner.i"
        :cx="corner.x"
        :cy="corner.y"
        r="5"
        class="fill-background stroke-primary cursor-grab"
        stroke-width="1.5"
        @pointerdown.stop="grab(corner.i, $event)"
        @dblclick.stop
        @contextmenu.prevent="remove(corner.i)"
      />
    </svg>
    <p class="text-muted-foreground text-[10px] leading-snug">
      Drag a corner · double-click an edge to add · right-click a corner to remove
    </p>
  </div>
</template>
