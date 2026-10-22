---
name: kemolate
description: How to work on comic and manga chapters through the Kemolate MCP server — reading pages with Kemolate's own OCR, checking and correcting the reading, translating with the chapter's glossary and cast, and reviewing and fixing the lettering of balloons (frame, size, copyfitting a line that will not fit without losing its meaning). Use this whenever Kemolate's tools are available (get_active_workspace, list_pages, request_page_read, prepare_page_translation, save_page_translations, set_lettering_style …) or the user talks about their Kemolate chapter, "this page", scanlation, typesetting or a balloon whose text is too small — even if they do not name Kemolate.
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
4. **Fix blocks that are not one balloon each** — before translating, because
   both cost the translation of the blocks they change:
   - `join_blocks` for one balloon read as several blocks (a block per column or
     per line — the crops show half a sentence each). Name them **in reading
     order**; their text is joined in that order. The balloon is one block with
     the parts inside it (`parts` in `read_page`).
   - `split_block` for the other way round. A joined balloon (one with `parts`)
     is taken apart with no `parts` given. Any other block is cut into the
     `parts` you send: each a box in page-width units and the text it holds, in
     reading order — for one box drawn round two balloons, or a balloon and a
     caption. Look at the block first (`get_page_image` with its `blockId`) to
     place the boxes.
   - Both answer with any translation they removed, quoted. Translate the new
     blocks afterwards; tell the user if a wording of theirs was removed.
   - Both have Kemolate clean the new blocks as they are made: a join's balloon
     and a cut's parts are boxes no repair covered, so the original lettering
     would show again under them. `cleaning` in the answer says which blocks are
     clean now. If it says `cleaned: false` (chapter not open, no cleaner chosen),
     pass on what it says to do — the user presses **Clean page** later.
5. `sort_page_blocks` only if a page's order is clearly wrong. It overwrites an
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
  `outline` (`#rrggbb`), `shape` (box, soft, oval, diamond, custom), `emphasis`
  (see below). Only the
  fields you send change; **send a field as `null` to give it back to
  automatic**; `reset: true` clears them all.
- **Sizes are in the scan's own pixels** — the same numbers as Kemolate's
  Lettering panel. A size means nothing without the page width: 40 is large on
  a 1200-pixel page and small on a 4000-pixel one. Prefer `size: null`
  (fitted automatically) unless the user asks for a size, or you are making
  lines match.
- `frame` — where the lines are set, upright, in the width-normalised units
  above; one block per call. `frame: null` hands the line back to its room.

### One size for the voice, not the balloon

A lettered book sets every ordinary line of dialogue at **one size** — the
chapter's **standard** — and centres it in its balloon with air round it. The
artist leaves room; the room is not the voice. Without a standard Kemolate fills
each balloon, so lines change size with their balloons and a big balloon gets
big text: set one with `set_lettering_standard` (`review_lettering` gives the
page's ordinary size as a starting value; null turns it off). It is a setting of
the whole chapter — say so and ask before setting or changing it.

A line set **louder** than the standard is one the *original* lettered louder:
a shout drawn in bigger characters. Kemolate measures that from the source's
characters against the chapter's usual ones — `measuredEmphasis` in
`review_lettering`, 1 for ordinary — and sets the line that many times the
standard. Override per line with `set_lettering_style`'s `emphasis` (1.5 for a
shout the measure missed, 1 to set one like the rest, null to measure). Look at
the original before raising one: big characters mean a raised voice; a big
balloon with ordinary characters does not. A jagged or burst balloon is a shout
too; a wobbly or dashed one is weak or whispered, and can go under 1. Sound
effects keep their own size.

### Line breaks

**A newline in a translation is a line break Kemolate keeps.** Left alone, a
balloon's words are wrapped to fill each line, which at a standard size packs a
line mid-phrase and strands what is left: "FIRST, LET / ME SHOW / YOU", "HM? OH, /
YEAH, IT / IS.". A letterer breaks by hand, and so can you:

- **One phrase to a line.** Break after punctuation and between phrases ("Hm? /
  Oh, yeah, / it is."). Never split a pair that reads as one: "let / me",
  "it / is", "going to / be", an article from its noun, a name from its
  honorific.
- **The shape of the balloon.** Short lines at the top and foot, the longest in
  the middle — an oval's widest part. Three to five lines for an ordinary
  balloon; a very short line belongs at the top or the foot, never between two
  long ones.
- **No word alone on the last line**, and no hyphen where another set of breaks
  would do: hand-broken lines are never hyphenated.
- Keep each typed line short enough for its place. If one is too long, Kemolate
  sets the balloon a little smaller to keep your breaks, down to the standard's
  floor; past that it wraps the line again and `review_lettering` says
  **rewrapped** — make that line shorter or move a word. **Compare `size` before
  and after**: breaks that set a balloon smaller than the automatic ones did are
  too long — use more, shorter lines. A word too long for any line ("neighborhood...")
  can be broken by hand with a typed hyphen: "neighbor-⏎hood...".
- Breaks are part of the wording: a pinned line's breaks are the user's
  (**propose** them); a machine line you may re-break with
  `save_page_translations` — `entries` naming each block, plus `glossary: []`
  and `cast: []`. Change nothing but the breaks unless the line also needs
  shortening.

## Reviewing lettering

After translating or restyling a page — and whenever the user says text looks
wrong — call `review_lettering` (no ids: the page on screen). For every line it
gives the size it is set at, what decided it (`auto` fitted to its frame,
`standard` held to the chapter's size, `chosen` by someone), its `capacity`
(the size its frame would allow with nothing holding it), and flags:

- **does-not-fit** — will not go even at the smallest size; clipped. Always fix.
- **squeezed** — set tighter or a word broken to go. Usually fine; look at it.
- **small-for-its-balloon** — a chosen size well under what the frame holds.
- **smaller-than-the-page** — an automatic line well under the page's ordinary
  size: a frame too small for its balloon, or one long word.
- **larger-than-the-page** — an automatic line well over it, in a big balloon
  with ordinary lettering in the original. The fix is a standard size, not
  shrinking that one line. (A line the original shouts is not flagged.)
- **stranded-word**, **lone-last-word** — a word alone between longer lines, or
  alone at the foot. **rewrapped** — a line you broke by hand was too long for its
  place and was wrapped again. See "Line breaks".

Each line comes with `drawn`: its lines exactly as Kemolate draws them. Read
them for every balloon, flagged or not — a phrase split across two lines
("LET / ME") is not flagged, because telling one needs the language, and you
have it. Breaks need no picture, so a line flagged only for its breaks comes back
without a crop.

It returns a close crop of each flagged balloon **as lettered**, not the scan
(`images: "all"` for every line). `get_page_image` with `lettered: true` shows a
whole page as lettered. A line held to a `standard` with room round it is not a
fault: one size for every ordinary line is what a standard is for.

### Fixing a line — layout first, words last

Work in the order a letterer works; each step changes less than the next.

1. **Give the line its balloon.** If its frame is narrower than the balloon
   (compare `frame` and `room` in `read_page`, and look at the crop), send
   `set_lettering_style` with a `frame` round the balloon's inside — a few
   percent in from its outline, width-normalised units — and
   `style: { shape: "oval", size: null }`. Kemolate then wraps the words into the
   balloon, breaks a long word once if that sets them much larger, and sizes
   them to fill it.
2. **Then the breaks.** Where `drawn` splits a phrase or strands a word, re-break
   the line by hand (see "Line breaks"). It changes no word, and often lets a
   line go at its size without a hyphen.
3. **Then the words**, only if the line still does not fit or is held small by
   its length. This is copyfitting, and it belongs to whoever owns the script:
   - A line the user typed (`pinned`) is theirs. **Propose** a shorter wording
     and ask; do not save it.
   - A machine line you may shorten and save with `save_page_translations`
     (`entries` naming the block) — it is filed as a revision and can be undone.
     Say what you changed.
   - Keep: the meaning and the facts; who is speaking and their voice and
     register (the chapter's honorifics setting included); names and terms from
     the glossary; anything set up for later. Let the art carry what it already
     shows.
   - In this order: contractions; cut filler and hedging; a shorter word of the
     same register; reshape the sentence. Splitting a line across two balloons
     is the user's call.
   - Never change what happens, soften or sharpen the tone (a threat does not
     become polite), smooth away a character's deliberate way of speaking, or
     reword a sound effect that should be redrawn as art.
4. **Size last.** A chosen `size` is for matching lines on purpose, or when the
   user asks; it also takes the line off the standard. Prefer `emphasis` for a
   line that should be louder, so it follows the standard if that changes.
   Setting or changing the chapter's standard (`set_lettering_standard`) is the
   user's decision — propose a value and ask.

Then `review_lettering` again, and tell the user what you changed and what is
left for their eye — fitting is measured, but tone and placement are theirs.

## Spending images well

Images cost the user tokens; text is cheap.

- Read with `request_page_read`, check with `review_page_reading` — neither
  sends you a whole page.
- To look at one balloon, `get_page_image` with `blockId` (or a `region`) gives a
  sharp crop; a whole page is downscaled and small lettering becomes unreadable.
- To check lettering, `review_lettering` shows only the flagged balloons; a
  whole lettered page (`lettered: true`) is for a final look, not for review.
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
done in the Kemolate window (you can look at the result with `lettered: true`). If the user asks for them, tell them where:
cleaning is the Detect panel's **Clean page**; re-measuring balloons (for oval
rooms on chapters read before) is Detect › **Measure balloons**.

## A good run, in short

`get_active_workspace` → `list_pages {needs: "anything"}` →
`request_page_read` (all unread, once) → poll `list_pages` →
`review_page_reading` + `correct_blocks` (and `join_blocks` / `split_block`) per page →
`prepare_page_translation` (batched, text mode) → answer →
`save_page_translations` (one call, with `glossary` and `cast`) →
`review_lettering` per page, fixing layout, then breaks, then words → tell the user
what was done, what was held by their pins, and anything you were unsure of.

The server also offers a `translate_chapter` prompt with the same order, for a
user who wants to start a run from their client's menu.
