/**
 * 在 Service Worker 中轮询答案状态，避免后台标签节流 content script 里的 setTimeout。
 */

/**
 * @param {() => boolean} isAborted
 * @param {number} tabId
 * @param {(tabId: number) => Promise<void>} pulseTab
 * @param {(tabId: number, payload: object) => Promise<object | undefined>} pollOnce
 * @param {object} payload
 * @param {{ timeoutMs?: number, minStableLen?: number, stableRequired?: number, intervalMs?: number }} [opts]
 */
export async function waitForAnswerByBackgroundPoll(
  isAborted,
  tabId,
  pulseTab,
  pollOnce,
  payload,
  opts = {}
) {
  const timeoutMs = opts.timeoutMs ?? 180000;
  const minStableLen = opts.minStableLen ?? 12;
  const stableRequired = opts.stableRequired ?? 12;
  const intervalMs = opts.intervalMs ?? 400;

  let lastText = "";
  let stableTicks = 0;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (isAborted()) {
      throw new Error("采集已停止");
    }

    await pulseTab(tabId);
    const snap = await pollOnce(tabId, payload);

    if (!snap?.ok) {
      await sleep(intervalMs);
      continue;
    }

    const text = String(snap.text || "");
    const generating = Boolean(snap.generating);

    if (generating) {
      stableTicks = 0;
      lastText = text;
      await sleep(intervalMs);
      continue;
    }

    if (text.length < minStableLen) {
      stableTicks = 0;
      lastText = text;
      await sleep(intervalMs);
      continue;
    }

    if (text === lastText) stableTicks += 1;
    else {
      stableTicks = 0;
      lastText = text;
    }

    if (stableTicks >= stableRequired && !generating) {
      return snap;
    }

    await sleep(intervalMs);
  }

  throw new Error("等待条件超时");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
