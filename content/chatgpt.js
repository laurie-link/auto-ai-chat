/* global chrome */
(function () {
  if (globalThis.__CHATGPT_AI_AUTOCHAT_LOADED) return;
  globalThis.__CHATGPT_AI_AUTOCHAT_LOADED = true;

  const HOSTS = ["chatgpt.com", "www.chatgpt.com", "chat.openai.com"];

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
      source: "chatgpt-content",
      message,
      ...(detailStr !== undefined ? { detail: detailStr } : {}),
    };
    chrome.runtime.sendMessage(payload).catch(() => {});
    const line = `[chatgpt-content] ${message}${detailStr ? ` ${detailStr}` : ""}`;
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  }

  function isChatGPTPage() {
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
   * 是否可见（排除 display:none / 零尺寸），避免命中隐藏 textarea 等。
   * @param {Element} el
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
   * 新建对话：优先 ChatGPT 稳定 data-testid（Playwright MCP 实测 chatgpt.com 2026）。
   * 顺序：create-new-chat-button → sidebar-new-chat → new-chat-button。
   *
   * @returns {HTMLElement | null}
   */
  function findNewChatButton() {
    const ids = [
      "create-new-chat-button",
      "sidebar-new-chat",
      "new-chat-button",
    ];
    for (const id of ids) {
      const el = document.querySelector(`[data-testid="${id}"]`);
      if (el instanceof HTMLElement && isVisible(el)) return el;
    }
    /** 无 testid 的旧版：侧栏会话列表上方第一条「新开对话」常为 ul 首项链到 / */
    const sidebarFirst = document.querySelector(
      "aside [role=\"navigation\"] ul > li:first-child a[href=\"/\"], aside nav ul > li:first-child a[href=\"/\"]"
    );
    if (sidebarFirst instanceof HTMLElement && isVisible(sidebarFirst)) return sidebarFirst;
    return null;
  }

  async function startNewChat() {
    trace("info", "startNewChat: 查找 data-testid create-new-chat / sidebar-new-chat");
    const el = await waitFor(() => findNewChatButton(), 22000, 250);
    trace("info", "startNewChat: 点击", {
      tag: el.tagName,
      testid: el.getAttribute("data-testid"),
      aria: el.getAttribute("aria-label"),
    });
    el.click();
    await sleep(1000);
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

  async function waitForGenerationEnd(maxMs = 180000) {
    if (!isGenerating()) {
      await sleep(200);
      return;
    }
    await waitUntil(() => !isGenerating(), maxMs, 400);
    await sleep(400);
  }

  /**
   * 主输入区：`#prompt-textarea`（多为 ProseMirror div + role=textbox），与界面语言无关。
   * 回退：name / 主区域可见 textarea / 可见 contenteditable textbox（仍用结构，不用文案）。
   *
   * @returns {HTMLElement | null}
   */
  function findPromptEditor() {
    const byId = document.querySelector("#prompt-textarea");
    if (byId instanceof HTMLElement && isVisible(byId)) {
      return byId;
    }

    const byName = document.querySelector('textarea[name="prompt-textarea"]');
    if (byName instanceof HTMLElement && isVisible(byName)) return byName;

    const main = document.querySelector("main");
    if (main) {
      const tas = /** @type {HTMLTextAreaElement[]} */ ([...main.querySelectorAll("textarea")]);
      let best = /** @type {HTMLTextAreaElement | null} */ (null);
      let bestArea = 0;
      for (const ta of tas) {
        if (!isVisible(ta)) continue;
        const r = ta.getBoundingClientRect();
        const area = r.width * r.height;
        if (area > bestArea) {
          bestArea = area;
          best = ta;
        }
      }
      if (best) return best;

      const editables = /** @type {HTMLElement[]} */ (
        [...main.querySelectorAll('[role="textbox"][contenteditable="true"], .ProseMirror[contenteditable="true"]')]
      );
      for (const el of editables) {
        if (isVisible(el) && el.getBoundingClientRect().width > 40) return el;
      }
    }

    const pm = document.querySelector(
      'div[contenteditable="true"][role="textbox"], .ProseMirror[contenteditable="true"]'
    );
    if (pm instanceof HTMLElement && isVisible(pm) && pm.getBoundingClientRect().width > 40) return pm;

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
      el.dispatchEvent(new Event("change", { bubbles: true }));
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
   * 发送：`data-testid="send-button"`（有内容且可点时启用；与语言无关）。
   *
   * @returns {HTMLElement | null}
   */
  function findSendButton() {
    const byTest = document.querySelector('[data-testid="send-button"]');
    if (byTest instanceof HTMLButtonElement) {
      if (byTest.disabled || !isVisible(byTest)) return null;
      return byTest;
    }
    if (byTest instanceof HTMLElement && isVisible(byTest)) return byTest;
    return null;
  }

  /**
   * 生成中：仅依赖 `data-testid="stop-button"` 可见（ChatGPT 各语言 UI 一致）。
   */
  function isGenerating() {
    const stop = document.querySelector('[data-testid="stop-button"]');
    return stop instanceof HTMLElement && isVisible(stop);
  }

  /**
   * @returns {HTMLElement | null}
   */
  function findConversationRoot() {
    return (
      document.querySelector("main") ||
      document.querySelector('[role="presentation"]') ||
      document.body
    );
  }

  /**
   * @returns {HTMLElement[]}
   */
  function collectAssistantRoots() {
    const byRole = /** @type {HTMLElement[]} */ (
      [...document.querySelectorAll('[data-message-author-role="assistant"]')]
    );
    if (byRole.length) {
      return [byRole[byRole.length - 1]];
    }
    return [];
  }

  /**
   * 将最后一条助手消息滚入视口，避免虚拟列表/懒渲染导致 innerText 偏短。
   * @param {HTMLElement | null} assistantRoot
   */
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

  function scrollAssistantIntoView(assistantRoot) {
    if (!assistantRoot) return;
    try {
      assistantRoot.scrollIntoView({ block: "end", behavior: "instant" });
    } catch (_) {
      try {
        assistantRoot.scrollIntoView(false);
      } catch (_) {}
    }
    const main = document.querySelector("main");
    if (main instanceof HTMLElement) {
      try {
        main.scrollTop = main.scrollHeight;
      } catch (_) {}
    }
  }

  /**
   * 优先从正文 .markdown / .prose 取字。勿只用 querySelector 取「第一个」markdown：
   * 带搜索/多段结构时首块常为 Short answer 摘要，会误判为全文并截断。
   * @param {HTMLElement | null} assistantRoot
   */
  function extractAssistantMessageText(assistantRoot) {
    if (!assistantRoot) return "";

    const mdFn = globalThis.aiAutoChatHtmlToMarkdown;
    const rawBlocks = /** @type {HTMLElement[]} */ (
      [...assistantRoot.querySelectorAll("div.markdown.prose, div.markdown, .markdown.prose")]
    );
    const blocks = rawBlocks.filter((el) => {
      return !rawBlocks.some((other) => other !== el && other.contains(el));
    });
    if (blocks.length > 0 && typeof mdFn === "function") {
      const merged = blocks
        .map((el) => mdFn(el))
        .filter(Boolean)
        .join("\n\n")
        .trim();
      if (merged.length > 40) return merged;
    }
    if (blocks.length > 0) {
      const merged = blocks
        .map((el) => (el.innerText || "").replace(/\s+\n/g, "\n").trim())
        .filter(Boolean)
        .join("\n\n")
        .trim();
      if (merged.length > 40) return merged;
    }

    const proseSelectors = ['[class*="markdown"]', ".prose", '[class*="prose"]', "article"];
    let best = "";
    for (const sel of proseSelectors) {
      try {
        assistantRoot.querySelectorAll(sel).forEach((el) => {
          if (!(el instanceof HTMLElement)) return;
          const t = (el.innerText || "").replace(/\s+\n/g, "\n").trim();
          if (t.length > best.length) best = t;
        });
      } catch (_) {
        /* ignore invalid selector */
      }
    }
    if (best.length >= 120) return best;

    const clone = /** @type {HTMLElement} */ (assistantRoot.cloneNode(true));
    clone
      .querySelectorAll(
        [
          "button",
          '[role="button"]',
          "aside",
          "nav",
          '[data-testid="stop-button"]',
          '[data-testid="copy-button"]',
          '[class*="SearchResult"]',
          '[class*="search-result"]',
          '[class*="web-result"]',
          '[class*="citation-card"]',
          '[class*="shopping"]',
          '[class*="product"]',
        ].join(", ")
      )
      .forEach((n) => n.remove());
    const fallback = (clone.innerText || "").replace(/\s+\n/g, "\n").trim();
    return best.length > fallback.length ? best : fallback;
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
      seen.add(href);
      out.push(href);
    });
    return out;
  }

  /**
   * @param {string} _userQuestion
   * @param {number} baselineAssistantCount
   */
  async function waitForAnswerStable(_userQuestion, baselineAssistantCount = 0) {
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
      scrollAssistantIntoView(last);
      await sleep(120);
      const assistantCount = document.querySelectorAll('[data-message-author-role="assistant"]').length;
      const text = extractAssistantMessageText(last) || (root.innerText || "").trim();

      if (assistantCount <= baselineAssistantCount && text.length < minStableLen) {
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
        scrollAssistantIntoView(last);
        await sleep(200);
        const finalText =
          extractAssistantMessageText(last) || (last?.innerText || "").trim() || text;
        return { text: finalText, element: last || root };
      }
    }

    const nodes = collectAssistantRoots();
    const last =
      nodes.length > 0 ? /** @type {HTMLElement} */ (nodes[nodes.length - 1]) : root;
    scrollAssistantIntoView(last);
    await sleep(250);
    const text = extractAssistantMessageText(last) || (last.innerText || "").trim();
    return { text, element: last };
  }

  /**
   * @param {{ question: string, newChat: boolean }} opts
   */
  async function runOneQuestion(opts) {
    return withQuestionLock(async () => {
      trace("info", "runOneQuestion 开始", { url: location.href, newChat: opts.newChat });

      if (!isChatGPTPage()) throw new Error("不在 ChatGPT 页面");

      await waitForPageReady();
      if (isGenerating()) await waitForGenerationEnd();

      if (opts.newChat) {
        await startNewChat();
      }

      trace("info", "查找输入框");
      const editor = await waitFor(() => findPromptEditor(), 28000, 200);
      if (getPromptText(editor).length > 0) {
        await clearPromptEditor(editor);
      }

      trace("info", "找到输入框", {
        tag: editor.tagName,
        id: editor.id,
        role: editor.getAttribute("role"),
      });

      const baselineAssistantCount = document.querySelectorAll(
        '[data-message-author-role="assistant"]'
      ).length;

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
        trace("info", "点击发送", {
          testid: send.getAttribute("data-testid"),
          aria: send.getAttribute("aria-label"),
        });
        send.click();
      } else {
        trace("warn", "未找到发送按钮，尝试 Enter");
        editor.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            code: "Enter",
            bubbles: true,
            cancelable: true,
          })
        );
      }

      trace("info", "等待模型回复结束");
      const { text, element } = await waitForAnswerStable(opts.question, baselineAssistantCount);
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
    if (msg?.type !== "CHATGPT_RUN_QUESTION") return false;

    trace("info", "收到 CHATGPT_RUN_QUESTION", { index: msg.payload?.index });

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

  trace("info", "chatgpt.js 已注入", { url: location.href });
})();
