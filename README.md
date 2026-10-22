# Kemolate

Translate comics on your own computer. Open a chapter, and Kemolate finds the lettering, reads
it, cleans it off the art, translates it and letters the translation back in. You can correct
every step by hand.

This is the desktop app, built on Electron. Your pages stay on your machine, and so does
everything done to them.

## Install

Download `Kemolate-Setup-<version>.exe` from the
[latest release](https://github.com/azeranex/kemolate-desktop/releases/latest) and run it.
Windows 10 or 11, x64. It installs for your user only, with no administrator prompt.

The installer is not code-signed yet, so Windows SmartScreen will warn about it the first time.
Choose **More info → Run anyway**. Updates after that install without the warning.

**Updates are automatic.** Kemolate checks for a new version at launch and every few hours, and
downloads it in the background. Then it offers **Restart to update**. It never restarts on its
own; if you don't restart, the update installs the next time you quit. Settings › Updates shows
the version and has a button to check now.

## What it does

- **Open a chapter**: a folder of pages, loose image files, or a PDF. Folders and files are
  read where they are, not copied. PDF pages come out as their original image bytes.
- **Find and read the lettering.** The default is Kemolate OCR (this project's own reader).
  The alternatives are PP-OCR (Japanese, Chinese, Korean) and Google Vision (with your own key).
  Balloons and free text are found by a comic-trained detector.
- **Clean it off the art** with AOT, LaMa or MI-GAN, balloon by balloon. Brushes are there for
  what the cleaning misses.
- **Translate**:
  - Google, free and with no key.
  - AI models through [OpenRouter](https://openrouter.ai) with your OpenRouter key:
    - Claude, which always uses the newest version of the family you pick.
    - Gemini, GPT and others.
    - OpenRouter's free models, which still need an OpenRouter key, free to create.
  - Claude directly with an Anthropic key.
  - The AI engines can be shown the whole page. A glossary and a cast list keep names
    consistent across a chapter.
- **Letter it**: fitted to each balloon, editable, with every earlier wording of a line kept.
- **Paint and layer**: retouching, sheets, placed pictures, and layer presets for reading,
  cleaning, lettering and the finished page.
- **Export** finished pages as a PDF or a zip of PNGs or JPEGs. Save a whole chapter's work,
  scans included, as a `.kemolate` project file to move it to another machine. Double-clicking
  a `.kemolate` file opens it.

## Your data

- **Pages are never uploaded.** Detection, reading and cleaning run on your machine, using the
  GPU through WebGPU where it can.
- **Translation is the one step that sends anything**, and only to the service you choose,
  with your own key:
  - **AI · Text** sends the lines' text.
  - **AI · Image** sends the page image too.
- **API keys** are encrypted by the operating system (Windows DPAPI) and never written anywhere
  in plain text.
- **Your work** is kept in a database in `%APPDATA%\kemolate-desktop\kemolate.db`. That covers
  the readings, translations, layers, retouching, glossary and cast. It's backed up
  automatically:
  - at launch, every hour while you work, and on quit;
  - a day of backups is kept, then one a day for 30 days.
  
  If the file is ever damaged it is set aside, never deleted, and the newest good backup is
  put back. Settings › Your data lists the backups and restores one.
- **Models** download on first use and are kept on your machine after that. Kemolate OCR is
  published at [azeranex/kemolate-ocr](https://huggingface.co/azeranex/kemolate-ocr) on
  Hugging Face; the others come from the Hugging Face Hub.

## Optional extras

- **An AI agent (MCP).** Settings › Agents turns on an MCP server for a client on this computer —
  Claude Code, Claude Desktop, an editor. It can list your workspaces, have pages read by
  Kemolate's own OCR, check and correct the reading, and translate and file the result. It
  listens on this computer only, takes no token, and is off until you turn it on. While it is
  on, any program on this computer can use your workspaces through it. It works on the chapter
  and page open in the window unless told otherwise, and page images come from that window.
  For Claude Desktop, **Add to Claude Desktop** installs Kemolate as an extension.
- **NVIDIA GPU (CUDA).** On Windows x64 with an NVIDIA card, Settings › NVIDIA GPU (CUDA) sets
  up a private Python environment inside Kemolate's own folder with one press. It runs the
  comic detector and Kemolate OCR on CUDA, about twice as fast as WebGPU. Remove deletes the
  environment.
- **Anime Ace 3**, the classic comic dialogue face, is not included: its licence doesn't allow
  redistributing it. Install it on your system and Kemolate uses it; otherwise dialogue is set
  in Shantell Sans.

## Development

Requires Node 24 and pnpm 12.

```bash
pnpm install
pnpm dev          # the app with hot reload (Vite + Electron)
pnpm typecheck
pnpm lint
pnpm test         # vitest: node unit tests and the app's tests
pnpm dist         # build the installer into release/
```

`pnpm dev` uses the same profile as an installed Kemolate, and only one of them can run at a
time. Give a development run its own profile with `KEMOLATE_PROFILE=<folder>`.

This app is a port of the Kemolate web build. Files carried across keep the same paths, so
fixes can move between the two. [CLAUDE.md](CLAUDE.md) explains how the code is laid out, how
it differs from the web build, and the decisions behind it. Read it before changing anything
substantial.

### Releasing

1. Bump `version` in `package.json` and commit.
2. Push a tag for it:

   ```bash
   git tag v0.2.0
   git push origin main v0.2.0
   ```

The [release workflow](.github/workflows/release.yml) then:

- checks the tag matches `package.json`;
- runs the checks;
- builds the Windows installer;
- publishes a GitHub Release with the installer, its blockmap and `latest.yml`.

Installed copies find it on their own. Every push and pull request runs the same checks in
[CI](.github/workflows/ci.yml).

## Licence

No licence has been chosen yet.
