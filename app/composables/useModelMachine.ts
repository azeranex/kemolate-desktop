import type { ModelMachine } from '~/utils/ocr/readers'

import { webGpuHalf, webGpuOffered } from '~/utils/resources'

/**
 * What this browser will run models on, for a label that says what it will
 * fetch — see `readerBytes` and `detectorBytes`.
 *
 * No GPU until mounted: a label drawn on the server has none to ask about, and
 * the first render here has to agree with it or hydration has a disagreement to
 * settle. Then WebGPU at once, and half precision when the adapter has answered
 * — a moment later, and only ever between the figures the label can show.
 */
export function useModelMachine () {
  const mounted = useMounted()
  const half = ref(false)

  onMounted(() => {
    webGpuHalf().then((yes) => {
      half.value = yes
    })
  })

  return computed<ModelMachine>(() => ({ gpu: mounted.value && webGpuOffered(), half: half.value }))
}
