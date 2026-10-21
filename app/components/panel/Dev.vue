<script setup lang="ts">
/**
 * A bench for the things that are hard to look at on purpose.
 *
 * Every control here fires something the app normally only does when it goes
 * wrong, or when a long job finishes, or when somebody else moves — states you
 * would otherwise have to break the app to see, and which therefore get styled
 * once and never checked again. A toast is the clearest case: it is the last
 * thing anybody looks at and the first thing a stylesheet change quietly
 * ruins.
 *
 * It is a panel rather than a page because that is where the styling actually
 * has to hold. A toast on a bare route is a toast over nothing; here it lands
 * on the real canvas, over the real docks, at the real z-index, next to the
 * transfer readout in the status bar it has to sit above.
 *
 * Development only — see `PANEL_SECTIONS`, which leaves it out of a build. It
 * follows that nothing in here should be load-bearing.
 *
 * It presses the app's own `toast`, not sonner's, which is the point: bad news
 * lingers there far longer than anything else, and a toast with something to
 * press waits without a timer at all (see `utils/toast.ts`) — a difference to
 * look at rather than to bypass. It does mean two of the five outstay the rest,
 * and the one with an action outstays everything; there is a button below to
 * clear them.
 */

/** One press each, and one of every kind sonner draws differently. */
const KINDS = [
  { id: 'default', label: 'Default' },
  { id: 'success', label: 'Success' },
  { id: 'info', label: 'Info' },
  { id: 'warning', label: 'Warning' },
  { id: 'error', label: 'Error' },
] as const

type Kind = typeof KINDS[number]['id']

/**
 * Real sentences rather than "Lorem ipsum", because the thing being judged is
 * how a toast looks with what this app actually puts in one — two lines of
 * description wrapping under a title is the case that goes wrong, and it only
 * turns up if the text is as long as the real text.
 */
const SAMPLES: Record<Kind, { title: string, description: string }> = {
  default: { title: 'Nothing in particular happened', description: 'The plain one, with no icon and no colour to lean on.' },
  success: { title: 'Left “Zhongkit’s chapter”', description: 'The work stays where it is, and so does the record of what you did on it.' },
  info: { title: 'Sign in to share this workspace', description: 'An invitation needs somebody to have sent it.' },
  warning: { title: 'These aren’t this workspace’s pages', description: 'It holds 24 other pages. Nothing has been changed for anybody else.' },
  error: { title: 'Could not delete it', description: 'Only the owner can change the workspace itself.' },
}

function fire (kind: Kind) {
  const { title, description } = SAMPLES[kind]

  if (kind === 'default') toast(title, { description })
  else toast[kind](title, { description })
}

/** The one with something to press, which is a different shape again. */
function withAction () {
  toast.warning('Nothing could be read from “ch-04”', {
    description: 'If it has pages in it, press Reopen folder to let the browser in.',
    action: { label: 'Reopen folder', onClick: () => toast.success('Pretend that worked') },
  })
}

/**
 * The one that changes under you.
 *
 * Worth its own button: a promise toast is the only kind that has to look right
 * twice, and the swap from spinner to tick is where the width jumps if the
 * layout is wrong.
 */
function promised () {
  toast.promise(new Promise((resolve) => setTimeout(resolve, 1800)), {
    loading: 'Copying 24 pages…',
    success: 'Copied into this browser',
    error: 'Could not copy them',
  })
}

/** Several at once, which is the only way to see the stack and its spacing. */
function pileUp () {
  KINDS.forEach((kind, index) => setTimeout(() => fire(kind.id), index * 120))
}

const held = ref<string | number | null>(null)

/**
 * One that stays until it is dismissed, for looking at rather than catching.
 *
 * Everything else here is gone in four seconds, which is long enough to notice
 * a toast and nowhere near long enough to measure one.
 */
function stick () {
  if (held.value !== null) {
    toast.dismiss(held.value)
    held.value = null

    return
  }

  held.value = toast.info('This one waits', {
    description: 'Held open so it can be inspected. Press again to dismiss it.',
    duration: Number.POSITIVE_INFINITY,
  })
}

/*
 * Desktop: the web build's bench also raises the dialog a locked key vault asks
 * for its passcode with (`askForPasscode`, `KeyUnlock.vue`). There is no vault
 * here — keys are kept by the OS, and never locked (see `useProviderKeys`) — so
 * there is no dialog to look at, and its button is gone with it.
 */
</script>

<template>
  <UFieldGroup density="panel" class="grid gap-3">
    <div class="grid gap-1.5">
      <UFieldLabel>Toasts</UFieldLabel>
      <div class="grid grid-cols-2 gap-1.5">
        <UButton
          v-for="kind in KINDS"
          :key="kind.id"
          variant="outline"
          size="sm"
          @click="fire(kind.id)"
        >
          {{ kind.label }}
        </UButton>
        <UButton variant="outline" size="sm" @click="pileUp">
          All five
        </UButton>
      </div>
    </div>

    <div class="grid gap-1.5">
      <UFieldLabel>Shapes</UFieldLabel>
      <div class="grid gap-1.5">
        <UButton variant="outline" size="sm" @click="withAction">
          With an action button
        </UButton>
        <UButton variant="outline" size="sm" @click="promised">
          Promise — loading, then done
        </UButton>
        <UButton variant="outline" size="sm" @click="stick">
          {{ held === null ? 'One that stays open' : 'Dismiss the one that stays' }}
        </UButton>
        <UButton variant="ghost" size="sm" @click="toast.dismiss()">
          Clear them all
        </UButton>
      </div>
    </div>

    <p class="text-muted-foreground text-[11px] leading-relaxed">
      The toaster itself — position, width, rich colours, the close button — is
      set once in <code class="font-mono">app.vue</code>, and what it is made of
      is <code class="font-mono">ui/sonner</code>. This panel only presses it.
    </p>
  </UFieldGroup>
</template>
