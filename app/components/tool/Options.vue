<script setup lang="ts">
/**
 * The settings of whichever tool is out, in the bar above the canvas.
 *
 * ## Why here and not in the dock
 *
 * The dock scrolls. These do not read as ordinary settings — the brush's own
 * gestures move them, so alt-right-dragging on the page changes the size and
 * the softness while the pointer is on the canvas, and a readout that can be
 * scrolled out of sight is no readout at all. The bar cannot be scrolled away
 * from, which is the whole of the argument.
 *
 * The mask brush's settings lived in the Detect panel until this existed, for
 * want of anywhere better. That panel is about reading a page, and a brush is
 * not.
 *
 * ## One set of settings, a different few shown
 *
 * Nothing here owns a value. Size, softness and colour are the paint brush's,
 * one set across the whole app — reaching for the eraser should not change the
 * size of the hole you make — and this only decides which of them the tool in
 * hand has any use for. That list is the tool's own, declared in the registry
 * beside its glyph, so the bar has no opinion about any particular tool and
 * adding one does not mean editing this file.
 */
const { tool } = useTools()
const { size, softness, colour } = usePaintSettings()

/** Add, wipe, or erase — the mask brush's own mode. */
const chosen = useState<'add' | 'wipe' | 'erase'>('mask-brush-mode', () => 'add')

/**
 * Alt held on the way down makes that stroke an erase, so the toggle has to
 * show what is being done rather than only what was last pressed.
 */
const erasing = useState('mask-brush-erasing', () => false)

const mode = computed(() => (erasing.value ? 'erase' : chosen.value))

const options = computed(() => TOOLS.find((candidate) => candidate.id === tool.value)?.options ?? [])

/**
 * Hardness, which is the same dial read from the other end.
 *
 * The slider says hardness because that is the word every editor a reader
 * arrives from uses — Photoshop, Affinity and Krita all label it that way, all
 * count it upwards to a crisp edge, and somebody who knows what "hardness 0"
 * looks like should not have to work out that it is called a hundred here.
 *
 * The value behind it stays *softness*, deliberately and not merely for want of
 * a rename. Every stroke ever recorded carries `softness` in its params, and the
 * page is rebuilt by replaying those rows: inverting the stored sense would
 * either mean a migration over every stroke in the database or a renderer that
 * has to know which era a row came from. The conversion is one line at the one
 * place a person reads the number, which is where a difference between what is
 * spoken and what is stored belongs.
 *
 * Percent here, fraction underneath, for the same reason: it is a multiplier on
 * a brush width everywhere it is used, and a control that stored a hundred
 * would push that division out into the drawing code.
 */
const hard = computed({
  get: () => 100 - Math.round(softness.value * 100),
  set: (next: number) => { softness.value = Math.min(1, Math.max(0, (100 - next) / 100)) },
})
</script>

<template>
  <template v-if="options.length">
    <div class="bg-border h-4 w-px" />

    <div class="flex items-center gap-3">
      <template v-for="option in options" :key="option">
        <!--
          Mode first and as a pair of buttons rather than a switch: which of the
          two is out is the thing being read at a glance, and a switch says
          "on" for one of them and nothing for the other.
        -->
        <UToggleGroup
          v-if="option === 'mask-mode'"
          type="single"
          variant="outline"
          size="sm"
          :model-value="mode"
          @update:model-value="chosen = pick($event, chosen)"
        >
          <UToggleGroupItem value="add" class="aria-pressed:text-primary h-6 px-2 text-[11px]">
            Add
          </UToggleGroupItem>
          <UToggleGroupItem value="wipe" class="aria-pressed:text-primary h-6 px-2 text-[11px]">
            Wipe
          </UToggleGroupItem>
          <UToggleGroupItem
            value="erase"
            class="aria-pressed:text-primary h-6 px-2 text-[11px]"
            title="Take a correction back off — shift-drag on the page does the same"
          >
            Erase
          </UToggleGroupItem>
        </UToggleGroup>

        <ToolScrub
          v-else-if="option === 'size'"
          v-model="size"
          label="Size"
          :min="SIZE_MIN"
          :max="SIZE_MAX"
          suffix=" px"
          title="Drag to resize · alt-right-drag on the page does the same"
        />

        <!--
          Still keyed on `softness`: the registry names the *setting* a tool
          uses, and that is the one the brush is drawn with. Only the reading of
          it is turned around — see `hard`.
        -->
        <ToolScrub
          v-else-if="option === 'softness'"
          v-model="hard"
          label="Hardness"
          :min="0"
          :max="100"
          :per-pixel="0.5"
          suffix="%"
          title="Drag to sharpen · alt-right-drag up on the page does the same"
        />

        <!--
          The swatch is the input. A colour well that opens a picker is what a
          native colour input already is, and the alternative is reimplementing
          one to look the same.
        -->
        <label v-else-if="option === 'colour'" class="flex items-center gap-1.5">
          <span class="text-muted-foreground text-[10px] uppercase">Colour</span>
          <span class="border-border relative size-5 overflow-hidden rounded-sm border" :style="{ background: colour }">
            <input v-model="colour" type="color" class="absolute inset-0 cursor-pointer opacity-0" aria-label="Colour">
          </span>
        </label>
      </template>
    </div>
  </template>
</template>
