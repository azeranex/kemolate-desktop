/**
 * The model list, with what OpenRouter actually charges for it.
 *
 * `shared/utils/models.ts` is the curated list and says openly that its prices
 * are placeholders "of the right order of magnitude" — invented numbers, put
 * there so a cost estimate reads as roughly the right size before anything has
 * been asked. This is the half that was missing: the part that replaces them
 * with the real ones.
 *
 * ## Why this is a composable and not a function in `utils/openrouter.ts`
 *
 * It was one, and it could not work. `refreshModels()` there reached into the
 * shared `AI_MODELS` array and rewrote each entry's `price` in place, which
 * fails twice over:
 *
 * - a plain module-level array is not reactive, so nothing re-rendered when the
 *   numbers changed; and
 * - the panel had already done `AI_MODELS.map((m) => ({ in: m.price.in, … }))`
 *   at setup, copying the placeholders into a snapshot that no later mutation
 *   could reach.
 *
 * So the fetch existed, was never called from anywhere, and would have changed
 * nothing on screen if it had been. Held in `useState` instead, the list is one
 * per app rather than one per component, it is reactive, and the price a panel
 * prints is the price the next request will be billed at.
 *
 * ## Best effort, always
 *
 * The endpoint is public — no key, so this can run before anybody has entered
 * one — and every failure leaves the curated list exactly as it was. Being
 * offline should cost you the accuracy of an estimate, not the ability to
 * choose a model.
 */
import type { AiModel } from '#shared/utils/models'

const ENDPOINT = 'https://openrouter.ai/api/v1/models'

const TIMEOUT = 15_000

/**
 * A curated entry plus whether *its* price is OpenRouter's or still ours.
 *
 * Per model rather than one flag for the list, because the fetch replacing
 * every price is the ordinary case and not a guarantee: a curated id that
 * OpenRouter has renamed or dropped keeps its placeholder, and under a single
 * flag that invented number was presented to four decimal places as the real
 * rate the moment any *other* model's price landed.
 */
export interface PricedModel extends AiModel {
  priced: boolean
}

export function useModels () {
  /**
   * Copied out of the shared list rather than referenced, so that a refresh
   * replaces this state and leaves `AI_MODELS` as the constant it reads like
   * everywhere else. `price` is copied too — a shallow copy would hand every
   * entry the shared object and put the fetched numbers back into the module.
   */
  const models = useState<PricedModel[]>('ai-models', () =>
    AI_MODELS.map((model) => ({ ...model, price: { ...model.price }, priced: false })))

  /**
   * True once OpenRouter has answered at all — the once-per-session guard,
   * which is a different fact from any one model being priced.
   */
  const fetched = useState('ai-models-fetched', () => false)

  const byId = (id: string | null | undefined) =>
    models.value.find((model) => model.id === id) ?? models.value[0]!

  /**
   * Ask what these models cost and whether they think.
   *
   * Once per session: prices move on the scale of provider announcements, not
   * of page turns, and a panel that refetched on every mount would spend a
   * request each time somebody opened a dock column.
   */
  async function refresh (): Promise<void> {
    if (fetched.value) return

    try {
      const response = await fetch(ENDPOINT, { signal: AbortSignal.timeout(TIMEOUT) })

      if (!response.ok) return

      const data = await response.json() as {
        data?: {
          id: string
          supported_parameters?: string[]
          architecture?: { input_modalities?: string[] }
          pricing?: { prompt?: string, completion?: string }
        }[]
      }

      const live = new Map((data.data ?? []).map((model) => [model.id, model]))

      models.value = models.value.map((model) => {
        const found = live.get(model.id)

        if (!found) return model

        // OpenRouter quotes dollars per *token*, as strings. Everything on our
        // side is per million, which is the unit anybody reading a price thinks
        // in — and the unit the placeholders were written in.
        const input = Number(found.pricing?.prompt)
        const output = Number(found.pricing?.completion)

        // Whether it can be shown a page at all. Taken from the provider rather
        // than trusted from the curated list, because getting it wrong here is
        // silent in the worst way: a text-only model handed an image either
        // errors or ignores it, and the second looks exactly like a translation
        // that read the artwork and made nothing of it. A list written by hand
        // will eventually be wrong about this; the endpoint will not.
        const modalities = found.architecture?.input_modalities

        const good = Number.isFinite(input) && Number.isFinite(output)

        return {
          ...model,
          vision: modalities ? modalities.includes('image') : model.vision,
          // Whether the effort control is wired to anything real for this
          // model. Unknown until asked, which is why it is optional.
          reasoning: found.supported_parameters?.includes('reasoning') ?? false,
          // Marked on the entry it is true of, not on the list: an id the
          // endpoint did not answer for stays a placeholder and keeps saying so.
          priced: good,
          price: good
            ? { in: input * 1_000_000, out: output * 1_000_000 }
            : model.price,
        }
      })

      fetched.value = true
    } catch {
      // Offline, or OpenRouter having a moment. The curated list still works,
      // and the estimate goes on reading as the estimate it says it is.
    }
  }

  return { models, byId, refresh }
}
