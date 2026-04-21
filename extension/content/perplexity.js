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
   * 新对话由后台 `tabs.update` 到首页完成；勿在 onMessage 异步里点击「New」，否则整页卸载会导致 sendResponse 丢失。
   *
   * MCP：主输入 `#ask-input` 为 `role="textbox"` 的 contenteditable。
   *
   * @returns {HTMLElement | null}
   */
  function findPromptEditor() {
    const ask = document.querySelector("#ask-input");
    if (ask instanceof HTMLElement) {
      const rect = ask.getBoundingClientRect();
      if (rect.width > 16 && rect.height > 8) return ask;
    }
    const tb = document.querySelector('[role="textbox"]');
    if (tb instanceof HTMLElement) return tb;
    return null;
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
      // Perplexity 为 React 受控 contenteditable：insertText 已触发 input，再手动 dispatch InputEvent 会导致文案重复（如「你是谁你是谁」）。
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
   * MCP：有输入后出现 `button[aria-label="Submit"]`。
   *
   * @returns {HTMLElement | null}
   */
  function findSendButton() {
    const b = document.querySelector('button[aria-label="Submit"]');
    if (b instanceof HTMLButtonElement && b.disabled) return null;
    if (b instanceof HTMLElement) return b;
    const byPartial = Array.from(document.querySelectorAll("button")).find((x) => {
      const a = (x.getAttribute("aria-label") || "").toLowerCase();
      return a.includes("submit") && !a.includes("upgrade");
    });
    return /** @type {HTMLElement | null} */ (byPartial || null);
  }

  function isGenerating() {
    return Array.from(document.querySelectorAll("button")).some((b) => {
      const a = (b.getAttribute("aria-label") || "").toLowerCase();
      return a.includes("stop") || a.includes("停止");
    });
  }

  /**
   * @returns {HTMLElement | null}
   */
  function findConversationRoot() {
    return document.querySelector("main") || document.body;
  }

  /**
   * MCP：回答正文在 `main .prose` 中，多轮时取最后一个。
   *
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

    await waitUntil(() => !isGenerating(), 180000, 400);

    let lastText = "";
    let stableTicks = 0;

    for (let i = 0; i < 120; i++) {
      await sleep(280);
      const nodes = collectAssistantRoots();
      const last =
        nodes.length > 0
          ? /** @type {HTMLElement} */ (nodes[nodes.length - 1])
          : null;
      const text = (last?.innerText || "").trim() || (root.innerText || "").trim();

      if (text.length < 1) continue;

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

    trace("info", "查找输入框");
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
      trace("info", "点击 Submit", { aria: send.getAttribute("aria-label") });
      send.click();
    } else {
      trace("warn", "未找到 Submit，尝试 Enter");
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
