/* global chrome */
(function () {
  if (globalThis.__CHATGPT_AI_AUTOCHAT_LOADED) return;
  globalThis.__CHATGPT_AI_AUTOCHAT_LOADED = true;

  const HOSTS = ["chatgpt.com", "www.chatgpt.com", "chat.openai.com"];

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
   * MCP 实测：侧栏「New chat」多为 `a[href="/"]`，纯文本以 New chat 开头（可能带 CtrlShiftO 等快捷键文案）；
   * `data-testid="sidebar-new-chat"` 当前版本未出现。
   *
   * @returns {HTMLElement | null}
   */
  function findNewChatButton() {
    const byTest =
      document.querySelector('[data-testid="sidebar-new-chat"]') ||
      document.querySelector('[data-testid="new-chat-button"]');
    if (byTest instanceof HTMLElement) return byTest;

    const byHomeLink = Array.from(document.querySelectorAll('a[href="/"]')).find((a) => {
      const raw = (a.textContent || "").replace(/\u00a0/g, " ").trim().toLowerCase();
      const head = raw.split(/ctrl|⌘|shift|shortcut/i)[0].trim();
      return head.startsWith("new chat") || head.startsWith("新对话");
    });
    if (byHomeLink instanceof HTMLElement) return byHomeLink;

    const btn = Array.from(document.querySelectorAll("button, a[role='button'], a")).find((el) => {
      const aria = (el.getAttribute("aria-label") || "").toLowerCase();
      const t = (el.textContent || "").trim().toLowerCase();
      return (
        aria.includes("new chat") ||
        aria.includes("新对话") ||
        t === "new chat" ||
        t.startsWith("new chat") ||
        t === "新对话"
      );
    });
    return /** @type {HTMLElement | null} */ (btn || null);
  }

  async function startNewChat() {
    trace("info", "startNewChat: 查找「新对话」");
    const el = await waitFor(() => findNewChatButton(), 22000, 250);
    trace("info", "startNewChat: 点击", {
      tag: el.tagName,
      testid: el.getAttribute("data-testid"),
      aria: el.getAttribute("aria-label"),
    });
    el.click();
    await sleep(1000);
  }

  /**
   * MCP 实测：`#prompt-textarea` 常为带 ProseMirror 的 div（`role="textbox"`，`aria-label="Chat with ChatGPT"`），不是 textarea。
   *
   * @returns {HTMLElement | null}
   */
  function findPromptEditor() {
    const byId = document.querySelector("#prompt-textarea");
    if (byId instanceof HTMLElement) {
      const rect = byId.getBoundingClientRect();
      if (rect.width > 16 && rect.height > 8) return byId;
    }

    const labeled = document.querySelector(
      '[role="textbox"][aria-label="Chat with ChatGPT"], [role="textbox"][aria-label*="ChatGPT"]'
    );
    if (labeled instanceof HTMLElement) return labeled;

    const byName = document.querySelector('textarea[name="prompt-textarea"]');
    if (byName instanceof HTMLElement) return byName;

    const placeholder = document.querySelector(
      'textarea[placeholder*="Message"], textarea[placeholder*="message"], textarea[placeholder*="Ask"]'
    );
    if (placeholder instanceof HTMLElement) return placeholder;

    const pm = document.querySelector(
      'div[contenteditable="true"][role="textbox"], .ProseMirror[contenteditable="true"]'
    );
    if (pm instanceof HTMLElement) {
      const rect = pm.getBoundingClientRect();
      if (rect.width > 40 && rect.height > 16) return pm;
    }

    const ta = document.querySelector("textarea");
    if (ta instanceof HTMLElement) {
      const rect = ta.getBoundingClientRect();
      if (rect.width > 40 && rect.height > 16) return ta;
    }
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
   * MCP 实测：空输入时第三颗按钮可能是「Start Voice」；填入内容后出现 `data-testid="send-button"`，`aria-label="Send prompt"`。
   *
   * @returns {HTMLElement | null}
   */
  function findSendButton() {
    const byTest =
      document.querySelector('[data-testid="send-button"]') ||
      document.querySelector('button[data-testid="send-button"]');
    if (byTest instanceof HTMLButtonElement && byTest.disabled) {
      return null;
    }
    if (byTest instanceof HTMLElement) return byTest;

    const byAria = Array.from(document.querySelectorAll("button")).find((b) => {
      const a = (b.getAttribute("aria-label") || "").toLowerCase();
      return (
        a.includes("send prompt") ||
        a.includes("send message") ||
        a.includes("send") ||
        a.includes("发送")
      );
    });
    return /** @type {HTMLElement | null} */ (byAria || null);
  }

  function isGenerating() {
    if (document.querySelector('[data-testid="stop-button"]')) return true;
    return Array.from(document.querySelectorAll("button")).some((b) => {
      const a = (b.getAttribute("aria-label") || "").toLowerCase();
      return (
        a.includes("stop") ||
        a.includes("停止") ||
        a.includes("stop generating")
      );
    });
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

    const rawBlocks = /** @type {HTMLElement[]} */ (
      [...assistantRoot.querySelectorAll("div.markdown.prose, div.markdown, .markdown.prose")]
    );
    const blocks = rawBlocks.filter((el) => {
      return !rawBlocks.some((other) => other !== el && other.contains(el));
    });
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
   */
  async function waitForAnswerStable(_userQuestion) {
    const root = /** @type {HTMLElement} */ (findConversationRoot());

    await waitUntil(() => !isGenerating(), 180000, 400);
    await sleep(900);

    let lastText = "";
    let stableTicks = 0;

    for (let i = 0; i < 140; i++) {
      await sleep(320);
      const nodes = collectAssistantRoots();
      const last =
        nodes.length > 0
          ? /** @type {HTMLElement} */ (nodes[nodes.length - 1])
          : null;
      scrollAssistantIntoView(last);
      await sleep(120);
      const text = extractAssistantMessageText(last) || (root.innerText || "").trim();

      if (text.length < 1) continue;

      if (text === lastText) stableTicks += 1;
      else stableTicks = 0;
      lastText = text;

      if (stableTicks >= 10 && !isGenerating()) {
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
    trace("info", "runOneQuestion 开始", { url: location.href, newChat: opts.newChat });

    if (!isChatGPTPage()) throw new Error("不在 ChatGPT 页面");

    if (opts.newChat) {
      await startNewChat();
    }

    trace("info", "查找输入框");
    const editor = await waitFor(() => findPromptEditor(), 28000, 200);
    trace("info", "找到输入框", {
      tag: editor.tagName,
      id: editor.id,
      role: editor.getAttribute("role"),
    });

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
