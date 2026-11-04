---
name: review
description: Review and fix the lettering of translated pages in the open Kemolate chapter — size, frames, line breaks, collisions — without translating anything new.
argument-hint: "[pages, e.g. 3-10 or all — default: the page on screen]"
disable-model-invocation: true
---

# Review the lettering in Kemolate

The user wants the lettering of pages already translated checked and fixed.
**Do not read, re-read or translate pages here** — that is `/kemolate:translate`.
A page with lines still untranslated is reviewed as it is, and named in the
report.

Which pages: $ARGUMENTS — a range like `3-10`, `all` for every translated page,
or nothing for the page on screen.

How to judge and fix a line — layout first, then breaks, then words; one size
for the voice; several lines in one balloon; pinned lines get a proposal, not a
rewrite — is in the `kemolate` skill's "Lettering" and "Reviewing lettering"
sections. If it is not already loaded, load it, or call `get_guide`, before the
first fix.

1. `get_active_workspace`, and `list_pages` for the chosen pages.
2. If the chapter has no standard size, `review_lettering` says so: set one with
   `set_lettering_standard` first, since it changes every line's size.
3. `review_lettering` per page. Fix what it flags with `set_lettering_style`
   (frame, size, emphasis) and, for breaks or wording, `save_page_translations`
   — a proposal for a pinned line. Review the page again after fixing it, until
   nothing is flagged or what is left needs the user's eye.
4. Report in a few lines per page: what was fixed, what was proposed for pinned
   lines, and what is left for the user to look at.
