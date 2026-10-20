<script setup lang="ts">
import { PanelLeftIcon, PanelRightIcon } from '@lucide/vue'

/**
 * The workspace shell: an optional tool rail down the left edge, and the canvas
 * column — context bar, work area, status bar — between two resizable docks.
 *
 * Migrated from the web build's `layouts/workspace.vue`. Its brand bar is not
 * here: in the desktop app the window's own title bar (`TitleBar`) is the strip
 * across the top, and what the brand bar held — the workspace's breadcrumb,
 * actions, notifications, the account — moves into that as each arrives.
 *
 * The layout owns the frame and nothing else; every region is a slot, so a page
 * fills in the controls it actually has. `rail` falls back to the standard tool
 * rail — the tools are the same wherever the pointer is, so a page only fills
 * this in to replace them, or with an empty template to work without any at
 * all; `panel-left` and `panel-right` fall back to the standard docks, whose
 * columns and contents the user arranges themselves — see `usePanelDock`.
 *
 * Both docks collapse away to nothing entirely, from the buttons in the header
 * — which is the only place that still works once a dock has no width left to
 * click in. That is a different thing from compacting a column to its icons,
 * which is the dock's own business and leaves it on screen.
 */

/** The one call the layout needs off a resizable panel, and nothing else. */
interface DockHandle {
  resize: (size: number) => void
}

const { layout, dragging, dockWidth, setDockWidth, moveSection, endDrag, shown } = usePanelDock()

usePanelLayoutStorage()

const docks = {
  left: useTemplateRef<DockHandle>('leftDock'),
  right: useTemplateRef<DockHandle>('rightDock'),
}

/**
 * Something arriving in an empty dock shows it; the last thing leaving hides
 * it again. Only the change counts, not the count itself — a dock that has
 * been put away by hand has things in it and is meant to stay away.
 *
 * This is also what settles the docks on the way in. The arrangement is read
 * back from storage after mount, which is a dock going from empty to full
 * like any other: without it, a panel left in a dock that starts hidden comes
 * back sealed inside one, present in the page, nought pixels wide, and not
 * draggable back out because there is nothing left of it to take hold of.
 */
watch(() => DOCK_SIDES.map((side) => layout.value[side].length), (counts, previous) => {
  DOCK_SIDES.forEach((side, index) => {
    const had = previous?.[index] ?? 0

    if (counts[index] && !had) shown.value[side] = true
    else if (!counts[index] && had) shown.value[side] = false
  })
}, { immediate: true })

/**
 * The docks are sized in pixels rather than as a share of the window: a panel
 * of controls needs the width its controls need, and no more of a wide screen
 * than of a narrow one.
 *
 * Every one of these is the columns added up, so a dock is only ever as wide
 * as what is in it — pull a section out into a new column and the dock widens
 * by a column, fold one down to icons and it narrows to a rail, handing the
 * room back to the canvas rather than keeping a gap where the panel was.
 */
const size = computed(() => Object.fromEntries(DOCK_SIDES.map((side) => [side, {
  want: dockWidth(side),
  min: dockWidth(side, 'min'),
}])) as Record<DockSide, { want: number, min: number }>)

/**
 * How much room the three panels divide between them, so the sizes below can
 * be stated as shares of it.
 *
 * The group works in shares. Given pixels it converts them, and to convert
 * them it has to have measured itself — which the server cannot do, having no
 * window. Every figure it was handed was therefore a guess about a width it
 * would only meet later, the three did not come to the width they were laid
 * out in, and the group made them fit the only way it can: by scaling all
 * three. A dock saved at its minimum came back half as wide again, then shrank
 * to its real width once the page was running. The arrangement arrived
 * visibly late, which is the one thing rendering it on the server was supposed
 * to prevent.
 *
 * So the room is what is remembered, rather than any panel's width. A width is
 * a result of the arrangement, and remembering a result means writing the
 * wrong one back after a load that got it wrong — each reload creeping closer
 * to the truth without arriving. How much room there is does not depend on how
 * the room is divided, so it is right the first time.
 *
 * Less the two handles, which are a pixel each and are not anybody's share.
 *
 * The desktop app has no server render, but the problem has not gone with it:
 * the sizes below are frozen at setup, before the group has been measured, so
 * the room still has to be known before it can be measured. Remembered in local
 * storage rather than a cookie — read synchronously, before the first render.
 */
const groupWidth = useLocalStorage<number>('panel-group', 1280)

const group = useTemplateRef<HTMLElement>('group')
const { width: measured } = useElementSize(group)

watch(measured, (width) => {
  if (width > 1) groupWidth.value = Math.round(width)
})

// Measured once there is a window, remembered until then — so the first render
// and every one after it agree, and nothing has to guess.
const room = computed(() => Math.max(1, (measured.value || groupWidth.value) - 2))

/**
 * A width, as the group wants to hear it.
 *
 * Shares rather than pixels, and not only because the server cannot convert
 * pixels. A share is at most a hundred, and the group writes whatever it is
 * given into `flex-grow` to three significant figures — so a canvas of one
 * thousand four hundred and eighteen pixels was written `1.42e+3`, which is a
 * number CSS does not accept, in a declaration it therefore threw away, on the
 * one panel the whole window is laid out around.
 */
function share (width: number) {
  return width / room.value * 100
}

/**
 * The three sizes the group is first given, taken once and never changed.
 *
 * A default is only read when a panel registers itself, which is on mount, and
 * refreshed only when that panel's *limits* move. Fold a column to a rail and
 * the dock's limits move, so the dock hands the group a new default — while
 * the canvas, whose own limits have not moved, is still holding the one it
 * registered with. The group works the layout out afresh from both, and two
 * figures answering different questions do not come to a whole. It said so,
 * and put it right, several times a click.
 *
 * Frozen, they always agree, because they are the same three numbers that
 * agreed at the start; every recomputation reproduces the arrangement the page
 * opened with, and the watch below moves it on to the current one. They are
 * taken before anything is measured — the room comes from the cookie — so the
 * server and the first client render arrive at them identically.
 */
const initial = (() => {
  const docks = Object.fromEntries(
    DOCK_SIDES.map((side) => [side, shown.value[side] ? share(size.value[side].want) : 0]),
  ) as Record<DockSide, number>

  return { ...docks, canvas: Math.max(share(320), 100 - docks.left - docks.right) }
})()

// The docks follow the layout; the layout follows the user dragging a dock's
// edge. Both directions settle, because sharing a width out over the columns
// does not change what they add up to — so this asks for a size the group is
// already at, and the group says nothing back.
//
// `shown` is watched alongside the sizes because putting a dock away, or
// bringing it back, changes what there is to go round without changing what
// any dock is worth. The one left on screen is squeezed to make room and has
// to be told, afterwards, that it is still owed its full width.
watch([size, shown, room], ([next]) => {
  for (const side of DOCK_SIDES) {
    if (shown.value[side]) docks[side].value?.resize(share(next[side].want))
  }
}, { deep: true, flush: 'post' })

/**
 * Whether the width a dock is reporting is one the user asked it for.
 *
 * A dock is told its size by the group for all sorts of reasons that are not
 * someone dragging its edge — the window narrowing, the other dock opening,
 * the canvas refusing to go below its minimum. Written back, every one of
 * those would be taken for a preference, and a dock squeezed by something
 * temporary would stay squeezed once the reason had gone away. So only a
 * handle actually under the pointer counts as the user saying anything.
 */
const dragged = ref(false)

function onDockResize (side: DockSide, size: number) {
  // Collapsing reports zero on the way past; it is not a width anyone chose.
  if (!dragged.value || !shown.value[side] || size < 0.01) return

  setDockWidth(side, size / 100 * room.value)
}

/**
 * Where a section can be let go to open a dock that has been put away.
 *
 * A dock with no width is not something a drag can be dropped on, and the side
 * that has been put away is exactly the one a section is most likely being
 * carried to. Picking a section up used to open both docks for the length of
 * the drag, which is the obvious answer and the wrong one: a dock opening takes
 * its width from the panels beside it, so the other dock is squeezed, and the
 * section being dragged — which lives in it — is laid out again underneath the
 * pointer. A browser reads its drag source moving as the drag having gone away,
 * and ends it there and then. Two columns is enough of a squeeze to do it, so
 * the panel was dropped before it had travelled a pixel.
 *
 * So nothing in the flow moves. The strip is drawn over the edge instead, out
 * of the layout entirely, and the dock it stands for opens once something has
 * landed in it.
 */
const dropEdge = ref<DockSide | null>(null)

/** Only the sides that have been put away need one; the rest can be aimed at. */
const edges = computed(() => (dragging.value ? DOCK_SIDES.filter((side) => !shown.value[side]) : []))

function onEdgeOver (side: DockSide, event: DragEvent) {
  if (!dragging.value) return

  // Without this the browser reads the strip as refusing the drop.
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'

  dropEdge.value = side
}

function onEdgeDrop (side: DockSide, event: DragEvent) {
  const id = dragging.value

  if (!id) return

  event.preventDefault()

  // As a column against the outer edge of that side — beyond whatever the dock
  // was already holding when it was put away.
  moveSection(id, { side, kind: 'column', index: side === 'left' ? 0 : layout.value[side].length })

  // A dock that has just been dropped into is one the user means to see. The
  // watch above only speaks for docks going from empty to full, and this one
  // may have had columns in it the whole time it was away.
  shown.value[side] = true
  endDrag()
}

watch(dragging, (id) => {
  if (!id) dropEdge.value = null
})
</script>

<template>
  <UTooltipProvider :delay-duration="350">
    <!-- Fills what the title bar leaves, rather than the screen: the window is the title bar and this. -->
    <div class="bg-background text-foreground flex min-h-0 flex-1 flex-col overflow-hidden text-sm">
      <!-- something that happened, said across the full width -->
      <slot name="banner" />

      <!-- rail │ dock │ canvas column │ dock -->
      <div class="flex min-h-0 flex-1">
        <slot name="rail">
          <ToolRail />
        </slot>

        <!--
          `relative` for the drop strips below, which are positioned against
          this rather than against the group: an absolute child of the group
          would be a child reka reads as one of its panels.
        -->
        <div ref="group" class="relative flex min-w-0 flex-1">
          <!--
            No `auto-save-id`: the group would keep its own copy of the sizes
            in local storage and put them back after hydration, which is both
            a second answer to a question the layout already answers and the
            very flash the layout cookie is there to avoid.
          -->
          <UResizablePanelGroup direction="horizontal" class="min-w-0 flex-1">
            <!--
              Starts at whatever the arrangement says, which for a dock with
              nothing in it is nothing: the left dock is empty until something
              is dragged into it, and an empty dock has no business holding a
              fifth of the window open.

              The default is what the server renders, and it is taken from the
              layout rather than fixed, so a dock the user left open comes back
              open, at its own width, in the first paint — see the cookie in
              `usePanelDock`. Fixed, it would render shut and then spring open
              a moment after the page appeared.

              Held at nothing by a maximum of nothing, rather than just by being
              collapsed. Any change of size anywhere in the group has to put the
              width it frees somewhere, and a dock that is merely collapsed is
              still somewhere — fold the other dock's column to icons and the
              three hundred pixels it gives up land here, opening a dock the user
              put away rather than widening the canvas.

              Nought or nothing at all, though, and never a figure: a maximum
              that moved with what the dock held was one the group had to
              enforce the moment it dropped, and it enforced it by shrinking
              this panel without giving the width to anybody — a layout whose
              parts no longer came to a whole, which it then complained about
              and put right itself. The canvas keeps a minimum of its own, so
              there was never a second thing here worth saying.
            -->
            <UResizablePanel
              ref="leftDock"
              :default-size="initial.left"
              :min-size="shown.left ? share(size.left.min) : 0"
              :max-size="shown.left ? undefined : 0"
              @resize="onDockResize('left', $event)"
            >
              <slot name="panel-left">
                <Dock side="left" />
              </slot>
            </UResizablePanel>

            <!--
              Emptied rather than removed when the dock beside it is away.
              A handle is the line between two things, and with the dock at no
              width it is a divider with nothing on the far side of it — drawn
              hard against the tool rail's own border, which is where it reads
              as a second, unexplained edge.

              It keeps its pixel because the room is measured as the group less
              two handles, and a handle that came and went would move that by
              one every time a dock was put away. Its pointer events go with the
              colour: an invisible line that still took a drag is a line that
              cannot be resized to anything, since a dock that is away is held
              at a maximum of nought.
            -->
            <UResizableHandle
              :class="!shown.left && 'pointer-events-none bg-transparent'"
              @dragging="dragged = $event"
            />

            <!--
              Whatever the docks have not claimed, stated so rather than left
              to be worked out: the three sizes then come to a hundred exactly,
              which is the whole of why nothing has to be corrected after the
              page appears — see `share`.
            -->
            <UResizablePanel :default-size="initial.canvas" :min-size="share(320)">
              <div class="flex size-full min-w-0 flex-col">
                <!-- context bar: what the current tool does, and its settings -->
                <div
                  v-if="$slots.context"
                  class="border-border text-muted-foreground flex h-10 flex-none items-center gap-3 border-b px-3.5 text-xs"
                >
                  <slot name="context" />
                </div>

                <div class="min-h-0 flex-1 overflow-hidden">
                  <slot />
                </div>

                <!--
                  `@container`, and it is load-bearing rather than tidy.

                  What fits along here is decided by the width of *this bar*,
                  which is the canvas column — and that is the one width on
                  screen a viewport breakpoint cannot see. Two docks open on a
                  wide monitor leave this narrower than the same app on a
                  laptop with both put away, so a `lg:` guard on a status item
                  is answering a question nobody asked: it kept the tally at
                  1280px while the bar itself was 506px, and the text wrapped
                  to four lines inside 32px of height.

                  `overflow-hidden` is the backstop for the case the queries
                  cannot cover — a very long filename — where a clipped word is
                  better than a bar that grows and shunts the canvas up.
                -->
                <div
                  v-if="$slots.status"
                  class="border-border bg-card text-muted-foreground @container flex h-8 flex-none items-center gap-2 overflow-hidden border-t px-2 text-[11px]"
                >
                  <slot name="status" />
                </div>
              </div>
            </UResizablePanel>

            <UResizableHandle
              :class="!shown.right && 'pointer-events-none bg-transparent'"
              @dragging="dragged = $event"
            />

            <UResizablePanel
              ref="rightDock"
              :default-size="initial.right"
              :min-size="shown.right ? share(size.right.min) : 0"
              :max-size="shown.right ? undefined : 0"
              @resize="onDockResize('right', $event)"
            >
              <slot name="panel-right">
                <Dock side="right" />
              </slot>
            </UResizablePanel>
          </UResizablePanelGroup>

          <!--
            The way back to a dock that has been put away, for as long as
            something is in the air to put there. Over the edge rather than in
            it, so that a drag which is already under way is not interrupted by
            the room being made for its own landing — see `dropEdge` above.
          -->
          <div
            v-for="side in edges"
            :key="side"
            class="border-primary/40 bg-primary/5 text-primary absolute inset-y-0 z-30 flex w-20 flex-col items-center justify-center gap-2 border-dashed p-2 text-center text-xs"
            :class="[
              side === 'left' ? 'left-0 border-r-2' : 'right-0 border-l-2',
              dropEdge === side && 'border-primary bg-primary/15',
            ]"
            @dragover="onEdgeOver(side, $event)"
            @dragleave="dropEdge = null"
            @drop="onEdgeDrop(side, $event)"
          >
            <!--
              Not a target of its own: a leave fired by crossing onto the icon
              would put the strip out from under the pointer aiming at it.
            -->
            <PanelLeftIcon v-if="side === 'left'" class="pointer-events-none size-5" />
            <PanelRightIcon v-else class="pointer-events-none size-5" />
            <span class="pointer-events-none">Drop here</span>
          </div>
        </div>
      </div>
    </div>
  </UTooltipProvider>
</template>
