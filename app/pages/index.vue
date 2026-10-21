<script setup lang="ts">
/**
 * Everything you can open, from either direction.
 *
 * A workspace reaches this list two ways and they are genuinely different
 * things. One is **on this machine**: made in the browser, opened from a folder,
 * and known to nobody else — that is where every workspace starts, and where
 * plenty of them stay. The other is **shared with you**: a row in the database
 * saying you are a contributor, which arrives whether or not this computer has
 * ever held a page of it.
 *
 * Merged rather than listed apart, because from the reader's side they are one
 * question — what am I working on — and a workspace is routinely both: your own
 * chapter, opened here, that you have since invited somebody into. Two lists
 * would show it twice and make you work out that they were the same thing.
 *
 * The difference still shows, because it decides what happens when you click:
 * one opens immediately, the other may have to fetch its pages from whoever has
 * them.
 *
 * ## Desktop
 *
 * The "shared with you" direction is the app's own database
 * (`electron/database.ts`): the one person at this machine is always signed in
 * (`useUserSession`) and owns every workspace in it, so the script is the web
 * build's as written — the list from `/api/workspaces`, a new workspace made
 * there first (`mint`), rename and delete through it. The other direction is
 * this window's own index, which still names workspaces from before the
 * database and every chapter's folder or files. What changes is the wording:
 * no roles, no "Cloud" or "Local" badge (every row would wear the same one), no
 * signing in, and a delete that says what is true here. The page wears the
 * plain layout's title bar (`layouts/Default.vue`), as the web build's wore its
 * default layout.
 */
import { BookImageIcon, EllipsisVerticalIcon, LogOutIcon, PencilIcon, PlusIcon, Trash2Icon } from '@lucide/vue'

import type { WorkspaceRole } from '#shared/utils/roles'

import Default from '~/layouts/Default.vue'
import { PROJECT_EXTENSION } from '~/utils/project'
import { readThumb } from '~/utils/thumbs'

interface Row {
  id: string
  title: string
  /** When this browser last opened it, if it ever has. */
  opened: number | null
  /** What you may do in it, when the server knows about it. */
  role: WorkspaceRole | null
  /** Whether the pages are on this computer. */
  here: boolean
  /** An object URL onto its first page's thumbnail, where this browser has one. */
  cover: string | null
  /**
   * Whether it is a cloud workspace — known from the server's list when signed
   * in, and from this browser's own note of it when not. See `Workspace.cloud`.
   */
  cloud: boolean
}

const { all, create, purge, markKind } = useWorkspaces()
const { loggedIn } = useUserSession()
const { handOver } = useProjectFile()

/** Whether a dropped project is being given a workspace to land in. */
const importing = ref(false)

interface Remote { publicId: string, name: string, role: WorkspaceRole }

const local = ref<Workspace[]>([])
const remote = ref<Remote[]>([])

/**
 * One flag each, rather than one for the pair.
 *
 * The two sources have nothing in common but the list they end up in: reading
 * the browser's storage can hang for seconds when that storage is wedged, and
 * making the shared workspaces — which arrive in milliseconds — wait behind it
 * meant staring at placeholders for something already in hand.
 */
const reading = ref(true)
const asking = ref(true)

/**
 * The covers this browser holds, by scan hash — see `utils/thumbs.ts`.
 *
 * Read here rather than drawn straight from the file, because an OPFS read is
 * asynchronous and a template cannot await one. A workspace whose cover has not
 * arrived (or was never made, or belongs to somebody else's chapter) simply has
 * none, and the row shows its icon instead.
 */
const covers = ref<Record<string, string>>({})

async function loadCovers (found: Workspace[]) {
  for (const workspace of found) {
    if (!workspace.cover || covers.value[workspace.cover]) continue

    const image = await readThumb(workspace.cover).catch(() => null)

    if (image) covers.value = { ...covers.value, [workspace.cover]: URL.createObjectURL(image) }
  }
}

onBeforeUnmount(() => {
  for (const url of Object.values(covers.value)) URL.revokeObjectURL(url)
})

const loading = computed(() => reading.value && asking.value)

onMounted(() => {
  all()
    .then((found) => { local.value = found; loadCovers(found).catch(() => {}) })
    .catch(() => {})
    .finally(() => { reading.value = false })

  if (!loggedIn.value) {
    asking.value = false

    return
  }

  $fetch<Remote[]>('/api/workspaces')
    .then((found) => {
      remote.value = found

      // Noted in this browser's index as well, so that signed out the list can
      // still say these are cloud workspaces — see `Workspace.cloud`.
      for (const workspace of found) markKind(workspace.publicId, true).catch(() => {})
    })
    .catch(() => {})
    .finally(() => { asking.value = false })
})

/**
 * The two lists as one, keyed by the id in the address — which is the same
 * string on both sides, and the reason merging them needs no matching rule.
 */
const rows = computed<Row[]>(() => {
  const merged = new Map<string, Row>()

  for (const workspace of local.value) {
    merged.set(workspace.id, {
      id: workspace.id,
      title: workspace.title,
      opened: workspace.opened,
      role: null,
      here: true,
      cover: workspace.cover ? covers.value[workspace.cover] ?? null : null,
      cloud: Boolean(workspace.cloud),
    })
  }

  for (const workspace of remote.value) {
    const already = merged.get(workspace.publicId)

    merged.set(workspace.publicId, {
      id: workspace.publicId,
      // The server's name wins: it is the one everybody in the workspace sees,
      // and a local title is only ever this browser's note to itself.
      title: workspace.name,
      opened: already?.opened ?? null,
      role: workspace.role,
      here: already?.here ?? false,
      cover: already?.cover ?? null,
      cloud: true,
    })
  }

  return [...merged.values()].sort((a, b) => (b.opened ?? 0) - (a.opened ?? 0))
})

/**
 * A new workspace, made on the server first when there is somebody to make it
 * for.
 *
 * Signed in, a workspace is the server's from the moment it exists. It used to
 * be an id and nothing else — the row was written at whatever later moment
 * something happened to save, which in practice was the first reading (see
 * `useShared.claim`). That left a gap nobody could see the shape of: the
 * workspace was at its own address, listed on this machine, shareable-looking,
 * and answering 404 to every request about it. Anything that asked first and
 * acted second — the page list, the block sync, joining the swarm — simply had
 * nothing to talk to, and the invitation you could send pointed at a workspace
 * that was not there.
 *
 * Signed out it stays exactly as it was: an id and somewhere to go. There is no
 * account to hang a workspace on, and a local chapter is a thing this app is
 * meant to support rather than a state to be got out of.
 *
 * Best effort, and it navigates either way. A workspace the server would not
 * take is still perfectly good locally — that is the case above — and refusing
 * to open it would turn a bad minute for the network into a button that does
 * nothing.
 *
 * Split from `start` once a dropped project needed one too. The two gestures
 * differ in what happens *after* the id exists and not at all in what an id is,
 * and the paragraphs above are exactly the sort of decision that goes wrong
 * when it is written down twice.
 */
async function mint (): Promise<string> {
  const id = create()

  if (loggedIn.value) {
    await createWorkspace(id, UNTITLED).catch((error: unknown) => {
      console.warn('[kemolate] workspace not created on the server:', error)
    })
  }

  return id
}

async function start () {
  await navigateTo(`/w/${await mint()}`)
}

/**
 * A project dropped on the list: a workspace of its own, and the file waiting
 * in it.
 *
 * Always a *new* workspace, never the one nearest the pointer. Opening a
 * project replaces a chapter outright, so a drop that landed on a row would be
 * a destructive act aimed by a gesture with no aim in it — and the list is the
 * one place in the app with no chapter to mean. Making one is also what a
 * reader moving work between machines wants anyway.
 *
 * Nothing is unpacked here. The file is parked for the workspace being
 * navigated to and claimed on the other side once that page has stood itself
 * up — see `useProjectFile.handOver`, which says why the parking is keyed by
 * workspace and why it is only in memory.
 */
async function onProject (file: File) {
  if (importing.value) return

  importing.value = true

  try {
    const id = await mint()

    handOver(id, file)

    await navigateTo(`/w/${id}`)
  } finally {
    // The page is on its way out, but not always: `navigateTo` can be refused
    // by a guard, and an overlay left spinning over a list that is still here
    // is a page that looks broken.
    importing.value = false
  }
}

const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/* ---------- getting rid of one ---------- */

/**
 * Which of the two a row is offered, and never both.
 *
 * They are not degrees of the same act. Deleting destroys the chapter for
 * everybody in it; leaving gives up your own place and touches nothing anybody
 * else can see. The owner has only the first and a contributor only the second,
 * which is the server's rule as well — `manageWorkspace` against
 * `contributors.leave` — so this is the interface agreeing with it rather than
 * a second opinion about it.
 *
 * A workspace with no role at all is one the server has never heard of. There
 * is nothing to delete but what is in this browser, which is still a deletion
 * and still the right word for it.
 */
function offer (row: Row) {
  return row.role && row.role !== 'owner' ? 'leave' : 'delete'
}

/* ---------- renaming one ---------- */

/**
 * The row being renamed, and what it is being renamed to.
 *
 * A dialog rather than an in-place field, unlike the page list one panel along.
 * A page's name is a label on a tile and typing over it is cheap; a workspace's
 * is what everybody working on the chapter sees, and it is worth a moment and a
 * button. It also has somewhere to say so — see the description.
 */
const renaming = ref<Row | null>(null)
const proposed = ref('')
const saving = ref(false)

function beginRename (row: Row) {
  renaming.value = row
  proposed.value = row.title
}

/**
 * Keep it, unless there is nothing to keep.
 *
 * Trimmed and compared before anything is sent: a name reopened and closed
 * unchanged is not an edit, and the endpoint would log one. Empty is refused
 * rather than accepted as a blank title — the schema refuses it too, and this
 * is the interface agreeing rather than finding out by 400.
 */
async function commitRename () {
  const row = renaming.value
  const name = proposed.value.trim()

  if (!row || !name || name === row.title) {
    renaming.value = null

    return
  }

  saving.value = true

  const done = await renameWorkspace(row.id, name)

  saving.value = false

  if (!done) {
    toast.error('That workspace could not be renamed', {
      description: 'Only its owner can change the name, and the server has to be reachable.',
    })

    return
  }

  // Straight into the list rather than waiting for a refetch: the answer is
  // already known and the row is on screen.
  const held = rows.value.find((candidate) => candidate.id === row.id)

  if (held) held.title = name

  renaming.value = null
}

/** The row a confirmation is currently about, and which act it is confirming. */
const asked = ref<{ row: Row, act: 'delete' | 'leave' } | null>(null)

const working = ref(false)

function ask (row: Row) {
  asked.value = { row, act: offer(row) }
}

/**
 * Do it, once it has been agreed to.
 *
 * The server first and this browser second, deliberately. Local storage is the
 * only copy of what is on this machine, so wiping it before knowing the server
 * agreed would leave a workspace you can no longer open and have not left —
 * whereas the other order fails safely: the row is gone from the database and
 * this browser still holds a chapter it can be told to forget again.
 *
 * A workspace the server does not know about skips the first half entirely,
 * which is the ordinary case and not a failure.
 */
async function confirm () {
  const asking = asked.value

  if (!asking || working.value) return

  const { row, act } = asking

  working.value = true

  try {
    if (row.role) {
      // `everybody`, because this dialog says it deletes the chapter for
      // everybody in it — the server refuses a delete with other people still
      // in the workspace unless the caller says so by name. See
      // `workspaces.remove`.
      await $fetch(`/api/workspaces/${row.id}${act === 'leave' ? '/leave' : '?everybody=1'}`, {
        method: act === 'leave' ? 'POST' : 'DELETE',
      })
    }

    /**
     * The same erasing either way, and leaving is the case worth justifying.
     *
     * A workspace you have left is one the server will not let you open again,
     * so a record of it kept here is a row in the list that opens a chapter
     * with no standing and no way to get one back — and if the pages were
     * copied in rather than opened from a folder, a copy nothing points at.
     * The reader's own folder is never touched: `purge` cannot reach a handle,
     * only the note saying we had one.
     */
    await purge(row.id)

    local.value = local.value.filter((workspace) => workspace.id !== row.id)
    remote.value = remote.value.filter((workspace) => workspace.publicId !== row.id)

    toast.success(act === 'delete' ? `Deleted “${row.title}”` : `Left “${row.title}”`)
    asked.value = null
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    toast.error(act === 'delete' ? 'Could not delete it' : 'Could not leave it', { description: message })
  } finally {
    working.value = false
  }
}
</script>

<template>
  <!--
    The whole page is the target, which is what makes dropping a project
    discoverable at all — see `ProjectDrop`. It wraps rather than nests inside
    the column so that the margins either side of a narrow list are droppable
    too, which is most of the window on a wide screen.
  -->
  <Default>
    <ProjectDrop :busy="importing" @project="onProject">
      <div class="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-12">
        <header class="flex items-end justify-between gap-4">
          <div class="grid gap-1">
            <h1 class="text-xl font-semibold">
              Workspaces
            </h1>
            <!--
              What a new one will be, said where the button that makes it is.

              The two modes are the most consequential fork in the app and the
              quietest: pressing this signed out makes a chapter that exists in one
              browser, and pressing it signed in makes one with a record on the
              server — and until now the button looked identical either way. The
              scans are the same in both cases and that is worth repeating rather
              than assuming, because "cloud" invites exactly the wrong guess about
              where the pages went.
            -->
            <!-- Desktop: one mode only, and it is this computer. -->
            <p class="text-muted-foreground text-sm">
              Each one is a chapter: its pages, its reading, its translation and its lettering.
              All of it stays on this computer.
            </p>
          </div>

          <UButton size="sm" @click="start">
            <PlusIcon class="size-4" /> New workspace
          </UButton>
        </header>

        <!--
          Three states, and the empty one is only true once we have looked. Saying
          "nothing here" before the answer is in would be the same lie the canvas
          used to tell with the stand-in comic.
        -->
        <div v-if="loading" class="grid gap-2">
          <USkeleton v-for="row in 3" :key="row" class="h-16 w-full rounded-md" />
        </div>

        <UEmpty v-else-if="!rows.length" class="border-border rounded-md border border-dashed py-16">
          <UEmptyHeader>
            <UEmptyMedia variant="icon">
              <BookImageIcon />
            </UEmptyMedia>
            <UEmptyTitle>Nothing open yet</UEmptyTitle>
            <UEmptyDescription>
              Start a workspace and drop a folder of pages into it — or drop a
              <code>{{ PROJECT_EXTENSION }}</code> project file here to open work you exported
              somewhere else. The pages stay on this computer either way.
            </UEmptyDescription>
            <UEmptyContent>
              <UButton variant="outline" size="sm" @click="start">
                <PlusIcon class="size-4" /> New workspace
              </UButton>
            </UEmptyContent>
          </UEmptyHeader>
        </UEmpty>

        <!--
          The menu is a sibling of the link rather than a child of it. A button
          inside an anchor is a press the browser gives to the anchor as well, so
          opening the menu would also open the workspace — and stopping the event to
          prevent that takes the keyboard's version of it away too.
        -->
        <ul v-else class="grid gap-2">
          <li
            v-for="row in rows"
            :key="row.id"
            class="border-border hover:bg-muted/50 focus-within:ring-ring relative flex items-center gap-3 rounded-md border pr-2 transition-colors focus-within:ring-2"
          >
            <NuxtLink
              :to="`/w/${row.id}`"
              class="flex min-w-0 flex-1 items-center gap-3 py-3 pl-4 focus-visible:outline-none"
            >
              <!--
                The chapter's first page where this browser has it, and the icon
                where it does not — a workspace shared with you has no pages here
                yet, and a chapter opened a moment ago has not been identified.
                Fixed box either way, so the rows do not change height as covers
                arrive one by one.
              -->
              <div class="bg-muted flex h-11 w-8 flex-none items-center justify-center overflow-hidden rounded-xs">
                <img
                  v-if="row.cover"
                  :src="row.cover"
                  alt=""
                  class="size-full object-cover"
                  draggable="false"
                >
                <BookImageIcon v-else class="text-muted-foreground size-5" />
              </div>

              <div class="grid min-w-0 flex-1 gap-0.5">
                <span class="truncate text-sm font-medium">{{ row.title }}</span>
                <span class="text-muted-foreground text-xs">
                  <!--
                    What clicking will get you. "Opened here" is the only one that
                    promises pages; a workspace known only to the server may still
                    have to fetch them from whoever is holding them.
                  -->
                  <template v-if="row.opened">Opened {{ when.format(row.opened) }}</template>
                  <template v-else>Not opened here yet</template>
                </span>
              </div>

              <!--
                Desktop: no badge. In the web build it told a workspace with a role
                in the account apart from one only in this browser; here every
                workspace is this computer's, and kept in the app's database.
              -->

              <span class="text-muted-foreground hidden font-mono text-[10px] sm:inline">
                {{ row.id.slice(0, 8) }}
              </span>
            </NuxtLink>

            <UDropdownMenu>
              <UDropdownMenuTrigger as-child>
                <UButton
                  variant="ghost"
                  size="icon-sm"
                  class="text-muted-foreground hover:text-foreground flex-none"
                  :aria-label="`More for ${row.title}`"
                >
                  <EllipsisVerticalIcon class="size-4" />
                </UButton>
              </UDropdownMenuTrigger>
              <UDropdownMenuContent align="end" class="w-48">
                <!--
                  Offered on the same terms the server allows it: the name is a fact
                  about the chapter that everybody in it sees, so it is the owner's
                  to change — `manageWorkspace`, the same rule that decides between
                  Leave and Delete just below. A workspace with no role at all is
                  this browser's alone and has no row to rename; its title comes
                  from the folder, and renaming the *chapter* is what would change
                  it.
                -->
                <template v-if="row.role === 'owner'">
                  <UDropdownMenuItem @select="beginRename(row)">
                    <PencilIcon class="size-4" /> Rename workspace
                  </UDropdownMenuItem>
                  <UDropdownMenuSeparator />
                </template>

                <UDropdownMenuItem v-if="offer(row) === 'leave'" @select="ask(row)">
                  <LogOutIcon class="size-4" /> Leave workspace
                </UDropdownMenuItem>
                <UDropdownMenuItem v-else variant="destructive" @select="ask(row)">
                  <Trash2Icon class="size-4" /> Delete workspace
                </UDropdownMenuItem>
              </UDropdownMenuContent>
            </UDropdownMenu>
          </li>
        </ul>

        <!--
          One dialog for the list rather than one per row: only ever one question is
          being asked, and thirty copies of it in the markup is thirty dialogs to
          mount for a press that may never come.

          It says what will happen in the words of the thing that will happen — what
          is lost, and to whom. "Are you sure?" is a question nobody can answer,
          because it does not say what they are being asked to be sure about.
        -->
        <!--
          Renaming, which is not a confirmation and so not an AlertDialog: nothing
          is being destroyed and there is something to type.
        -->
        <UDialog :open="!!renaming" @update:open="(open: boolean) => { if (!open && !saving) renaming = null }">
          <UDialogContent>
            <UDialogHeader>
              <UDialogTitle>Rename “{{ renaming?.title }}”</UDialogTitle>
              <UDialogDescription>
                What the chapter is called for everybody working on it. The folder
                it was opened from keeps its own name.
              </UDialogDescription>
            </UDialogHeader>

            <UInput
              v-model="proposed"
              aria-label="Workspace name"
              maxlength="200"
              :disabled="saving"
              autofocus
              @keydown.enter.prevent="commitRename"
            />

            <UDialogFooter>
              <UButton variant="outline" :disabled="saving" @click="renaming = null">
                Cancel
              </UButton>
              <UButton :disabled="saving || !proposed.trim()" @click="commitRename">
                <USpinner v-if="saving" class="size-4" />
                Rename
              </UButton>
            </UDialogFooter>
          </UDialogContent>
        </UDialog>

        <UAlertDialog :open="!!asked" @update:open="(open: boolean) => { if (!open && !working) asked = null }">
          <UAlertDialogContent>
            <UAlertDialogHeader>
              <UAlertDialogTitle>
                {{ asked?.act === 'leave' ? `Leave “${asked?.row.title}”?` : `Delete “${asked?.row.title}”?` }}
              </UAlertDialogTitle>
              <UAlertDialogDescription>
                <template v-if="asked?.act === 'leave'">
                  You will not be able to open it again unless somebody invites you
                  back. The work stays where it is, and so does the record of what
                  you did on it.
                </template>
                <template v-else-if="asked?.row.role">
                  This deletes the chapter's work — the blocks, the translations,
                  the layers and the retouching. The pages themselves are your
                  files and are not touched. Kemolate's backups keep a copy of
                  the work for 30 days (Settings › Your data).
                </template>
                <template v-else>
                  This workspace exists only on this computer. Its blocks,
                  translations and layers go with it, along with any pages copied in
                  here — a folder you opened from is left alone.
                </template>
              </UAlertDialogDescription>
            </UAlertDialogHeader>
            <UAlertDialogFooter>
              <UAlertDialogCancel :disabled="working">
                Cancel
              </UAlertDialogCancel>
              <!--
                Not `AlertDialogAction`, which closes the dialog on press whatever
                happens next: the request can fail, and a dialog that has already
                gone leaves the refusal to a toast beside a row that is still there.
              -->
              <UButton
                :variant="asked?.act === 'leave' ? 'default' : 'destructive'"
                :disabled="working"
                @click="confirm"
              >
                <USpinner v-if="working" class="size-4" />
                {{ asked?.act === 'leave' ? 'Leave' : 'Delete' }}
              </UButton>
            </UAlertDialogFooter>
          </UAlertDialogContent>
        </UAlertDialog>
      </div>
    </ProjectDrop>
  </Default>
</template>
