// Flies lab throws off the main thread: a run takes up to 30 000 physics steps.
import { flyTrial, type Launch } from '../shared/trial'

self.onmessage = ({
  data,
}: MessageEvent<{ design: unknown; launch: Launch }>) => {
  try {
    self.postMessage({ result: flyTrial(data.design, data.launch) })
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
