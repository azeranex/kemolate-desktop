---
name: kemolate
description: How to work on comic and manga chapters through the Kemolate MCP server — reading pages with Kemolate's own OCR, checking and correcting the reading, translating with the chapter's glossary and cast, and fixing the lettering (size, face, frame) of balloons. Use this whenever Kemolate's tools are available (get_active_workspace, list_pages, request_page_read, prepare_page_translation, save_page_translations, set_lettering_style …) or the user talks about their Kemolate chapter, "this page", scanlation, typesetting or a balloon whose text is too small — even if they do not name Kemolate.
---

# Working in Kemolate through MCP

Kemolate is a desktop app for translating comics. Its MCP server gives you the
chapters on the user's machine: the pages, the text blocks found on them, their
translations, and how each line is lettered. You do the judgement — what a
line says, what it should say, whether a reading is right — and the app does
the seeing: its detector and OCR run on the user's machine, on the real files.

Three facts shape everything below:

1. **The pages live in the Kemolate window, not on a server.** Images and OCR
   come from the chapter the user has *open*. If a tool says nobody is holding
   the page, ask the user to open that chapter in Kemolate; retrying will not
   help. Text tools (`read_page`, `prepare_page_translation`, saving) work
   whether the chapter is open or not.
2. **A person outranks you.** A line the user typed is *pinned*: your wording is
   filed in its history and does not replace it. That is deliberate — report it,
   do not retry it.
3. **Every write shows up in the user's window straight away.** Work as you would
   in someone else's document while they watch it: say what you are about to do
   to more than a page or two, and never overwrite work you did not make without
   asking.

## Start where the user is

When the user says "this page", "this chapter" or "the open one", call
`get_active_workspace`. It returns the chapter and the page on screen. **You
can then leave `workspaceId` out of every tool, and `pageId` out of the
one-page tools** — they default to what is open. Only reach for
`list_workspaces` when the user names a chapter that is not open.

Then `list_pages`, with `needs: "anything"` (or `"reading"` / `"translation"`)
to see what work is left. It also gives each page's pixel size, and whether
its image can be reached right now (`reachable`).

## Coordinates

Every box in this API — a block's `box`, a `room`, a `frame`, a `region` — is
**normalised by the page's WIDTH on both axes**. `cx` and `w` are fractions of
the width; so are `cy` and `h`. On a page taller than it is wide, `cy` and `h`
legitimately exceed 1. To turn pixels into these units, divide x *and* y by the
page width from `list_pages` or `read_page`. This is the one thing models most
often get wrong; check it every time you write a box.

## Reading a chapter

Let the app read. Do not read pages by looking at images.

1. `request_page_read` with **all** the unread pages in one call. The app's
   detector draws boxes shaped for lettering; a box you estimate from a picture
   traces the original column of text, and the translation then gets set in a
   narrow strip. It costs no image tokens. It usually answers `working` — the
   first run downloads models — and saves the pages as it finishes them. Poll
   `list_pages` with `needs: "reading"` instead of calling it again.
2. `review_page_reading` on each page that was read. It returns every block's
   text beside a close crop of that block, in one call. Do this even when the
   reading looks plausible: the recogniser is trained on Japanese, and on other
   scripts it returns believable characters with full confidence.
3. `correct_blocks` to fix a wrong character, a box of the wrong shape, or to
   mark a block `kind: "garbage"` (not lettering — signs, background text it
   should leave alone) or `hidden`. It patches one block at a time and leaves
   the rest of the page alone.
4. `sort_page_blocks` only if a page's order is clearly wrong. It overwrites an
   order the user set by hand, so do not run it over a whole chapter blindly.

`save_page_blocks` is for a balloon the reading missed (`mode: "append"`).
`mode: "replace"` deletes every block on the page **with its translations** —
only for a page you are re-reading from nothing, and only after saying so.

## Translating

1. `prepare_page_translation` with a batch of pages (up to 20 in `text` mode).
   It returns `instructions` once for the batch — the house rules, the chapter's
   glossary, its cast, the honorifics setting — and a `prompt` per page with its
   numbered lines. **Follow `instructions`; you do not need `get_glossary` or
   `get_cast` first.** Use `mode: "image"` (up to 4 pages) only when the
   dialogue depends on the art — who is speaking, a sign, a gesture — or when
   you have not seen the page and the lines are ambiguous.
2. Answer each page as its prompt asks, then `save_page_translations` with each
   page's `job` and your `translations` **in the prompt's order, exactly as many
   as its `expects`**. The server matches them to blocks, so you never copy
   block ids. Lines listed in `answerAsIs` go in as `entries` unchanged.
3. `glossary` and `cast` are required: send the names, terms and characters the
   pages established — or `[]` if they taught nothing. This is what keeps a name
   spelled the same way on page 40 as on page 4; leaving it out quietly breaks
   the rest of the chapter.
4. Save a whole run in **one** call where you can: it becomes one batch the user
   can undo together.

What comes back:

- `heldByHuman` — lines the user pinned. Your wording is in their history; the
  line on the page is unchanged. Mention it if it matters; do not re-send.
- A **409 about the job** — the page changed since you prepared it. Prepare that
  page again; do not force the old answer onto it.
- `setAside` — answers for context lines the brief did not ask about. Expected.

To retranslate lines that already have a translation, prepare with
`force: true`, or `blockId` for a single line with its page as context.

## Lettering

`read_page` shows each line's `style` (only what has been set — absent is
automatic), its own `frame` if it has one, and each block's `room`: the space
measured inside its balloon. `room.round: true` means the balloon is an oval
and the line is wrapped into it.

`set_lettering_style` changes how lines are set, and never their words:

- `style` — `font` (dialogue, sfx, retro, casual, marker, hand, poster, sans,
  serif, mono), `size`, `line`, `spacing`, `stroke`, `bold`, `italic`,
  `underline`, `align`, `anchor` (top/middle/bottom), `vertical`, `color` and
  `outline` (`#rrggbb`), `shape` (box, soft, oval, diamond, custom). Only the
  fields you send change; **send a field as `null` to give it back to
  automatic**; `reset: true` clears them all.
- **Sizes are in the scan's own pixels** — the same numbers as Kemolate's
  Lettering panel. A size means nothing without the page width: 40 is large on
  a 1200-pixel page and small on a 4000-pixel one. Prefer `size: null`
  (fitted automatically) unless the user asks for a size, or you are making
  lines match.
- `frame` — where the lines are set, upright, in the width-normalised units
  above; one block per call. `frame: null` hands the line back to its room.

### "The balloon is big but the text is tiny"

The usual causes, and what to do:

1. **The line is set in a frame narrower than its balloon.** Compare the
   block's `box`, `room` and the line's `frame` in `read_page`. Look at the
   balloon with `get_page_image` and a `region` a little wider than the block,
   estimate the balloon's inside (a few percent in from its outline), and send
   that as `frame` with `style: { shape: "oval", size: null }`. The words are
   then wrapped into the balloon and sized to fill it.
2. **One long word sets the size.** Lines wrap between words, so the longest
   word ("NEIGHBORHOOD...") must fit across the balloon on its own, and the
   whole balloon is set at whatever size allows that. Kemolate cannot hyphenate
   on Windows. The fix is wording: offer the user a version without the long
   word, and save it with `save_page_translations` (`entries` naming the block).
3. **The user has a standard size, and the line is too long for it** — the app
   squeezes a line a little, then flags it. Again the fix is fewer words.

You **cannot see the lettered result**: `get_page_image` returns the scan, not
the page as lettered, and the size a line was actually fitted at is measured in
the window, not stored. So after changing lettering, ask the user to look, and
describe what you changed so they can judge it.

## Spending images well

Images cost the user tokens; text is cheap.

- Read with `request_page_read`, check with `review_page_reading` — neither
  sends you a whole page.
- To look at one balloon, `get_page_image` with `blockId` (or a `region`) gives a
  sharp crop; a whole page is downscaled and small lettering becomes unreadable.
- Do not fetch a page image and then also prepare it in `image` mode — that pays
  twice. If you have already seen the page, prepare in `text` mode.
- Batch: one `request_page_read` for the chapter, up to 20 pages per
  `prepare_page_translation`, one `save_page_translations` per run.

## Settings and things to ask about

- `update_workspace` changes the chapter's languages, reading direction,
  honorifics and name. Changing the target language switches which glossary
  later pages use — ask first.
- Anything destructive or wide — `save_page_blocks` with `replace`, sorting a
  page someone arranged, restyling every line of a chapter — say what you will
  do and wait for a yes.

## Not available through MCP

Cleaning the original lettering off the art, painting, layers and export are
done in the Kemolate window. If the user asks for them, tell them where:
cleaning is the Detect panel's **Clean page**; re-measuring balloons (for oval
rooms on chapters read before) is Detect › **Measure balloons**.

## A good run, in short

`get_active_workspace` → `list_pages {needs: "anything"}` →
`request_page_read` (all unread, once) → poll `list_pages` →
`review_page_reading` + `correct_blocks` per page →
`prepare_page_translation` (batched, text mode) → answer →
`save_page_translations` (one call, with `glossary` and `cast`) →
fix lettering where the user points at a problem → tell the user what was done,
what was held by their pins, and anything you were unsure of.

The server also offers a `translate_chapter` prompt with the same order, for a
user who wants to start a run from their client's menu.
