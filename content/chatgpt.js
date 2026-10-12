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
   * 取**最后一个可见**的匹配元素。
   *
   * 从对话页点「New chat」时，ChatGPT 不会卸载旧对话：旧 `main` / 旧 composer 会以
   * 0×0 的尺寸留在 DOM 里，新视图挂在**后面**。`querySelector` 只返回文档序第一个，
   * 于是永远命中那个已废弃的隐藏节点，表现为「找不到输入框 / 发送按钮超时」。
   *
   * @param {string} selector
   * @param {ParentNode} [scope]
   * @returns {HTMLElement | null}
   */
  function lastVisible(selector, scope = document) {
    const all = scope.querySelectorAll(selector);
    for (let i = all.length - 1; i >= 0; i--) {
      const el = all[i];
      if (el instanceof HTMLElement && isVisible(el)) return el;
    }
    return null;
  }

  /**
   * 新建对话。2026 版 chatgpt.com 已移除全部 data-testid，侧栏导航列表
   * （`[data-appearance="plain"]` 里的首个按钮）即「新开对话」；文本/语言无关，
   * 因此用结构定位，data-testid 仅作旧版回退。
   *
   * 展开与收起是**两套并存**的元素树，易踩两个坑：
   * 1. 展开态外层是 `nav[role=navigation]`，收起态是 `nav[aria-label="Show sidebar"]`（无 role）
   *    —— 不能用 role 限定；收起态按钮只有 36px —— 不能要求宽度。
   * 2. 文档序里第一个匹配常常是「当前隐藏的那一套」，必须取**第一个可见的**。
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
    const navButtons = document.querySelectorAll(
      '#app-shell-sidebar [data-appearance="plain"] button, [data-appearance="plain"] button'
    );
    for (const btn of navButtons) {
      if (btn instanceof HTMLElement && isVisible(btn)) return btn;
    }
    /** 更早版本：侧栏会话列表上方第一条「新开对话」常为 ul 首项链到 / */
    const sidebarFirst = document.querySelector(
      "aside [role=\"navigation\"] ul > li:first-child a[href=\"/\"], aside nav ul > li:first-child a[href=\"/\"]"
    );
    if (sidebarFirst instanceof HTMLElement && isVisible(sidebarFirst)) return sidebarFirst;
    return null;
  }

  function isFreshChatPage() {
    try {
      if (location.pathname !== "/") return false;
    } catch (_) {
      return false;
    }
    if (countAssistantMessages() > 0) return false;
    return findPromptEditor() !== null;
  }

  async function startNewChat() {
    trace("info", "startNewChat: 查找侧栏新开对话按钮");
    if (isFreshChatPage()) {
      trace("info", "startNewChat: 已在新建对话页，跳过点击");
      await sleep(200);
      return;
    }
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
   * 主输入区。2026 版没有 `#prompt-textarea` 了：输入框是
   * `form[data-chatgpt-composer]` 内一个无 id 的 `div.ProseMirror[contenteditable][role=textbox]`。
   * 回退：name / 主区域可见 textarea / 可见 contenteditable textbox（仍用结构，不用文案）。
   *
   * @returns {HTMLElement | null}
   */
  function findPromptEditor() {
    const byComposer = lastVisible(
      "form[data-chatgpt-composer] [contenteditable=\"true\"][role=\"textbox\"], " +
        "[contenteditable=\"true\"][role=\"textbox\"].ProseMirror, " +
        "form[data-chatgpt-composer] .ProseMirror[contenteditable=\"true\"]"
    );
    if (byComposer) return byComposer;

    const byId = lastVisible("#prompt-textarea");
    if (byId) return byId;

    const byName = lastVisible('textarea[name="prompt-textarea"]');
    if (byName) return byName;

    const main = lastVisible("main");
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
      for (let i = editables.length - 1; i >= 0; i--) {
        const el = editables[i];
        if (isVisible(el) && el.getBoundingClientRect().width > 40) return el;
      }
    }

    const pm = lastVisible(
      'div[contenteditable="true"][role="textbox"], .ProseMirror[contenteditable="true"]'
    );
    if (pm && pm.getBoundingClientRect().width > 40) return pm;

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
   * 发送。2026 版：输入框有内容时，composer 内才渲染一个 `button[type=submit]`
   * （空输入框时该位置是「Start Voice」，所以不能只靠按钮位置判断）。
   * 旧版回退 `data-testid="send-button"`。
   *
   * @returns {HTMLElement | null}
   */
  function findSendButton() {
    const byTest = lastVisible('[data-testid="send-button"]');
    if (byTest) return byTest;

    const form = lastVisible("form[data-chatgpt-composer]");
    return lastVisible('button[type="submit"]', form || document);
  }

  /**
   * 是否处于禁用态。发送按钮在文本写入后是**延迟几秒**才 enable 的（React 受控状态），
   * 所以「找到按钮」和「按钮可点」必须分开判断。
   *
   * @param {HTMLElement} el
   */
  function isDisabled(el) {
    return el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true";
  }

  /**
   * 在输入框上派发一次真正的回车（composer 的 keydown 处理器认这个）。
   *
   * @param {HTMLElement} el
   */
  function pressEnter(el) {
    el.focus();
    for (const type of ["keydown", "keypress", "keyup"]) {
      el.dispatchEvent(
        new KeyboardEvent(type, {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true,
        })
      );
    }
  }

  /**
   * 「停止」按钮的 aria-label 随界面语言变化，用子串匹配。注意**不能**用 `\b`：
   * JS 的 `\b` 只认 ASCII 单词字符，`/^停止\b/` 在「停止」这种纯非 ASCII 文案上永不成立。
   */
  const STOP_LABEL_RE = /stop|cancel|停止|中止|终止|中断|정지|중지|やめる/i;

  /**
   * 生成中 composer 主操作位是 `aria-label="Stop"`（中文界面「停止」）的 `type=button`，
   * 空闲时该位置是 `aria-label="Send"` 的 `type=submit`。
   *
   * 只认 aria-label，**不要**按 class 结构兜底：`size-token-button-composer` 是主操作位的
   * 通用类，输入框为空时的「Start Voice」也带这个类，会被误判成「正在生成」而永久卡死。
   *
   * @returns {HTMLElement | null}
   */
  function findStopButton() {
    const legacy = lastVisible('[data-testid="stop-button"]');
    if (legacy) return legacy;

    const form = lastVisible("form[data-chatgpt-composer]");
    const scope = form || document;
    for (const btn of scope.querySelectorAll("button")) {
      if (!(btn instanceof HTMLElement) || !isVisible(btn)) continue;
      const label = (btn.getAttribute("aria-label") || "").trim();
      if (label && STOP_LABEL_RE.test(label)) return btn;
    }
    return null;
  }

  /**
   * 生成中：composer 的发送按钮被「停止」按钮取代（两者同一位置、同样式）。
   */
  function isGenerating() {
    return findStopButton() !== null;
  }

  /**
   * @returns {HTMLElement | null}
   */
  function findConversationRoot() {
    return (
      lastVisible("main") ||
      lastVisible('[role="presentation"]') ||
      document.body
    );
  }

  /**
   * 助手消息节点。2026 版移除了 `data-message-author-role`，改为在助手正文根节点上
   * 标 `data-markdown-text-style="assistant-message"`（用户消息是 user-message）。
   * 两个属性只会存在其一，故优先取旧版，避免将来同页并存时重复计数。
   *
   * @returns {HTMLElement[]}
   */
  function assistantMessageNodes() {
    const pick = (sel) =>
      /** @type {HTMLElement[]} */ (
        [...document.querySelectorAll(sel)].filter(
          (el) => el instanceof HTMLElement && isVisible(el)
        )
      );
    // 只算可见节点：刚新建对话时旧对话仍以 0×0 挂在 DOM 里，算进去会让
    // 「本轮是否已产出新回复」的基线从 0 变成 1，从而把旧答案当成本轮结果。
    const legacy = pick('[data-message-author-role="assistant"]');
    if (legacy.length) return legacy;
    return pick('[data-markdown-text-style="assistant-message"]');
  }

  /**
   * @returns {HTMLElement[]}
   */
  function collectAssistantRoots() {
    const nodes = assistantMessageNodes();
    if (nodes.length) {
      return [nodes[nodes.length - 1]];
    }
    return [];
  }

  /**
   * 已出现的助手消息条数（用于判断本轮是否已产出新回复）。
   */
  function countAssistantMessages() {
    return assistantMessageNodes().length;
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

  /**
   * 消息滚动容器不再是 `main`（2026 版 `main` 本身不滚动），改为就近找可滚动的祖先。
   * @param {HTMLElement} el
   * @returns {HTMLElement | null}
   */
  function findScrollContainer(el) {
    let node = el.parentElement;
    while (node && node !== document.body) {
      const st = getComputedStyle(node);
      if (/(auto|scroll)/.test(st.overflowY) && node.scrollHeight > node.clientHeight + 4) {
        return node;
      }
      node = node.parentElement;
    }
    return lastVisible("main");
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
    const scroller = findScrollContainer(assistantRoot);
    if (scroller) {
      try {
        scroller.scrollTop = scroller.scrollHeight;
      } catch (_) {}
    }
  }

  /**
   * 助手正文根节点：2026 版是 `[data-markdown-text-style="assistant-message"]`
   * （旧的 `div.markdown.prose` 已不存在）。同时把自身算进来，因为
   * collectAssistantRoots 返回的就是正文根节点本身。
   *
   * @param {HTMLElement | null} assistantRoot
   * @returns {HTMLElement[]}
   */
  function collectMarkdownRoots(assistantRoot) {
    if (!assistantRoot) return [];
    const sel =
      '[data-markdown-text-style="assistant-message"], div.markdown.prose, div.markdown, .markdown.prose';
    const found = /** @type {HTMLElement[]} */ ([]);
    if (assistantRoot.matches(sel)) found.push(assistantRoot);
    for (const el of assistantRoot.querySelectorAll(sel)) {
      found.push(/** @type {HTMLElement} */ (el));
    }
    return found.filter((el) => !found.some((other) => other !== el && other.contains(el)));
  }

  /**
   * 优先从正文根节点取字。勿只用 querySelector 取「第一个」markdown：
   * 带搜索/多段结构时首块常为 Short answer 摘要，会误判为全文并截断。
   * @param {HTMLElement | null} assistantRoot
   */
  function extractAssistantMessageText(assistantRoot) {
    if (!assistantRoot) return "";

    const mdFn = globalThis.aiAutoChatHtmlToMarkdown;
    const blocks = collectMarkdownRoots(assistantRoot);
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

    const proseSelectors = [
      '[data-markdown-text-style="assistant-message"]',
      '[class*="markdown"]',
      ".prose",
      '[class*="prose"]',
      "article",
    ];
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
   * @param {number} baselineAssistantCount
   */
  function getAnswerSnapshot(baselineAssistantCount) {
    const root = /** @type {HTMLElement} */ (findConversationRoot());
    const nodes = collectAssistantRoots();
    const last =
      nodes.length > 0 ? /** @type {HTMLElement} */ (nodes[nodes.length - 1]) : null;
    scrollAssistantIntoView(last);
    const assistantCount = countAssistantMessages();
    const text = extractAssistantMessageText(last) || (root.innerText || "").trim();
    return {
      ok: true,
      generating: isGenerating(),
      assistantCount,
      baselineAssistantCount,
      text,
      pageUrl: location.href,
    };
  }

  /**
   * @param {number} baselineAssistantCount
   */
  function finalizeAnswer(baselineAssistantCount) {
    const root = /** @type {HTMLElement} */ (findConversationRoot());
    const nodes = collectAssistantRoots();
    const last =
      nodes.length > 0 ? /** @type {HTMLElement} */ (nodes[nodes.length - 1]) : root;
    scrollAssistantIntoView(last);
    const text = extractAssistantMessageText(last) || (last.innerText || "").trim();
    const citations = extractCitationsFrom(last || root);
    return {
      ok: true,
      answer: text,
      citations,
      pageUrl: location.href,
      baselineAssistantCount,
    };
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
      const assistantCount = countAssistantMessages();
      const text = extractAssistantMessageText(last);

      // 没出现新的助手消息 = 本轮回复还没落地。此处**不能**退回 `root.innerText`：
      // 那会把整页文案（含用户自己的提问）当成答案返回，静默产出垃圾。
      if (assistantCount <= baselineAssistantCount) {
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
    if (countAssistantMessages() <= baselineAssistantCount) {
      throw new Error("等待模型回复超时：未出现新的助手回复");
    }
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

      const baselineAssistantCount = countAssistantMessages();

      await setPromptText(editor, opts.question);
      await sleep(250);

      /** 提交是否已生效：生成已开始，或输入框已被清空。 */
      const committed = () =>
        Promise.resolve(isGenerating() || getPromptText(editor).length === 0);

      const trySubmit = async (attempt) => {
        let send = findSendButton();
        if (!send || isDisabled(send)) {
          try {
            send = await waitFor(
              () => {
                const b = findSendButton();
                return b && !isDisabled(b) ? b : null;
              },
              20000,
              200
            );
          } catch (_) {
            send = findSendButton();
          }
        }
        if (send && !isDisabled(send)) {
          trace("info", "点击发送", {
            testid: send.getAttribute("data-testid"),
            aria: send.getAttribute("aria-label"),
            attempt,
          });
          send.click();
        } else {
          trace("warn", "发送按钮不可用，改用 Enter", {
            found: Boolean(send),
            disabled: send ? isDisabled(send) : null,
            attempt,
          });
          pressEnter(editor);
        }
        return waitUntil(committed, 15000, 250).then(() => true).catch(() => false);
      };

      let submitted = await trySubmit(1);
      if (!submitted) {
        trace("warn", "消息未提交，重试一次");
        submitted = await trySubmit(2);
      }
      if (!submitted) {
        throw new Error("消息未发送成功：输入框未清空且未进入生成状态");
      }
      trace("info", "消息已提交", { generating: isGenerating() });

      trace("info", "等待模型回复结束");
      if (opts.submitOnly) {
        return {
          submitted: true,
          baselineAssistantCount,
          pageUrl: location.href,
        };
      }

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
    if (msg?.type === "CHATGPT_POLL_ANSWER") {
      const baseline = Number(msg.payload?.baselineAssistantCount ?? 0);
      sendResponse(getAnswerSnapshot(baseline));
      return false;
    }
    if (msg?.type === "CHATGPT_FINALIZE_ANSWER") {
      const baseline = Number(msg.payload?.baselineAssistantCount ?? 0);
      sendResponse(finalizeAnswer(baseline));
      return false;
    }
    if (msg?.type !== "CHATGPT_RUN_QUESTION") return false;

    trace("info", "收到 CHATGPT_RUN_QUESTION", { index: msg.payload?.index });

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

  trace("info", "chatgpt.js 已注入", { url: location.href });
})();
