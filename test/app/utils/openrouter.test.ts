import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AiModel } from '#shared/utils/models'

import { translatePage, translateRegion } from '~/utils/openrouter'

/**
 * The one thing worth pinning in the errand itself: what happens when the
 * model's answer does not have the promised shape. The single-block ask
 * promises exactly one line back, and a model that answers for the whole page
 * anyway is the dangerous miscount rather than the harmless one —
 * `translations[0]` is then block one's line, and applying it would put
 * another balloon's words into the block that was asked about, silently, and
 * then persist them. That failure was observed, not imagined, which is why it
 * has a test rather than a comment.
 */

const model: AiModel = {
  id: 'test/model',
  label: 'Testy',
  note: '',
  vision: false,
  price: { in: 1, out: 1 },
}

/** OpenRouter answering with exactly these translations, and nothing learned. */
function answering (translations: string[]) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{
        message: {
          content: JSON.stringify({ source_language: 'ja', translations, glossary: [], cast: [] }),
        },
      }],
    }),
  }))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('translatePage', () => {
  it('refuses a whole page of answers where one block was asked', async () => {
    vi.stubGlobal('fetch', answering(['one', 'two', 'three']))

    await expect(
      translatePage('key', { blocks: ['あ', 'い', 'う'], target: 'en', model, only: 1 }),
    ).rejects.toThrow(/one was asked/)
  })

  it('takes the one line when the model kept its word', async () => {
    vi.stubGlobal('fetch', answering(['just this']))

    const result = await translatePage('key', { blocks: ['あ', 'い', 'う'], target: 'en', model, only: 1 })

    expect(result.translations).toEqual(['just this'])
  })

  /**
   * A page run is different on purpose: its lines are positional, so a short
   * list still lands every answer on the block it belongs to and the rest stay
   * pending. Refusing it would throw away lines that were paid for and right.
   */
  it('tolerates a short list on a page run, where lines are positional', async () => {
    vi.stubGlobal('fetch', answering(['one', 'two']))

    const result = await translatePage('key', { blocks: ['あ', 'い', 'う'], target: 'en', model })

    expect(result.translations).toEqual(['one', 'two'])
  })
})

/**
 * The region ask, whose failure modes are about the *shape* of the reply rather
 * than its length. It asks for two things and both are load-bearing: a reply
 * with only a translation would land a block claiming an empty source, and a
 * reply with only a source would land one that looks translated because the
 * lettering plate has something to draw.
 */
describe('translateRegion', () => {
  const seeing: AiModel = { ...model, vision: true }

  /*
   * happy-dom has no image decoder, and `shrinkForModel` opens the crop to find
   * out whether it needs shrinking. A hundred pixels is inside the bound, so it
   * hands the blob straight back and the request carries what it was given —
   * which is what these tests are about. What the shrink *does* is
   * `test/app/utils/images.test.ts`'s business.
   */
  beforeEach(() => {
    vi.stubGlobal('createImageBitmap', async () => ({ width: 100, height: 100, close () {} }))
  })

  /** OpenRouter answering with exactly this object. */
  function replying (body: unknown) {
    return vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(body) } }] }),
    }))
  }

  const region = (over = {}) => ({ model: seeing, image: new Blob(['x']), target: 'en', ...over })

  it('takes both halves when the model answered with both', async () => {
    vi.stubGlobal('fetch', replying({
      source_language: 'ja', source: 'あ', translation: 'ah', glossary: [], cast: [],
    }))

    const result = await translateRegion('key', region())

    expect(result).toMatchObject({ source: 'あ', translation: 'ah', language: 'ja' })
  })

  it('refuses a reply that translated without saying what it read', async () => {
    vi.stubGlobal('fetch', replying({ translation: 'ah' }))

    await expect(translateRegion('key', region())).rejects.toThrow(/unexpected JSON/)
  })

  it('refuses a reply that read without carrying it over', async () => {
    vi.stubGlobal('fetch', replying({ source: 'あ' }))

    await expect(translateRegion('key', region())).rejects.toThrow(/unexpected JSON/)
  })

  /**
   * Empty is a real answer — the region held no lettering — and must survive the
   * check that a missing field fails, which is why the guard is on the type and
   * not on the truthiness.
   */
  it('lets a region that held nothing come back empty', async () => {
    vi.stubGlobal('fetch', replying({ source: '', translation: '' }))

    await expect(translateRegion('key', region())).resolves.toMatchObject({ source: '', translation: '' })
  })

  /**
   * A model with no eyes, handed a message whose picture was dropped, answers
   * fluently and invents the line — indistinguishable from a reading. Refused
   * before the request rather than after the bill.
   */
  it('will not ask a model that cannot see', async () => {
    const sent = replying({ source: 'あ', translation: 'ah' })

    vi.stubGlobal('fetch', sent)

    await expect(translateRegion('key', region({ model }))).rejects.toThrow(/cannot see/)
    expect(sent).not.toHaveBeenCalled()
  })
})

/** A real `Response`, since a refusal is read through its status and headers. */
function reply (status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers })
}

/** A good answer for the three-line page these tests ask about. */
const good = () => reply(200, {
  choices: [{
    message: { content: JSON.stringify({ source_language: 'ja', translations: ['one', 'two', 'three'], glossary: [], cast: [] }) },
    finish_reason: 'stop',
  }],
})

const page = { blocks: ['あ', 'い', 'う'], target: 'en', model }

/**
 * A model's list is not always a list of strings.
 *
 * Only `Array.isArray` was checked, so a number, or an element written as an
 * object, reached `useTranslate` intact — where `.trim()` threw on it, after
 * the page had been paid for, and the run stopped over one line. Each element
 * is now read as the line it plainly is where there is one, and anything else is
 * a gap that is counted rather than a crash.
 */
describe('translatePage — what a line can come back as', () => {
  it('reads a number or a {text} object as the line it plainly is', async () => {
    vi.stubGlobal('fetch', answering(['one', 2, { text: 'three' }] as unknown as string[]))

    const result = await translatePage('key', page)

    expect(result.translations).toEqual(['one', '2', 'three'])
    expect(result.unreadable).toEqual([])
  })

  it('leaves anything else empty, and says which', async () => {
    vi.stubGlobal('fetch', answering(['one', null, ['two']] as unknown as string[]))

    const result = await translatePage('key', page)

    expect(result.translations).toEqual(['one', '', ''])
    expect(result.unreadable).toEqual([1, 2])
  })

  it('changes nothing about a good answer', async () => {
    vi.stubGlobal('fetch', answering(['one', 'two', 'three']))

    const result = await translatePage('key', page)

    expect(result.translations).toEqual(['one', 'two', 'three'])
    expect(result.unreadable).toEqual([])
  })
})

/**
 * A refusal that passes is asked again; one that persists ends the run.
 *
 * Nothing retried, so one 502 from a provider in the middle of a chapter
 * stopped the run at that page — for a condition that was gone a second later.
 * Twice more, then the error stands exactly as it did, because "a refusal ends
 * the run" (see `useAutoRun`) is right for a missing key or a model that has
 * gone away, and those are not retried at all.
 *
 * Fake timers, because the waits are real seconds: what is being checked is
 * *when* each attempt goes out.
 */
describe('translatePage — refusals that pass', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** Every response in turn, and then the last one for ever after. */
  function responding (...responses: (() => Response | Promise<Response>)[]) {
    let call = 0

    return vi.fn(async () => {
      const next = responses[Math.min(call, responses.length - 1)]!

      call += 1

      return next()
    })
  }

  it('asks again after a rate limit, and takes the answer', async () => {
    const sent = responding(() => reply(429, 'slow down'), good)

    vi.stubGlobal('fetch', sent)

    const asked = translatePage('key', page)

    await vi.runAllTimersAsync()

    await expect(asked).resolves.toMatchObject({ translations: ['one', 'two', 'three'] })
    expect(sent).toHaveBeenCalledTimes(2)
  })

  it('asks again after a server error or a dropped connection', async () => {
    const sent = responding(
      () => reply(502, 'bad gateway'),
      () => Promise.reject(new TypeError('Failed to fetch')),
      good,
    )

    vi.stubGlobal('fetch', sent)

    const asked = translatePage('key', page)

    await vi.runAllTimersAsync()

    await expect(asked).resolves.toMatchObject({ translations: ['one', 'two', 'three'] })
    expect(sent).toHaveBeenCalledTimes(3)
  })

  it('gives up after two more tries, with the error as it always was', async () => {
    const sent = responding(() => reply(503, 'unavailable'))

    vi.stubGlobal('fetch', sent)

    const asked = translatePage('key', page)
    const settled = expect(asked).rejects.toThrow(/OpenRouter error 503/)

    await vi.runAllTimersAsync()
    await settled

    expect(sent).toHaveBeenCalledTimes(3)
  })

  it('waits as long as Retry-After says', async () => {
    const sent = responding(() => reply(429, 'slow down', { 'Retry-After': '7' }), good)

    vi.stubGlobal('fetch', sent)

    const asked = translatePage('key', page)

    await vi.advanceTimersByTimeAsync(6_900)
    expect(sent).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(200)
    expect(sent).toHaveBeenCalledTimes(2)

    await expect(asked).resolves.toMatchObject({ translations: ['one', 'two', 'three'] })
  })

  it('does not wait an hour because a provider asked it to', async () => {
    const sent = responding(() => reply(429, 'slow down', { 'Retry-After': '3600' }), good)

    vi.stubGlobal('fetch', sent)

    const asked = translatePage('key', page)

    await vi.advanceTimersByTimeAsync(60_000)

    expect(sent).toHaveBeenCalledTimes(2)
    await expect(asked).resolves.toMatchObject({ translations: ['one', 'two', 'three'] })
  })

  it.each([
    ['a rejected key', 401, /rejected the API key/],
    ['no credit', 402, /OpenRouter error 402/],
    ['a bad request', 400, /OpenRouter error 400/],
    ['a model that has gone', 404, /OpenRouter error 404/],
  ])('does not ask again after %s', async (_, status, message) => {
    const sent = responding(() => reply(status, 'no'), good)

    vi.stubGlobal('fetch', sent)

    const asked = translatePage('key', page)
    const settled = expect(asked).rejects.toThrow(message)

    await vi.runAllTimersAsync()
    await settled

    expect(sent).toHaveBeenCalledTimes(1)
  })

  it('does not ask again after the model took too long', async () => {
    const sent = responding(() => Promise.reject(new DOMException('timed out', 'TimeoutError')), good)

    vi.stubGlobal('fetch', sent)

    const asked = translatePage('key', page)
    const settled = expect(asked).rejects.toThrow(/took too long/)

    await vi.runAllTimersAsync()
    await settled

    expect(sent).toHaveBeenCalledTimes(1)
  })

  it('still falls back to the model\'s own reasoning when a setting is refused', async () => {
    const sent = responding(() => reply(400, 'Reasoning is mandatory for this endpoint'), good)

    vi.stubGlobal('fetch', sent)

    const asked = translatePage('key', { ...page, effort: 'none' })

    await vi.runAllTimersAsync()

    await expect(asked).resolves.toMatchObject({ translations: ['one', 'two', 'three'] })

    const bodies = sent.mock.calls.map((call) => JSON.parse((call as unknown as [string, { body: string }])[1].body))

    expect(bodies[0].reasoning).toEqual({ effort: 'none' })
    expect(bodies[1].reasoning).toBeUndefined()
  })
})

/**
 * A rate limit is the run's, not one page's.
 *
 * A run has three pages out at once, and a 429 is the provider counting this
 * key's requests — all three of them. Each ask used to take its own refusal and
 * its own backoff, so the three came back together, were refused together, and
 * spent their tries in lock-step until the run ended on a limit one shared
 * pause would have cleared. The asks of a run now share a `RateGate`: a 429 on
 * one holds every send of the run, first or again, for as long as the provider
 * asked, and marks the run as limited.
 */
describe('translatePage — a rate limit the run shares', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('holds the other asks of the run for as long as the provider asked', async () => {
    let call = 0

    const sent = vi.fn(async () => (call++ === 0 ? reply(429, 'slow down', { 'Retry-After': '5' }) : good()))

    vi.stubGlobal('fetch', sent)

    const gate = { until: 0, limited: false }
    const first = translatePage('key', { ...page, gate })

    // The refusal arrives, and is said to the gate before its own wait begins.
    await vi.advanceTimersByTimeAsync(1)
    expect(gate.limited).toBe(true)

    // The next page of the same run, asked while the first waits.
    const second = translatePage('key', { ...page, gate })

    await vi.advanceTimersByTimeAsync(4_800)
    expect(sent).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(300)
    expect(sent).toHaveBeenCalledTimes(3)

    await expect(first).resolves.toMatchObject({ translations: ['one', 'two', 'three'] })
    await expect(second).resolves.toMatchObject({ translations: ['one', 'two', 'three'] })
  })

  /*
   * A 5xx or a dropped connection is about one request. Holding the rest of the
   * run for it would slow every page for a fault in one.
   */
  it('leaves a server error to the ask that met it', async () => {
    let call = 0

    const sent = vi.fn(async () => (call++ === 0 ? reply(502, 'bad gateway') : good()))

    vi.stubGlobal('fetch', sent)

    const gate = { until: 0, limited: false }
    const first = translatePage('key', { ...page, gate })

    await vi.advanceTimersByTimeAsync(1)

    const second = translatePage('key', { ...page, gate })

    await vi.advanceTimersByTimeAsync(1)
    expect(sent).toHaveBeenCalledTimes(2)
    expect(gate.limited).toBe(false)

    await vi.runAllTimersAsync()
    await expect(first).resolves.toMatchObject({ translations: ['one', 'two', 'three'] })
    await expect(second).resolves.toMatchObject({ translations: ['one', 'two', 'three'] })
  })
})

/**
 * A reply cut off at the token limit is not an answer.
 *
 * It used to be read as one: a truncated reply is almost always broken JSON,
 * which surfaced as "not JSON — try again" (and trying again truncates again),
 * and the rare one that parsed was a page with its last lines missing. The
 * provider says exactly what happened in `finish_reason`, so that is what is
 * reported.
 */
describe('translatePage — a reply cut off', () => {
  it('says the answer was cut off, rather than that it was not JSON', async () => {
    vi.stubGlobal('fetch', async () => reply(200, {
      choices: [{ message: { content: '{"source_language": "ja", "translations": ["one", "tw' }, finish_reason: 'length' }],
    }))

    await expect(translatePage('key', page)).rejects.toThrow(/cut off/)
  })

  it('does not take even a complete-looking answer from a reply that was cut off', async () => {
    vi.stubGlobal('fetch', async () => reply(200, {
      choices: [{
        message: { content: `${JSON.stringify({ translations: ['one', 'two', 'three'] })} And a note on` },
        finish_reason: 'length',
      }],
    }))

    await expect(translatePage('key', page)).rejects.toThrow(/cut off/)
  })

  it('says so for a model that spent the whole budget thinking', async () => {
    vi.stubGlobal('fetch', async () => reply(200, {
      choices: [{ message: { content: '' }, finish_reason: 'length' }],
    }))

    await expect(translatePage('key', page)).rejects.toThrow(/cut off/)
  })
})
