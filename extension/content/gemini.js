/* global chrome */
(function () {
  if (globalThis.__GEMINI_AI_AUTOCHAT_LOADED) return;
  globalThis.__GEMINI_AI_AUTOCHAT_LOADED = true;

  const GEMINI_HOST = "gemini.google.com";

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
      source: "gemini-content",
      message,
      ...(detailStr !== undefined ? { detail: detailStr } : {}),
    };
    chrome.runtime.sendMessage(payload).catch(() => {});
    const line = `[gemini-content] ${message}${detailStr ? ` ${detailStr}` : ""}`;
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

  /**
   * @param {ParentNode} root
   * @param {string} selector
   * @returns {Element | null}
   */
  function querySelectorDeep(selector, root = document) {
    const queue = [root];
    while (queue.length) {
      const node = queue.shift();
      if (!node) continue;
      try {
        if ("querySelector" in node && typeof node.querySelector === "function") {
          const found = node.querySelector(selector);
          if (found) return found;
        }
      } catch (_) {
        /* ignore */
      }
      const children = "children" in node ? node.children : null;
      if (!children) continue;
      for (const child of children) {
        queue.push(child);
        const el = /** @type {Element} */ (child);
        if (el.shadowRoot) queue.push(el.shadowRoot);
      }
    }
    return null;
  }

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

  async function waitFor(fn, timeoutMs = 20000, intervalMs = 200) {
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
  async function waitUntil(fn, timeoutMs = 120000, intervalMs = 300) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (fn()) return;
      await sleep(intervalMs);
    }
    throw new Error("等待条件超时");
  }

  function isGeminiPage() {
    return location.hostname === GEMINI_HOST;
  }

  /**
   * 新对话：侧栏 `a[href="/app"]` 排除顶部 logo（bard-logo-container）；与界面语言无关。
   * Playwright MCP 实测 gemini.google.com/app。
   *
   * @returns {HTMLElement | null}
   */
  function findNewChatButton() {
    const links = /** @type {HTMLElement[]} */ ([...document.querySelectorAll('a[href="/app"]')]);
    for (const a of links) {
      if (!(a instanceof HTMLElement) || !isVisible(a)) continue;
      const cls = a.className || "";
      if (cls.includes("bard-logo")) continue;
      return a;
    }
    return null;
  }

  async function startNewChat() {
    trace("info", "startNewChat: 查找 a[href=/app]（非 logo）");
    const btn = await waitFor(() => findNewChatButton(), 20000, 250);
    trace("info", "startNewChat: 点击", {
      tag: btn.tagName,
      href: btn.getAttribute("href"),
      cls: (btn.className || "").slice(0, 80),
    });
    btn.click();
    await sleep(800);
  }

  /**
   * 主输入：`rich-textarea` 内 `[role=textbox]`；与语言无关。
   *
   * @returns {HTMLElement | null}
   */
  function findPromptEditor() {
    const inRich =
      querySelectorDeep('rich-textarea [role="textbox"]') ||
      querySelectorDeep('rich-textarea textarea') ||
      querySelectorDeep('rich-textarea [contenteditable="true"]');
    if (inRich instanceof HTMLElement && isVisible(inRich)) return inRich;

    const rich = querySelectorDeep("rich-textarea");
    if (rich instanceof HTMLElement && isVisible(rich)) {
      return /** @type {HTMLElement} */ (rich);
    }

    const main = document.querySelector("main");
    if (main) {
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
      if (best) return best;
    }

    const ta = document.querySelector("textarea");
    if (ta instanceof HTMLElement && isVisible(ta) && ta.getBoundingClientRect().width > 40) return ta;

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
      try {
        document.execCommand("selectAll", false);
        document.execCommand("insertText", false, text);
      } catch (_) {
        el.textContent = text;
      }
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      return;
    }

    el.textContent = "";
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
    el.textContent = text;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
  }

  /**
   * 发送：`main button.send-button`；生成中同一按钮会加 `.stop`，此时不作为「发送」。
   * Playwright MCP 实测：流式时 class 含 `send-button` 与 `stop`。
   *
   * @returns {HTMLElement | null}
   */
  function findSendButton() {
    const b = document.querySelector("main button.send-button");
    if (!(b instanceof HTMLButtonElement)) return null;
    if (!isVisible(b) || b.disabled) return null;
    if (b.classList.contains("stop")) return null;
    return b;
  }

  /**
   * 生成中：同一 `send-button` 带 `.stop`（与 aria「Stop response」等语言无关）。
   */
  function isGenerating() {
    const b = document.querySelector("main button.send-button");
    return b instanceof HTMLButtonElement && isVisible(b) && b.classList.contains("stop");
  }

  /**
   * @returns {HTMLElement | null}
   */
  function findConversationRoot() {
    return (
      document.querySelector("main") ||
      document.querySelector('[role="main"]') ||
      document.body
    );
  }

  /**
   * @returns {HTMLElement[]}
   */
  function collectAssistantRoots() {
    const models = /** @type {HTMLElement[]} */ ([...document.querySelectorAll("model-response")]);
    if (models.length) {
      return [models[models.length - 1]];
    }
    const msgs = /** @type {HTMLElement[]} */ ([...document.querySelectorAll("message-content")]);
    if (msgs.length) {
      return [msgs[msgs.length - 1]];
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
    await sleep(900);

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
  async function runOneQuestion(opts) {
    trace("info", "runOneQuestion 开始", { url: location.href, newChat: opts.newChat });

    if (!isGeminiPage()) throw new Error("不在 Gemini 页面");

    await waitForPageReady();

    if (opts.newChat) {
      await startNewChat();
    }

    trace("info", "查找输入框");
    const editor = await waitFor(() => findPromptEditor(), 25000, 200);
    trace("info", "找到输入框", {
      tag: editor.tagName,
      role: editor.getAttribute("role"),
      editable: editor.isContentEditable,
    });

    await setPromptText(editor, opts.question);
    await sleep(200);

    const send = findSendButton();
    if (send) {
      trace("info", "点击发送", { cls: (send.className || "").match(/send-button/)?.[0] });
      send.click();
    } else {
      trace("warn", "未找到 send-button，尝试 Enter");
      editor.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true })
      );
    }

    trace("info", "等待模型回复结束");
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
    if (msg?.type !== "GEMINI_RUN_QUESTION") return false;

    trace("info", "收到 GEMINI_RUN_QUESTION", { index: msg.payload?.index });

    const payload = msg.payload || {};
    (async () => {
      try {
        const out = await runOneQuestion({
          question: String(payload.question || ""),
          newChat: Boolean(payload.newChat),
        });
        sendResponse({ ok: true, ...out });
      } catch (e) {
        const msgErr = e instanceof Error ? e.message : String(e);
        const stack = e instanceof Error ? e.stack : "";
        trace("error", "runOneQuestion 异常", { message: msgErr, stack });
        sendResponse({
          ok: false,
          error: msgErr,
        });
      }
    })();

    return true;
  });

  trace("info", "gemini.js 已注入", { url: location.href });
})();
