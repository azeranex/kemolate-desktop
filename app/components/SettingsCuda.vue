<script setup lang="ts">
/**
 * Settings' CUDA section — desktop only. The comic detector and Kemolate OCR on
 * an NVIDIA GPU; see `electron/cuda.ts` for why it is a separate process.
 *
 * One press is the whole of it for most readers: **Set up CUDA** makes the app
 * a Python of its own, in its own folder, with CUDA in it (`cudaSetup.ts`), and
 * switches CUDA on once it has proved it opens. It is about two gigabytes, and the
 * button says so before it is pressed rather than after. Remove gives them back.
 * A reader with an ML setup of their own can point at its Python instead, under
 * "Use another Python" — the way this section began, kept for them.
 *
 * Offered only where it can work: Windows on x64 with an NVIDIA card. Elsewhere
 * the section says what is missing, in a line, and stays out of the way.
 *
 * Its own component rather than more of `pages/settings.vue`, which is the web
 * build's page and stays close to it.
 */
import { CpuIcon, LoaderCircleIcon } from '@lucide/vue'

import type { CudaHello, CudaManaged, CudaProgress, CudaSettings } from '../../electron/preload'

import { cudaChanged } from '~/utils/ocr/cuda'

const cuda = typeof window === 'undefined' ? undefined : window.kemolate?.cuda

const settings = ref<CudaSettings | null>(null)
const managed = ref<CudaManaged | null>(null)
const python = ref('')
const found = ref<CudaHello | null>(null)

const testing = ref(false)
const setting = ref(false)
const progress = ref<CudaProgress | null>(null)
const removing = ref(false)
const confirming = ref(false)
const own = ref(false)

/** Whether the setting points at the app's own Python rather than one the reader named. */
const usesManaged = computed(() => Boolean(managed.value && settings.value?.python === managed.value.python))

async function refresh () {
  if (!cuda) return

  ;[settings.value, managed.value] = await Promise.all([cuda.settings().catch(() => null), cuda.managed().catch(() => null)])
  python.value = settings.value?.python ?? ''
  own.value = Boolean(settings.value?.python) && !usesManaged.value
}

onMounted(refresh)

const stop = cuda?.onProgress((next) => { progress.value = next })

onBeforeUnmount(() => stop?.())

async function configure (patch: Partial<CudaSettings>) {
  if (!cuda) return

  settings.value = await cuda.configure(patch)
  cudaChanged()
}

async function setup () {
  if (!cuda) return

  setting.value = true
  found.value = null
  progress.value = null

  try {
    found.value = await cuda.setup()
    cudaChanged()
    await refresh()
  } finally {
    setting.value = false
  }
}

async function remove () {
  if (!cuda) return

  if (!confirming.value) {
    confirming.value = true
    return
  }

  removing.value = true
  confirming.value = false

  try {
    await cuda.remove()
    cudaChanged()
    found.value = null
    await refresh()
  } finally {
    removing.value = false
  }
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

/** The setup's line, with a count where there is one — uv's own download is the only part with a size to show. */
const said = computed(() => {
  const now = progress.value

  if (!now) return 'Starting…'
  if (now.total) return `${now.message} ${formatBytes(now.done ?? 0)} of ${formatBytes(now.total)}`

  return now.message
})
</script>

<template>
  <section v-if="cuda && managed" class="grid gap-4">
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
            The comic detector and Kemolate OCR run on
            {{ managed.gpu ? `your ${managed.gpu}` : 'an NVIDIA card' }} instead of WebGPU — about twice as quick
            a page. Anything that goes wrong falls back to WebGPU.
          </p>
        </div>
        <USwitch
          id="cuda-enabled"
          :model-value="settings?.enabled ?? false"
          :disabled="!settings?.python || setting"
          @update:model-value="(on: boolean) => configure({ enabled: on })"
        />
      </div>

      <!-- Where it cannot work, one line saying why, and nothing to press. -->
      <p v-if="!managed.supported || !managed.gpu" class="text-muted-foreground text-xs">
        {{ !managed.supported ? 'Setting CUDA up here is for Windows on x64.' : 'No NVIDIA card was found on this computer.' }}
      </p>

      <!-- The one press. -->
      <div v-else-if="!managed.installed || setting" class="grid gap-2">
        <div class="flex items-center gap-3">
          <UButton size="sm" :disabled="setting" @click="setup">
            <LoaderCircleIcon v-if="setting" class="size-4 animate-spin" />
            {{ setting ? 'Setting up…' : 'Set up CUDA' }}
          </UButton>
          <UButton v-if="setting" variant="ghost" size="sm" @click="cuda.cancel()">
            Cancel
          </UButton>
        </div>
        <p v-if="setting" class="text-muted-foreground truncate font-mono text-[11px]">
          {{ said }}
        </p>
        <p v-else class="text-muted-foreground text-xs">
          Downloads about 2 GB — Python, onnxruntime-gpu, and NVIDIA's CUDA and cuDNN libraries — into
          this app's own folder. Nothing is installed anywhere else, and Remove takes all of it back.
          Needs a recent NVIDIA driver.
        </p>
      </div>

      <!-- Set up: what it takes, and the way back. -->
      <div v-else class="flex items-center justify-between gap-3">
        <p class="text-muted-foreground text-xs">
          The app's own Python, with CUDA — {{ formatBytes(managed.bytes) }} in its folder.
          <template v-if="!usesManaged">
            Not in use: CUDA is set to another Python below.
          </template>
        </p>
        <div class="flex flex-none gap-2">
          <UButton v-if="!usesManaged" variant="outline" size="sm" @click="configure({ python: managed.python }).then(refresh)">
            Use it
          </UButton>
          <UButton variant="ghost" size="sm" :disabled="removing" @click="remove">
            {{ removing ? 'Removing…' : confirming ? `Remove ${formatBytes(managed.bytes)}?` : 'Remove' }}
          </UButton>
        </div>
      </div>

      <p v-if="found" class="text-xs" :class="found.ready ? 'text-foreground' : 'text-destructive'">
        <template v-if="found.ready">
          Ready{{ found.device ? ` on ${found.device}` : '' }} — Python {{ found.python }}, onnxruntime {{ found.onnxruntime }}.
        </template>
        <template v-else>
          {{ found.error }}
        </template>
      </p>

      <button
        type="button"
        class="text-muted-foreground hover:text-foreground justify-self-start text-xs underline underline-offset-2"
        @click="own = !own"
      >
        {{ own ? 'Hide' : 'Use another Python' }}
      </button>

      <div v-if="own" class="grid gap-1.5">
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
          an ML environment of your own, if you have one.
        </p>
      </div>
    </div>
  </section>
</template>
