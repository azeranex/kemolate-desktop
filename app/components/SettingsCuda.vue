<script setup lang="ts">
/**
 * Settings' CUDA section — desktop only. The comic detector and Kemolate OCR on
 * an NVIDIA GPU, through a Python the reader already has; see `electron/cuda.ts`
 * for why it is a separate process and why the app does not ship CUDA itself.
 *
 * Its own component rather than more of `pages/settings.vue`, which is the web
 * build's page and stays close to it.
 *
 * Off until switched on, and switching it on does not start anything: the
 * process starts with the first page read. Test starts it now, whether or not
 * the switch is on, and says what it found — the Python, onnxruntime, the card
 * — or, in words, why not. A Python that is not there, or has no CUDA in it, is
 * the ordinary failure, and the reading carries on on WebGPU either way.
 */
import { CpuIcon, LoaderCircleIcon } from '@lucide/vue'

import type { CudaHello, CudaSettings } from '../../electron/preload'

import { cudaChanged } from '~/utils/ocr/cuda'

const cuda = typeof window === 'undefined' ? undefined : window.kemolate?.cuda

const settings = ref<CudaSettings | null>(null)
const python = ref('')
const testing = ref(false)
const found = ref<CudaHello | null>(null)

onMounted(async () => {
  settings.value = await cuda?.settings().catch(() => null) ?? null
  python.value = settings.value?.python ?? ''
})

async function configure (patch: Partial<CudaSettings>) {
  if (!cuda) return

  settings.value = await cuda.configure(patch)
  cudaChanged()
}

/** Kept as typed once the field is left, so Test and the next reading use it. */
async function keepPython () {
  if (python.value.trim() !== (settings.value?.python ?? '')) {
    await configure({ python: python.value.trim() })
    found.value = null
  }
}

async function test () {
  if (!cuda) return

  testing.value = true
  found.value = null

  try {
    await keepPython()
    found.value = await cuda.test()
  } finally {
    testing.value = false
  }
}
</script>

<template>
  <section v-if="cuda" class="grid gap-4">
    <div class="flex items-center gap-2">
      <CpuIcon class="text-muted-foreground size-4" />
      <h2 class="text-sm font-medium">
        NVIDIA GPU (CUDA)
      </h2>
    </div>

    <div class="border-border grid gap-3 rounded-md border p-4">
      <div class="flex items-start justify-between gap-3">
        <div class="grid gap-0.5">
          <label for="cuda-enabled" class="text-sm font-medium">Find and read the lettering on CUDA</label>
          <p class="text-muted-foreground text-xs">
            The comic detector and Kemolate OCR run on your NVIDIA card instead of WebGPU — several
            times quicker once warm. Anything that goes wrong falls back to WebGPU.
          </p>
        </div>
        <USwitch
          id="cuda-enabled"
          :model-value="settings?.enabled ?? false"
          :disabled="!settings"
          @update:model-value="(on: boolean) => configure({ enabled: on })"
        />
      </div>

      <div class="grid gap-1.5">
        <label for="cuda-python" class="text-xs font-medium">Python</label>
        <div class="flex gap-2">
          <UInput
            id="cuda-python"
            v-model="python"
            spellcheck="false"
            placeholder="C:\path\to\.venv\Scripts\python.exe"
            class="font-mono text-xs"
            @blur="keepPython"
            @keydown.enter="keepPython"
          />
          <UButton variant="outline" size="sm" :disabled="testing || !python.trim()" @click="test">
            <LoaderCircleIcon v-if="testing" class="size-4 animate-spin" />
            {{ testing ? 'Testing…' : 'Test' }}
          </UButton>
        </div>
        <p class="text-muted-foreground text-xs">
          One with <code class="font-mono">onnxruntime-gpu</code> and <code class="font-mono">numpy</code> installed —
          an ML environment on this machine usually has both. The app does not install CUDA itself.
        </p>
      </div>

      <p v-if="found" class="text-xs" :class="found.ready ? 'text-foreground' : 'text-destructive'">
        <template v-if="found.ready">
          Ready{{ found.device ? ` on ${found.device}` : '' }} — Python {{ found.python }}, onnxruntime {{ found.onnxruntime }}.
        </template>
        <template v-else>
          {{ found.error }}
        </template>
      </p>
    </div>
  </section>
</template>
