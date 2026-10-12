/* global chrome */
(function () {
  if (globalThis.__PERPLEXITY_AI_AUTOCHAT_LOADED) return;
  globalThis.__PERPLEXITY_AI_AUTOCHAT_LOADED = true;

  const HOSTS = ["www.perplexity.ai", "perplexity.ai"];

  let questionRunLock = Promise.resolve();

  /**
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  function withQuestionLock(fn) {
    const run = questionRunLock.then(fn);
    questionRunLock = run.catch(() => {});
    return run;
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /**
   * @param {"info"|"warn"|"error"} level
   * @param {string} message
   * @param {unknown} [detail]
   */
  function trace(level, message, detail) {
    let detailStr;
    if (detail !== undefined) {
      try {
        detailStr = typeof detail === "string" ? detail : JSON.stringify(detail);
      } catch {
        detailStr = String(detail);
      }
    }
    const payload = {
      type: "DEBUG_LOG",
      level,
      source: "perplexity-content",
      message,
      ...(detailStr !== undefined ? { detail: detailStr } : {}),
    };
    chrome.runtime.sendMessage(payload).catch(() => {});
    const line = `[perplexity-content] ${message}${detailStr ? ` ${detailStr}` : ""}`;
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  }

  /**
   * @param {HTMLElement} el
   */
  function isVisible(el) {
    if (!(el instanceof HTMLElement)) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const st = getComputedStyle(el);
    if (st.visibility === "hidden" || st.display === "none") return false;
    return true;
  }

  function isPerplexityPage() {
    return HOSTS.includes(location.hostname);
  }

  /**
   * @param {() => Element | null} fn
   */
  async function waitFor(fn, timeoutMs = 25000, intervalMs = 200) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const el = fn();
      if (el) return el;
      await sleep(intervalMs);
    }
    throw new Error("等待元素超时");
  }

  /**
   * @param {() => boolean} fn
   */
  async function waitUntil(fn, timeoutMs = 180000, intervalMs = 300) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (fn()) return;
      await sleep(intervalMs);
    }
    throw new Error("等待条件超时");
  }

  /**
   * 与 `#ask-input` 同一条 composer 工具行内的按钮（grid `grid-cols-[1fr_auto]`）；
   * 发送/停止一般为该行最后一个 `button`（Playwright MCP 实测 www.perplexity.ai）。
   *
   * @returns {HTMLButtonElement | null}
   */
  function findComposerPrimaryButton() {
    const ask = document.querySelector("#ask-input");
    if (!ask) return null;
    let p = ask;
    for (let i = 0; i < 12 && p; i++) {
      const buttons = /** @type {HTMLButtonElement[]} */ (
        [...p.querySelectorAll(":scope button")].filter((b) => b instanceof HTMLButtonElement && isVisible(b))
      );
      if (buttons.length >= 2) {
        return buttons[buttons.length - 1];
      }
      p = p.parentElement;
    }
    return null;
  }

  /**
   * 主输入：稳定 id `#ask-input`（role=textbox），与语言无关。
   *
   * @returns {HTMLElement | null}
   */
  function findPromptEditor() {
    const ask = document.querySelector("#ask-input");
    if (ask instanceof HTMLElement && isVisible(ask)) return ask;

    const main = document.querySelector("main");
    if (!main) return null;
    const tbs = /** @type {HTMLElement[]} */ ([...main.querySelectorAll('[role="textbox"]')]);
    let best = /** @type {HTMLElement | null} */ (null);
    let bestArea = 0;
    for (const el of tbs) {
      if (!isVisible(el)) continue;
      const r = el.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea) {
        bestArea = area;
        best = el;
      }
    }
    return best;
  }

  /**
   * @param {HTMLElement} el
   * @returns {string}
   */
  function getPromptText(el) {
    if (el instanceof HTMLTextAreaElement) return (el.value || "").trim();
    return (el.innerText || el.textContent || "").trim();
  }

  /**
   * @param {HTMLElement} el
   */
  async function clearPromptEditor(el) {
    await setPromptText(el, "");
    await sleep(120);
    if (getPromptText(el).length > 0) {
      el.focus();
      try {
        document.execCommand("selectAll", false);
        document.execCommand("delete", false);
      } catch (_) {
        el.textContent = "";
      }
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
      await sleep(120);
    }
  }

  async function waitForGenerationEnd(maxMs = 180000) {
    if (!isGenerating()) {
      await sleep(200);
      return;
    }
    await waitUntil(() => !isGenerating(), maxMs, 400);
    await sleep(400);
  }

  /**
   * @param {HTMLElement | null} root
   */
  function extractAssistantMarkdown(root) {
    if (!root) return "";
    const mdFn = globalThis.aiAutoChatHtmlToMarkdown;
    if (typeof mdFn === "function") {
      const md = mdFn(root).trim();
      if (md.length > 20) return md;
    }
    return (root.innerText || "").trim();
  }

  /**
   * @param {HTMLElement} el
   * @param {string} text
   */
  async function setPromptText(el, text) {
    el.focus();
    await sleep(80);

    if (el instanceof HTMLTextAreaElement) {
      el.value = "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.value = text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }

    if (el.isContentEditable) {
      try {
        const sel = window.getSelection();
        sel?.removeAllRanges();
        const range = document.createRange();
        range.selectNodeContents(el);
        sel?.addRange(range);
        document.execCommand("delete", false);
      } catch (_) {
        el.textContent = "";
      }
      await sleep(40);
      try {
        document.execCommand("insertText", false, text);
      } catch (_) {
        el.textContent = text;
        el.dispatchEvent(
          new InputEvent("input", { bubbles: true, inputType: "insertText", data: text })
        );
      }
      return;
    }

    el.textContent = text;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  }

  /** 主操作位（发送 / 停止）的 aria-label；界面语言不同，用多语言子串匹配。 */
  const SEND_LABEL_RE = /send|submit|发送|送信|전송|enviar|envoyer|senden|invia|отправить/i;
  const STOP_LABEL_RE = /stop|停止|중지|정지|やめる|detener|arrêter|anhalten|interrompi|остановить/i;
  const VOICE_LABEL_RE =
    /voice|dictate|microphone|speech|语音|听写|口述|音声|음성|voz|dictado|vocal/i;

  /**
   * 发送：composer 行内最后一个主按钮。
   *
   * 空输入框时该位置是麦克风（实测 `aria-label="Use voice mode"`），必须排除，
   * 否则会把提问点成录音。
   *
   * @returns {HTMLElement | null}
   */
  function findSendButton() {
    const b = findComposerPrimaryButton();
    if (!b || b.disabled) return null;
    const label = (b.getAttribute("aria-label") || "").trim();
    if (label && VOICE_LABEL_RE.test(label)) return null;
    if (label && !SEND_LABEL_RE.test(label) && !STOP_LABEL_RE.test(label)) return null;
    const cls = b.className || "";
    if (cls.includes("pointer-events-none") && cls.includes("opacity-50")) return null;
    return b;
  }

  /**
   * 生成中的「停止」按钮（实测流式时主操作位为 `aria-label="Stop response (Esc)"`）。
   *
   * 之前按 class（`opacity-50` / `pointer-events-none` / `cursor-default`）判断，
   * 实测流式与空闲时这些 class 都命中，导致 `isGenerating()` 恒为 false、
   * 稳定性判据退化成「文本 3.8s 不变」，长回答中途停顿就会被提前截断。
   *
   * @returns {HTMLButtonElement | null}
   */
  function findStopButton() {
    const scope = document.querySelector("main") || document;
    for (const b of scope.querySelectorAll("button")) {
      if (!(b instanceof HTMLButtonElement) || !isVisible(b)) continue;
      const label = (b.getAttribute("aria-label") || "").trim();
      if (label && STOP_LABEL_RE.test(label)) return b;
    }
    return null;
  }

  function isGenerating() {
    if (findStopButton()) return true;
    const marker = document.querySelector(
      'main [data-streaming="true"], main [data-testid*="stream" i], main [class*="result-streaming"]'
    );
    return marker instanceof HTMLElement && isVisible(marker);
  }

  /**
   * @returns {HTMLElement | null}
   */
  function findConversationRoot() {
    return document.querySelector("main") || document.body;
  }

  /**
   * 已渲染的答案块（每条回答一个 `main .prose`）。只取**可见**的：Perplexity 是
   * SPA，切换会话时旧会话可能仍留在 DOM 里，算进来会把上一轮答案当成本轮结果。
   *
   * @returns {HTMLElement[]}
   */
  function visibleProses() {
    const main = document.querySelector("main");
    if (!main) return [];
    return /** @type {HTMLElement[]} */ (
      [...main.querySelectorAll(".prose")].filter(
        (el) => el instanceof HTMLElement && isVisible(el)
      )
    );
  }

  function proseCount() {
    return visibleProses().length;
  }

  /**
   * @returns {HTMLElement[]}
   */
  function collectAssistantRoots() {
    const proses = visibleProses();
    if (proses.length) {
      return [proses[proses.length - 1]];
    }
    return [];
  }

  /**
   * @param {HTMLElement} root
   */
  function extractCitationsFrom(root) {
    /** @type {string[]} */
    const out = [];
    const seen = new Set();
    root.querySelectorAll('a[href^="http"]').forEach((a) => {
      const href = a.href;
      if (!href || seen.has(href)) return;
      if (href.includes("google.com/url")) return;
      seen.add(href);
      out.push(href);
    });
    return out;
  }

  /**
   * @param {number} baselineProseCount
   */
  function getAnswerSnapshot(baselineProseCount) {
    const root = /** @type {HTMLElement} */ (findConversationRoot());
    const nodes = collectAssistantRoots();
    const last =
      nodes.length > 0 ? /** @type {HTMLElement} */ (nodes[nodes.length - 1]) : null;
    const rendered = proseCount();
    const text =
      extractAssistantMarkdown(last) || (last?.innerText || "").trim() || (root.innerText || "").trim();
    return {
      ok: true,
      generating: isGenerating(),
      proseCount: rendered,
      baselineProseCount,
      text,
      pageUrl: location.href,
    };
  }

  /**
   * @param {number} baselineProseCount
   */
  function finalizeAnswer(baselineProseCount) {
    const root = /** @type {HTMLElement} */ (findConversationRoot());
    const nodes = collectAssistantRoots();
    const last =
      nodes.length > 0 ? /** @type {HTMLElement} */ (nodes[nodes.length - 1]) : root;
    const text = extractAssistantMarkdown(last) || (last.innerText || "").trim();
    const citations = extractCitationsFrom(last || root);
    return {
      ok: true,
      answer: text,
      citations,
      pageUrl: location.href,
      baselineProseCount,
    };
  }

  /**
   * @param {string} _userQuestion
   * @param {number} baselineProseCount
   */
  async function waitForAnswerStable(_userQuestion, baselineProseCount = 0) {
    const root = /** @type {HTMLElement} */ (findConversationRoot());

    await sleep(400);
    await waitUntil(() => isGenerating(), 8000, 200).catch(() => {});
    await waitUntil(() => !isGenerating(), 180000, 400);
    await sleep(500);
    await waitForGenerationEnd();

    let lastText = "";
    let stableTicks = 0;
    const minStableLen = 12;

    for (let i = 0; i < 200; i++) {
      await sleep(320);
      const nodes = collectAssistantRoots();
      const last =
        nodes.length > 0
          ? /** @type {HTMLElement} */ (nodes[nodes.length - 1])
          : null;
      const rendered = proseCount();
      const text =
        extractAssistantMarkdown(last) || (last?.innerText || "").trim() || (root.innerText || "").trim();

      // 本轮答案还没落地。此处**不能**退回上一轮的 `.prose`：同一会话里上一条回答
      // 又长又稳定，会被当成本轮结果直接上传。
      if (rendered <= baselineProseCount) {
        stableTicks = 0;
        lastText = text;
        continue;
      }

      if (text.length < minStableLen) {
        stableTicks = 0;
        lastText = text;
        continue;
      }

      if (isGenerating()) {
        stableTicks = 0;
        continue;
      }

      if (text === lastText) stableTicks += 1;
      else stableTicks = 0;
      lastText = text;

      if (stableTicks >= 12 && !isGenerating()) {
        await waitForGenerationEnd();
        const finalText = extractAssistantMarkdown(last) || text;
        return { text: finalText, element: last || root };
      }
    }

    const nodes = collectAssistantRoots();
    const last =
      nodes.length > 0 ? /** @type {HTMLElement} */ (nodes[nodes.length - 1]) : root;
    if (proseCount() <= baselineProseCount) {
      throw new Error("等待回答超时：未出现新的回答");
    }
    const text = extractAssistantMarkdown(last) || (last.innerText || "").trim();
    return { text, element: last };
  }

  /**
   * @param {{ question: string, newChat: boolean }} opts
   */
  async function waitForPageReady() {
    if (document.readyState !== "complete") {
      await new Promise((r) => {
        if (document.readyState === "complete") r();
        else window.addEventListener("load", () => r(), { once: true });
      });
    }
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await sleep(500);
  }

  async function runOneQuestion(opts) {
    return withQuestionLock(async () => {
      trace("info", "runOneQuestion 开始", { url: location.href, newChat: opts.newChat });

      if (!isPerplexityPage()) throw new Error("不在 Perplexity 页面");

      await waitForPageReady();
      if (isGenerating()) await waitForGenerationEnd();

      trace("info", "查找输入框 #ask-input");
      const editor = await waitFor(() => findPromptEditor(), 28000, 200);
      if (getPromptText(editor).length > 0) {
        await clearPromptEditor(editor);
      }

      trace("info", "找到输入框", { tag: editor.tagName, id: editor.id });

      const baselineProseCount = proseCount();

      await setPromptText(editor, opts.question);
      await sleep(250);

      let send = findSendButton();
      if (!send) {
        try {
          send = await waitFor(() => findSendButton(), 12000, 200);
        } catch (_) {
          send = null;
        }
      }
      if (send) {
        trace("info", "点击 composer 主按钮", {});
        send.click();
      } else {
        trace("warn", "未找到可点击主按钮，尝试 Enter");
        editor.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true })
        );
      }

      trace("info", "等待回答");
      if (opts.submitOnly) {
        return {
          submitted: true,
          baselineProseCount,
          pageUrl: location.href,
        };
      }

      const { text, element } = await waitForAnswerStable(opts.question, baselineProseCount);
      trace("info", "采集完成", { answerLen: text.length });
      const citations = extractCitationsFrom(element || findConversationRoot());

      return {
        answer: text,
        citations,
        pageUrl: location.href,
      };
    });
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "PERPLEXITY_POLL_ANSWER") {
      const baseline = Number(msg.payload?.baselineProseCount ?? 0);
      sendResponse(getAnswerSnapshot(baseline));
      return false;
    }
    if (msg?.type === "PERPLEXITY_FINALIZE_ANSWER") {
      const baseline = Number(msg.payload?.baselineProseCount ?? 0);
      sendResponse(finalizeAnswer(baseline));
      return false;
    }
    if (msg?.type !== "PERPLEXITY_RUN_QUESTION") return false;

    trace("info", "收到 PERPLEXITY_RUN_QUESTION", { index: msg.payload?.index });

    const payload = msg.payload || {};
    (async () => {
      try {
        const out = await runOneQuestion({
          question: String(payload.question || ""),
          newChat: Boolean(payload.newChat),
          submitOnly: Boolean(payload.submitOnly),
        });
        sendResponse({ ok: true, ...out });
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        const stack = e instanceof Error ? e.stack : "";
        trace("error", "runOneQuestion 异常", { message: errMsg, stack });
        sendResponse({
          ok: false,
          error: errMsg,
        });
      }
    })();

    return true;
  });

  trace("info", "perplexity.js 已注入", { url: location.href });
})();
