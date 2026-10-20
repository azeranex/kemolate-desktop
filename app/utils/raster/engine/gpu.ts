/**
 * The page engine on WebGPU: the run's layers composited onto one canvas.
 *
 * Measured against the 2D canvas before it was made the default, on a chapter
 * of 3732 × 5197 pages: both are smooth when the canvas is redrawn only once a
 * gesture stops, but only this one can redraw on *every* frame of a zoom — 9 ms
 * frames and about a millisecond of main thread a redraw, against 17–33 ms
 * frames for 2D — so only this one stays sharp all the way through.
 *
 * A layer is a list of pictures in scan pixels, an opacity, and the adjustment
 * tables that reach it. A plain layer is drawn straight onto the canvas; a
 * layer with an opacity or an adjustment is drawn onto a scratch texture first
 * and composited from there, because both apply to the layer as a whole — two
 * repairs that overlap at half opacity are one half-opaque plate, as the DOM
 * draws them, not two.
 *
 * The adjustment pass divides the alpha out before it looks a level up and
 * multiplies it back after, because the tables are written for plain 8-bit
 * levels: that is what `applyLut` applies on export, and a table read with
 * premultiplied values would darken every soft edge.
 *
 * Textures are made from the bitmaps the engine is handed, once each, and
 * destroyed when their bitmap is closed.
 */

/** One picture to draw: the page region `sx, sy, sw, sh`, in scan pixels, that the whole bitmap covers. */
import { surfaceCanvases, takeDirty } from './surfaces'

export interface Quad {
  /** A decoded picture — or a paint surface's canvas, when `surface` names it. */
  bitmap: ImageBitmap | HTMLCanvasElement
  sx: number
  sy: number
  sw: number
  sh: number
  /**
   * The paint surface this is (`surfaces.ts`): kept as a texture of its own
   * and updated only where it changed, since it changes under a brush every
   * frame and is the page's full size.
   */
  surface?: string
}

/** One layer of the run. `luts` are `adjustLut`'s 256-entry tables (0–1), nearest adjustment first. */
export interface FrameLayer {
  quads: Quad[]
  opacity: number
  luts: number[][]
}

export interface Frame {
  layers: FrameLayer[]
  /** Scan pixels to canvas pixels: `canvas = scan * scale + shift`. */
  scale: number
  shift: { x: number, y: number }
  /** From 1:1 up, pixels drawn as blocks — `pixelPeek`. */
  crisp: boolean
}

const QUAD = /* wgsl */ `
struct Quad { dst: vec4f }

@group(0) @binding(0) var<uniform> quad: Quad;
@group(0) @binding(1) var picture: texture_2d<f32>;
@group(0) @binding(2) var pick: sampler;

struct Out { @builtin(position) at: vec4f, @location(0) uv: vec2f }

@vertex fn vs (@builtin(vertex_index) i: u32) -> Out {
  let corner = vec2f(f32(i & 1u), f32(i >> 1u));
  var out: Out;
  out.at = vec4f(mix(quad.dst.xy, quad.dst.zw, corner), 0.0, 1.0);
  out.uv = corner;
  return out;
}

@fragment fn fs (in: Out) -> @location(0) vec4f {
  return textureSample(picture, pick, in.uv);
}
`

const COMPOSE = /* wgsl */ `
struct Compose { opacity: f32, count: u32 }

@group(0) @binding(0) var<uniform> compose: Compose;
@group(0) @binding(1) var layer: texture_2d<f32>;
@group(0) @binding(2) var tables: texture_2d<f32>;

@vertex fn vs (@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let corner = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(corner * 2.0 - 1.0, 0.0, 1.0);
}

fn level (value: f32) -> i32 {
  return i32(round(clamp(value, 0.0, 1.0) * 255.0));
}

@fragment fn fs (@builtin(position) at: vec4f) -> @location(0) vec4f {
  var colour = textureLoad(layer, vec2i(at.xy), 0);

  if (colour.a > 0.0 && compose.count > 0u) {
    var rgb = colour.rgb / colour.a;

    for (var i = 0u; i < compose.count; i++) {
      let row = i32(i);

      rgb = vec3f(
        textureLoad(tables, vec2i(level(rgb.r), row), 0).r,
        textureLoad(tables, vec2i(level(rgb.g), row), 0).r,
        textureLoad(tables, vec2i(level(rgb.b), row), 0).r,
      );
    }

    colour = vec4f(rgb * colour.a, colour.a);
  }

  return colour * compose.opacity;
}
`

/*
 * The WebGPU flag values, written out: TypeScript's DOM library here has the
 * interfaces but not these namespaces. The numbers are the spec's.
 */
const STAGE = { VERTEX: 0x1, FRAGMENT: 0x2 }
const BUFFER = { COPY_DST: 0x8, UNIFORM: 0x40 }
const TEXTURE = { COPY_DST: 0x2, TEXTURE_BINDING: 0x4, RENDER_ATTACHMENT: 0x10 }

/** Uniform slots per frame, each at the 256-byte alignment dynamic offsets need. */
const QUADS = 512
const LAYERS = 32
const SLOT = 256

/** The most adjustments one layer can have applied; the rest are dropped with a warning. */
const TABLES = 16

/** Premultiplied source over. */
const OVER: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
}

export interface Gpu {
  device: GPUDevice
  format: GPUTextureFormat
  quadLayout: GPUBindGroupLayout
  composeLayout: GPUBindGroupLayout
  /** Quads onto the canvas, and onto a scratch texture. */
  quadToCanvas: GPURenderPipeline
  quadToScratch: GPURenderPipeline
  compose: GPURenderPipeline
  quadUniforms: GPUBuffer
  composeUniforms: GPUBuffer
  smooth: GPUSampler
  crisp: GPUSampler
}

let opening: Promise<Gpu | null> | null = null

/** The device, opened once for the tab, or null where WebGPU will not open. */
export function openGpu (): Promise<Gpu | null> {
  if (opening) return opening

  opening = (async () => {
    if (typeof navigator === 'undefined' || !('gpu' in navigator)) return null

    const adapter = await navigator.gpu.requestAdapter().catch(() => null)
    const device = await adapter?.requestDevice().catch(() => null)

    if (!device) return null

    // A lost device is a GPU gone; the next ask opens a new one, and every
    // texture made on this one goes with it.
    device.lost.then(() => {
      opening = null
      textures.clear()
      tables.clear()
      surfaceTextures.clear()
    })

    const format = navigator.gpu.getPreferredCanvasFormat()
    const quadModule = device.createShaderModule({ code: QUAD })
    const composeModule = device.createShaderModule({ code: COMPOSE })

    const quadLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: STAGE.VERTEX, buffer: { type: 'uniform', hasDynamicOffset: true } },
        { binding: 1, visibility: STAGE.FRAGMENT, texture: {} },
        { binding: 2, visibility: STAGE.FRAGMENT, sampler: {} },
      ],
    })

    const composeLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: STAGE.FRAGMENT, buffer: { type: 'uniform', hasDynamicOffset: true } },
        { binding: 1, visibility: STAGE.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
        { binding: 2, visibility: STAGE.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
      ],
    })

    const quadPipeline = (target: GPUTextureFormat) => device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [quadLayout] }),
      vertex: { module: quadModule, entryPoint: 'vs' },
      fragment: { module: quadModule, entryPoint: 'fs', targets: [{ format: target, blend: OVER }] },
      primitive: { topology: 'triangle-strip' },
    })

    return {
      device,
      format,
      quadLayout,
      composeLayout,
      quadToCanvas: quadPipeline(format),
      quadToScratch: quadPipeline('rgba8unorm'),
      compose: device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [composeLayout] }),
        vertex: { module: composeModule, entryPoint: 'vs' },
        fragment: { module: composeModule, entryPoint: 'fs', targets: [{ format, blend: OVER }] },
        primitive: { topology: 'triangle-list' },
      }),
      quadUniforms: device.createBuffer({ size: QUADS * SLOT, usage: BUFFER.UNIFORM | BUFFER.COPY_DST }),
      composeUniforms: device.createBuffer({ size: LAYERS * SLOT, usage: BUFFER.UNIFORM | BUFFER.COPY_DST }),
      smooth: device.createSampler({ magFilter: 'linear', minFilter: 'linear' }),
      crisp: device.createSampler({ magFilter: 'nearest', minFilter: 'linear' }),
    }
  })()

  return opening
}

/* ---------- textures ---------- */

/**
 * A picture's texture, by the bitmap it was made from.
 *
 * The bitmap is closed as soon as it is on the GPU (`closeOnUpload`): kept, it
 * is a second copy of every picture in the tab's own memory — the fit levels
 * of five pages and a zoom's tiles, some 150 MB at the largest pages measured
 * — for nothing, since nothing reads it again. So the bitmap object stays only
 * as the picture's name, and `release` is how a picture is let go of: its
 * texture destroyed, its bitmap closed if it was not already.
 */
const textures = new Map<ImageBitmap, { texture: GPUTexture, groups: Map<GPUSampler, GPUBindGroup> }>()

/** Whether a bitmap is closed once uploaded — on while the engine draws with WebGPU. */
let closeOnUpload = false

export function setCloseOnUpload (on: boolean) {
  closeOnUpload = on
}

/**
 * Put a picture on the GPU now rather than when it is first drawn: a page
 * decoded ahead is then uploaded ahead too — its bitmap let go of at once, and
 * the upload out of the frame the page is turned to.
 */
export function upload (gpu: Gpu, bitmap: ImageBitmap) {
  if (bitmap.width) pictureOf(gpu, bitmap)
}

/** Let a picture go: its texture, if it has one, and its bitmap. */
export function release (bitmap: ImageBitmap) {
  textures.get(bitmap)?.texture.destroy()
  textures.delete(bitmap)
  bitmap.close()
}

/** Whether a picture can still be drawn — an open bitmap, or one already on the GPU. */
export function drawable (bitmap: ImageBitmap): boolean {
  return bitmap.width > 0 || textures.has(bitmap)
}

function pictureOf (gpu: Gpu, bitmap: ImageBitmap) {
  const held = textures.get(bitmap)

  if (held) return held

  const texture = gpu.device.createTexture({
    size: [bitmap.width, bitmap.height],
    format: 'rgba8unorm',
    usage: TEXTURE.TEXTURE_BINDING | TEXTURE.COPY_DST | TEXTURE.RENDER_ATTACHMENT,
  })

  gpu.device.queue.copyExternalImageToTexture({ source: bitmap }, { texture, premultipliedAlpha: true }, [bitmap.width, bitmap.height])

  const made = { texture, groups: new Map<GPUSampler, GPUBindGroup>() }

  textures.set(bitmap, made)

  if (closeOnUpload) bitmap.close()

  return made
}

/** Bytes of picture held on the GPU — for measuring. */
export function gpuBytes (): number {
  let bytes = 0

  for (const { texture } of textures.values()) bytes += texture.width * texture.height * 4

  return bytes
}

/**
 * Paint surfaces' textures, by their canvas. Made at the canvas's size and
 * brought up to date from the rectangle painting says it changed (`takeDirty`)
 * — a brush stroke is a few hundred pixels a frame of a twenty-megapixel
 * surface, and uploading all of it every frame is what this avoids.
 */
const surfaceTextures = new Map<HTMLCanvasElement, { texture: GPUTexture, groups: Map<GPUSampler, GPUBindGroup> }>()

function surfaceOfCanvas (gpu: Gpu, key: string, canvas: HTMLCanvasElement) {
  let held = surfaceTextures.get(canvas)

  if (held && (held.texture.width !== canvas.width || held.texture.height !== canvas.height)) {
    held.texture.destroy()
    surfaceTextures.delete(canvas)
    held = undefined
  }

  const dirty = takeDirty(key)

  if (!held) {
    held = {
      texture: gpu.device.createTexture({
        size: [canvas.width, canvas.height],
        format: 'rgba8unorm',
        usage: TEXTURE.TEXTURE_BINDING | TEXTURE.COPY_DST | TEXTURE.RENDER_ATTACHMENT,
      }),
      groups: new Map(),
    }
    surfaceTextures.set(canvas, held)
    gpu.device.queue.copyExternalImageToTexture({ source: canvas }, { texture: held.texture, premultipliedAlpha: true }, [canvas.width, canvas.height])

    return held
  }

  if (dirty) {
    gpu.device.queue.copyExternalImageToTexture(
      { source: canvas, origin: { x: dirty.x, y: dirty.y } },
      { texture: held.texture, origin: { x: dirty.x, y: dirty.y }, premultipliedAlpha: true },
      [dirty.w, dirty.h],
    )
  }

  return held
}

/** Surface textures whose canvas is gone or empty. */
function sweepSurfaces () {
  const live = surfaceCanvases()

  for (const [canvas, held] of surfaceTextures) {
    if (live.has(canvas) && canvas.width) continue

    held.texture.destroy()
    surfaceTextures.delete(canvas)
  }
}

/** Adjustment tables, one row of 256 levels per adjustment, kept by content. */
const tables = new Map<string, GPUTexture>()

function tablesOf (gpu: Gpu, luts: number[][]): GPUTexture {
  const name = luts.map((lut) => lut.join(',')).join('|')
  const held = tables.get(name)

  if (held) return held

  const texture = gpu.device.createTexture({
    size: [256, Math.max(1, luts.length)],
    format: 'r8unorm',
    usage: TEXTURE.TEXTURE_BINDING | TEXTURE.COPY_DST,
  })

  const bytes = new Uint8Array(256 * Math.max(1, luts.length))

  // As `applyLut` turns a table into bytes — the export's rounding exactly, so
  // the two cannot land a level apart. A table holds 0–1, not 0–255.
  luts.forEach((lut, row) => bytes.set(lut.map((value) => Math.max(0, Math.min(255, Math.round(value * 255)))), row * 256))
  gpu.device.queue.writeTexture({ texture }, bytes, { bytesPerRow: 256 }, [256, Math.max(1, luts.length)])

  // A handful are live at once; a slider dragged makes a new one per step.
  if (tables.size > 32) {
    const [oldest, gone] = tables.entries().next().value!

    gone.destroy()
    tables.delete(oldest)
  }

  tables.set(name, texture)

  return texture
}

/* ---------- per canvas ---------- */

interface Surface {
  context: GPUCanvasContext
  /** The device it was configured for — a new one after a loss means configuring again. */
  device: GPUDevice
  scratch: GPUTexture | null
}

const surfaces = new WeakMap<HTMLCanvasElement, Surface>()

function surfaceOf (gpu: Gpu, canvas: HTMLCanvasElement): Surface | null {
  const held = surfaces.get(canvas)

  if (held?.device === gpu.device) return held

  const context = canvas.getContext('webgpu') as GPUCanvasContext | null

  if (!context) return null

  context.configure({ device: gpu.device, format: gpu.format, alphaMode: 'premultiplied' })

  const made = { context, device: gpu.device, scratch: null }

  surfaces.set(canvas, made)

  return made
}

function scratchOf (gpu: Gpu, surface: Surface, width: number, height: number): GPUTexture {
  if (surface.scratch && surface.scratch.width === width && surface.scratch.height === height) return surface.scratch

  surface.scratch?.destroy()
  surface.scratch = gpu.device.createTexture({
    size: [width, height],
    format: 'rgba8unorm',
    usage: TEXTURE.RENDER_ATTACHMENT | TEXTURE.TEXTURE_BINDING,
  })

  return surface.scratch
}

/** Draw a frame onto `canvas`, which is already sized. */
export function drawGpu (gpu: Gpu, canvas: HTMLCanvasElement, frame: Frame) {
  const surface = surfaceOf(gpu, canvas)

  if (!surface) return

  sweepSurfaces()

  const { device } = gpu
  const w = canvas.width
  const h = canvas.height
  const sampler = frame.crisp ? gpu.crisp : gpu.smooth

  // Every quad's place on the canvas, in clip space, written once for the frame.
  const quadData = new Float32Array((QUADS * SLOT) / 4)
  const composeData = new ArrayBuffer(LAYERS * SLOT)
  let quads = 0

  const placed = frame.layers.slice(0, LAYERS).map((layer) => layer.quads.map((quad) => {
    if (quads >= QUADS) return -1

    const x0 = quad.sx * frame.scale + frame.shift.x
    const y0 = quad.sy * frame.scale + frame.shift.y
    const x1 = (quad.sx + quad.sw) * frame.scale + frame.shift.x
    const y1 = (quad.sy + quad.sh) * frame.scale + frame.shift.y

    quadData.set([(x0 / w) * 2 - 1, 1 - (y0 / h) * 2, (x1 / w) * 2 - 1, 1 - (y1 / h) * 2], (quads * SLOT) / 4)

    return quads++
  }))

  frame.layers.slice(0, LAYERS).forEach((layer, i) => {
    new Float32Array(composeData, i * SLOT, 1)[0] = layer.opacity
    new Uint32Array(composeData, i * SLOT + 4, 1)[0] = Math.min(TABLES, layer.luts.length)
  })

  device.queue.writeBuffer(gpu.quadUniforms, 0, quadData, 0, (Math.max(1, quads) * SLOT) / 4)
  device.queue.writeBuffer(gpu.composeUniforms, 0, composeData, 0, Math.max(1, frame.layers.length) * SLOT)

  const encoder = device.createCommandEncoder()
  const target = surface.context.getCurrentTexture().createView()
  let cleared = false

  const drawQuads = (pass: GPURenderPassEncoder, layer: FrameLayer, slots: number[]) => {
    layer.quads.forEach((quad, q) => {
      const slot = slots[q]!

      if (slot < 0) return

      const source = quad.bitmap

      if (source instanceof HTMLCanvasElement ? !source.width : !drawable(source)) return

      const held = quad.surface && source instanceof HTMLCanvasElement
        ? surfaceOfCanvas(gpu, quad.surface, source)
        : pictureOf(gpu, source as ImageBitmap)
      let group = held.groups.get(sampler)

      if (!group) {
        group = device.createBindGroup({
          layout: gpu.quadLayout,
          entries: [
            { binding: 0, resource: { buffer: gpu.quadUniforms, size: 16 } },
            { binding: 1, resource: held.texture.createView() },
            { binding: 2, resource: sampler },
          ],
        })
        held.groups.set(sampler, group)
      }

      pass.setBindGroup(0, group, [slot * SLOT])
      pass.draw(4)
    })
  }

  const onCanvas = () => {
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: target, loadOp: cleared ? 'load' : 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }],
    })

    cleared = true

    return pass
  }

  let pass: GPURenderPassEncoder | null = null

  frame.layers.slice(0, LAYERS).forEach((layer, i) => {
    if (!layer.quads.length || layer.opacity <= 0) return

    // A plain layer goes straight on.
    if (layer.opacity >= 1 && !layer.luts.length) {
      pass ??= onCanvas()
      pass.setPipeline(gpu.quadToCanvas)
      drawQuads(pass, layer, placed[i]!)

      return
    }

    if (layer.luts.length > TABLES) console.warn(`[kemolate] only ${TABLES} adjustments are applied to one layer`)

    // A layer with an opacity or an adjustment: onto the scratch first, then
    // composited — see the header for why a layer is one thing.
    pass?.end()
    pass = null

    const scratch = scratchOf(gpu, surface, w, h)
    const own = encoder.beginRenderPass({
      colorAttachments: [{ view: scratch.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }],
    })

    own.setPipeline(gpu.quadToScratch)
    drawQuads(own, layer, placed[i]!)
    own.end()

    const composite = onCanvas()

    composite.setPipeline(gpu.compose)
    composite.setBindGroup(0, device.createBindGroup({
      layout: gpu.composeLayout,
      entries: [
        { binding: 0, resource: { buffer: gpu.composeUniforms, size: 8 } },
        { binding: 1, resource: scratch.createView() },
        { binding: 2, resource: tablesOf(gpu, layer.luts.slice(0, TABLES)).createView() },
      ],
    }), [i * SLOT])
    composite.draw(3)
    composite.end()
  })

  pass ??= onCanvas()
  ;(pass as GPURenderPassEncoder).end()

  device.queue.submit([encoder.finish()])
}
