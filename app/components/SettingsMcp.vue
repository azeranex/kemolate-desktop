<script setup lang="ts">
/**
 * Settings › Agents: the MCP server, for an agent on this machine — desktop
 * only; see `electron/mcp.ts`.
 *
 * Off until switched on here, because it opens a port. On, it listens on this
 * machine alone and takes any client there, with no token — see
 * `electron/mcp.ts` for why.
 *
 * Claude Desktop is offered the bundle the installer carries (`kemolate.mcpb`,
 * from `mcpb/`), which it installs with its own dialog.
 *
 * Its own component rather than more of `pages/settings.vue`, which is the web
 * build's page and stays close to it.
 */
import { BotIcon, CheckIcon, CopyIcon, LoaderCircleIcon } from '@lucide/vue'

import type { McpStatus } from '../../electron/preload'

const bridge = typeof window === 'undefined' ? undefined : window.kemolate?.mcp

const status = ref<McpStatus | null>(null)
const busy = ref(false)
const port = ref('')
const copied = ref<string | null>(null)

function took (next: McpStatus) {
  status.value = next
  port.value = String(next.port)
}

onMounted(async () => {
  if (bridge) took(await bridge.status())
})

async function set (patch: { enabled?: boolean, port?: number }) {
  if (!bridge) return

  busy.value = true

  try {
    took(await bridge.set(patch))
  } catch (error) {
    toast.error('The MCP server could not be changed', { description: error instanceof Error ? error.message : String(error) })
  } finally {
    busy.value = false
  }
}

function keepPort () {
  const value = Number(port.value)

  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    port.value = String(status.value?.port ?? '')
    toast.error('A port is a whole number from 1024 to 65535.')

    return
  }

  if (value !== status.value?.port) set({ port: value })
}

const claudeCode = computed(() => `claude mcp add --transport http kemolate ${status.value?.url}`)

const json = computed(() => JSON.stringify({
  mcpServers: { kemolate: { type: 'http', url: status.value?.url } },
}, null, 2))

async function copy (what: string, text: string) {
  await navigator.clipboard.writeText(text)
  copied.value = what
  setTimeout(() => {
    if (copied.value === what) copied.value = null
  }, 1500)
}

/** The port the Claude Desktop bundle assumes — `DEFAULT_PORT` in `electron/mcp.ts`. */
const DEFAULT_PORT = 38427

/** Claude Desktop's install dialog, or why it could not be opened. */
async function addToClaude () {
  const failed = await bridge?.addToClaude()

  if (failed) toast.error('Could not open Claude Desktop', { description: failed })
}

/** One line on where things stand. */
const said = computed(() => {
  const now = status.value

  if (!now?.enabled) return 'Off. Nothing is listening.'
  if (now.error) return now.error
  if (!now.listening) return 'Starting…'

  return `Listening at ${now.url}, on this computer only.`
})
</script>

<template>
  <section v-if="bridge && status" class="grid gap-4">
    <div class="flex items-center gap-2">
      <BotIcon class="text-muted-foreground size-4" />
      <h2 class="text-sm font-medium">
        Agents
      </h2>
    </div>

    <div class="border-border grid gap-3 rounded-md border p-4">
      <div class="flex items-start justify-between gap-3">
        <div class="grid gap-0.5">
          <label for="mcp-enabled" class="text-sm font-medium">Let an agent work on your chapters (MCP)</label>
          <p class="text-muted-foreground text-xs">
            An MCP client on this computer — Claude Code, Claude Desktop, an editor — can list your workspaces,
            have pages read by Kemolate's own OCR, check and correct the reading, and translate. Pictures of a
            page come from the chapter open in this window, and nowhere else.
          </p>
        </div>
        <USwitch
          id="mcp-enabled"
          :model-value="status.enabled"
          :disabled="busy"
          @update:model-value="(on: boolean) => set({ enabled: on })"
        />
      </div>

      <p class="text-xs" :class="status.enabled && status.error ? 'text-destructive' : 'text-muted-foreground'">
        <LoaderCircleIcon v-if="busy" class="mr-1 inline size-3 animate-spin" />
        {{ said }}
      </p>

      <div class="grid gap-1.5">
        <label for="mcp-port" class="text-xs font-medium">Port</label>
        <UInput
          id="mcp-port"
          v-model="port"
          inputmode="numeric"
          class="w-32 font-mono text-xs"
          :disabled="busy"
          @blur="keepPort"
          @keydown.enter="keepPort"
        />
      </div>

      <div v-if="status.enabled" class="grid gap-2">
        <!-- Claude Desktop installs a bundle rather than taking an address — see `electron/mcp.ts`. -->
        <div v-if="status.bundle" class="grid gap-1.5">
          <p class="text-xs font-medium">
            Claude Desktop
          </p>
          <div class="flex flex-wrap items-center gap-2">
            <UButton size="sm" variant="outline" @click="addToClaude">
              Add to Claude Desktop
            </UButton>
            <button
              type="button"
              class="text-muted-foreground hover:text-foreground text-xs underline underline-offset-2"
              @click="bridge.showBundle()"
            >
              Show the file
            </button>
          </div>
          <p class="text-muted-foreground text-xs">
            <template v-if="status.port !== DEFAULT_PORT">
              Claude Desktop asks for the port as it installs Kemolate — enter {{ status.port }}.
            </template>
            Kemolate must be open for its tools to work; they appear in Claude by themselves once it is.
            If the button opens nothing, drag the file onto Claude Desktop’s Settings › Extensions.
          </p>
        </div>

        <div class="grid gap-1">
          <div class="flex items-center justify-between gap-2">
            <p class="text-xs font-medium">
              Claude Code
            </p>
            <UButton variant="ghost" size="sm" @click="copy('cli', claudeCode)">
              <CheckIcon v-if="copied === 'cli'" class="size-4" />
              <CopyIcon v-else class="size-4" />
            </UButton>
          </div>
          <pre class="bg-muted overflow-x-auto rounded-md p-2 font-mono text-xs break-all whitespace-pre-wrap">{{ claudeCode }}</pre>
        </div>

        <div class="grid gap-1">
          <div class="flex items-center justify-between gap-2">
            <p class="text-xs font-medium">
              Other clients
            </p>
            <UButton variant="ghost" size="sm" @click="copy('json', json)">
              <CheckIcon v-if="copied === 'json'" class="size-4" />
              <CopyIcon v-else class="size-4" />
            </UButton>
          </div>
          <pre class="bg-muted overflow-x-auto rounded-md p-2 font-mono text-xs">{{ json }}</pre>
        </div>
      </div>
    </div>
  </section>
</template>
