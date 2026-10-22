<script setup lang="ts">
/**
 * Where the reader puts the keys the app spends on their behalf.
 *
 * Three, and they are theirs: their account with each provider, their bill,
 * their rate limit. The app does not hold one on anybody's behalf — what this
 * page saves is kept on this machine, encrypted by the operating system, and
 * handed only to the run that spends it, which calls Vision and OpenRouter
 * directly so the scans go on never leaving the machine.
 *
 * A field never shows a stored key, only what it ends in. That is not
 * decoration: a settings page that printed three secrets into the DOM is three
 * secrets in every screenshot and screen-share. Typing over a field replaces
 * that key; emptying one that was set removes it; leaving it alone leaves it
 * alone.
 *
 * ## Desktop: a partial port
 *
 * The web build's page, with two sections gone and one fact changed:
 *
 * - **No passcode** (`KeyPasscode`). There a key is sealed in the browser under
 *   a passcode so the server holding it cannot read it. Here nothing leaves the
 *   machine, and the keys are encrypted against the reader's own login by the
 *   OS — see `electron/keys.ts` — so there is no passcode to set and nothing is
 *   ever locked. What can still stop a save is the OS offering no real
 *   encryption, which the footer says in the web build's place for "set a
 *   passcode first".
 * - **No access tokens** (`AccessTokens`): those let an agent reach the MCP
 *   endpoint on a server, which the desktop app does not run.
 * - **The Vision advice** drops "and to this site": a key used from the desktop
 *   app is not sent from a website, so a referrer restriction would refuse it.
 *
 * ## Drawn over the workspace
 *
 * `App.vue` keeps the workspace mounted behind this page so coming back costs
 * nothing — which means the workspace's shortcuts, bound on the window, are
 * still listening. So this page stops every key press at its own root before
 * it can reach the window, and keeps focus inside itself: an arrow here does not
 * turn a hidden page, and Delete does not remove a block nobody can see. It is
 * modal over the workspace in fact, and says so (`role="dialog"`). Escape, or
 * the button at the top, goes back.
 */
import { ArrowLeftIcon, CheckIcon, ExternalLinkIcon, KeyRoundIcon, Trash2Icon } from '@lucide/vue'

import type { KeyStatus } from '../../electron/preload'

import Default from '~/layouts/Default.vue'

/**
 * What each key is for, in the reader's terms, and the one piece of advice that
 * actually protects it. "Keep it secret" helps nobody; "restrict it to this API"
 * is a thing they can go and do.
 */
const FIELDS = [
  {
    provider: 'vision' as const,
    label: 'Google Cloud Vision',
    use: 'Reads the lettering off a page.',
    advice: 'Restrict the key to the Vision API in the Google console.',
    href: 'https://console.cloud.google.com/apis/credentials',
    linkLabel: 'Google console',
  },
  {
    provider: 'openrouter' as const,
    label: 'OpenRouter',
    use: 'Translates the pages, through whichever model is picked.',
    advice: 'Give it a spending limit — a run over a long volume is a request per page.',
    href: 'https://openrouter.ai/keys',
    linkLabel: 'OpenRouter keys',
  },
  {
    provider: 'anthropic' as const,
    label: 'Anthropic',
    use: 'Translates through Claude directly, without OpenRouter in between.',
    advice: 'Only used when the chosen model is one of Anthropic’s own.',
    href: 'https://console.anthropic.com/settings/keys',
    linkLabel: 'Anthropic console',
  },
  {
    provider: 'deepseek' as const,
    label: 'DeepSeek',
    use: 'Translates through DeepSeek directly, without OpenRouter in between.',
    advice: 'Only used when the chosen model is one of DeepSeek’s own. Top it up with a small balance — it bills from that.',
    href: 'https://platform.deepseek.com/api_keys',
    linkLabel: 'DeepSeek platform',
  },
]

const { save: writeKeys, load, status, trouble, loaded } = useProviderKeys()

/** The web build's `useFetch('/api/settings/status')`: which keys are stored, by what each ends in. */
const stored = computed<KeyStatus['keys']>(() => status.value?.keys ?? [])

onMounted(load)

/** Nothing may be typed until the OS can keep it — the web build's "until there is a passcode". */
const ready = computed(() => loaded.value && Boolean(status.value?.available))

/** What is typed but not yet saved. Empty means "no change to this one". */
const drafts = ref<Record<string, string>>({})

const saving = ref(false)

const hintFor = (provider: string) => stored.value.find((key) => key.provider === provider)?.hint ?? null

/** Nothing to send is not a save — it is a press that should say so. */
const changed = computed(() => Object.values(drafts.value).some((value) => value.trim().length > 0))

async function save () {
  if (!changed.value) return

  saving.value = true

  try {
    // Only the fields with something in them. An untouched field must not be
    // sent at all, or an empty string would read as "clear this key".
    const patch = Object.fromEntries(
      Object.entries(drafts.value).filter(([, value]) => value.trim().length > 0),
    )

    await writeKeys(patch)

    drafts.value = {}

    toast.success('Keys saved')
  } catch (error) {
    toast.error('Those keys couldn’t be saved', {
      description: error instanceof Error ? error.message : String(error),
    })
  } finally {
    saving.value = false
  }
}

async function forget (provider: string, label: string) {
  try {
    // The empty string is the clear, which is the other half of the same rule.
    await writeKeys({ [provider]: '' })

    drafts.value[provider] = ''

    toast.success(`${label} key removed`)
  } catch (error) {
    toast.error('That key couldn’t be removed', {
      description: error instanceof Error ? error.message : String(error),
    })
  }
}

/* ---------- over the workspace ---------- */

const root = useTemplateRef<HTMLElement>('root')

/**
 * Back to the workspace this page was opened over — see `App.vue`, which keeps
 * it, and the route, which keeps its id while Settings is up — or to the list
 * when it was opened from there.
 */
const route = useRoute()

function back () {
  const id = route.params.workspaceId

  navigateTo(id ? `/w/${encodeURIComponent(id)}` : '/')
}

/**
 * Every key press stops here, on its way out of this page — see "Drawn over the
 * workspace" above. Escape is the one this page answers itself. A menu opened
 * from the title bar lives in a portal outside this element, so its own Escape
 * never arrives here to be mistaken for this one.
 */
function onKeys (event: KeyboardEvent) {
  event.stopPropagation()

  if (event.key === 'Escape') back()
}

/**
 * Focus kept inside, so a press always has a target here rather than the body,
 * which is outside this page and would reach the window's listeners.
 */
onMounted(() => root.value?.focus())

useEventListener(document, 'focusin', (event: FocusEvent) => {
  const target = event.target as Node | null

  // Only the body: a menu or a toast opened from here lives in a portal at the
  // body's end, and is meant to have focus.
  if (target === document.body) root.value?.focus()
})
</script>

<template>
  <div
    ref="root"
    role="dialog"
    aria-modal="true"
    aria-label="Settings"
    tabindex="-1"
    class="outline-none"
    @keydown="onKeys"
  >
    <Default>
      <div class="mx-auto flex w-full max-w-2xl flex-col gap-8 p-6">
        <header class="grid gap-1">
          <UButton variant="ghost" size="sm" class="text-muted-foreground mb-2 -ml-2 justify-self-start" @click="back">
            <ArrowLeftIcon class="size-4" />
            Back to the chapter
          </UButton>
          <h1 class="text-2xl font-semibold tracking-tight">
            Settings
          </h1>
          <p class="text-muted-foreground text-sm">
            The keys the app uses on your behalf.
          </p>
        </header>

        <section class="grid gap-4">
          <div class="flex items-center gap-2">
            <KeyRoundIcon class="text-muted-foreground size-4" />
            <h2 class="text-sm font-medium">
              API keys
            </h2>
          </div>

          <div
            v-for="field in FIELDS"
            :key="field.provider"
            class="border-border grid gap-2 rounded-md border p-4"
          >
            <div class="flex items-start justify-between gap-3">
              <div class="grid gap-0.5">
                <label :for="`key-${field.provider}`" class="text-sm font-medium">{{ field.label }}</label>
                <p class="text-muted-foreground text-xs">
                  {{ field.use }}
                </p>
              </div>

              <!--
                Says a key is stored and what it ends in — the way every provider
                prints them, so it can be checked against their own dashboard
                without either of us showing the thing itself.
              -->
              <span
                v-if="hintFor(field.provider)"
                class="text-muted-foreground flex flex-none items-center gap-1 font-mono text-[11px]"
              >
                <CheckIcon class="text-primary size-3.5" />
                {{ hintFor(field.provider) }}
              </span>
            </div>

            <div class="flex gap-2">
              <UInput
                :id="`key-${field.provider}`"
                v-model="drafts[field.provider]"
                type="password"
                autocomplete="off"
                spellcheck="false"
                :disabled="!ready"
                :placeholder="hintFor(field.provider) ? 'Type a new key to replace it' : 'Paste your key'"
                class="font-mono text-xs"
              />
              <UButton
                v-if="hintFor(field.provider)"
                variant="ghost"
                size="icon"
                :disabled="!ready"
                :aria-label="`Remove ${field.label} key`"
                @click="forget(field.provider, field.label)"
              >
                <Trash2Icon class="size-4" />
              </UButton>
            </div>

            <p class="text-muted-foreground text-xs">
              {{ field.advice }}
              <a
                :href="field.href"
                target="_blank"
                rel="noopener noreferrer"
                class="hover:text-foreground inline-flex items-center gap-0.5 underline underline-offset-2"
              >{{ field.linkLabel }}<ExternalLinkIcon class="size-3" /></a>
            </p>
          </div>

          <div class="flex items-center justify-between gap-4">
            <p class="text-muted-foreground text-xs">
              <template v-if="trouble">
                {{ trouble }}
              </template>
              <template v-else-if="!loaded">
                Checking…
              </template>
              <template v-else-if="!status?.available">
                {{ status?.reason }}
              </template>
              <template v-else>
                Kept on this computer, encrypted by your operating system under your
                login. Nothing is sent anywhere but to the service each key is for.
              </template>
            </p>
            <UButton size="sm" :disabled="!changed || saving || !ready" @click="save">
              {{ saving ? 'Saving…' : 'Save keys' }}
            </UButton>
          </div>
        </section>

        <!-- Desktop: models on an NVIDIA GPU, opt-in — see `SettingsCuda`. -->
        <SettingsCuda />

        <!-- Desktop: the MCP server, for an agent on this machine — see `SettingsMcp`. -->
        <SettingsMcp />

        <!-- Desktop: where the work is kept, and its backups — see `SettingsData`. -->
        <SettingsData />

        <!-- Desktop: the app's own updates — see `SettingsUpdates`. -->
        <SettingsUpdates />
      </div>
    </Default>
  </div>
</template>
