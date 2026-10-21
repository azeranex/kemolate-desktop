<script setup lang="ts">
/**
 * Every block on the page, as the pictures the cleaning works with.
 *
 * Three per block: the crop of the scan a repair covers, the repair itself on a
 * checkerboard so its transparency shows, and the repair laid over the crop the
 * way the canvas lays it. Then the two numbers that say what kind of repair it
 * is. `clear` is how much of it is transparent. `copied` is how much is opaque
 * but identical to the scan underneath — artwork the repair carries without
 * having changed it. A repair made before `MASK_RECIPE` 12 is mostly that
 * (78–88% on page 3 of Business trip grooming 2); a current one is 13–18%,
 * which is paper inside the mask that was white before the fill and after it.
 * Red past half. Together with the recipe read out of its key, an old
 * rectangle still being shown for a block is one glance.
 *
 * Development only — see `PANEL_SECTIONS`, which leaves it out of a build. It
 * reads what `useClean` already has on screen and writes nothing.
 *
 * Drawn on demand rather than on every change: decoding the scan and every
 * repair on a large page is a few hundred milliseconds, which is fine for a
 * press and not for a watcher that fires on each brush stroke.
 */
import { RefreshCwIcon } from '@lucide/vue'

const { page, setSelection } = useComic()
const { patchFor } = useClean()

interface Row {
  id: string
  index: number
  source: string
  /** Object URLs, revoked on the next draw. */
  crop: string | null
  repair: string | null
  over: string | null
  size: string | null
  /** Shares of the repair's pixels, 0–100. */
  clear: number | null
  copied: number | null
  key: string | null
  recipe: number | null
}

const rows = ref<Row[]>([])
const drawing = ref(false)
const note = ref<string | null>(null)

let urls: string[] = []

function forget () {
  for (const url of urls) URL.revokeObjectURL(url)
  urls = []
}

onBeforeUnmount(forget)

async function url (canvas: OffscreenCanvas): Promise<string> {
  const made = URL.createObjectURL(await canvas.convertToBlob({ type: 'image/png' }))

  urls.push(made)

  return made
}

/** How far apart two pixels may be and still count as the scan, unchanged. */
const SAME = 2

async function draw () {
  const target = page.value
  const scan = target?.scan

  forget()
  rows.value = []
  note.value = null

  if (!target) return

  if (!scan) {
    note.value = 'This page has no scan in this browser, so there is nothing to crop.'

    return
  }

  drawing.value = true

  const bitmap = await createImageBitmap(scan.file)

  try {
    const made: Row[] = []

    for (const [index, block] of target.blocks.entries()) {
      const patch = patchFor(target, block)
      const row: Row = {
        id: block.id,
        index: index + 1,
        source: block.source.slice(0, 40),
        crop: null,
        repair: null,
        over: null,
        size: null,
        clear: null,
        copied: null,
        key: patch?.key ?? null,
        recipe: patch?.key ? patchRecipe(patch.key) : null,
      }

      if (patch) {
        const image = await createImageBitmap(await (await fetch(patch.url)).blob(), { premultiplyAlpha: 'none' })
        const w = image.width
        const h = image.height
        const x = Math.round((patch.x / 100) * scan.width)
        const y = Math.round((patch.y / 100) * scan.height)

        const crop = new OffscreenCanvas(w, h)
        const cropped = crop.getContext('2d', { willReadFrequently: true })!

        cropped.drawImage(bitmap, x, y, w, h, 0, 0, w, h)

        const repair = new OffscreenCanvas(w, h)
        const repaired = repair.getContext('2d', { willReadFrequently: true })!

        repaired.drawImage(image, 0, 0)

        const under = cropped.getImageData(0, 0, w, h).data
        const mine = repaired.getImageData(0, 0, w, h).data

        let clear = 0
        let copied = 0

        for (let i = 0; i < mine.length; i += 4) {
          const alpha = mine[i + 3]!

          if (alpha === 0) clear++
          else if (alpha === 255
            && Math.abs(mine[i]! - under[i]!) <= SAME
            && Math.abs(mine[i + 1]! - under[i + 1]!) <= SAME
            && Math.abs(mine[i + 2]! - under[i + 2]!) <= SAME) copied++
        }

        const over = new OffscreenCanvas(w, h)
        const laid = over.getContext('2d')!

        laid.drawImage(crop, 0, 0)
        laid.drawImage(image, 0, 0)
        image.close()

        const pixels = w * h

        row.crop = await url(crop)
        row.repair = await url(repair)
        row.over = await url(over)
        row.size = `${w}×${h}`
        row.clear = Math.round((clear / pixels) * 100)
        row.copied = Math.round((copied / pixels) * 100)
      } else {
        // No repair: the block's own box, so there is still something to look at.
        const bx = Math.round((block.x / 100) * scan.width)
        const by = Math.round((block.y / 100) * scan.height)
        const bw = Math.max(1, Math.round((block.w / 100) * scan.width))
        const bh = Math.max(1, Math.round((block.h / 100) * scan.height))
        const crop = new OffscreenCanvas(bw, bh)

        crop.getContext('2d')!.drawImage(bitmap, bx, by, bw, bh, 0, 0, bw, bh)
        row.crop = await url(crop)
      }

      made.push(row)
    }

    rows.value = made
  } finally {
    bitmap.close()
    drawing.value = false
  }
}

// Drawn when the panel opens and when the page turns; a press redraws the rest.
watch(() => page.value?.id, () => { draw().catch((error: unknown) => { note.value = String(error) }) }, { immediate: true })

/** The recipe a repair made right now would carry — anything else is an old one. */
const RECIPE = MASK_RECIPE

/** A checkerboard, so a transparent pixel reads as transparent. */
const CHECKER = {
  backgroundImage: 'conic-gradient(#ccc 25%, #fff 0 50%, #ccc 0 75%, #fff 0)',
  backgroundSize: '12px 12px',
}
</script>

<template>
  <div class="grid gap-2">
    <div class="flex items-center justify-between gap-2">
      <span class="text-muted-foreground text-[11px]">
        {{ rows.length }} blocks · current recipe m{{ RECIPE }}
      </span>
      <UButton variant="outline" size="sm" :disabled="drawing" @click="draw">
        <RefreshCwIcon class="size-3.5" :class="{ 'animate-spin': drawing }" />
        Redraw
      </UButton>
    </div>

    <p v-if="note" class="text-muted-foreground text-[11px]">
      {{ note }}
    </p>

    <!-- `min-w-0` on the row itself — see the panel note in CLAUDE.md. -->
    <button
      v-for="row in rows"
      :key="row.id"
      type="button"
      class="
        border-border hover:bg-muted/50 grid min-w-0 gap-1.5 rounded-md border p-2
        text-left
      "
      @click="setSelection([row.id], row.id)"
    >
      <span class="flex min-w-0 items-baseline gap-1.5 text-[11px]">
        <span class="text-muted-foreground font-mono tabular-nums">{{ row.index }}</span>
        <span class="truncate">{{ row.source || '—' }}</span>
      </span>

      <span class="grid grid-cols-3 gap-1">
        <img v-if="row.crop" :src="row.crop" alt="The scan under this block" class="max-h-24 w-full object-contain">
        <span
          v-if="row.repair"
          class="grid place-items-center"
          :style="CHECKER"
        >
          <img :src="row.repair" alt="The repair, on a checkerboard" class="max-h-24 w-full object-contain">
        </span>
        <img v-if="row.over" :src="row.over" alt="The repair over the scan" class="max-h-24 w-full object-contain">
        <span v-if="!row.repair" class="text-muted-foreground col-span-2 self-center text-[11px]">No repair shown</span>
      </span>

      <span v-if="row.repair" class="text-muted-foreground flex flex-wrap gap-x-2 font-mono text-[10px] tabular-nums">
        <span>{{ row.size }}</span>
        <span>clear {{ row.clear }}%</span>
        <span :class="{ 'text-destructive': (row.copied ?? 0) > 50 }">copied {{ row.copied }}%</span>
        <span :class="{ 'text-destructive': row.recipe !== null && row.recipe !== RECIPE }">
          {{ row.recipe === null ? 'recipe ?' : `m${row.recipe}` }}
        </span>
      </span>
      <span v-if="row.key" class="text-muted-foreground truncate font-mono text-[10px]">{{ row.key }}</span>
    </button>
  </div>
</template>
