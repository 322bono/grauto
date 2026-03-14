const DEFAULT_AI_REQUEST_GAP_MS = 15_000;

let lastAiRequestAt = 0;
let requestQueue: Promise<void> = Promise.resolve();

export function throttleAiRequest(minGapMs = DEFAULT_AI_REQUEST_GAP_MS) {
  const queued = requestQueue.then(async () => {
    const now = Date.now();
    const waitMs = Math.max(0, lastAiRequestAt + minGapMs - now);

    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    lastAiRequestAt = Date.now();
  });

  requestQueue = queued.catch(() => {});
  return queued;
}
