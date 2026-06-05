/* global chrome */
(function () {
  if (globalThis.__PERPLEXITY_AI_AUTOCHAT_LOADED) return;
  globalThis.__PERPLEXITY_AI_AUTOCHAT_LOADED = true;

  const HOSTS = ["www.perplexity.ai", "perplexity.ai"];

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

  /**
   * 发送：composer 行内最后一个主按钮；就绪时需可点（未处于回答完成后的灰显 Submit）。
   *
   * @returns {HTMLElement | null}
   */
  function findSendButton() {
    const b = findComposerPrimaryButton();
    if (!b || b.disabled) return null;
    const cls = b.className || "";
    if (cls.includes("pointer-events-none") && cls.includes("opacity-50")) return null;
    return b;
  }

  /**
   * 生成中：不依赖 aria「Stop/停止」。
   * 完成后主按钮多为 disabled + opacity-50 + pointer-events-none + cursor-default；
   * 流式中主按钮可点且输入区通常已空；用户正在输入下一题时输入区非空，视为非生成。
   */
  function isGenerating() {
    const marker = document.querySelector(
      'main [data-streaming="true"], main [data-testid*="stream" i], main [class*="result-streaming"]'
    );
    if (marker instanceof HTMLElement && isVisible(marker)) return true;

    const b = findComposerPrimaryButton();
    if (!b) return false;
    const cls = b.className || "";
    if (b.disabled && cls.includes("opacity-50") && cls.includes("pointer-events-none")) return false;

    const ask = document.querySelector("#ask-input");
    const typed = (ask && (ask.innerText || ask.textContent || "").trim()) || "";
    if (typed.length > 0) return false;

    if (cls.includes("opacity-50") && cls.includes("pointer-events-none")) return false;
    if (cls.includes("cursor-default")) return false;
    return !b.disabled;
  }

  /**
   * @returns {HTMLElement | null}
   */
  function findConversationRoot() {
    return document.querySelector("main") || document.body;
  }

  /**
   * @returns {HTMLElement[]}
   */
  function collectAssistantRoots() {
    const main = document.querySelector("main");
    if (!main) return [];
    const proses = /** @type {HTMLElement[]} */ ([...main.querySelectorAll(".prose")]);
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
   * @param {string} _userQuestion
   */
  async function waitForAnswerStable(_userQuestion) {
    const root = /** @type {HTMLElement} */ (findConversationRoot());

    await sleep(900);
    await waitUntil(() => !isGenerating(), 180000, 400);
    await sleep(600);

    let lastText = "";
    let stableTicks = 0;
    const minStableLen = 12;

    for (let i = 0; i < 180; i++) {
      await sleep(280);
      const nodes = collectAssistantRoots();
      const last =
        nodes.length > 0
          ? /** @type {HTMLElement} */ (nodes[nodes.length - 1])
          : null;
      const text = (last?.innerText || "").trim() || (root.innerText || "").trim();

      if (text.length < minStableLen) {
        stableTicks = 0;
        lastText = text;
        continue;
      }

      if (text === lastText) stableTicks += 1;
      else stableTicks = 0;
      lastText = text;

      if (stableTicks >= 8 && !isGenerating()) {
        return { text, element: last || root };
      }
    }

    const nodes = collectAssistantRoots();
    const last =
      nodes.length > 0 ? /** @type {HTMLElement} */ (nodes[nodes.length - 1]) : root;
    return { text: (last.innerText || "").trim(), element: last };
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
    trace("info", "runOneQuestion 开始", { url: location.href, newChat: opts.newChat });

    if (!isPerplexityPage()) throw new Error("不在 Perplexity 页面");

    await waitForPageReady();

    trace("info", "查找输入框 #ask-input");
    const editor = await waitFor(() => findPromptEditor(), 28000, 200);
    trace("info", "找到输入框", { tag: editor.tagName, id: editor.id });

    await setPromptText(editor, opts.question);
    await sleep(200);

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
    const { text, element } = await waitForAnswerStable(opts.question);
    trace("info", "采集完成", { answerLen: text.length });
    const citations = extractCitationsFrom(element || findConversationRoot());

    return {
      answer: text,
      citations,
      pageUrl: location.href,
    };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "PERPLEXITY_RUN_QUESTION") return false;

    trace("info", "收到 PERPLEXITY_RUN_QUESTION", { index: msg.payload?.index });

    const payload = msg.payload || {};
    (async () => {
      try {
        const out = await runOneQuestion({
          question: String(payload.question || ""),
          newChat: Boolean(payload.newChat),
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
