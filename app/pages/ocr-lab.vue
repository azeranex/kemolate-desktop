<script setup lang="ts">
/**
 * A bench for trying the OCR engines against each other, on a real page.
 *
 * Same engines the Detect panel runs, and the same registries behind them —
 * this is where a reader is judged before it is trusted with a chapter. Drop
 * a scan, run a pairing, see what came back and how long it took. Nothing
 * here writes to a workspace; a run is a run, kept only as long as the tab.
 *
 * The readers only recognise, so the detector runs first and hands them
 * boxes — except Vision, which finds its own and takes the page whole. The
 * whole-page button is the blunt version of the same thing, kept because a
 * crop of one balloon is a perfectly good thing to drop here.
 */
import { ChevronLeftIcon, ChevronRightIcon, ImageUpIcon, LoaderCircleIcon } from '@lucide/vue'

import type { RoomReason } from '~/utils/ocr/rooms'

// Imported rather than auto-imported: the `utils/ocr` family only learns a new
// file's exports when the dev server restarts.
import { useModelMachine } from '~/composables/useModelMachine'
import { detectorBytes } from '~/utils/ocr/detectors'
import { readerBytes } from '~/utils/ocr/readers'
import { fencesOf, roomVerdicts } from '~/utils/ocr/rooms'
import { traceFill, VERDICT_COLOUR } from '~/utils/ocr/trace'

definePageMeta({
  layout: false,
})

interface Run {
  engine: string
  ms: number
  blocks: ReadBlock[]
}

const scan = ref<{ url: string, file: File, width: number, height: number } | null>(null)

/**
 * Every page picked or dropped, in name order, and which is on the stage.
 *
 * A chapter rather than a page, because the question the Balloons run asks is
 * only answered across one: whether a rule that looked right on the page in
 * front of you holds on the nineteen others. One page is still the ordinary
 * case, and a list of one looks exactly as the bench always did.
 */
const pages = ref<File[]>([])
const place = ref(0)

/** What the bench is doing right now, or null when it is yours. */
const busy = ref<string | null>(null)
const error = ref<string | null>(null)

/** Every reading taken of the current scan, newest first. */
const runs = ref<Run[]>([])
const shown = ref(0)

/**
 * The block the pointer is on, in either place it lives — a row in the shown
 * run's card, or its box on the page. Both light up together, which is how a
 * reading and the lettering it came from find each other.
 */
const hovered = ref<number | null>(null)

/**
 * The last cleaning, as an object URL of the whole page with the lettering
 * painted out — patches composited back over the scan, so what is judged is
 * the page rather than a row of crops.
 */
const cleaned = ref<{ url: string, patches: number, ms: number, model: string } | null>(null)

/** Which of the two the stage is showing. Off the moment a new page arrives. */
const showCleaned = ref(true)

/** Which model paints the lettering out — see `INPAINTERS`. */
// `InpainterModel`, because the bench compares models and `none` is not one:
// its own control lists `INPAINTERS`, which has never held it.
const inpainter = ref<InpainterModel>('aot')

function dropCleaned () {
  if (cleaned.value) URL.revokeObjectURL(cleaned.value.url)

  cleaned.value = null
}

/**
 * Detect, clean, and composite — the bench version of the cleanup step.
 *
 * The patches come back as small images and are drawn back onto a copy of
 * the scan here rather than in `cleanPage`, because compositing is what a
 * *bench* wants and not what the app will do: in the workspace each patch
 * belongs to its block's own surface, and the page is never flattened at
 * all. Doing it here keeps that decision out of the engine.
 */
async function runClean () {
  if (!scan.value || busy.value) return

  busy.value = 'Cleaning…'
  error.value = null

  const started = performance.now()

  try {
    const status = (message: string) => { busy.value = message }
    const regions = await detectWith(detector.value, page(), status)

    if (!regions.length) throw new Error('The detector found no lettering to clean.')

    const patches = await cleanPage(page(), regions, status, inpainter.value)

    const bitmap = await createImageBitmap(scan.value.file)
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const context = canvas.getContext('2d')!

    context.drawImage(bitmap, 0, 0)

    for (const patch of patches) {
      const image = await createImageBitmap(patch.image)

      context.drawImage(image, 0, 0, image.width, image.height, patch.x, patch.y, patch.w, patch.h)
      image.close()
    }

    bitmap.close()

    dropCleaned()

    cleaned.value = {
      url: URL.createObjectURL(await canvas.convertToBlob({ type: 'image/png' })),
      patches: patches.length,
      ms: Math.round(performance.now() - started),
      model: INPAINTERS.find((item) => item.id === inpainter.value)!.label,
    }
    showCleaned.value = true
  } catch (thrown) {
    error.value = thrown instanceof Error ? thrown.message : String(thrown)
  } finally {
    busy.value = null
  }
}

/**
 * Which model reads the crops — the shared list in `utils/ocr/readers.ts`,
 * so the bench and the workspace panel cannot drift apart about what exists.
 *
 * Desktop: starts on Kemolate OCR, the desktop's default reader (`useOcr`).
 * The web build's starts on Manga OCR, which is off this build's list — and the
 * label below is read with `!`, so the bench threw before it drew.
 */
const reader = ref<ReaderId>('kemolate-beta')

/** A reader that finds its own lettering — the detector choice does not reach it. */
const selfFinding = computed(() => Boolean(READERS_BY_ID.get(reader.value)?.detects))

const readerLabel = computed(() => READERS_BY_ID.get(reader.value)!.label)

/**
 * Which model finds the boxes — the shared list in `utils/ocr/detectors.ts`,
 * for the same reason the readers come from theirs. Grouped by family, because
 * picking between two models and picking between three builds of one are
 * different decisions and a flat list of six asks them as if they were one.
 */
const detector = ref<DetectorId>(DEFAULT_BUILD.comic)

/** Which builds this browser will fetch, for the sizes in the selects — see `useModelMachine`. */
const machine = useModelMachine()

const FAMILY_GROUPS = (Object.keys(FAMILIES) as FamilyId[]).map((id) => ({
  id,
  label: FAMILIES[id].label,
  builds: buildsOf(id),
}))

const { get: getKey } = useProviderKeys()

/** The selected reader, over whatever regions the caller found. */
async function readWith (regions?: Region[]) {
  const provider = READERS_BY_ID.get(reader.value)?.provider
  const key = provider ? await getKey(provider) : undefined

  if (provider && !key) throw new Error(`No ${provider} key yet — add one in settings.`)

  return readWithReader(reader.value, page(), regions, (message) => { busy.value = message }, {
    key: key ?? undefined,
  })
}

/** The image element the overlay is scaled to, however large it renders. */
const art = useTemplateRef<HTMLImageElement>('art')
const { width: drawn } = useElementSize(art)

/** Everything in `ReadBlock` is width-normalised, so one scale serves both axes. */
const overlay = computed(() => {
  const run = runs.value[shown.value]

  if (!run || !drawn.value) return []

  return run.blocks.map((block, index) => ({
    index,
    text: block.text,
    style: {
      left: `${block.cx * drawn.value}px`,
      top: `${block.cy * drawn.value}px`,
      width: `${block.w * drawn.value}px`,
      height: `${block.h * drawn.value}px`,
      transform: `translate(-50%, -50%) rotate(${block.angle}deg)`,
    },
  }))
})

/**
 * Put a page on the stage. Resolves once it is there, so a whole-chapter run
 * can wait for each page before measuring it.
 */
function open (file: File): Promise<void> {
  if (!file.type.startsWith('image/')) return Promise.resolve()

  if (scan.value) URL.revokeObjectURL(scan.value.url)

  const url = URL.createObjectURL(file)
  const image = new Image()
  const { promise, resolve } = Promise.withResolvers<undefined>()

  image.onload = () => {
    scan.value = { url, file, width: image.naturalWidth, height: image.naturalHeight }
    runs.value = []
    shown.value = 0
    hovered.value = null
    error.value = null
    dropCleaned()

    // What was measured here before, back on the stage — see `measured`.
    const kept = measured.get(place.value)

    if (kept) show(kept)

    resolve(undefined)

    // Segment straight away, in the background. The engines take their block
    // geometry from the det head and the seg-filtered ink *when a
    // segmentation exists* (`segmentedAlready`) — and a bench run made
    // before pressing Segment silently fell back to raw-ink geometry, which
    // read as the good measurements having vanished. The bench downloads
    // models freely by its own charter, so here the segmentation is simply
    // always on its way by the time a read finishes. Failure is ignored:
    // the fallback is exactly what ran before this line existed.
    segmentPage({ file, width: image.naturalWidth }).catch(() => {})
  }
  image.onerror = () => {
    URL.revokeObjectURL(url)
    error.value = 'That file could not be opened as an image.'
    resolve(undefined)
  }
  image.src = url

  return promise
}

/** The page at this place in the list, on the stage. */
function openAt (index: number): Promise<void> {
  const file = pages.value[index]

  if (!file) return Promise.resolve()

  place.value = index

  return open(file)
}

/** A new set of pages: the old one's measurements go with it. */
function load (files: File[]) {
  const images = files
    .filter((file) => file.type.startsWith('image/'))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))

  if (!images.length) return

  measured.clear()
  chapter.value = null
  pages.value = images
  openAt(0)
}

function onPick (event: Event) {
  load([...(event.target as HTMLInputElement).files ?? []])
}

function onDrop (event: DragEvent) {
  load([...event.dataTransfer?.files ?? []])
}

/** One engine's turn: time it, keep what it read, surface what it threw. */
async function bench (engine: string, read: () => Promise<ReadBlock[]>) {
  if (!scan.value || busy.value) return

  busy.value = `${engine}…`
  error.value = null

  const started = performance.now()

  try {
    const blocks = await read()

    runs.value.unshift({ engine, ms: Math.round(performance.now() - started), blocks })
    shown.value = 0
    hovered.value = null
  } catch (thrown) {
    error.value = thrown instanceof Error ? thrown.message : String(thrown)
  } finally {
    busy.value = null
  }
}

const page = () => ({ file: scan.value!.file, width: scan.value!.width })

const runWholePage = () =>
  bench(`${readerLabel.value} · whole page`, () => readWith())

/**
 * A detector for the boxes, the chosen reader for the words in them — the
 * pairing this lab exists to prove out. Both halves are local.
 *
 * The run is named with the detector's full label rather than its build, so
 * two runs a page apart cannot be told apart only by which was quicker — and
 * with no detector at all where the reader found its own lettering, because a
 * run named after a model it never loaded is a bench lying to itself.
 */
const runDetected = () =>
  bench(selfFinding.value ? readerLabel.value : `${fullLabel(detector.value)} + ${readerLabel.value}`, async () => {
    // A reader that finds its own lettering has nothing to be handed.
    if (READERS_BY_ID.get(reader.value)?.detects) return readWith()

    const found = await detectWith(detector.value, page(), (message) => { busy.value = message })

    if (!found.length) throw new Error('The detector found no lettering on this page.')

    return readWith(found)
  })

/**
 * Which way each block's lettering runs, from its own ink.
 *
 * The detector only draws upright boxes, so this asks the mask instead —
 * see `inkAngle`. Drawn rather than merely printed because an angle is the
 * one measurement you cannot check by reading a number: the box has to sit
 * on the words.
 */
const runRotation = () =>
  bench(`${fullLabel(detector.value)} + rotation`, async () => {
    const found = await detectWith(detector.value, page(), (message) => { busy.value = message })

    if (!found.length) throw new Error('The detector found no lettering to measure.')

    const bitmap = await createImageBitmap(scan.value!.file)
    const width = scan.value!.width

    try {
      return found.map((region) => {
        // Cropped at its own size, capped so a full-page sound effect does
        // not cost a megapixel to measure.
        const scale = Math.min(1, 512 / Math.max(region.w, region.h))
        const w = Math.max(8, Math.round(region.w * scale))
        const h = Math.max(8, Math.round(region.h * scale))

        const canvas = new OffscreenCanvas(w, h)
        const context = canvas.getContext('2d', { willReadFrequently: true })!

        context.drawImage(bitmap, region.x, region.y, region.w, region.h, 0, 0, w, h)

        const { data } = context.getImageData(0, 0, w, h)
        const rect = inkRect(autoMask(data, w, h, { x: 0, y: 0, w, h }), w, h)

        // Back out of the crop: undo the cap, then put it where the region
        // sits on the page. The box is the ink's own, not the detector's —
        // which is the whole point of measuring it.
        return {
          cx: (region.x + rect.cx / scale) / width,
          cy: (region.y + rect.cy / scale) / width,
          w: (rect.w / scale) / width,
          h: (rect.h / scale) / width,
          angle: rect.angle,
          text: `${rect.angle}°`,
          confidence: region.score,
        }
      })
    } finally {
      bitmap.close()
    }
  })

/**
 * The learned lettering mask, drawn over the page — see `segment.ts`.
 *
 * Two things at once, because they answer different doubts: the page tinted
 * where the model says "lettering" (the toggle flicks it against the
 * original, which is how a missed sound effect or a swallowed outline is
 * actually spotted), and a run card of per-region angles measured from that
 * mask — the same `inkRect`, handed a model's answer instead of a
 * threshold's.
 */
async function runSegment () {
  if (!scan.value || busy.value) return

  busy.value = 'Segmenting…'
  error.value = null

  const started = performance.now()

  try {
    const status = (message: string) => { busy.value = message }
    const whole = await segmentPage(page(), status)

    // The tint: the page, with the model's lettering in colour over it.
    const bitmap = await createImageBitmap(scan.value.file)
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const context = canvas.getContext('2d')!

    context.drawImage(bitmap, 0, 0)

    const tint = context.getImageData(0, 0, bitmap.width, bitmap.height)

    for (let y = 0; y < bitmap.height; y++) {
      const sy = Math.min(1023, Math.round(y * whole.scale))

      for (let x = 0; x < bitmap.width; x++) {
        const sx = Math.min(1023, Math.round(x * whole.scale))

        if (whole.seg[sy * 1024 + sx]! > 0.5) {
          const i = (y * bitmap.width + x) * 4

          tint.data[i] = 255
          tint.data[i + 1] = Math.round(tint.data[i + 1]! * 0.3)
          tint.data[i + 2] = Math.round(tint.data[i + 2]! * 0.3)
        }
      }
    }

    context.putImageData(tint, 0, 0)
    bitmap.close()

    dropCleaned()

    cleaned.value = {
      url: URL.createObjectURL(await canvas.convertToBlob({ type: 'image/png' })),
      patches: 0,
      ms: Math.round(performance.now() - started),
      model: 'Segmenter mask',
    }
    showCleaned.value = true

    // And the angles the mask implies, region by region.
    const found = await detectWith(detector.value, page(), status)
    const width = scan.value.width

    const blocks = found.map((region) => {
      const rect = inkRect(segFor(whole, region), Math.max(1, Math.round(region.w)), Math.max(1, Math.round(region.h)))

      return {
        cx: (region.x + rect.cx) / width,
        cy: (region.y + rect.cy) / width,
        w: rect.w / width,
        h: rect.h / width,
        angle: rect.angle,
        text: `${rect.angle}°`,
        confidence: region.score,
      }
    })

    runs.value.unshift({ engine: 'Segmenter + rotation', ms: Math.round(performance.now() - started), blocks })
    shown.value = 0
    hovered.value = null
  } catch (thrown) {
    error.value = thrown instanceof Error ? thrown.message : String(thrown)
  } finally {
    busy.value = null
  }
}

/** What each verdict is called on a run card — `RoomReason`, said for a person. */
const REASON: Record<RoomReason, string> = {
  room: 'room',
  found: 'room, in a balloon the detector did not draw',
  clear: 'room, in the clear paper round borderless lettering',
  skipped: 'hidden or rubbish — not measured',
  crowded: 'would cover another block\'s lettering',
  'not-balloon': 'text on art — no balloon to measure',
  tilted: 'tilted — an upright room would not fit it',
  'no-fence': 'no balloon drawn around it by the detector',
  shared: 'shares its balloon with another block',
  'no-paper': 'no paper under it',
  escaped: 'escaped',
  smaller: 'smaller than the block',
}

const ZERO = (): Record<RoomReason, number> => ({
  room: 0,
  found: 0,
  clear: 0,
  skipped: 0,
  crowded: 0,
  'not-balloon': 0,
  tilted: 0,
  'no-fence': 0,
  shared: 0,
  'no-paper': 0,
  escaped: 0,
  smaller: 0,
})

/** One page's Balloons run: the card, the tinted page, and how its verdicts fell. */
interface Measurement {
  run: Run
  tint: Blob
  counts: Record<RoomReason, number>
}

/**
 * Each page's Balloons run, kept for as long as the pages are — so stepping
 * back through a chapter shows what was measured there rather than a bare page,
 * and a whole-chapter run is something to flick through afterwards. The tint is
 * kept as a `Blob` and given a fresh URL when it is shown, because `dropCleaned`
 * revokes whatever URL is on screen.
 */
const measured = new Map<number, Measurement>()

/** How every verdict fell over the last whole-chapter run. */
const chapter = ref<(Record<RoomReason, number> & { pages: number }) | null>(null)

/**
 * Where each block's balloon is, and what the app would do with it — the same
 * `roomVerdicts` a reading and "Measure balloons" run, so what this bench shows
 * is what a chapter would store. See `rooms.ts` for the rules and `balloon.ts`
 * for the fill.
 *
 * Drawn so the balloons worth looking at stand out rather than hide: the fill
 * tinted blue where a room was kept, hatched red where it escaped and amber
 * where it came back smaller than the block, and the balloon the detector drew
 * dashed in yellow — the fence a leak had to get past. The overlay boxes are the
 * rooms where there is one and the detector's box where there is not, and every
 * card line says which verdict it got and why.
 *
 * The blocks are the detector's regions, upright, and not a reading: the reader
 * is where a lean is measured, so the "tilted" rule never fires on this bench.
 */
async function measureHere (status: (message: string) => void): Promise<Measurement> {
  const started = performance.now()
  const found = await detectWith(detector.value, page(), status)
  const sheet = await readSheet(scan.value!.file)

  if (!sheet) throw new Error('That page could not be decoded.')

  const width = scan.value!.width
  const scale = sheet.w / width
  const fences = fencesOf(found)
  const verdicts = roomVerdicts(sheet, found.map((region) => ({
    kind: region.label === 'text_free' ? 'sfx' : 'bubble',
    cx: (region.x + region.w / 2) / width,
    cy: (region.y + region.h / 2) / width,
    w: region.w / width,
    h: region.h / width,
  })), fences, width)

  const bitmap = await createImageBitmap(scan.value!.file)
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const context = canvas.getContext('2d')!

  context.drawImage(bitmap, 0, 0)
  bitmap.close()

  const counts = ZERO()
  const blocks: ReadBlock[] = []

  for (const [index, verdict] of verdicts.entries()) {
    const region = found[index]!
    const balloon = verdict.balloon

    counts[verdict.reason]++

    if (balloon) traceFill(context, balloon, 1 / scale, VERDICT_COLOUR[verdict.reason])

    const numbers = balloon
      ? ` · ${Math.round(balloon.room.w / scale)}×${Math.round(balloon.room.h / scale)} · ${(verdict.gain ?? 0).toFixed(1)}× · ${Math.round(balloon.share * 100)}% of ${balloon.sides} side${balloon.sides === 1 ? '' : 's'} · solid ${balloon.solidity.toFixed(2)}`
      : ''

    blocks.push({
      ...(verdict.room ?? {
        cx: (region.x + region.w / 2) / width,
        cy: (region.y + region.h / 2) / width,
        w: region.w / width,
        h: region.h / width,
      }),
      angle: 0,
      // Desktop: a round room says so, with its own size — the numbers above are the rectangle's.
      text: `${REASON[verdict.reason]}${verdict.room?.round ? ` · oval ${Math.round(verdict.room.w * width)}×${Math.round(verdict.room.h * width)}` : ''}${numbers}`,
      confidence: region.score,
    })
  }

  // The balloons the detector drew, dashed — the fence every fill is held to.
  context.setLineDash([Math.max(8, width / 150), Math.max(6, width / 200)])
  context.lineWidth = Math.max(2, width / 500)
  context.strokeStyle = 'rgba(234, 179, 8, 0.95)'

  for (const fence of fences) context.strokeRect(fence.x, fence.y, fence.w, fence.h)

  // Each block's Reading box — the detector's region, which is what a read
  // stores as the block's own box and what a translation is lettered into when
  // no room was kept. Drawn beside the room (the overlay box) so the two frames
  // a translation can get are compared on the page rather than in the numbers:
  // `letterBoxOf` falls from the room to exactly this.
  context.setLineDash([Math.max(4, width / 300), Math.max(4, width / 300)])
  context.lineWidth = Math.max(2, width / 700)
  context.strokeStyle = 'rgba(230, 0, 140, 0.9)'

  for (const region of found) context.strokeRect(region.x, region.y, region.w, region.h)

  return {
    run: { engine: 'Balloons', ms: Math.round(performance.now() - started), blocks },
    tint: await canvas.convertToBlob({ type: 'image/png' }),
    counts,
  }
}

/** A measurement put on the stage: its card first, its tint showing. */
function show (measurement: Measurement) {
  dropCleaned()

  cleaned.value = {
    url: URL.createObjectURL(measurement.tint),
    patches: 0,
    ms: measurement.run.ms,
    model: 'Balloon fill',
  }
  showCleaned.value = true

  runs.value.unshift(measurement.run)
  shown.value = 0
  hovered.value = null
}

/** The Balloons button: the page on the stage. */
async function runBalloons () {
  if (!scan.value || busy.value) return

  busy.value = 'Finding balloons…'
  error.value = null

  try {
    const measurement = await measureHere((message) => { busy.value = message })

    measured.set(place.value, measurement)
    show(measurement)
  } catch (thrown) {
    error.value = thrown instanceof Error ? thrown.message : String(thrown)
  } finally {
    busy.value = null
  }
}

/**
 * Every page, one after another, each kept to flick back through — and the
 * chapter's verdicts added up, which is the number to judge the rules by.
 */
async function runBalloonsAll () {
  if (!pages.value.length || busy.value) return

  error.value = null
  chapter.value = null
  measured.clear()

  const totals = { ...ZERO(), pages: 0 }
  const count = pages.value.length

  try {
    for (let index = 0; index < count; index++) {
      busy.value = `Page ${index + 1} of ${count}…`

      await openAt(index)

      const measurement = await measureHere((message) => { busy.value = `Page ${index + 1} of ${count}: ${message}` })

      measured.set(index, measurement)
      show(measurement)

      for (const reason of Object.keys(measurement.counts) as RoomReason[]) totals[reason] += measurement.counts[reason]
      totals.pages++
    }

    chapter.value = totals
  } catch (thrown) {
    error.value = thrown instanceof Error ? thrown.message : String(thrown)
  } finally {
    busy.value = null
  }
}

const runVision = () =>
  bench('Google Vision', async () => {
    const key = await getKey('vision')

    if (!key) throw new Error('No Vision key yet — add one in settings.')

    return readWithVision(key, page())
  })

onBeforeUnmount(() => {
  dropCleaned()

  if (scan.value) URL.revokeObjectURL(scan.value.url)
})
</script>

<template>
  <div class="bg-background text-foreground min-h-screen p-6">
    <div class="mx-auto flex max-w-6xl flex-col gap-4">
      <header class="flex flex-wrap items-center gap-3">
        <h1 class="mr-auto text-lg font-semibold">
          OCR lab
        </h1>

        <select
          v-model="detector"
          class="border-input h-9 rounded-md border bg-transparent px-2 text-sm"
          title="Which build finds the boxes"
        >
          <optgroup v-for="group in FAMILY_GROUPS" :key="group.id" :label="group.label">
            <option v-for="build in group.builds" :key="build.id" :value="build.id">
              {{ build.label }} · {{ formatBytes(detectorBytes(build, machine)) }}
            </option>
          </optgroup>
        </select>

        <select
          v-model="reader"
          class="border-input h-9 rounded-md border bg-transparent px-2 text-sm"
          title="Which model reads the boxes"
        >
          <option v-for="option in READERS" :key="option.id" :value="option.id" :title="option.note">
            {{ option.label }}<template v-if="readerBytes(option, machine)"> · {{ formatBytes(readerBytes(option, machine)!) }}</template>
          </option>
        </select>

        <UButton :disabled="!scan || !!busy" variant="secondary" @click="runWholePage">
          Whole page
        </UButton>
        <UButton :disabled="!scan || !!busy" @click="runDetected">
          Detector + reader
        </UButton>
        <UButton :disabled="!scan || !!busy" variant="secondary" @click="runRotation">
          Rotation
        </UButton>
        <UButton :disabled="!scan || !!busy" variant="secondary" @click="runSegment">
          Segment
        </UButton>
        <UButton :disabled="!scan || !!busy" variant="secondary" @click="runBalloons">
          Balloons
        </UButton>
        <UButton v-if="pages.length > 1" :disabled="!!busy" variant="secondary" @click="runBalloonsAll">
          Balloons · all {{ pages.length }} pages
        </UButton>
        <UButton :disabled="!scan || !!busy" variant="outline" @click="runVision">
          Vision
        </UButton>
        <select
          v-model="inpainter"
          class="border-input h-9 rounded-md border bg-transparent px-2 text-sm"
          title="Which model paints the lettering out"
        >
          <option v-for="option in INPAINTERS" :key="option.id" :value="option.id">
            {{ option.label }} · {{ formatBytes(option.bytes) }}
          </option>
        </select>

        <UButton :disabled="!scan || !!busy" variant="outline" @click="runClean">
          Clean
        </UButton>
      </header>

      <p v-if="busy" class="text-muted-foreground flex items-center gap-2 text-sm">
        <LoaderCircleIcon class="size-4 animate-spin" />
        {{ busy }}
      </p>
      <p v-else-if="error" class="text-destructive text-sm">
        {{ error }}
      </p>
      <p v-else class="text-muted-foreground text-sm">
        Drop a page, pick a detector and a reader, then run an engine. First runs
        download the model itself — the detector eleven megabytes, manga-ocr around
        two hundred, its 2025 retrain around one-forty, LaMa two hundred — and all of
        them are kept on this machine afterwards. The pages never leave it, except on
        a Vision run, which sends the page to Google.
      </p>

      <!--
        The cleaning, and the one control that matters for judging it: the
        same page with the lettering painted out, switchable against the
        original. Anything less than an exact swap in the same place hides
        the halo and the smeared tone that are the whole question.
      -->
      <div
        v-if="cleaned"
        class="border-border flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2 text-sm"
      >
        <span class="font-medium">Cleaned · {{ cleaned.model }}</span>
        <span class="text-muted-foreground text-xs">
          {{ cleaned.patches }} patch{{ cleaned.patches === 1 ? '' : 'es' }} · {{ cleaned.ms }} ms
        </span>
        <label class="ml-auto flex items-center gap-2 text-xs">
          <input v-model="showCleaned" type="checkbox" class="accent-primary">
          Show cleaned
        </label>
      </div>

      <!--
        The page list, where there is more than one: step through it, and see
        how a whole-chapter Balloons run came out before looking at any page.
      -->
      <div v-if="pages.length > 1" class="flex flex-wrap items-center gap-2 text-sm">
        <UButton size="sm" variant="outline" :disabled="place === 0 || !!busy" aria-label="Previous page" @click="openAt(place - 1)">
          <ChevronLeftIcon class="size-4" />
        </UButton>
        <span class="tabular-nums">{{ place + 1 }} / {{ pages.length }}</span>
        <UButton size="sm" variant="outline" :disabled="place === pages.length - 1 || !!busy" aria-label="Next page" @click="openAt(place + 1)">
          <ChevronRightIcon class="size-4" />
        </UButton>
        <span class="text-muted-foreground truncate">{{ pages[place]?.name }}</span>
        <span v-if="chapter" class="text-muted-foreground ml-auto text-xs">
          {{ chapter.pages }} pages ·
          {{ chapter.room }} room{{ chapter.room === 1 ? '' : 's' }} kept ·
          {{ chapter.found }} found without a detected balloon ·
          {{ chapter.clear }} in clear paper ·
          {{ chapter.crowded }} crowding another block ·
          {{ chapter.escaped }} escaped ·
          {{ chapter.smaller }} smaller than the block ·
          {{ chapter.shared }} sharing a balloon ·
          {{ chapter['no-fence'] }} with no balloon drawn ·
          {{ chapter['not-balloon'] }} on art<template v-if="chapter['no-paper']">
            · {{ chapter['no-paper'] }} with no paper</template>
        </span>
      </div>

      <p v-if="cleaned?.model === 'Balloon fill'" class="text-muted-foreground text-xs">
        Fills traced in <span class="font-medium text-green-600">green</span> where the room was kept,
        <span class="font-medium text-sky-500">sky blue</span> where a room was found round free text the detector drew no balloon for,
        <span class="font-medium text-purple-600">purple</span> where the room would cover another block,
        <span class="font-medium text-red-600">red</span> where the fill escaped and
        <span class="font-medium text-orange-500">orange</span> where it held but had less room than the block;
        <span class="font-medium text-yellow-500">yellow dashes</span> are the balloons the detector drew,
        <span class="font-medium text-pink-600">pink dashes</span> each block's Reading box — what a read stores and what
        the translation falls back to. The solid boxes are the rooms the translation is lettered into, or the
        Reading box where none was kept.
      </p>

      <div class="flex flex-col gap-4 lg:flex-row">
        <div
          class="border-border relative min-h-64 flex-1 overflow-auto rounded-lg border"
          @dragover.prevent
          @drop.prevent="onDrop"
        >
          <label
            v-if="!scan"
            class="text-muted-foreground flex h-64 cursor-pointer flex-col items-center justify-center gap-2"
          >
            <ImageUpIcon class="size-8" />
            <span class="text-sm">Drop pages here, or click to pick them</span>
            <input type="file" accept="image/*" multiple class="hidden" @change="onPick">
          </label>

          <div v-else class="relative inline-block">
            <!--
              One element, two sources. Swapping the `src` rather than
              stacking two images keeps the boxes measured against the same
              element whichever is showing — and makes the comparison a
              flick, which is the only way a halo is ever spotted.
            -->
            <img
              ref="art"
              :src="cleaned && showCleaned ? cleaned.url : scan.url"
              alt="The page being read"
              class="block max-w-full"
            >

            <div
              v-for="box in overlay"
              :key="box.index"
              class="absolute border-2"
              :class="box.index === hovered
                ? 'border-primary bg-primary/30 z-10'
                : 'border-primary/70 bg-primary/10'"
              :style="box.style"
              :title="box.text"
              @mouseenter="hovered = box.index"
              @mouseleave="hovered = null"
            />
          </div>
        </div>

        <aside class="flex w-full flex-col gap-3 lg:w-96">
          <div
            v-for="(run, index) in runs"
            :key="`${run.engine}-${runs.length - index}`"
            class="cursor-pointer rounded-lg border p-3 text-sm"
            :class="index === shown ? 'border-primary' : 'border-border'"
            @click="shown = index; hovered = null"
          >
            <div class="mb-2 flex items-baseline justify-between gap-2">
              <span class="font-medium">{{ run.engine }}</span>
              <span class="text-muted-foreground text-xs">
                {{ run.blocks.length }} block{{ run.blocks.length === 1 ? '' : 's' }} · {{ run.ms }} ms
              </span>
            </div>

            <ol v-if="run.blocks.length" class="flex flex-col gap-1">
              <li
                v-for="(block, at) in run.blocks"
                :key="at"
                class="-mx-1 flex gap-2 rounded-sm px-1"
                :class="{ 'bg-primary/15': index === shown && at === hovered }"
                @mouseenter="index === shown && (hovered = at)"
                @mouseleave="index === shown && (hovered = null)"
              >
                <span class="text-muted-foreground shrink-0 tabular-nums">{{ at + 1 }}.</span>
                <span class="break-anywhere min-w-0">{{ block.text }}</span>
                <span
                  v-if="block.confidence !== undefined"
                  class="text-muted-foreground ml-auto shrink-0 text-xs tabular-nums"
                >
                  {{ Math.round(block.confidence * 100) }}%
                </span>
              </li>
            </ol>
            <p v-else class="text-muted-foreground">
              Nothing read.
            </p>
          </div>

          <p v-if="scan && !runs.length" class="text-muted-foreground text-sm">
            No readings yet.
          </p>
        </aside>
      </div>
    </div>
  </div>
</template>
