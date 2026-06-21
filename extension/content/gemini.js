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

  /**
   * @param {ParentNode} root
   * @param {string} selector
   * @returns {Element[]}
   */
  function querySelectorAllDeep(selector, root = document) {
    /** @type {Element[]} */
    const found = [];
    const queue = [root];
    while (queue.length) {
      const node = queue.shift();
      if (!node) continue;
      try {
        if ("querySelectorAll" in node && typeof node.querySelectorAll === "function") {
          found.push(...node.querySelectorAll(selector));
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
    return found;
  }

  /**
   * @param {ParentNode} root
   * @param {string} selector
   * @returns {Element | null}
   */
  function querySelectorDeep(selector, root = document) {
    const all = querySelectorAllDeep(selector, root);
    return all.length ? all[0] : null;
  }

  async function waitForPageReady() {
    if (document.readyState !== "complete") {
      await new Promise((r) => {
        if (document.readyState === "complete") r();
        else window.addEventListener("load", () => r(), { once: true });
      });
    }
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await sleep(200);
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
    if (isGenerating()) {
      await waitUntil(() => !isGenerating(), 45000, 300).catch(() => {});
    }
    await sleep(300);
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

  /** 仅等待生成结束；不在空输入时等发送按钮（否则会白等 ~20s） */
  async function waitForGenerationEnd(maxMs = 180000) {
    if (!isGenerating()) {
      await sleep(200);
      return;
    }
    await waitUntil(() => !isGenerating(), maxMs, 400);
    await sleep(400);
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
   * @param {HTMLElement | null} root
   */
  function extractAssistantMarkdown(root) {
    if (!root) return "";
    const mdFn = globalThis.aiAutoChatHtmlToMarkdown;
    const raw = /** @type {HTMLElement[]} */ (
      [...root.querySelectorAll("message-content, .markdown, .model-response-text")]
    );
    // 只取最外层块，避免嵌套的 message-content / .markdown / .model-response-text 重复拼接
    const blocks = raw.filter(
      (el) => !raw.some((other) => other !== el && other.contains(el))
    );
    if (blocks.length && typeof mdFn === "function") {
      /** @type {string[]} */
      const parts = [];
      const seen = new Set();
      for (const el of blocks) {
        const md = mdFn(el).trim();
        if (md.length > 20 && !seen.has(md)) {
          seen.add(md);
          parts.push(md);
        }
      }
      const merged = parts.join("\n\n").trim();
      if (merged.length > 20) return merged;
    }
    if (typeof mdFn === "function") {
      const md = mdFn(root).trim();
      if (md.length > 20) return md;
    }
    return (root.innerText || "").trim();
  }

  /**
   * @param {string} href
   */
  function isCitationUrl(href) {
    if (!href || !/^https?:\/\//i.test(href)) return false;
    if (/google\.com\/url/i.test(href)) return false;
    if (/accounts\.google\.com/i.test(href)) return false;
    if (/support\.google\.com/i.test(href)) return false;
    if (/policies\.google\.com/i.test(href)) return false;
    return true;
  }

  /**
   * Gemini 行内引用 chip（Reddit / YouTube 等 pill 按钮）。
   * 与界面语言无关：优先按 DOM 结构识别，aria-label 仅作兜底。
   * @param {HTMLElement} root
   * @returns {HTMLElement[]}
   */
  function findGeminiCitationChipButtons(root) {
    return querySelectorAllDeep("button.multiple-button", root).filter((btn) => {
      if (!(btn instanceof HTMLElement) || !isVisible(btn)) return false;
      if (
        btn.closest(
          "source-inline-chip, sources-carousel-inline, .source-inline-chip-container"
        )
      ) {
        return true;
      }
      const label = btn.getAttribute("aria-label") || "";
      return /opens side panel|view source details|查看来源|打开侧边栏|ソース|Quellen|detalles de la fuente|détails de la source/i.test(
        label
      );
    });
  }

  /**
   * 触发 Gemini 引用 chip 的 hover 卡片（真实 URL 在 CDK overlay 中）。
   * @param {HTMLElement} btn
   */
  function hoverGeminiCitationButton(btn) {
    const rect = btn.getBoundingClientRect();
    const opts = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    };
    btn.dispatchEvent(new MouseEvent("mouseenter", opts));
    btn.dispatchEvent(new MouseEvent("mouseover", opts));
    btn.dispatchEvent(new PointerEvent("pointerenter", opts));
    btn.dispatchEvent(new PointerEvent("pointerover", opts));
  }

  /**
   * @param {HTMLElement} btn
   */
  function unhoverGeminiCitationButton(btn) {
    btn.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
    btn.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
  }

  /**
   * 侧栏/悬浮引用卡片链接（DOM 在 model-response 外）。
   * @returns {string[]}
   */
  function collectGeminiSidePanelLinks() {
    /** @type {string[]} */
    const links = [];
    for (const a of document.querySelectorAll(
      '.cdk-overlay-pane a[target="_blank"][href^="http"], a[target="_blank"][href^="http"]'
    )) {
      if (!(a instanceof HTMLAnchorElement)) continue;
      if (!a.querySelector(".inline-source-card-container")) continue;
      links.push(a.href);
    }
    return links;
  }

  /**
   * 提取正文时去掉引用 chip，避免 chip 延迟挂载导致 stableTicks 反复清零。
   * @param {HTMLElement | null} root
   */
  function extractStableAssistantMarkdown(root) {
    if (!root) return "";
    const clone = root.cloneNode(true);
    if (!(clone instanceof HTMLElement)) return extractAssistantMarkdown(root);
    clone
      .querySelectorAll(
        "sources-carousel-inline, source-inline-chip, button.multiple-button"
      )
      .forEach((el) => el.remove());
    return extractAssistantMarkdown(clone);
  }

  /**
   * 等待生成开始，或新回答已出现（避免生成极快时白等 8s）。
   * @param {number} baselineResponseCount
   * @param {number} [minStableLen]
   */
  async function waitForGenerationOrResponse(baselineResponseCount, minStableLen = 12) {
    const start = Date.now();
    while (Date.now() - start < 8000) {
      if (isGenerating()) return;
      const nodes = collectAssistantRoots();
      const last = nodes.length ? /** @type {HTMLElement} */ (nodes[nodes.length - 1]) : null;
      const text = extractStableAssistantMarkdown(last);
      const responseCount = document.querySelectorAll("model-response").length;
      if (responseCount > baselineResponseCount && text.length >= minStableLen) return;
      await sleep(200);
    }
  }

  /**
   * @param {number} [timeoutMs]
   * @returns {Promise<string[]>}
   */
  async function waitForGeminiSidePanelLinks(timeoutMs = 1500) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const links = collectGeminiSidePanelLinks();
      if (links.length > 0) return links;
      await sleep(100);
    }
    return collectGeminiSidePanelLinks();
  }

  /**
   * 依次 hover 行内引用 chip，从 overlay 采集真实 URL。
   * @param {HTMLElement} root
   * @param {(href: string) => void} push
   */
  async function extractCitationsFromInlineChips(root, push) {
    const buttons = findGeminiCitationChipButtons(root);
    /** @type {Set<string>} */
    const seenButtons = new Set();
    for (const btn of buttons) {
      const rect = btn.getBoundingClientRect();
      const chipKey = `${Math.round(rect.top)}:${Math.round(rect.left)}:${(btn.textContent || "").trim()}`;
      if (seenButtons.has(chipKey)) continue;
      seenButtons.add(chipKey);
      hoverGeminiCitationButton(btn);
      await sleep(280);
      const panelLinks = await waitForGeminiSidePanelLinks(2000);
      for (const href of panelLinks) push(href);
      unhoverGeminiCitationButton(btn);
      await sleep(80);
    }
  }

  /**
   * @param {HTMLElement} root
   */
  async function extractCitationsFrom(root) {
    /** @type {string[]} */
    const out = [];
    const seen = new Set();

    const push = (href) => {
      const u = String(href || "").trim();
      if (!isCitationUrl(u) || seen.has(u)) return;
      seen.add(u);
      out.push(u);
    };

    for (const a of querySelectorAllDeep('a[href^="http"]', root)) {
      if (a instanceof HTMLAnchorElement) push(a.href);
    }

    for (const el of querySelectorAllDeep("[data-href], [data-url], [data-link]", root)) {
      for (const attr of ["data-href", "data-url", "data-link"]) {
        push(el.getAttribute(attr));
      }
    }

    await extractCitationsFromInlineChips(root, push);

    return out;
  }

  /**
   * @param {string} _userQuestion
   * @param {number} baselineResponseCount
   */
  async function waitForAnswerStable(_userQuestion, baselineResponseCount = 0) {
    const root = /** @type {HTMLElement} */ (findConversationRoot());
    const minStableLen = 12;

    await sleep(400);
    await waitForGenerationOrResponse(baselineResponseCount, minStableLen);
    await waitUntil(() => !isGenerating(), 180000, 400);
    await sleep(300);
    await waitForGenerationEnd();

    let lastText = "";
    let stableTicks = 0;

    for (let i = 0; i < 200; i++) {
      await sleep(320);
      const nodes = collectAssistantRoots();
      const last =
        nodes.length > 0
          ? /** @type {HTMLElement} */ (nodes[nodes.length - 1])
          : null;
      const responseCount = document.querySelectorAll("model-response").length;
      const text =
        extractStableAssistantMarkdown(last) ||
        extractAssistantMarkdown(last) ||
        (last?.innerText || "").trim() ||
        (root.innerText || "").trim();

      if (responseCount <= baselineResponseCount && text.length < minStableLen) {
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
    const text = extractAssistantMarkdown(last) || (last.innerText || "").trim();
    return { text, element: last };
  }

  /**
   * @param {{ question: string, newChat: boolean }} opts
   */
  async function runOneQuestion(opts) {
    return withQuestionLock(async () => {
      trace("info", "runOneQuestion 开始", { url: location.href, newChat: opts.newChat });

      if (!isGeminiPage()) throw new Error("不在 Gemini 页面");

      await waitForPageReady();
      if (isGenerating()) await waitForGenerationEnd();

      if (opts.newChat) {
        await startNewChat();
      }

      trace("info", "查找输入框");
      const editor = await waitFor(() => findPromptEditor(), 25000, 200);
      if (getPromptText(editor).length > 0) {
        await clearPromptEditor(editor);
      }

      trace("info", "找到输入框", {
        tag: editor.tagName,
        role: editor.getAttribute("role"),
        editable: editor.isContentEditable,
      });

      const baselineResponseCount = document.querySelectorAll("model-response").length;

      await setPromptText(editor, opts.question);
      await sleep(250);

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
      const { text, element } = await waitForAnswerStable(opts.question, baselineResponseCount);
      trace("info", "采集完成", { answerLen: text.length });
      const citations = await extractCitationsFrom(element || findConversationRoot());

      return {
        answer: text,
        citations,
        pageUrl: location.href,
      };
    });
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
