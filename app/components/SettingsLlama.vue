<script setup lang="ts">
/**
 * Settings' local models section — desktop only. Language models run by the
 * app itself, from GGUF files on this computer: see `electron/llama.ts` for how,
 * and `BUILTIN_PREFIX` for how they reach the model pickers.
 *
 * One press sets it up, as CUDA's does: llama.cpp, pinned, into the app's own
 * folder, with the size on the button before it is pressed. Vulkan by default,
 * because it runs on any card; CUDA offered beside it where there is an NVIDIA
 * one, for the reader who wants a long prompt read quicker and has the space.
 *
 * The models are files the reader already has, or fetches themselves — LM
 * Studio's folder is looked in by default, so what they downloaded there is
 * here too. The app downloads no model: which one, at what size and in what
 * quantisation, is the reader's decision and their disk.
 */
import { BotIcon, FolderOpenIcon, LoaderCircleIcon } from '@lucide/vue'

import type { LlamaBuild, LlamaModel, LlamaProgress, LlamaStatus } from '../../electron/preload'

const llama = typeof window === 'undefined' ? undefined : window.kemolate?.llama

const status = ref<LlamaStatus | null>(null)
const models = ref<LlamaModel[]>([])
const progress = ref<LlamaProgress | null>(null)
const installing = ref<LlamaBuild | null>(null)
const failed = ref<string | null>(null)
const removing = ref(false)
const confirming = ref(false)

/** Context windows offered: an assistant turn is ~15–30k tokens, and VRAM pays for every one. */
const CONTEXTS = [16_384, 32_768, 65_536, 131_072]

const { refresh: refreshModels } = useModels()

async function refresh () {
  if (!llama) return

  status.value = await llama.status().catch(() => null)
  models.value = status.value?.build ? await llama.models().catch(() => []) : []
}

onMounted(refresh)

const stop = llama?.onProgress((next) => { progress.value = next })

onBeforeUnmount(() => stop?.())

async function install (build: LlamaBuild) {
  if (!llama) return

  installing.value = build
  failed.value = null
  progress.value = null

  try {
    const done = await llama.install(build)

    if (!done.ok) failed.value = done.error ?? 'Setup failed.'
    await refresh()
    await refreshModels()
  } finally {
    installing.value = null
  }
}

async function remove () {
  if (!llama) return

  if (!confirming.value) {
    confirming.value = true
    return
  }

  removing.value = true
  confirming.value = false

  try {
    await llama.remove()
    await refresh()
  } finally {
    removing.value = false
  }
}

async function chooseFolder () {
  const folder = await llama?.chooseFolder()

  if (!folder) return

  await llama!.configure({ folder })
  await refresh()
  await refreshModels()
}

async function setContext (context: number) {
  await llama?.configure({ context })
  await refresh()
}

const said = computed(() => {
  const now = progress.value

  if (!now) return 'Starting…'
  if (now.total) return `${now.message} ${formatBytes(now.done ?? 0)} of ${formatBytes(now.total)}`

  return now.message
})

const buildLabel = (build: LlamaBuild) => (build === 'cuda' ? 'CUDA' : 'Vulkan')
</script>

<template>
  <section v-if="llama && status" class="grid gap-4">
    <div class="flex items-center gap-2">
      <BotIcon class="text-muted-foreground size-4" />
      <h2 class="text-sm font-medium">
        Local models
      </h2>
    </div>

    <div class="border-border grid gap-3 rounded-md border p-4">
      <p class="text-muted-foreground text-xs">
        Run a language model on this computer for the assistant and for translation — free, private, and as quick as
        your GPU. Kemolate runs GGUF models with llama.cpp; you choose and download the model.
      </p>

      <p v-if="!status.supported" class="text-muted-foreground text-xs">
        Setting up local models here is for Windows on x64.
      </p>

      <!-- Setup: the press, or its progress. -->
      <div v-else-if="!status.build || installing" class="grid gap-2">
        <div class="flex flex-wrap items-center gap-2">
          <UButton size="sm" :disabled="Boolean(installing)" @click="install('vulkan')">
            <LoaderCircleIcon v-if="installing === 'vulkan'" class="size-4 animate-spin" />
            Set up — Vulkan, {{ formatBytes(status.sizes.vulkan) }}
          </UButton>
          <UButton v-if="status.gpu" variant="outline" size="sm" :disabled="Boolean(installing)" @click="install('cuda')">
            <LoaderCircleIcon v-if="installing === 'cuda'" class="size-4 animate-spin" />
            CUDA instead, {{ formatBytes(status.sizes.cuda) }}
          </UButton>
          <UButton v-if="installing" variant="ghost" size="sm" @click="llama.cancel()">
            Cancel
          </UButton>
        </div>
        <p v-if="installing" class="text-muted-foreground truncate font-mono text-[11px]">
          {{ said }}
        </p>
        <p v-else class="text-muted-foreground text-xs">
          Downloads llama.cpp {{ status.release }} into this app's own folder. Vulkan runs on any recent GPU<template v-if="status.gpu">
            ;
            CUDA reads long prompts quicker on your {{ status.gpu }} and needs no CUDA install
          </template>. Remove takes it all back.
        </p>
        <p v-if="failed" class="text-destructive text-xs">
          {{ failed }}
        </p>
      </div>

      <template v-else>
        <div class="flex items-center justify-between gap-3">
          <p class="text-muted-foreground text-xs">
            llama.cpp {{ status.release }} ({{ buildLabel(status.build) }}) — {{ formatBytes(status.bytes) }}.
            <template v-if="status.running">
              Loaded now: {{ status.running.model.split('/').pop() }}.
            </template>
          </p>
          <div class="flex flex-none gap-2">
            <UButton v-if="status.gpu && status.build === 'vulkan'" variant="outline" size="sm" @click="install('cuda')">
              Switch to CUDA
            </UButton>
            <UButton variant="ghost" size="sm" :disabled="removing" @click="remove">
              {{ removing ? 'Removing…' : confirming ? `Remove ${formatBytes(status.bytes)}?` : 'Remove' }}
            </UButton>
          </div>
        </div>

        <div class="grid gap-1.5">
          <label class="text-xs font-medium">Models folder</label>
          <div class="flex min-w-0 gap-2">
            <UInput :model-value="status.folder" readonly spellcheck="false" class="min-w-0 font-mono text-xs" />
            <UButton variant="outline" size="sm" @click="chooseFolder">
              <FolderOpenIcon class="size-4" />
              Choose…
            </UButton>
          </div>
          <p class="text-muted-foreground text-xs">
            Every <code class="font-mono">.gguf</code> in it is offered in the model pickers. A model that can see has
            its <code class="font-mono">mmproj-*.gguf</code> beside it, as LM Studio and Hugging Face lay them out.
          </p>
        </div>

        <div class="grid gap-1.5">
          <label class="text-xs font-medium">Context</label>
          <div class="flex flex-wrap gap-1.5">
            <UButton
              v-for="size in CONTEXTS"
              :key="size"
              size="sm"
              :variant="status.context === size ? 'default' : 'outline'"
              @click="setContext(size)"
            >
              {{ size / 1024 }}k
            </UButton>
          </div>
          <p class="text-muted-foreground text-xs">
            How much a model holds at once. The assistant needs 32k; more costs VRAM.
          </p>
        </div>

        <ul v-if="models.length" class="grid gap-1">
          <li v-for="model in models" :key="model.id" class="flex min-w-0 items-center justify-between gap-3 text-xs">
            <span class="min-w-0 truncate font-mono">{{ model.name }}</span>
            <span class="text-muted-foreground flex-none">{{ model.vision ? 'sees · ' : '' }}{{ formatBytes(model.bytes) }}</span>
          </li>
        </ul>
        <p v-else class="text-muted-foreground text-xs">
          No models in this folder yet. Download a GGUF — Gemma 4 26B A4B at Q4_K_M is a good start on a 24 GB card.
        </p>
      </template>
    </div>
  </section>
</template>
