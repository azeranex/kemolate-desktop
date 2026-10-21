<script setup lang="ts">
/**
 * The password a locked PDF is asking for.
 *
 * Mounted once at the root beside the toaster, for the same reason: what put
 * this question up is a file being read, and the read outlives whatever page
 * somebody happened to drop it on. It shows only when something is actually
 * waiting on an answer — see `utils/pdf/password.ts`, which is the whole of
 * the arrangement between the reader and this.
 *
 * The password is used and forgotten. It goes to the reader, opens the file,
 * and is gone with the attempt: nothing here saves it, offers to save it, or
 * lets it out of this machine. That is worth saying in the dialog too, because
 * a page asking for a password with no explanation is a page that has to earn
 * the typing.
 */
import { LockKeyholeIcon } from '@lucide/vue'

// Imported rather than auto-imported: `utils/pdf` is a family of internals —
// parsers, ciphers, filters — and only these two belong anywhere near a
// component, so the folder stays out of the global scope.
import { passwordWanted, stopAsking } from '~/utils/pdf/password'

const typed = ref('')

/**
 * Bound to the dialog rather than read from it: closing by any means — the
 * escape key, the overlay, the close button — has to answer the request, and
 * an unanswered one is a read that waits for ever.
 */
const open = computed({
  get: () => Boolean(passwordWanted.value),
  set: (next) => { if (!next) stopAsking() },
})

/**
 * What the dialog says, which outlives what it is asking about.
 *
 * The request is cleared the instant it is answered, but the dialog is still
 * on screen for as long as it takes to fade — and reading the request directly
 * meant the file's name vanished out of the sentence on the way out, leaving
 * "is locked" over an empty space. This keeps the last one for the fade.
 */
const asking = shallowRef(passwordWanted.value)

watch(passwordWanted, (next) => {
  // The box is emptied on every change, so a second book does not come up
  // holding the first one's password and a refused attempt starts blank rather
  // than leaving somebody to select-all over their own typing.
  typed.value = ''

  if (next) asking.value = next
})

function submit () {
  // Never the empty string: that is the password the reader already tried on
  // its own before deciding to ask, so submitting it would fail identically
  // and look like the button doing nothing.
  if (!typed.value) return

  passwordWanted.value?.answer(typed.value)
}
</script>

<template>
  <UDialog v-model:open="open">
    <UDialogContent class="sm:max-w-sm">
      <UDialogHeader>
        <UDialogTitle class="flex items-center gap-2">
          <LockKeyholeIcon class="size-4 shrink-0" />
          This PDF needs a password
        </UDialogTitle>
        <UDialogDescription>
          <span class="font-medium">{{ asking?.name }}</span> is locked. It stays
          on this computer — the password is used to open it and never saved or sent.
        </UDialogDescription>
      </UDialogHeader>

      <!--
        A form, so that Enter submits. A password dialog people have to reach
        for the mouse to answer is one that gets abandoned.
      -->
      <form class="grid gap-2" @submit.prevent="submit">
        <ULabel for="pdf-password" class="sr-only">Password</ULabel>
        <UInput
          id="pdf-password"
          v-model="typed"
          type="password"
          autocomplete="off"
          placeholder="Password"
          :aria-invalid="asking?.again || undefined"
          :aria-describedby="asking?.again ? 'pdf-password-error' : undefined"
          autofocus
        />

        <!--
          Only after one has been refused. Saying "that didn't work" before
          anything has been tried is telling somebody off for nothing.
        -->
        <p v-if="asking?.again" id="pdf-password-error" class="text-destructive text-xs">
          That password didn’t open it. Try again, or the owner password if you have one.
        </p>

        <UDialogFooter class="mt-2">
          <UButton type="button" variant="ghost" size="sm" @click="stopAsking">
            Skip this file
          </UButton>
          <UButton type="submit" size="sm" :disabled="!typed">
            Open
          </UButton>
        </UDialogFooter>
      </form>
    </UDialogContent>
  </UDialog>
</template>
