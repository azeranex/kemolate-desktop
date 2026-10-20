<script setup lang="ts">
/**
 * Export as… — which pages, in what form, and a look at one before it is made.
 *
 * What it asks is what an export can differ by and nothing else: the format
 * (a PDF, or a zip of PNGs or JPEGs), the JPEG quality where there is JPEG in
 * it, and the pages — the same range slider Auto uses, starting on every page,
 * with All to put it back. It starts from this workspace's last export, which
 * is also what the File menu's plain "Export" repeats without asking.
 *
 * It says before anything is made what the export will leave out: lines with
 * no translation (not lettered — the board's orange stand-in is a reminder,
 * not something to print) and pages whose picture is not on this computer. A
 * reader finding either afterwards in a finished PDF is the thing to avoid.
 */
import { LoaderCircleIcon } from '@lucide/vue'

import type { ExportFormat, ExportSettings } from '~/composables/usePageExport'

import { EXPORT_DEFAULTS } from '~/composables/usePageExport'

const open = defineModel<boolean>('open', { default: false })

const { pages, at } = useComic()
const { progress, running, recall, shortfall, preview, run, stop } = usePageExport()

const format = ref<ExportFormat>(EXPORT_DEFAULTS.format)
const quality = ref(EXPORT_DEFAULTS.quality)

/** The range as the slider holds it — or null for every page, which is what All sets. */
const chosenRange = ref<{ from: number, to: number } | null>(null)

const FORMATS: { value: ExportFormat, label: string, note: string }[] = [
  { value: 'pdf', label: 'PDF', note: 'One file, a page per page, at 300 dpi.' },
  { value: 'png', label: 'PNG', note: 'A zip of lossless images — the largest, and exact.' },
  { value: 'jpeg', label: 'JPEG', note: 'A zip of compressed images — much smaller.' },
]

const range = computed(() => {
  const last = Math.max(1, pages.value.length)
  const from = Math.min(last, Math.max(1, chosenRange.value?.from ?? 1))
  const to = Math.min(last, Math.max(1, chosenRange.value?.to ?? last))

  return from <= to ? { from, to } : { from: to, to: from }
})

const everyPage = computed(() => range.value.from === 1 && range.value.to >= pages.value.length)

const span = computed({
  get: () => [range.value.from, range.value.to],
  set: (value: number[] | undefined) => {
    const [from, to] = value ?? []

    if (from && to) chosenRange.value = { from, to }
  },
})

const settings = computed<ExportSettings>(() => ({
  format: format.value,
  quality: quality.value,
  range: everyPage.value ? null : range.value,
}))

const missing = computed(() => shortfall(settings.value.range))

/* ---------- a look before it is made ---------- */

const previewUrl = ref<string | null>(null)
const previewing = ref(false)

function dropPreview () {
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)

  previewUrl.value = null
}

/** The page on screen if it is in the range, else the first one that is. */
async function look () {
  if (previewing.value) return

  previewing.value = true
  dropPreview()

  try {
    const here = at.value + 1
    const index = (here >= range.value.from && here <= range.value.to ? here : range.value.from) - 1
    const blob = await preview(index)

    previewUrl.value = blob ? URL.createObjectURL(blob) : null

    if (!blob) toast.warning('That page cannot be previewed', { description: 'Its picture is not on this computer.' })
  } catch (error) {
    toast.error('The preview could not be made', { description: error instanceof Error ? error.message : String(error) })
  } finally {
    previewing.value = false
  }
}

/* ---------- opening and running ---------- */

watch(open, async (now) => {
  if (!now) {
    dropPreview()

    return
  }

  const kept = await recall()

  format.value = kept?.format ?? EXPORT_DEFAULTS.format
  quality.value = kept?.quality ?? EXPORT_DEFAULTS.quality
  chosenRange.value = kept?.range ?? null
})

onBeforeUnmount(dropPreview)

async function go () {
  if (await run(settings.value)) open.value = false
}
</script>

<template>
  <UDialog v-model:open="open">
    <UDialogContent class="sm:max-w-md" @interact-outside="(event: Event) => { if (running) event.preventDefault() }">
      <UDialogHeader>
        <UDialogTitle>Export pages</UDialogTitle>
        <UDialogDescription>
          Each page as it looks on the board — cleaned, retouched and lettered — at the scan’s
          own resolution. Made here and downloaded; nothing is sent anywhere.
        </UDialogDescription>
      </UDialogHeader>

      <UFieldGroup data-density="popover">
        <UField>
          <UFieldLabel>Format</UFieldLabel>
          <UToggleGroup
            type="single"
            variant="outline"
            size="sm"
            class="w-full"
            :model-value="format"
            :disabled="running"
            @update:model-value="(value) => { if (value) format = value as ExportFormat }"
          >
            <UToggleGroupItem
              v-for="one in FORMATS"
              :key="one.value"
              :value="one.value"
              class="aria-pressed:text-primary flex-1"
            >
              {{ one.label }}
            </UToggleGroupItem>
          </UToggleGroup>
          <UFieldDescription>{{ FORMATS.find((one) => one.value === format)?.note }}</UFieldDescription>
        </UField>

        <UField v-if="format !== 'png'">
          <div class="flex items-center justify-between">
            <UFieldLabel>Quality</UFieldLabel>
            <span class="text-muted-foreground font-mono text-xs tabular-nums">{{ Math.round(quality * 100) }}%</span>
          </div>
          <USlider
            :model-value="[quality]"
            :min="0.5"
            :max="1"
            :step="0.01"
            :disabled="running"
            :label="(value) => `${Math.round(value * 100)}%`"
            aria-label="JPEG quality"
            @update:model-value="(value) => { if (value?.[0]) quality = value[0] }"
          />
        </UField>

        <UField>
          <UFieldLabel>Pages</UFieldLabel>
          <div class="grid gap-1.5 pt-1.5">
            <USlider
              v-model="span"
              :min="1"
              :max="Math.max(1, pages.length)"
              :step="1"
              :min-steps-between-thumbs="0"
              :disabled="pages.length < 2 || running"
              :label="(value) => String(value)"
              aria-label="Pages to export"
            />
            <div class="flex items-center justify-between gap-2">
              <span class="text-muted-foreground text-xs tabular-nums">
                <template v-if="everyPage">All {{ pages.length }} {{ pages.length === 1 ? 'page' : 'pages' }}</template>
                <template v-else>
                  {{ range.from === range.to ? `Page ${range.from}` : `Pages ${range.from}–${range.to}` }} of {{ pages.length }}
                </template>
              </span>
              <UButton variant="ghost" size="xs" :disabled="everyPage || running" @click="chosenRange = null">
                All
              </UButton>
            </div>
          </div>
        </UField>

        <!--
          What the export will leave out, said before it is made rather than
          found in the file afterwards.
        -->
        <div v-if="missing.untranslated || missing.noScan" class="border-border grid gap-1 rounded-md border px-2.5 py-2 text-xs">
          <p v-if="missing.untranslated">
            {{ missing.untranslated }} {{ missing.untranslated === 1 ? 'line has' : 'lines have' }} no translation
            yet and will be left blank.
          </p>
          <p v-if="missing.noScan">
            {{ missing.noScan }} {{ missing.noScan === 1 ? 'page has' : 'pages have' }} no picture on this
            computer and will be skipped.
          </p>
        </div>

        <!-- One page, drawn exactly as it will be exported — asked for, since it costs a second. -->
        <div class="grid gap-2">
          <UButton variant="outline" size="sm" :disabled="previewing || running" @click="look">
            <LoaderCircleIcon v-if="previewing" class="size-4 animate-spin" />
            {{ previewUrl ? 'Preview again' : 'Preview a page' }}
          </UButton>
          <img
            v-if="previewUrl"
            :src="previewUrl"
            alt="The first page of the export, as it will be made"
            class="border-border mx-auto max-h-72 rounded-sm border object-contain"
          >
        </div>

        <div v-if="progress" class="grid gap-1.5">
          <div class="flex items-baseline justify-between text-xs">
            <span>{{ progress.message }}</span>
            <span class="text-muted-foreground tabular-nums">{{ progress.page }} / {{ progress.pages }}</span>
          </div>
          <UProgress :model-value="progress.pages ? (progress.page / progress.pages) * 100 : 0" />
        </div>
      </UFieldGroup>

      <UDialogFooter>
        <UButton v-if="running" variant="outline" size="sm" @click="stop">
          Stop
        </UButton>
        <UButton v-else variant="outline" size="sm" @click="open = false">
          Cancel
        </UButton>
        <UButton size="sm" :disabled="running || !pages.length" @click="go">
          <LoaderCircleIcon v-if="running" class="size-4 animate-spin" />
          Export
        </UButton>
      </UDialogFooter>
    </UDialogContent>
  </UDialog>
</template>
