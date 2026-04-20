/* global chrome */
/**
 * Google 搜索结果中的 AI Overview（AIO）与 AI Mode（udm=50）。
 * 选择器随 Google A/B 与地区语言变化。
 * 已合并常见 SERP 抓取资料中的类名/jsname（如 Y3BBE、Kevs9、jydCyd、dvXlsc），可能与你的账号/地区 DOM 不一致，需以实际页面为准。
 * 若 Cursor 侧 Playwright MCP 已连接，可在目标页执行下方「探测」片段，把输出贴回以进一步收紧选择器。
 *
 * --- Playwright MCP browser_evaluate 探测示例 ---
 * () => {
 *   const rso = document.querySelector('#rso');
 *   return {
 *     href: location.href,
 *     hasRso: !!rso,
 *     y3bbe: rso ? rso.querySelectorAll('div.Y3BBE').length : 0,
 *     kevs9: rso ? rso.querySelectorAll('.Kevs9, [class*="Kevs9"]').length : 0,
 *     jyd: rso ? rso.querySelectorAll('li.jydCyd, .jydCyd').length : 0,
 *     dvXlsc: rso ? rso.querySelectorAll('div[jsname="dvXlsc"]').length : 0,
 *     aioText: !!document.body?.innerText?.match(/AI Overview|AI 概览/i),
 *   };
 * }
 */
(function () {
  if (globalThis.__GOOGLE_SEARCH_AI_AUTOCHAT_LOADED) return;
  globalThis.__GOOGLE_SEARCH_AI_AUTOCHAT_LOADED = true;

  const HOST_OK = (() => {
    try {
      const h = location.hostname || "";
      return /^www\.google\./i.test(h);
    } catch {
      return false;
    }
  })();

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
      source: "google-search-content",
      message,
      ...(detailStr !== undefined ? { detail: detailStr } : {}),
    };
    chrome.runtime.sendMessage(payload).catch(() => {});
    const line = `[google-search-content] ${message}${detailStr ? ` ${detailStr}` : ""}`;
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  }

  function isGoogleSearchPage() {
    if (!HOST_OK) return false;
    return /^\/search\b/i.test(location.pathname || "");
  }

  /** AI Overview 标题文案（多语言） */
  function headingLooksLikeAiOverview(text) {
    const t = String(text || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!t) return false;
    if (/^AI Overview\b/i.test(t)) return true;
    if (/^AI 概览\b/.test(t)) return true;
    if (/AI摘要|智能摘要|AI 摘要/.test(t)) return true;
    return false;
  }

  /**
   * @param {HTMLElement} el
   */
  function findOverviewHeadingIn(el) {
    const heads = el.querySelectorAll('h1, h2, h3, h4, [role="heading"], div[role="heading"]');
    for (const h of heads) {
      const t = (h.textContent || "").replace(/\s+/g, " ").trim();
      if (headingLooksLikeAiOverview(t)) return /** @type {HTMLElement} */ (h);
    }
    return null;
  }

  /**
   * 勿用 #rso 整列作 root：会混入自然结果与几十条无关链接。从标题向上找含 Y3BBE、体积适中的最小祖先。
   * @param {HTMLElement} heading
   * @returns {HTMLElement | null}
   */
  function findSmallestOverviewRoot(heading) {
    let el = heading.parentElement;
    /** @type {HTMLElement | null} */
    let best = null;
    let bestLen = Infinity;
    for (let i = 0; i < 22 && el instanceof HTMLElement; i++) {
      if (el.id === "rso") break;
      const txt = (el.innerText || "").trim();
      const len = txt.length;
      const hasY3 = el.querySelector("div.Y3BBE");
      if (hasY3 && len >= 60 && len < 14000 && len < bestLen) {
        best = el;
        bestLen = len;
      }
      el = el.parentElement;
    }
    if (best) return best;
    el = heading.parentElement;
    for (let i = 0; i < 18 && el instanceof HTMLElement; i++) {
      if (el.id === "rso") break;
      const len = (el.innerText || "").trim().length;
      if (len >= 120 && len < 10000) return el;
      el = el.parentElement;
    }
    return heading.parentElement;
  }

  /**
   * Playwright MCP 实测（2026）：「AI Overview」多为 div[role=heading].Fzsovc，且整块常不在 #rso 内，而在 .YzCcne / .Kevs9 / [jsname=dEwkXc] 下。
   * @returns {HTMLElement | null}
   */
  function findAiOverviewRoot() {
    const headSelectors = '[role="heading"],h1,h2,h3,h4';
    const candidates = Array.from(document.querySelectorAll(headSelectors));
    const heading = candidates.find((el) => {
      if (!(el instanceof HTMLElement)) return false;
      const t = (el.textContent || "").replace(/\s+/g, " ").trim();
      return headingLooksLikeAiOverview(t) || /^AI Overview\b/i.test(t);
    });
    if (heading instanceof HTMLElement) {
      const root =
        heading.closest(".YzCcne") ||
        heading.closest(".Kevs9") ||
        heading.closest('[jsname="dEwkXc"]') ||
        heading.closest(".EyBRub") ||
        findSmallestOverviewRoot(heading);
      if (root instanceof HTMLElement) {
        const via = heading.closest(".YzCcne")
          ? "YzCcne"
          : heading.closest(".Kevs9")
            ? "Kevs9"
            : heading.closest('[jsname="dEwkXc"]')
              ? "dEwkXc"
              : heading.closest(".EyBRub")
                ? "EyBRub"
                : "walk";
        trace("info", "AIO: heading + 容器", {
          tag: heading.tagName,
          via,
        });
        return narrowOverviewRootIfNeeded(root);
      }
    }

    const rso = document.querySelector("#rso");
    if (rso) {
      const kids = rso.querySelectorAll(":scope > div");
      for (const div of kids) {
        if (!(div instanceof HTMLElement)) continue;
        const h = findOverviewHeadingIn(div);
        if (h) return narrowOverviewRootIfNeeded(div);
        if (/AI Overview|AI 概览|AI摘要|智能摘要/i.test(div.innerText || "")) {
          return narrowOverviewRootIfNeeded(div);
        }
      }
    }

    const heads = document.querySelectorAll(
      'h1, h2, h3, h4, [role="heading"], div[role="heading"]'
    );
    for (const h of heads) {
      const t = (h.textContent || "").replace(/\s+/g, " ").trim();
      if (!headingLooksLikeAiOverview(t) && !/AI Overview|AI 概览/i.test(t)) continue;
      let el = h.parentElement;
      for (let i = 0; i < 14 && el instanceof HTMLElement; i++) {
        const txt = (el.innerText || "").trim();
        const links = el.querySelectorAll('a[href^="http"]').length;
        if (txt.length > 60 && links >= 1) return narrowOverviewRootIfNeeded(el);
        el = el.parentElement;
      }
    }
    return null;
  }

  /**
   * 若仍偏大，缩到 .YzCcne / .Kevs9 等子树，避免 citations 扫到整栏。
   * @param {HTMLElement} root
   */
  function narrowOverviewRootIfNeeded(root) {
    if (!(root instanceof HTMLElement)) return root;
    const len = (root.innerText || "").trim().length;
    if (len < 9500) return root;
    const sub =
      root.querySelector(".YzCcne") ||
      root.querySelector(".Kevs9") ||
      root.querySelector(".hdzaWe");
    if (sub instanceof HTMLElement) {
      const sl = (sub.innerText || "").trim().length;
      if (sl > 120 && sl < len) return sub;
    }
    return root;
  }

  /**
   * 侧栏来源「Show all / 显示全部」展开后才有完整引用链接。
   * @param {ParentNode | null} scope
   */
  function tryExpandAioShowAll(scope) {
    const s = scope || document.body;
    if (!s.querySelectorAll) return false;
    const clickable = s.querySelectorAll('button, [role="button"], a');
    for (const el of clickable) {
      if (!(el instanceof HTMLElement)) continue;
      const aria = (el.getAttribute("aria-label") || "").toLowerCase();
      const tx = (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (/discussion|filter|more filters|images|videos|shopping|short videos/i.test(aria)) {
        continue;
      }
      const showAll =
        /\bshow all\b/i.test(aria) ||
        aria.includes("all sources") ||
        aria.includes("所有来源") ||
        tx === "show all" ||
        /^show all\b/i.test(tx) ||
        tx.includes("显示全部") ||
        tx.includes("查看全部");
      if (!showAll) continue;
      trace("info", "AIO: 点击 Show all（来源）", {
        aria: (el.getAttribute("aria-label") || "").slice(0, 90),
      });
      el.click();
      return true;
    }
    return false;
  }

  /**
   * 与 findAiOverviewRoot 所用标题规则一致，避免无 AIO 时仍采到自然结果链接。
   * @param {ParentNode | null} root
   */
  function hasRealAiOverviewHeading(root) {
    const scope = root && "querySelectorAll" in root ? root : document.body;
    if (!scope || !scope.querySelectorAll) return false;
    const heads = scope.querySelectorAll(
      '[role="heading"], h1, h2, h3, h4, div[role="heading"]'
    );
    for (const h of heads) {
      const t = (h.textContent || "").replace(/\s+/g, " ").trim();
      if (headingLooksLikeAiOverview(t)) return true;
    }
    return false;
  }

  /**
   * @param {HTMLElement} a
   */
  function anchorInNavOrFooter(a) {
    let el = a.parentElement;
    for (let i = 0; i < 18 && el; i++) {
      const id = (el.id || "").toLowerCase();
      if (/^searchform$|^fbar|^top_nav|^taw|^botstuff|^f-footer|^footer|^nav/i.test(id)) {
        return true;
      }
      const role = el.getAttribute("role");
      if (role === "navigation" || role === "contentinfo") return true;
      if (el.tagName === "FOOTER" || el.tagName === "NAV") return true;
      el = el.parentElement;
    }
    return false;
  }

  /**
   * 优先：正文内链（Y3BBE）→ 来源卡片（jydCyd）→ 其余在 Overview 根内且非导航的链接。
   * @param {HTMLElement} root
   */
  function collectAioCitations(root) {
    const max = 24;
    const seen = new Set();
    /** @type {string[]} */
    const out = [];

    function tryAdd(a) {
      if (!(a instanceof HTMLAnchorElement)) return;
      if (anchorInNavOrFooter(a)) return;
      pushExternalHref(a, out, seen);
    }

    root.querySelectorAll('div.Y3BBE a[href^="http"]').forEach(tryAdd);
    if (out.length >= max) return out.slice(0, max);

    root
      .querySelectorAll('li.jydCyd a[href^="http"], .jydCyd a[href^="http"]')
      .forEach(tryAdd);
    if (out.length >= max) return out.slice(0, max);

    root.querySelectorAll('a[href^="http"]').forEach((a) => {
      if (out.length >= max) return;
      tryAdd(a);
    });
    return out.slice(0, max);
  }

  function tryExpandCollapsed(root) {
    const scope = root || document.body;
    const clickable = scope.querySelectorAll("button, [role=\"button\"]");
    for (const el of clickable) {
      if (!(el instanceof HTMLElement)) continue;
      const a = (el.getAttribute("aria-label") || "").toLowerCase();
      const tx = (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (a.includes("collapse") || a.includes("less")) continue;
      if (/discussion|discussions|forum|filter|shopping|video|image|short videos/i.test(a)) {
        continue;
      }
      const looksExpand =
        /\bexpand\b/i.test(a) ||
        /\bshow more\b/i.test(a) ||
        (a.includes("expand") && /overview|result|answer|ai\b/i.test(a)) ||
        (tx === "more" && el.tagName === "BUTTON") ||
        tx.includes("展开") ||
        tx.includes("显示更多");
      if (!looksExpand) continue;
      trace("info", "AIO: 尝试展开", { aria: el.getAttribute("aria-label")?.slice(0, 80) });
      el.click();
      return true;
    }
    return false;
  }

  /**
   * @param {HTMLElement} root
   */
  function extractAnswerFromOverviewRoot(root) {
    const y3 = root.querySelectorAll("div.Y3BBE");
    if (y3.length) {
      const parts = Array.from(y3)
        .map((n) => (n.innerText || "").trim())
        .filter(Boolean);
      if (parts.length) {
        let text = parts.join("\n\n").trim();
        text = text.replace(/^AI Overview\s*/i, "").replace(/^AI 概览\s*/, "");
        return text.trim();
      }
    }
    const clone = /** @type {HTMLElement} */ (root.cloneNode(true));
    clone.querySelectorAll("script, style").forEach((n) => n.remove());
    let text = (clone.innerText || "").trim();
    text = text.replace(/^AI Overview\s*/i, "").replace(/^AI 概览\s*/, "");
    return text.trim();
  }

  /**
   * @param {HTMLAnchorElement} a
   * @param {string[]} out
   * @param {Set<string>} seen
   */
  function pushExternalHref(a, out, seen) {
    const href = a.href;
    if (!href || seen.has(href)) return;
    try {
      const u = new URL(href);
      if (u.hostname.includes("google.com") && u.pathname.includes("/url")) return;
      if (u.hostname === "google.com" || u.hostname.endsWith(".google.com")) return;
    } catch {
      return;
    }
    seen.add(href);
    out.push(href);
  }

  /**
   * @param {HTMLElement} root
   * @param {number} [max]
   * @returns {string[]}
   */
  function collectCitationUrls(root, max = 24) {
    const out = [];
    const seen = new Set();
    const pref = root.querySelectorAll(
      'li.jydCyd a[href^="http"], .jydCyd a[href^="http"]'
    );
    for (const a of pref) {
      if (!(a instanceof HTMLAnchorElement)) continue;
      pushExternalHref(a, out, seen);
      if (out.length >= max) return out;
    }
    if (out.length) return out;

    for (const a of root.querySelectorAll('a[href^="http"]')) {
      if (!(a instanceof HTMLAnchorElement)) continue;
      pushExternalHref(a, out, seen);
      if (out.length >= max) return out;
    }
    return out;
  }

  /**
   * @param {() => boolean} fn
   */
  async function waitUntil(fn, timeoutMs = 90000, intervalMs = 400) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (fn()) return;
      await sleep(intervalMs);
    }
    throw new Error("等待条件超时");
  }

  /**
   * @param {() => HTMLElement | null} fn
   * @param {number} timeoutMs
   */
  async function waitForElement(fn, timeoutMs = 50000, intervalMs = 350) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const el = fn();
      if (el) return el;
      await sleep(intervalMs);
    }
    return null;
  }

  function findCenterColumn() {
    return (
      document.querySelector("#center_col") ||
      document.querySelector("#main") ||
      document.querySelector('[role="main"]') ||
      document.body
    );
  }

  /**
   * 去掉「N sites」及后面的引用卡片混在正文里的部分；去掉行首误捕获的「5 sites」。
   * @param {string} text
   * @param {string} question
   */
  function cleanAiModeAnswerText(text, question) {
    let t = String(text || "").trim();
    const lines0 = t.split("\n");
    if (lines0.length && /^\d+\s*sites\b/i.test(lines0[0].trim())) {
      lines0.shift();
      t = lines0.join("\n").trim();
    }
    t = t.replace(/^\d+\s*sites\s*/i, "");
    const q = String(question || "").trim();
    if (q.length >= 2 && t.startsWith(q)) {
      t = t.slice(q.length).trim();
    }
    const lineCut = t.search(/\n\d+\s+sites(?:\s*\n|$)/i);
    if (lineCut > 0) t = t.slice(0, lineCut).trim();
    return t.replace(/\n{3,}/g, "\n\n").trim();
  }

  /**
   * 勿取「最长」wDa0n：易选到整页引用列表。优先含用户问题、长度适中、非「N sites」开头、少「·」分隔的卡片行。
   * @param {string} question
   * @returns {HTMLElement | null}
   */
  function pickBestWda0nBlock(question) {
    const blocks = Array.from(document.querySelectorAll("div.wDa0n.notranslate"));
    if (blocks.length === 0) return null;
    const qNorm = String(question || "")
      .trim()
      .replace(/\s+/g, " ");
    const qPrefix = qNorm.slice(0, 28);

    /** @type {{ el: HTMLElement, score: number, raw: string }[]} */
    const scored = blocks.map((el) => {
      const raw = (el.innerText || "").trim();
      if (raw.length < 40) return { el, score: -999, raw };
      let score = 0;
      if (/^\d+\s*sites/i.test(raw)) score -= 250;
      if (score < -200) return { el, score, raw };
      if (qPrefix.length > 1 && raw.includes(qPrefix)) score += 45;
      if (qNorm.length > 2 && qNorm.length < 120 && raw.includes(qNorm)) score += 35;
      const len = raw.length;
      if (len >= 180 && len <= 4500) score += 28;
      if (len > 10000) score -= 80;
      if (len > 6000) score -= 35;
      const dots = (raw.match(/·/g) || []).length;
      if (dots > 5) score -= Math.min(dots * 4, 80);
      return { el, score, raw };
    });

    scored.sort((a, b) => b.score - a.score);
    const top = scored[0];
    if (top && top.score > -150) return top.el;
    const noSites = blocks.find((el) => !/^\d+\s*sites/i.test((el.innerText || "").trim()));
    return noSites || blocks[0];
  }

  /**
   * 引用链接优先从 body 中「N sites」标题之后的片段解析，避免把导航栏算进 citations。
   * @returns {string[]}
   */
  function extractAiModeCitationUrls() {
    const t = document.body?.innerText || "";
    const m = t.match(/\n\d+\s+sites\s*\n([\s\S]*)/i);
    if (!m || !m[1]) return collectCitationUrls(document.body).slice(0, 20);
    const tail = m[1].slice(0, 14000);
    /** @type {string[]} */
    const out = [];
    const seen = new Set();
    const re = /https?:\/\/[^\s\)\]"'<>]+/g;
    let x;
    while ((x = re.exec(tail)) && out.length < 25) {
      let u = x[0].replace(/[,.;:]+$/, "");
      try {
        const p = new URL(u);
        if (p.hostname.includes("google.com")) continue;
        if (seen.has(u)) continue;
        seen.add(u);
        out.push(u);
      } catch {
        /* skip */
      }
    }
    return out.length ? out : collectCitationUrls(document.body).slice(0, 15);
  }

  /**
   * AI Mode：MCP 实测 udm=50 时 #center_col 可能 innerText 为空；正文多在 div.wDa0n.notranslate（多块时勿取最长）。
   * @param {string} question
   * @returns {{ text: string, element: HTMLElement }}
   */
  function extractAiModeAnswerAndElement(question) {
    const q = String(question || "");

    const best = pickBestWda0nBlock(q);
    if (best instanceof HTMLElement) {
      const raw = (best.innerText || "").trim();
      const cleaned = cleanAiModeAnswerText(raw, q);
      if (cleaned.length > 80) {
        trace("info", "AI Mode: div.wDa0n.notranslate", {
          len: cleaned.length,
          rawLen: raw.length,
        });
        return { text: cleaned, element: best };
      }
    }

    const body = document.body?.innerText || "";
    const sr = body.indexOf("Search Results");
    if (sr >= 0) {
      let slice = body.slice(sr);
      const cut11 = slice.indexOf("\n11 sites\n");
      const cutN = slice.search(/\n\d+\s+sites\s*\n/i);
      const cutReady = slice.indexOf("AI Mode response is ready");
      let end = slice.length;
      if (cut11 > 200) end = Math.min(end, cut11);
      if (cutN > 200) end = Math.min(end, cutN);
      if (cutReady > 200) end = Math.min(end, cutReady);
      slice = slice.slice(0, end);
      slice = slice.replace(/^Search Results\s*\n[^\n]*\n?/, "").trim();
      const cleaned = cleanAiModeAnswerText(slice, q);
      if (cleaned.length > 200) {
        trace("info", "AI Mode: body 切片", { len: cleaned.length });
        const el =
          document.querySelector("#center_col") ||
          document.querySelector('[role="main"]') ||
          document.body;
        return {
          text: cleaned,
          element: el instanceof HTMLElement ? el : document.body,
        };
      }
    }

    const center = findCenterColumn();
    if (!(center instanceof HTMLElement)) {
      return { text: "", element: document.body };
    }
    const clone = /** @type {HTMLElement} */ (center.cloneNode(true));
    clone.querySelectorAll("script, style, nav, header, footer").forEach((n) => n.remove());
    const hideIds = ["searchform", "taw", "top_nav", "bres", "botstuff"];
    for (const id of hideIds) {
      const n = clone.querySelector(`#${id}`);
      if (n) n.remove();
    }
    const text = cleanAiModeAnswerText(
      (clone.innerText || "").replace(/\s+\n/g, "\n").trim(),
      q
    );
    return { text, element: center };
  }

  function looksLikeAiModeLoading() {
    const busy = document.querySelector('[aria-busy="true"]');
    if (busy) return true;
    const prog = document.querySelector('[role="progressbar"]');
    if (prog) return true;
    return false;
  }

  /**
   * @param {{ question: string, mode: "aio"|"aimode", index?: number }} opts
   */
  async function waitForPageReady() {
    if (document.readyState !== "complete") {
      await new Promise((r) => {
        if (document.readyState === "complete") r();
        else window.addEventListener("load", () => r(), { once: true });
      });
    }
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await sleep(450);
  }

  async function runOneQuestion(opts) {
    const mode = opts.mode === "aimode" ? "aimode" : "aio";
    trace("info", "runOneQuestion", { mode, url: location.href });

    if (!isGoogleSearchPage()) throw new Error("不在 Google 搜索页");

    await waitForPageReady();

    if (mode === "aio") {
      let root = await waitForElement(() => findAiOverviewRoot(), 55000, 400);
      if (root) tryExpandCollapsed(root);
      if (root) await sleep(500);
      if (root) {
        const center =
          document.querySelector("#center_col") ||
          document.querySelector("#main") ||
          document.querySelector('[role="main"]');
        if (!tryExpandAioShowAll(root) && center) tryExpandAioShowAll(center);
        await sleep(900);
      }
      if (!root) {
        trace("warn", "AIO: 未找到 AI Overview 区块", {});
        return {
          answer: "",
          citations: [],
          pageUrl: location.href,
          aioPresent: false,
          note: "本页未出现 AI Overview（与查询、地区、账号或策略有关）",
        };
      }

      let stable = "";
      let ticks = 0;
      for (let i = 0; i < 80; i++) {
        await sleep(350);
        const t = extractAnswerFromOverviewRoot(root);
        if (t === stable && t.length > 40) ticks += 1;
        else ticks = 0;
        stable = t;
        if (ticks >= 3) break;
      }

      if (root) {
        const centerLate =
          document.querySelector("#center_col") ||
          document.querySelector("#main") ||
          document.querySelector('[role="main"]');
        if (!tryExpandAioShowAll(root) && centerLate) tryExpandAioShowAll(centerLate);
        await sleep(650);
      }

      const answer = extractAnswerFromOverviewRoot(root);
      const trimmed = answer.trim();
      const headingOk = hasRealAiOverviewHeading(root);
      const hasProseBlock = !!root.querySelector("div.Y3BBE");
      const looksLikeAio =
        headingOk || (hasProseBlock && trimmed.length >= 40);
      if (!looksLikeAio || trimmed.length < 12) {
        trace("warn", "AIO: 未确认真实 AI Overview 或正文过短", {
          headingOk,
          hasProseBlock,
          len: trimmed.length,
        });
        return {
          answer: "",
          citations: [],
          pageUrl: location.href,
          aioPresent: false,
          note: "本页未出现 AI Overview（与查询、地区、账号或策略有关）",
        };
      }

      const citations = collectAioCitations(root);

      return {
        answer,
        citations,
        pageUrl: location.href,
        aioPresent: true,
        note: undefined,
      };
    }

    /* aimode */
    const qStr = String(opts.question || "");
    try {
      await waitUntil(
        () =>
          !looksLikeAiModeLoading() ||
          extractAiModeAnswerAndElement(qStr).text.length > 200,
        75000,
        450
      );
    } catch (_) {
      trace("warn", "AI Mode: 等待加载状态结束超时，继续采集当前正文", {});
    }

    let last = "";
    let stableTicks = 0;
    for (let i = 0; i < 50; i++) {
      await sleep(450);
      const { text } = extractAiModeAnswerAndElement(qStr);
      const t = text;
      if (t === last && t.length > 80) stableTicks += 1;
      else stableTicks = 0;
      last = t;
      if (stableTicks >= 4 && t.length > 80) {
        return {
          answer: t,
          citations: extractAiModeCitationUrls(),
          pageUrl: location.href,
          note:
            "AI Mode（udm=50）；引用为「N sites」区块内链接。未开通 Labs 时版面可能不同。",
        };
      }
    }

    const { text } = extractAiModeAnswerAndElement(qStr);
    return {
      answer: text,
      citations: extractAiModeCitationUrls(),
      pageUrl: location.href,
      note: "AI Mode：正文可能仍在变化，已尽力采集当前可见内容",
    };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "GOOGLE_SEARCH_RUN") return false;

    trace("info", "收到 GOOGLE_SEARCH_RUN", { index: msg.payload?.index, mode: msg.payload?.mode });

    let responded = false;
    function finish(payload) {
      if (responded) return;
      responded = true;
      try {
        sendResponse(payload);
      } catch (_) {
        /* 通道已关闭时二次 sendResponse 会抛错，忽略 */
      }
    }

    const payload = msg.payload || {};
    (async () => {
      try {
        const out = await runOneQuestion({
          question: String(payload.question || ""),
          mode: payload.mode === "aimode" ? "aimode" : "aio",
          index: payload.index,
        });
        finish({ ok: true, ...out });
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        const stack = e instanceof Error ? e.stack : "";
        trace("error", "runOneQuestion 异常", { message: errMsg, stack });
        finish({ ok: false, error: errMsg });
      }
    })();

    return true;
  });

  trace("info", "google-search.js 已注入", { url: location.href });
})();
