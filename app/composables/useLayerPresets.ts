/**
 * Saying what you are about to do, and letting the stack follow.
 *
 * A chapter is worked in stages — read it, clean it, letter it, look at the
 * result — and each stage wants the plates arranged a particular way. Doing
 * that by hand is half a dozen eyes and locks per page, so it was not done: the
 * mask stayed on through lettering, the cleaned plate stayed unlocked while
 * somebody typed, and a brush landed on the wrong plate often enough to be a
 * known annoyance rather than a bug anybody reported.
 *
 * A preset is that arrangement, named — see `LAYER_PRESETS`, which is where the
 * stages themselves live because the server has to agree about them too.
 *
 * ## Why this reaches every page when nothing else does
 *
 * A stack belongs to its page (`layers.pageId`), and that is what makes a sheet
 * added on page seven stay on page seven. A *stage* is the exception that
 * proves it: you do not clean one page, you clean the chapter, and a stage that
 * had to be re-chosen on every page turn would be worse than no button at all.
 *
 * It is safe to make that exception here and nowhere else because of how little
 * a preset can do. It sets three fields on rows that already exist, on the
 * seven rows every page is founded with, and it cannot insert, delete, reorder
 * or re-parent anything. Sheets, groups and adjustments somebody added are not
 * standard rows and are never named — so no arrangement of stages can cost
 * anyone a layer or a stroke. `layers.preset` enforces that server-side rather
 * than trusting what arrives.
 *
 * ## On screen first
 *
 * Applied locally before the request goes, because a stage is a view and a view
 * that waits for a round trip feels broken. The request is what makes it true
 * for the other pages and the other people; this browser is already right.
 */
import type { LayerPreset, PresetId } from '#shared/utils/layers'

export function useLayerPresets () {
  const route = useRoute()
  const { layers, layerSelection, page } = useComic()
  const { shared, pageRowOf } = useShared()

  const workspace = computed(() => String(route.params.workspaceId ?? ''))

  /**
   * Which stage is showing, or none.
   *
   * Not stored anywhere and not read back from the stack, which is deliberate.
   * A preset is a thing you *pressed*, and the moment you hide one plate by
   * hand the arrangement is yours rather than the stage's — so this is cleared
   * on any edit that is not a preset, and a reload starts with nothing lit. The
   * alternative, deriving it by comparing the stack against each preset, would
   * light a button up for a stack that merely happens to match and then argue
   * with the reader about which stage they are in.
   */
  const active = useState<PresetId | null>('layer-preset', () => null)

  /**
   * Editor, like the rest of the stack. A preset writes to every page, so a
   * viewer pressing one would be a 403 per press for doing nothing wrong — and
   * unlike the ordinary settle, this is a thing somebody deliberately did, so
   * it is refused here rather than left to fail quietly.
   */
  const writable = computed(() => Boolean(
    workspace.value && shared.value && atLeast(shared.value.role, 'editor'),
  ))

  /**
   * The standard rows as a preset sees them: what it sets, and nothing else.
   *
   * Only the three fields a stage has an opinion about, and only on the rows it
   * is allowed to name — so adding a sheet, renaming a group or dragging a row
   * does not read as leaving the stage, because none of those is something the
   * stage said.
   */
  const arrangement = computed(() => {
    const allowed = standardUids()
    const out: string[] = []

    const walk = (rows: StackLayer[]) => {
      for (const row of rows) {
        if (allowed.has(row.id)) out.push(`${row.id}:${row.visible}:${row.opacity}:${row.locked ?? false}`)

        walk(row.children ?? [])
      }
    }

    walk(layers.value)

    return out.sort().join('|')
  })

  /** The arrangement the lit stage asked for, so a hand on the eye is noticed. */
  const stamp = useState<string>('layer-preset-shape', () => '')

  /*
   * A stage stops being the stage the moment somebody arranges a plate
   * themselves. Not an error and not undone — the reader is right and the
   * button was only ever a shortcut — but the panel must stop claiming you are
   * in a stage you have edited your way out of.
   *
   * This also catches the arrangement arriving from somebody *else's* press,
   * through the ordinary layers change notice: their stage is now this stack,
   * and lighting nothing is the honest answer until this reader chooses one.
   */
  watch(arrangement, (now) => {
    if (active.value && now !== stamp.value) active.value = null
  })

  /** Set the rows a preset names, wherever they sit in the tree. */
  function arrange (preset: LayerPreset) {
    const walk = (rows: StackLayer[]) => {
      for (const row of rows) {
        const wanted = preset.rows[row.id]

        if (wanted) {
          row.visible = wanted.visible

          if (wanted.opacity !== undefined) row.opacity = wanted.opacity

          // Left alone when the stage says nothing, which is how the scan keeps
          // the lock that is not the reader's to open — see `StackLayer.fixed`.
          if (wanted.locked !== undefined && !row.fixed) row.locked = wanted.locked
        }

        walk(row.children ?? [])
      }
    }

    walk(layers.value)
  }

  async function apply (id: PresetId) {
    const preset = LAYER_PRESETS.find((candidate) => candidate.id === id)

    if (!preset || !writable.value) return

    arrange(preset)

    /*
     * The stage's own row is selected so the next stroke lands where the stage
     * says it should, and nothing is selected by the two stages that are only
     * ways of looking — arming a tool over a page you came to read is how a
     * stray click becomes a mark.
     */
    layerSelection.value = preset.works

    // Stamped after arranging and before lighting the button, so the watcher
    // above sees the stage's own change as the stage's rather than as a hand
    // undoing it a tick later.
    stamp.value = arrangement.value
    active.value = id

    const here = page.value ? pageRowOf(page.value) : null

    if (!here) return

    await $fetch(`/api/workspaces/${workspace.value}/layers/preset`, {
      method: 'PUT',
      body: {
        rows: Object.entries(preset.rows).map(([uid, row]) => ({ uid, ...row })),
        pageId: here,
      },
      headers: peerHeader(workspace.value),
    }).catch((error: unknown) => {
      // The arrangement on screen is still the one that was asked for, and the
      // ordinary stack settle saves it for *this* page regardless — what is
      // lost is only the other pages, and pressing again is the whole retry.
      console.warn('[kemolate] preset not applied to every page:', error)
    })
  }

  return { presets: LAYER_PRESETS, active, apply, writable }
}
