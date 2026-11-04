---
name: translate
description: Translate pages of the open Kemolate chapter — read, check the reading, translate, save and clean — and stop there, without reviewing the lettering.
argument-hint: "[pages, e.g. 3-10 or all — default: the page on screen]"
disable-model-invocation: true
---

# Translate in Kemolate, without the lettering review

The user wants pages translated and nothing more: **do not call
`review_lettering` and do not restyle lines.** The lettering review is its own
command (`/kemolate:review`) because it is the slow half of a run, and the user
runs it when they want it.

Which pages: $ARGUMENTS — a range like `3-10`, `all` for every page with work
left, or nothing for the page on screen.

The rules for each step — coordinates, pinned lines, batching, joining and
splitting — are in the `kemolate` skill. If it is not already loaded, load it,
or call `get_guide`, before the first write.

1. `get_active_workspace`, then `list_pages` with `needs: "anything"` to see
   which of the chosen pages still need reading or translating.
2. Pages with no blocks: `request_page_read` with all of them in one call; poll
   `list_pages` with `needs: "reading"` until they are read.
3. `review_page_reading` on each page just read; fix it with `correct_blocks`,
   `join_blocks` and `split_block`. A page that was already read and checked
   is left as it is.
4. `prepare_page_translation` in batches (text mode unless the dialogue leans on
   the art), answer, then `save_page_translations` — one call for the run,
   with `glossary` and `cast`.
5. `clean_page` on each translated page.
6. Report in a few lines: pages done, lines held by the user's pins, anything you
   were unsure of. End by saying `/kemolate:review` will check the lettering
   when they want it — do not start it.
