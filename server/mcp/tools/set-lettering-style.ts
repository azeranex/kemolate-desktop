/**
 * How a page's lines are lettered — face, size, weight, placement, ink, the
 * shape they wrap into. Desktop only: the web build's agent can write what a
 * line says but not how it is set.
 *
 * What it changes is each line's `style`, exactly what the Lettering panel
 * changes, through `translations.restyle` — the style alone, so the wording,
 * who wrote it and whether a person pinned it all stand. Fields are merged
 * into what the line already has: one sent is set, one sent as null goes back
 * to automatic, one left out is left alone; `reset` starts from automatic.
 * The merged style is checked against the app's own schema
 * (`letteringStyleSchema`), so an agent can store nothing the panel could not.
 *
 * `frame` is where the lines are set — the lettering frame the canvas lets a
 * letterer drag off the block. Upright, in the units a block's box uses. It is
 * how an agent fixes a balloon far bigger than its words: by default a line is
 * set in its balloon's measured room, or its detection box where none was kept,
 * and the box of a vertical Japanese column is a narrow strip that holds a
 * horizontal translation to tiny type; a frame round the balloon's interior
 * with `shape: oval` sets it as a letterer would. Null hands it back.
 *
 * Sizes are the panel's units — the scan's own pixels (see
 * `shared/utils/lettering.ts`) — so "size 40" here is the panel's 40, and the
 * page's width from `read_page` says what that is next to the page.
 */
import { z } from 'zod'

import type { TextStyle } from '~~/server/database'

import { letteringStyleSchema } from '#shared/schemas/workspace'
import { blocks, translations } from '~~/server/services'
import { mcpContext, mcpEnabled, mcpPage } from '~~/server/utils/mcp'

const field = letteringStyleSchema.shape

/** Every style field, optional, and nullable for "back to automatic". */
const stylePatch = z.object({
  font: field.font.describe('The face: dialogue, sfx, retro, casual, marker, hand, poster, sans, serif or mono. Null is automatic (dialogue for a balloon, sfx for a sound effect).'),
  size: field.size.describe('Type size in the scan\'s own pixels — the Lettering panel\'s number. Null is automatic (fitted to the balloon).'),
  line: field.line.describe('Line height as a multiple of the size, e.g. 1.1. Null is the face\'s own.'),
  spacing: field.spacing.nullable().describe('Letter spacing in scan pixels, either way from 0.'),
  stroke: field.stroke.nullable().describe('Outline thickness in scan pixels; 0 is none.'),
  bold: field.bold.nullable(),
  italic: field.italic.nullable(),
  underline: field.underline.nullable(),
  align: field.align.nullable().describe('left, center, right or justify.'),
  anchor: field.anchor.nullable().describe('Where the text sits in its balloon: top, middle or bottom.'),
  vertical: field.vertical.describe('Set down the page rather than across. Null is as the line reads.'),
  color: field.color.describe('Ink as #rrggbb. Null reads it off the page.'),
  outline: field.outline.describe('Outline colour as #rrggbb. Null is the reverse of the ink.'),
  shape: field.shape.describe('What the lines wrap into: box, soft (a rounded box, a balloon\'s default), oval, diamond, or custom with points.'),
  points: field.points.describe('A custom shape\'s polygon, [x0, y0, x1, y1, …] as shares of the frame, 0 to 1.'),
}).partial()

export default defineMcpTool({
  name: 'set_lettering_style',
  description: [
    'Change how lines are lettered on one page: face, size, line height, spacing, outline, bold/italic/underline,',
    'alignment, placement in the balloon, vertical setting, ink and outline colour, and the shape the lines wrap into.',
    'Only the fields you send change; send a field as null to put it back to automatic, or `reset` to start from automatic.',
    'Sizes are in the scan\'s own pixels, the same numbers as Kemolate\'s Lettering panel — `read_page` gives the page width.',
    'The wording, and whether a person pinned it, are never touched. `read_page` shows each line\'s current style.',
    'A block with no translation in the language has nothing to letter yet and is reported, not changed.',
    'TEXT TOO SMALL IN A BIG BALLOON: the line is set in a frame narrower than its balloon (`read_page` gives each block its',
    '`room` and `frame`). Look at the balloon with `get_page_image` and a `region` a little wider than the block, then send',
    '`frame` as the balloon’s inside — a few percent in from its outline — with `style: { shape: "oval", size: null }`;',
    'the lines are then wrapped into the balloon and sized to fill it. One block per call when frames differ.',
  ].join(' '),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  enabled: mcpEnabled,
  inputSchema: {
    workspaceId: z.string().describe('The chapter\'s id, from `list_workspaces`.'),
    pageId: z.number().int().positive().describe('The page these lines are on, from `list_pages`.'),
    blockIds: z.array(z.number().int().positive()).min(1).max(500).optional()
      .describe('The blocks to restyle. Omit for every translated block on the page.'),
    locale: z.string().trim().min(2).max(16).optional()
      .describe('Which language\'s lines. Defaults to the chapter\'s target language.'),
    style: stylePatch.default({}).describe('The fields to change.'),
    frame: z.object({
      cx: z.number().min(-10).max(10).describe('Centre across, as a fraction of the page WIDTH.'),
      cy: z.number().min(-10).max(10).describe('Centre down, also as a fraction of the page WIDTH — may exceed 1 on a tall page.'),
      w: z.number().min(0.005).max(10).describe('Width, as a fraction of the page width.'),
      h: z.number().min(0.005).max(10).describe('Height, as a fraction of the page width.'),
    }).nullable().optional()
      .describe('Where the lines are set, upright. Null puts them back in the balloon’s measured room (or the block). Applied to every block named — give one block per call.'),
    reset: z.boolean().default(false)
      .describe('Start from automatic before applying `style` — clears every setting the lines had.'),
  },
  handler: async ({ workspaceId, pageId, blockIds, locale, style, reset, frame }) => {
    const context = await mcpContext(workspaceId)
    const page = await mcpPage(context, pageId)
    const target = locale ?? context.workspace.targetLocale

    const restyling = reset || Object.keys(style).length > 0

    if (!restyling && frame === undefined) {
      throw createError({ statusCode: 400, statusMessage: 'Say what to change: `style`, `frame`, or `reset`.' })
    }

    const onPage = await blocks.onPage(context, page.id)
    // Unnamed, every block with a line to letter — not the rubbish and the
    // empty ones, which would only come back as `untranslated` noise.
    const wanted = blockIds?.length
      ? onPage.filter((block) => blockIds.includes(block.id))
      : onPage.filter((block) => block.translations.some((row) => row.locale === target && row.text))

    const stray = (blockIds ?? []).filter((id) => !onPage.some((block) => block.id === id))

    if (stray.length) {
      throw createError({
        statusCode: 404,
        statusMessage: `Not lettered blocks on page ${page.id}: ${stray.join(', ')}. A joined balloon is styled by its own block, not its parts.`,
      })
    }

    const entries = []

    if (frame && wanted.length > 1) {
      throw createError({ statusCode: 400, statusMessage: 'A frame is one balloon’s — name one block with `blockIds` when sending `frame`.' })
    }

    for (const block of wanted) {
      if (!restyling) {
        entries.push({ blockId: block.id, frame })

        continue
      }

      const line = block.translations.find((row) => row.locale === target)
      // A field sent as null is taken out, which is what "automatic" is.
      const merged = Object.fromEntries(Object.entries({ ...(reset ? {} : line?.style), ...style })
        .filter(([, value]) => value !== null && value !== undefined))

      // The app's own schema decides what may be stored, whichever door it came by.
      const checked = letteringStyleSchema.safeParse(merged)

      if (!checked.success) {
        const issue = checked.error.issues[0]

        throw createError({
          statusCode: 400,
          statusMessage: `Block ${block.id}: ${issue?.path.join('.') || 'style'} — ${issue?.message ?? 'not a style'}.`,
        })
      }

      entries.push({ blockId: block.id, style: checked.data as TextStyle, frame })
    }

    const { restyled, untranslated } = await translations.restyle(context, page.id, target, entries)

    return mcpJson({
      pageId: page.id,
      locale: target,
      restyled: restyled.map((row) => ({
        blockId: row.blockId,
        style: row.style ?? {},
        frame: row.cx === null ? null : { cx: row.cx, cy: row.cy, w: row.w, h: row.h },
      })),
      // Asked for and already set that way — not an error, and not a write.
      unchanged: entries.length - restyled.length - untranslated.length,
      ...(untranslated.length
        ? { untranslated, note: 'These blocks have no line in this language yet; translate them first.' }
        : {}),
    })
  },
})
