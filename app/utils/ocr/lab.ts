/**
 * Reading with a model that is not in the browser yet.
 *
 * The trained multilingual readers are 438 MB of PyTorch and live on the machine
 * that trained them. Until they are exported to ONNX the browser cannot load
 * them at all — which would mean testing them only through a separate bench,
 * against a separate pipeline, and slowly discovering that the two disagree.
 *
 * So this borrows the machine instead of the model. Everything the app does
 * stays here: the detector finds the regions, `deskew` straightens them, and
 * `regionCanvas` cuts exactly the crop the local reader would have read. Only
 * the recognition step goes over the wire, and it comes back as the same
 * `ReadBlock`s as everything else. When the ONNX export lands, the reader that
 * replaces this one is fed by the same code.
 *
 * The endpoint is `ocr_service.py` from the OCR training pipeline — no longer
 * kept in this repo; it runs on the machine with the weights. It replaced
 * `serve_ocr.py`, and is a different thing rather than the same thing moved.
 * `serve_ocr.py` served one checkpoint on `/crops`; this serves every reader on
 * `/read`, named in a request field, so trying out17 against GLM-OCR is a
 * string here and not a second server. `POST /read {model, images}` gives
 * back `{readings}`, and `GET /models` lists what it will answer to.
 *
 * It binds `0.0.0.0:8790`, so on a desk where both machines share a LAN this
 * reaches it directly — set `NUXT_PUBLIC_OCR_LAB` to that host. The committed
 * default stays on loopback, because a LAN address baked into the repo is one
 * that is wrong for everybody except the desk it was written on; from anywhere
 * else, tunnel:
 *
 *     ssh -L 127.0.0.1:8790:127.0.0.1:8790 you@that-machine
 *
 * Nothing here belongs in a build that ships. It is a development reader against
 * a development server, and it says so in its label.
 */

/** Where the weights are. Overridable with `NUXT_PUBLIC_OCR_LAB`. */
const FALLBACK = 'http://127.0.0.1:8790'

/**
 * Which of the service's readers to ask, when the caller does not say.
 *
 * out26, the checkpoint the in-browser beta reads (see
 * `KEMOLATE_OCR_BETA_MODEL` for how it was chosen over the earlier betas).
 * The service keeps out25, out22, out21, out19, out17 and out11 as well,
 * because a shard row names the checkpoint that read it. out17 had replaced out11 on every slice measured —
 * zh 0.016 → 0.009 CER, ko 0.196 → 0.134, ja 0.016 → 0.013.
 *
 * It was `out5`, which the service does not have. That is not a stale default
 * so much as a broken one: `/read` answers an unknown model with a 400, so
 * every lab read would have failed at the first request with `unknown model
 * 'out5'`. Kept as a named constant so the next rename is one line and not a
 * silent 400.
 */
const DEFAULT_MODEL = 'out26'

/**
 * How many crops go over in one request.
 *
 * The server batches whatever it is given onto the GPU, so bigger is faster —
 * but a page of forty balloons in one request is also forty balloons of silence
 * before the first progress tick, and a failure that loses all of them. This is
 * a compromise between the two, not a limit of either side.
 */
const BATCH = 8

export function labEndpoint (): string {
  // Guarded because this is the only `useRuntimeConfig` in `app/`, and it is
  // called from a plain function after several awaits rather than from a
  // component's setup — which is exactly where the Nuxt context can be gone. A
  // reader that fell over on a missing config would be a worse bug than one
  // that quietly used the default port it was going to use anyway.
  try {
    const configured = useRuntimeConfig().public.ocrLab

    if (typeof configured === 'string' && configured) return configured
  } catch {
    // no Nuxt instance here — fall through
  }

  return FALLBACK
}

/** A crop as the server takes it: base64 PNG, no data: prefix needed. */
async function encode (canvas: OffscreenCanvas): Promise<string> {
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  const buffer = new Uint8Array(await blob.arrayBuffer())

  let binary = ''
  for (const byte of buffer) binary += String.fromCharCode(byte)

  return btoa(binary)
}

/**
 * One batch, through whichever reader was named.
 *
 * The service reports a bad model name as a 400 carrying the list it *does*
 * know, so that list is put in the thrown message rather than dropped: the
 * failure is almost always a model that has been retired or renamed, and
 * "unknown model 'out5'" without the alternatives sends whoever reads it to
 * the Python source to find out what to type instead.
 */
async function recognise (crops: string[], model: string): Promise<string[]> {
  let response: Response

  try {
    response = await fetch(`${labEndpoint()}/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, images: crops }),
    })
  } catch {
    // A refused connection is the ordinary case here, not an exception: the
    // service is started by hand on another machine. Say which address failed,
    // because the fix is either starting it or setting NUXT_PUBLIC_OCR_LAB.
    throw new Error(`No lab server at ${labEndpoint()} — is it running?`)
  }

  const body = await response.json().catch(() => null) as
    { readings?: string[], error?: string, models?: string[] } | null

  if (!response.ok || body?.error) {
    const known = body?.models?.length ? ` Known models: ${body.models.join(', ')}.` : ''

    throw new Error((body?.error || `The lab server answered ${response.status}.`) + known)
  }

  return body?.readings ?? []
}

/**
 * Read a page through the lab server.
 *
 * `regions` is what the detector found; without any, the whole page goes as one
 * crop, which is the same degenerate case the local reader handles.
 */
export async function readWithLab (
  page: Readable,
  regions?: Region[],
  onProgress?: MangaProgress,
  model = DEFAULT_MODEL,
): Promise<ReadBlock[]> {
  const bitmap = await createImageBitmap(page.file)

  try {
    const boxes: Region[] = regions?.length
      ? regions
      : [{ x: 0, y: 0, w: bitmap.width, h: bitmap.height }]

    onProgress?.(`Cutting ${boxes.length} region${boxes.length === 1 ? '' : 's'}…`)

    // Prose becomes several pieces, a balloon stays one — see `prose.ts`. The
    // pieces are flattened into a single batch so the server sees full batches
    // either way, and each region's share is joined back up afterwards.
    const groups = boxes.map((region) => proseParts(bitmap, region) ?? [region])
    const flat = groups.flat()

    // The det head's lines when this page has been segmented — the manga
    // engine's arrangement exactly, and on the bench that means pressing
    // Segment first upgrades every later run. Read before the crops are cut
    // rather than after: the lean straightens the crop as well as filing the
    // quad, and those are the same measurement.
    const segmented = await segmentedAlready(page.file)?.catch(() => null) ?? null
    const lines = segmented ? detLines(segmented) : null

    // Native pixels, not a browser-squeezed square. The server resizes with the
    // same processor the weights were trained against, and measured on one
    // balloon that is worth a syllable: squeezing 213×294 to 224² here read
    // `미친호랑이x기`, sending the pixels read `미친호랑이x끼`. The local reader
    // has no such choice — its canvas *is* the tensor — but this one does.
    // Straightened by the det head where it measured a lean — the same
    // instrument the stored quad uses. See `regionCanvas`.
    const crops = await Promise.all(flat.map((part) =>
      encode(regionCanvas(bitmap, part, 'native', lines ? detLeanFor(lines, part) : null))))

    const texts: string[] = []

    for (let at = 0; at < crops.length; at += BATCH) {
      onProgress?.(
        `Reading ${Math.min(at + BATCH, crops.length)} of ${crops.length} on the lab server (${model})…`,
        { done: at, total: crops.length },
      )

      texts.push(...await recognise(crops.slice(at, at + BATCH), model))
    }

    // A short answer is a failed one, not a reason to mislabel the rest: each
    // region takes only its own pieces, so a truncated reply leaves later
    // regions empty rather than shifting somebody else's text onto them.
    let taken = 0
    const detections: Detection[] = boxes.map((region, index) => {
      const size = groups[index]!.length
      const text = texts.slice(taken, taken + size).join('')

      taken += size

      // The lean the lettering actually has, where it has one — the same
      // measurement `regionCanvas` makes to straighten the crop, which was
      // being spent on the resample and dropped. See `tiltedQuad`.
      // Det boxes are stored as given, with one exception: det's *level*
      // verdict is a claim about the lines it saw, and on a one-glyph
      // balloon with an ellipsis trail it sees the glyph and misses the
      // flow. A real ink lean outranks a level det box there; a tilted det
      // box outranks everything. Ink must also sit outside the ambiguity
      // band -- see `quadWorthy`.
      const fromDet = lines && detBoxFor(lines, region)
      const fromInk = fromDet === null || fromDet.tilt === 0
        ? uprightRegion(bitmap, region,
            segmented ? (crop) => segFor(segmented, crop) : undefined)
        : null
      const inkWorthy = fromInk && quadWorthy(fromInk) ? fromInk : null
      // One bar for the ink, whatever det said. It used to hold only where
      // det measured level; where det saw nothing the ink was taken at any
      // size (`fromDet ?? inkWorthy`), and that is how 5–7° leans on upright
      // lettering reached the database — the ink was the only witness and it
      // was believed on less than it needs anywhere else. Under the bar the
      // detector's upright box is stored, which is where that block was
      // before any lean was measured.
      const leaning = fromDet && fromDet.tilt !== 0
        ? fromDet
        : inkWorthy && Math.abs(inkWorthy.tilt) >= 8 ? inkWorthy : fromDet

      return {
        quad: leaning
          ? tiltedQuad(leaning)
          : [
              { x: region.x, y: region.y },
              { x: region.x + region.w, y: region.y },
              { x: region.x + region.w, y: region.y + region.h },
              { x: region.x, y: region.y + region.h },
            ],
        text,
      }
    })

    return readPage(detections, page.width || bitmap.width)
  } finally {
    bitmap.close()
  }
}
