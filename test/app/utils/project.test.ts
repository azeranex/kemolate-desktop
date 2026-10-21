import { describe, expect, it } from 'vitest'

import type { Project } from '~/utils/project'

import { PROJECT_VERSION, projectFilename, readManifest } from '~/utils/project'

/**
 * The manifest's schema, which is the project format's actual contract.
 *
 * `ProjectPage.blocks` is `Block[]` and `stack` is `StackLayer[]` — the arrays
 * the canvas draws, written out as they stand. That is deliberate and it is
 * also the risk: two shapes that are the same type today drift apart silently,
 * and an import that quietly dropped a reader's lettering would look like a
 * successful import. `projectSchema` is what stops that, so these tests are
 * about the schema refusing things rather than about the happy path.
 *
 * The version check is the other half. A file from a *newer* build is refused
 * outright rather than read as far as it goes: a later format may carry fields
 * this reader would drop on the floor, and dropping somebody's work without
 * telling them is the failure worth being strict about. An older file is fine,
 * because every field added since is optional.
 *
 * Seam: `readManifest` and `projectFilename`.
 */

const aBlock = () => ({
  id: 'read:a1b2c3d4:0',
  type: 'bubble',
  x: 0.1,
  y: 0.2,
  w: 0.3,
  h: 0.15,
  source: 'こんにちは',
  translation: 'Hello',
  confidence: 92,
  hidden: false,
})

const aProject = (extra: Record<string, unknown> = {}) => ({
  v: PROJECT_VERSION,
  app: 'kemolate',
  exported: 1_754_700_000_000,
  title: 'Chapter 12',
  pages: [{
    path: '006.jpg',
    name: '006',
    position: 0,
    blocks: [aBlock()],
  }],
  ...extra,
})

const read = (value: unknown) => readManifest(JSON.stringify(value))

describe('readManifest', () => {
  it('accepts the smallest manifest that means anything', () => {
    const held = read(aProject())

    expect('project' in held).toBe(true)
  })

  it('keeps a block whole, lettering and all', () => {
    const held = read(aProject({
      pages: [{
        path: '006.jpg',
        name: '006',
        position: 0,
        blocks: [{
          ...aBlock(),
          angle: -12.5,
          skewX: 3,
          quad: [1, 2, 3, 4, 5, 6, 7, 8],
          style: { font: 'CC Wild Words', size: 18 },
          letter: { x: 0.2, y: 0.3, w: 0.4, h: 0.2, angle: 4 },
        }],
      }],
    }))

    expect('project' in held).toBe(true)

    const block = (held as { project: Project }).project.pages[0]!.blocks[0]!

    expect(block.style).toEqual({ font: 'CC Wild Words', size: 18 })
    expect(block.letter?.angle).toBe(4)
    expect(block.quad).toHaveLength(8)
  })

  it('keeps a balloon, which is a block with children', () => {
    const held = read(aProject({
      pages: [{
        path: '006.jpg',
        name: '006',
        position: 0,
        blocks: [{ ...aBlock(), children: [aBlock(), aBlock()] }],
      }],
    }))

    expect('project' in held).toBe(true)
    expect((held as { project: Project }).project.pages[0]!.blocks[0]!.children).toHaveLength(2)
  })

  it('keeps a page whose scan was on another machine', () => {
    const held = read(aProject({
      pages: [{ path: '006.jpg', name: '006', position: 0, width: 1754, height: 2480, blocks: [] }],
    }))

    expect('project' in held).toBe(true)
    expect((held as { project: Project }).project.pages[0]!.file).toBeUndefined()
  })

  it('keeps the retouching, by surface', () => {
    const held = read(aProject({
      pages: [{
        path: '006.jpg',
        name: '006',
        position: 0,
        blocks: [],
        paint: {
          bg: [{
            seq: 1,
            clientId: 'tab-a',
            tool: 'brush',
            composite: null,
            params: { size: 20 },
            points: [1, 2, 3, 4],
            x: 0,
            y: 0,
            w: 10,
            h: 10,
            retracted: false,
          }],
        },
      }],
    }))

    expect('project' in held).toBe(true)
    expect((held as { project: Project }).project.pages[0]!.paint?.bg).toHaveLength(1)
  })

  /*
   * A uid goes straight back out in the page sync, which refuses the whole
   * request over one bad one — so a single odd name would stop every page of
   * the chapter reaching the server, on every retry, with nothing on screen to
   * say why. Dropped rather than refused, because a uid is a hint and the rest
   * of the file is perfectly good.
   */
  it('keeps a page uid that is a uuid', () => {
    const uid = '5f8d0a1e-4b2c-4d3e-8f9a-0b1c2d3e4f5a'
    const held = read(aProject({
      pages: [{ uid, path: '006.jpg', name: '006', position: 0, blocks: [] }],
    }))

    expect((held as { project: Project }).project.pages[0]!.uid).toBe(uid)
  })

  it('drops a page uid that is not one, rather than losing the file over it', () => {
    const held = read(aProject({
      pages: [{ uid: 'dropped-0', path: '006.jpg', name: '006', position: 0, blocks: [] }],
    }))

    expect('project' in held).toBe(true)
    expect((held as { project: Project }).project.pages[0]!.uid).toBeUndefined()
    expect((held as { project: Project }).project.pages[0]!.path).toBe('006.jpg')
  })

  /*
   * A history is keyed by the block's *index* in the page, because a block has
   * no name that survives being exported — `localise` rewrites exactly the ids
   * it might have had. JSON object keys are strings, so the schema has to
   * coerce them back or every history would be filed under a key nothing reads.
   */
  it('keeps a line\'s history, keyed by the block\'s index', () => {
    const held = read(aProject({
      pages: [{
        path: '006.jpg',
        name: '006',
        position: 0,
        blocks: [aBlock(), aBlock()],
        revisions: {
          1: [{
            locale: 'en',
            pinned: true,
            head: 1,
            revisions: [
              { text: 'First go', engine: 'ai-text', model: 'sonnet', batch: 'run-1', at: 1_700_000_000_000 },
              { text: 'Better', engine: 'human' },
            ],
          }],
        },
      }],
    }))

    expect('project' in held).toBe(true)

    const lines = (held as { project: Project }).project.pages[0]!.revisions

    expect(Object.keys(lines!)).toEqual(['1'])
    expect(lines![1]![0]!.revisions).toHaveLength(2)
    expect(lines![1]![0]!.revisions[0]!.batch).toBe('run-1')
    expect(lines![1]![0]!.head).toBe(1)
  })

  it('keeps a head of -1, which means the newest', () => {
    const held = read(aProject({
      pages: [{
        path: '006.jpg',
        name: '006',
        position: 0,
        blocks: [aBlock()],
        revisions: { 0: [{ locale: 'en', pinned: false, head: -1, revisions: [{ text: 'x', engine: 'human' }] }] },
      }],
    }))

    expect((held as { project: Project }).project.pages[0]!.revisions![0]![0]!.head).toBe(-1)
  })

  it('keeps the AI ledger, both halves of it', () => {
    const held = read(aProject({
      usage: {
        entries: [{ at: 1_700_000_000_000, pageId: 'scan:006.jpg', page: '006', model: 'Sonnet', inTokens: 400, outTokens: 90, cost: 0.0017 }],
        carried: { 'scan:006.jpg': { inTokens: 4000, outTokens: 900, cost: 0.017 } },
      },
    }))

    expect('project' in held).toBe(true)

    const usage = (held as { project: Project }).project.usage

    expect(usage!.entries).toHaveLength(1)
    // `carried` is per page and cannot be folded into one number — the ledger
    // says why. Both halves travel or the totals stop adding up.
    expect(Object.keys(usage!.carried)).toEqual(['scan:006.jpg'])
  })

  /*
   * The two settings are stamped into every patch key by `patchKey`, so a file
   * that carried repairs without them would carry pictures the other end never
   * looks up — present on disk, under names nothing computes.
   */
  it('keeps how the chapter was cleaned, since that names its repairs', () => {
    const held = read(aProject({ clean: { model: 'lama', segmenter: true } }))

    expect('project' in held).toBe(true)
    expect((held as { project: Project }).project.clean).toEqual({ model: 'lama', segmenter: true })
  })

  it('refuses a clean block missing the flag, which would read as false', () => {
    expect('refused' in read(aProject({ clean: { model: 'aot' } }))).toBe(true)
  })

  it('is happy with a file that carries neither, which is every local export', () => {
    const held = read(aProject())

    expect('project' in held).toBe(true)
    expect((held as { project: Project }).project.usage).toBeUndefined()
    expect((held as { project: Project }).project.pages[0]!.revisions).toBeUndefined()
  })

  it('refuses a file that is not JSON at all', () => {
    expect(readManifest('<html>')).toEqual({ refused: expect.stringContaining('could not be read') })
  })

  it('refuses a manifest that does not say it is ours', () => {
    expect('refused' in read({ ...aProject(), app: 'something-else' })).toBe(true)
  })

  it('refuses a project written by a newer build', () => {
    const held = read(aProject({ v: PROJECT_VERSION + 1 }))

    expect(held).toEqual({ refused: expect.stringContaining('newer version') })
  })

  it('refuses a block missing the geometry the canvas divides by', () => {
    const { x: _dropped, ...lame } = aBlock()

    expect('refused' in read(aProject({
      pages: [{ path: '006.jpg', name: '006', position: 0, blocks: [lame] }],
    }))).toBe(true)
  })

  it('refuses a placed image whose hash is not one', () => {
    expect('refused' in read(aProject({
      pages: [{
        path: '006.jpg',
        name: '006',
        position: 0,
        blocks: [],
        // The hash becomes a filename on the machine that opens this, which is
        // why the schema insists on its shape — see `layerDraftSchema`.
        stack: [{
          id: 'image:a1',
          label: 'clean',
          visible: true,
          opacity: 100,
          image: { hash: '../../etc/passwd', ext: 'png', name: 'c.png', width: 10, height: 10 },
        }],
      }],
    }))).toBe(true)
  })

  it('refuses a placed image in a format the store cannot keep', () => {
    expect('refused' in read(aProject({
      pages: [{
        path: '006.jpg',
        name: '006',
        position: 0,
        blocks: [],
        stack: [{
          id: 'image:a1',
          label: 'clean',
          visible: true,
          opacity: 100,
          image: {
            hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
            ext: 'bmp',
            name: 'c.bmp',
            width: 10,
            height: 10,
          },
        }],
      }],
    }))).toBe(true)
  })
})

describe('projectFilename', () => {
  it('keeps a name a reader would recognise, spaces and all', () => {
    expect(projectFilename('ECLIPSE日蝕 2')).toBe('ECLIPSE日蝕 2.kemolate')
  })

  it('takes out what a filesystem refuses without shredding the rest', () => {
    expect(projectFilename('Ch 3/4: "final"')).toBe('Ch 3-4-final.kemolate')
  })

  it('falls back rather than answering with a bare extension', () => {
    expect(projectFilename('')).toBe('chapter.kemolate')
    expect(projectFilename('///')).toBe('chapter.kemolate')
  })
})
