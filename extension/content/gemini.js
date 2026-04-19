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

/**
 * @param {() => Element | null} fn
 * @param {number} timeoutMs
 * @param {number} intervalMs
 */
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
 * Playwright 实测：侧栏「新对话」多为 link，href=/app，aria-label="New chat"；顶部同名 button 在空会话时可能 disabled。
 *
 * @returns {HTMLElement | null}
 */
function findNewChatButton() {
  const link = document.querySelector('a[href="/app"][aria-label="New chat"]');
  if (link instanceof HTMLElement) return link;

  const btn = Array.from(document.querySelectorAll("button")).find((b) => {
    const a = (b.getAttribute("aria-label") || "").toLowerCase();
    return (
      (a === "new chat" || a.includes("new chat") || a.includes("新对话") || a.includes("新聊天")) &&
      !b.disabled
    );
  });
  if (btn) return btn;

  const byAria = Array.from(document.querySelectorAll("button")).find((b) => {
    const a = (b.getAttribute("aria-label") || "").toLowerCase();
    return (
      a.includes("new conversation") ||
      a.includes("新對話")
    );
  });
  if (byAria) return byAria;

  const byText = Array.from(document.querySelectorAll("button, a")).find((b) => {
    const t = (b.textContent || "").trim().toLowerCase();
    return t === "new chat" || t === "新对话" || t === "新聊天";
  });
  return /** @type {HTMLElement | null} */ (byText || null);
}

async function startNewChat() {
  trace("info", "startNewChat: 查找「新对话」控件");
  const btn = await waitFor(() => findNewChatButton(), 20000, 250);
  trace("info", "startNewChat: 点击", {
    tag: btn.tagName,
    aria: btn.getAttribute("aria-label"),
    href: btn.getAttribute("href"),
  });
  btn.click();
  await sleep(800);
}

/**
 * 实测：主输入为 role=textbox，aria-label="Enter a prompt for Gemini"；部分版本仍包在 rich-textarea 内。
 *
 * @returns {HTMLElement | null}
 */
function findPromptEditor() {
  const labeled =
    document.querySelector('[role="textbox"][aria-label="Enter a prompt for Gemini"]') ||
    document.querySelector('[role="textbox"][aria-label*="prompt"]');
  if (labeled instanceof HTMLElement) {
    const rect = labeled.getBoundingClientRect();
    if (rect.width > 20 && rect.height > 10) return labeled;
  }

  const rich = querySelectorDeep("rich-textarea");
  if (rich) {
    const inner =
      querySelectorDeep("textarea", rich) ||
      querySelectorDeep('[contenteditable="true"]', rich) ||
      querySelectorDeep("div[contenteditable]", rich);
    if (inner) return /** @type {HTMLElement} */ (inner);
    return /** @type {HTMLElement} */ (rich);
  }

  const candidates = [
    () => querySelectorDeep('div[contenteditable="true"][role="textbox"]'),
    () => querySelectorDeep('div[contenteditable="true"]'),
    () => querySelectorDeep("textarea"),
    () => document.querySelector("textarea"),
  ];
  for (const c of candidates) {
    const el = c();
    if (el && el instanceof HTMLElement) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 40 && rect.height > 16) return el;
    }
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
 * @returns {HTMLElement | null}
 */
function findSendButton() {
  const buttons = Array.from(document.querySelectorAll("button"));
  const byAria = buttons.find((b) => {
    const a = (b.getAttribute("aria-label") || "").toLowerCase();
    return (
      a.includes("send message") ||
      a.includes("send prompt") ||
      a.includes("submit") ||
      a.includes("发送") ||
      a.includes("傳送") ||
      a === "send"
    );
  });
  if (byAria) return byAria;

  const nearInput = buttons.filter((b) => {
    const svg = b.querySelector("svg");
    return svg && b.getBoundingClientRect().width < 64;
  });
  if (nearInput.length > 0) return nearInput[nearInput.length - 1];

  return null;
}

function isGenerating() {
  const stopBtn = Array.from(document.querySelectorAll("button")).some((b) => {
    const a = (b.getAttribute("aria-label") || "").toLowerCase();
    return a.includes("stop") || a.includes("停止");
  });
  return stopBtn;
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
 * 实测：模型正文在 `model-response` 内，可见 `message-content`（user-query 为另一套标签）。
 *
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
async function runOneQuestion(opts) {
  trace("info", "runOneQuestion 开始", { url: location.href, newChat: opts.newChat });

  if (!isGeminiPage()) throw new Error("不在 Gemini 页面");

  if (opts.newChat) {
    await startNewChat();
  }

  trace("info", "查找输入框");
  const editor = await waitFor(() => findPromptEditor(), 25000, 200);
  trace("info", "找到输入框", {
    tag: editor.tagName,
    role: editor.getAttribute("role"),
    aria: editor.getAttribute("aria-label"),
    editable: editor.isContentEditable,
  });

  await setPromptText(editor, opts.question);
  await sleep(200);

  const send = findSendButton();
  if (send) {
    trace("info", "点击发送", { aria: send.getAttribute("aria-label") });
    send.click();
  } else {
    trace("warn", "未找到发送按钮，尝试 Enter");
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
      const msg = e instanceof Error ? e.message : String(e);
      const stack = e instanceof Error ? e.stack : "";
      trace("error", "runOneQuestion 异常", { message: msg, stack });
      sendResponse({
        ok: false,
        error: msg,
      });
    }
  })();

  return true;
});

trace("info", "gemini.js 已注入", { url: location.href });

})();
