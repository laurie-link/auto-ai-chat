import { appendLog, clearLogs, getLogs } from "../lib/logger.js";
import {
  buildWorkflowExportJson,
  difyRunWorkflowBlocking,
  difyRunWorkflowBlockingWithTypeRetry,
  difyUploadFile,
  normalizeDifyApiBase,
  normalizeWorkflowImportJson,
} from "../lib/dify-workflow.js";
import * as XLSX from "../vendor/xlsx.mjs";

const GEMINI_ORIGIN = "https://gemini.google.com";
const GEMINI_CS_FILE = "content/gemini.js";

const CHATGPT_CS_FILE = "content/chatgpt.js";

const CHATGPT_TAB_URL_PATTERNS = [
  "https://chatgpt.com/*",
  "https://*.chatgpt.com/*",
  "https://chat.openai.com/*",
];

const PERPLEXITY_CS_FILE = "content/perplexity.js";
const PERPLEXITY_HOME = "https://www.perplexity.ai/";
const PERPLEXITY_TAB_URL_PATTERNS = [
  "https://www.perplexity.ai/*",
  "https://perplexity.ai/*",
];

const GOOGLE_SEARCH_CS_FILE = "content/google-search.js";

/**
 * AI Mode：公开资料中常见 `udm=50`；若你所在地区/账号下参数不同，可用 Playwright MCP 打开目标页对比地址栏后改此常量。
 */
const GOOGLE_AI_MODE_UDM = "50";

/**
 * @param {string} question
 * @param {"aio"|"aimode"} mode
 */
function buildGoogleSearchUrl(question, mode) {
  const q = encodeURIComponent(String(question || "").trim());
  const base = `https://www.google.com/search?q=${q}&hl=en`;
  if (mode === "aimode") return `${base}&udm=${GOOGLE_AI_MODE_UDM}`;
  return base;
}

/**
 * Perplexity 侧点击「New」会整页跳转，内容脚本若在 onMessage 异步流程里点击，页面卸载导致
 * sendResponse 永远调不到（message channel closed）。新对话改为后台先导航到首页再发消息。
 *
 * @param {number} tabId
 */
async function navigatePerplexityHomeAndInject(tabId) {
  await trace("info", "background", "Perplexity 导航到首页并注入脚本", { tabId });
  await chrome.tabs.update(tabId, { url: PERPLEXITY_HOME });
  await waitTabComplete(tabId);
  await sleep(1500);
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: [PERPLEXITY_CS_FILE],
    });
    await sleep(350);
  } catch (e) {
    await trace("warn", "background", "Perplexity 导航后 executeScript", String(e));
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {"info"|"warn"|"error"} level
 * @param {string} source
 * @param {string} message
 * @param {unknown} [detail]
 */
async function trace(level, source, message, detail) {
  let detailStr;
  if (detail !== undefined) {
    try {
      detailStr = typeof detail === "string" ? detail : JSON.stringify(detail);
    } catch {
      detailStr = String(detail);
    }
  }
  const entry = {
    t: new Date().toISOString(),
    level,
    source,
    message,
    ...(detailStr !== undefined ? { detail: detailStr } : {}),
  };
  await appendLog(entry);
  const prefix = `[AI-AutoChat][${source}]`;
  // 用 warn 代替 error，避免 Chrome「扩展程序错误」页把业务失败当成严重异常刷屏
  if (level === "error") console.warn(prefix, "[error]", message, detailStr ?? "");
  else if (level === "warn") console.warn(prefix, message, detailStr ?? "");
  else console.log(prefix, message, detailStr ?? "");
}

/**
 * @param {string[]} questions
 * @returns {Promise<{ ok: boolean, results?: object[], error?: string }>}
 */
async function runGeminiQueue(questions) {
  const filtered = questions.map((q) => String(q).trim()).filter(Boolean);
  if (filtered.length === 0) {
    await trace("warn", "background", "runGeminiQueue", "没有有效问题");
    return { ok: false, error: "没有有效问题" };
  }

  await trace("info", "background", "runGeminiQueue 开始", {
    count: filtered.length,
    preview: filtered[0]?.slice(0, 80),
  });

  let tab;
  try {
    tab = await ensureGeminiTab();
  } catch (e) {
    await trace("error", "background", "ensureGeminiTab 失败", String(e));
    await recordRunError({ phase: "ensureGeminiTab", error: String(e) });
    return { ok: false, error: String(e) };
  }

  await trace("info", "background", "标签页就绪", { tabId: tab.id, url: tab.url || "" });
  await waitTabSettled(tab.id, 1400);

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: [GEMINI_CS_FILE],
    });
    await trace("info", "background", "预注入内容脚本 all_frames（避免 Receiving end）", {
      tabId: tab.id,
    });
    await sleep(250);
  } catch (e) {
    await trace("warn", "background", "预注入跳过或失败（可能已由 manifest 注入）", String(e));
  }

  const results = [];
  for (let i = 0; i < filtered.length; i++) {
    const question = filtered[i];
    await trace("info", "background", `发送第 ${i + 1}/${filtered.length} 题`, {
      len: question.length,
    });

    const res = await sendToTabWithRetry(
      tab.id,
      {
        type: "GEMINI_RUN_QUESTION",
        payload: {
          question,
          index: i,
          total: filtered.length,
          newChat: true,
        },
      },
      GEMINI_CS_FILE
    );

    if (!res?.ok) {
      await trace("error", "background", "内容脚本返回失败", {
        error: res?.error || "无 error 字段",
        raw: res,
      });
      await recordRunError({
        phase: "GEMINI_RUN_QUESTION",
        step: `${i + 1}/${filtered.length}`,
        tabId: tab.id,
        tabUrl: tab.url || "",
        error: res?.error || "内容脚本无响应",
      });
      return {
        ok: false,
        error: res?.error || "内容脚本无响应",
        results,
      };
    }

    await trace("info", "background", `第 ${i + 1} 题完成`, {
      answerLen: String(res.answer || "").length,
      citations: (res.citations || []).length,
    });

    results.push({
      site: "gemini",
      question,
      answer: res.answer,
      citations: res.citations || [],
      pageUrl: res.pageUrl || "",
      capturedAt: new Date().toISOString(),
    });
  }

  try {
    await saveRunToStorage(results, "gemini");
  } catch (e) {
    await trace("error", "background", "保存或下载失败", String(e));
    await recordRunError({
      phase: "save_or_export",
      tabId: tab.id,
      tabUrl: tab.url || "",
      error: String(e),
    });
    return { ok: false, error: `保存失败: ${e}`, results };
  }

  await trace("info", "background", "runGeminiQueue 全部成功", { n: results.length });
  return { ok: true, results };
}

/**
 * @param {string[]} questions
 * @returns {Promise<{ ok: boolean, results?: object[], error?: string }>}
 */
async function runChatGPTQueue(questions) {
  const filtered = questions.map((q) => String(q).trim()).filter(Boolean);
  if (filtered.length === 0) {
    await trace("warn", "background", "runChatGPTQueue", "没有有效问题");
    return { ok: false, error: "没有有效问题" };
  }

  await trace("info", "background", "runChatGPTQueue 开始", {
    count: filtered.length,
    preview: filtered[0]?.slice(0, 80),
  });

  let tab;
  try {
    tab = await ensureChatGPTTab();
  } catch (e) {
    await trace("error", "background", "ensureChatGPTTab 失败", String(e));
    await recordRunError({ phase: "ensureChatGPTTab", error: String(e) });
    return { ok: false, error: String(e) };
  }

  await trace("info", "background", "标签页就绪", { tabId: tab.id, url: tab.url || "" });
  await waitTabSettled(tab.id, 1600);

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: [CHATGPT_CS_FILE],
    });
    await trace("info", "background", "预注入 ChatGPT 内容脚本 all_frames", { tabId: tab.id });
    await sleep(250);
  } catch (e) {
    await trace("warn", "background", "ChatGPT 预注入跳过或失败", String(e));
  }

  const results = [];
  for (let i = 0; i < filtered.length; i++) {
    const question = filtered[i];
    await trace("info", "background", `ChatGPT 发送第 ${i + 1}/${filtered.length} 题`, {
      len: question.length,
    });

    const res = await sendToTabWithRetry(
      tab.id,
      {
        type: "CHATGPT_RUN_QUESTION",
        payload: {
          question,
          index: i,
          total: filtered.length,
          newChat: true,
        },
      },
      CHATGPT_CS_FILE
    );

    if (!res?.ok) {
      await trace("error", "background", "ChatGPT 内容脚本返回失败", {
        error: res?.error || "无 error 字段",
        raw: res,
      });
      await recordRunError({
        phase: "CHATGPT_RUN_QUESTION",
        step: `${i + 1}/${filtered.length}`,
        tabId: tab.id,
        tabUrl: tab.url || "",
        error: res?.error || "内容脚本无响应",
      });
      return {
        ok: false,
        error: res?.error || "内容脚本无响应",
        results,
      };
    }

    await trace("info", "background", `ChatGPT 第 ${i + 1} 题完成`, {
      answerLen: String(res.answer || "").length,
      citations: (res.citations || []).length,
    });

    results.push({
      site: "chatgpt",
      question,
      answer: res.answer,
      citations: res.citations || [],
      pageUrl: res.pageUrl || "",
      capturedAt: new Date().toISOString(),
    });
  }

  try {
    await saveRunToStorage(results, "chatgpt");
  } catch (e) {
    await trace("error", "background", "保存或下载失败", String(e));
    await recordRunError({
      phase: "save_or_export_chatgpt",
      tabId: tab.id,
      tabUrl: tab.url || "",
      error: String(e),
    });
    return { ok: false, error: `保存失败: ${e}`, results };
  }

  await trace("info", "background", "runChatGPTQueue 全部成功", { n: results.length });
  return { ok: true, results };
}

/**
 * @param {string[]} questions
 * @returns {Promise<{ ok: boolean, results?: object[], error?: string }>}
 */
async function runPerplexityQueue(questions) {
  const filtered = questions.map((q) => String(q).trim()).filter(Boolean);
  if (filtered.length === 0) {
    await trace("warn", "background", "runPerplexityQueue", "没有有效问题");
    return { ok: false, error: "没有有效问题" };
  }

  await trace("info", "background", "runPerplexityQueue 开始", {
    count: filtered.length,
    preview: filtered[0]?.slice(0, 80),
  });

  let tab;
  try {
    tab = await ensurePerplexityTab();
  } catch (e) {
    await trace("error", "background", "ensurePerplexityTab 失败", String(e));
    await recordRunError({ phase: "ensurePerplexityTab", error: String(e) });
    return { ok: false, error: String(e) };
  }

  await trace("info", "background", "标签页就绪", { tabId: tab.id, url: tab.url || "" });
  await waitTabSettled(tab.id, 900);

  const results = [];
  for (let i = 0; i < filtered.length; i++) {
    const question = filtered[i];
    await trace("info", "background", `Perplexity 发送第 ${i + 1}/${filtered.length} 题`, {
      len: question.length,
    });

    await navigatePerplexityHomeAndInject(tab.id);

    const res = await sendToTabWithRetry(
      tab.id,
      {
        type: "PERPLEXITY_RUN_QUESTION",
        payload: {
          question,
          index: i,
          total: filtered.length,
          newChat: false,
        },
      },
      PERPLEXITY_CS_FILE
    );

    if (!res?.ok) {
      await trace("error", "background", "Perplexity 内容脚本返回失败", {
        error: res?.error || "无 error 字段",
        raw: res,
      });
      await recordRunError({
        phase: "PERPLEXITY_RUN_QUESTION",
        step: `${i + 1}/${filtered.length}`,
        tabId: tab.id,
        tabUrl: tab.url || "",
        error: res?.error || "内容脚本无响应",
      });
      return {
        ok: false,
        error: res?.error || "内容脚本无响应",
        results,
      };
    }

    await trace("info", "background", `Perplexity 第 ${i + 1} 题完成`, {
      answerLen: String(res.answer || "").length,
      citations: (res.citations || []).length,
    });

    results.push({
      site: "perplexity",
      question,
      answer: res.answer,
      citations: res.citations || [],
      pageUrl: res.pageUrl || "",
      capturedAt: new Date().toISOString(),
    });
  }

  try {
    await saveRunToStorage(results, "perplexity");
  } catch (e) {
    await trace("error", "background", "保存或下载失败", String(e));
    await recordRunError({
      phase: "save_or_export_perplexity",
      tabId: tab.id,
      tabUrl: tab.url || "",
      error: String(e),
    });
    return { ok: false, error: `保存失败: ${e}`, results };
  }

  await trace("info", "background", "runPerplexityQueue 全部成功", { n: results.length });
  return { ok: true, results };
}

/**
 * @param {string[]} questions
 * @param {"aio"|"aimode"} mode
 * @returns {Promise<{ ok: boolean, results?: object[], error?: string }>}
 */
async function runGoogleSearchQueue(questions, mode) {
  const site = mode === "aimode" ? "google_aimode" : "google_aio";
  const filtered = questions.map((q) => String(q).trim()).filter(Boolean);
  if (filtered.length === 0) {
    await trace("warn", "background", "runGoogleSearchQueue", "没有有效问题");
    return { ok: false, error: "没有有效问题" };
  }

  await trace("info", "background", "runGoogleSearchQueue 开始", {
    count: filtered.length,
    mode,
    preview: filtered[0]?.slice(0, 80),
  });

  let tab;
  try {
    tab = await ensureGoogleTab();
  } catch (e) {
    await trace("error", "background", "ensureGoogleTab 失败", String(e));
    await recordRunError({ phase: "ensureGoogleTab", error: String(e) });
    return { ok: false, error: String(e) };
  }

  await trace("info", "background", "标签页就绪", { tabId: tab.id, url: tab.url || "" });
  await waitTabSettled(tab.id, 600);

  const results = [];
  for (let i = 0; i < filtered.length; i++) {
    const question = filtered[i];
    const url = buildGoogleSearchUrl(question, mode);
    await trace("info", "background", `Google ${mode} 第 ${i + 1}/${filtered.length} 题`, {
      len: question.length,
    });

    await chrome.tabs.update(tab.id, { url });
    await waitTabComplete(tab.id);
    await waitUntilTabUrlMatches(tab.id, (u) => {
      const s = u || "";
      return /\.google\./.test(s) && /\/search\?/.test(s);
    });
    await sleep(4500);

    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: [GOOGLE_SEARCH_CS_FILE],
      });
      await sleep(750);
    } catch (e) {
      await trace("warn", "background", "Google executeScript", String(e));
    }

    const res = await sendToTabWithRetry(
      tab.id,
      {
        type: "GOOGLE_SEARCH_RUN",
        payload: {
          question,
          index: i,
          total: filtered.length,
          mode,
        },
      },
      GOOGLE_SEARCH_CS_FILE,
      { mainFrameOnly: true, injectAllFrames: false }
    );

    if (!res?.ok) {
      await trace("error", "background", "Google 内容脚本返回失败", {
        error: res?.error || "无 error 字段",
        raw: res,
      });
      await recordRunError({
        phase: "GOOGLE_SEARCH_RUN",
        step: `${i + 1}/${filtered.length}`,
        tabId: tab.id,
        tabUrl: tab.url || "",
        error: res?.error || "内容脚本无响应",
      });
      return {
        ok: false,
        error: res?.error || "内容脚本无响应",
        results,
      };
    }

    await trace("info", "background", `Google ${mode} 第 ${i + 1} 题完成`, {
      answerLen: String(res.answer || "").length,
      citations: (res.citations || []).length,
    });

    results.push({
      site,
      question,
      answer: res.answer,
      citations: res.citations || [],
      pageUrl: res.pageUrl || "",
      capturedAt: new Date().toISOString(),
      ...(res.aioPresent !== undefined ? { aioPresent: res.aioPresent } : {}),
      ...(res.note ? { note: res.note } : {}),
    });
  }

  try {
    await saveRunToStorage(results, site);
  } catch (e) {
    await trace("error", "background", "Google 保存失败", String(e));
    await recordRunError({
      phase: "save_google_search",
      tabId: tab.id,
      tabUrl: tab.url || "",
      error: String(e),
    });
    return { ok: false, error: `保存失败: ${e}`, results };
  }

  await trace("info", "background", "runGoogleSearchQueue 全部成功", { n: results.length, mode });
  return { ok: true, results };
}

async function ensureGoogleTab() {
  const tabs = await chrome.tabs.query({ url: "https://www.google.com/*" });
  if (tabs.length > 0 && tabs[0].id != null) {
    const t = tabs[0];
    await chrome.tabs.update(t.id, { active: true });
    return chrome.tabs.get(t.id);
  }
  const created = await chrome.tabs.create({ url: "https://www.google.com/", active: true });
  if (created.id == null) throw new Error("无法创建标签页");
  return chrome.tabs.get(created.id);
}

async function ensurePerplexityTab() {
  for (const pattern of PERPLEXITY_TAB_URL_PATTERNS) {
    const tabs = await chrome.tabs.query({ url: pattern });
    if (tabs.length > 0 && tabs[0].id != null) {
      const t = tabs[0];
      await chrome.tabs.update(t.id, { active: true });
      return chrome.tabs.get(t.id);
    }
  }
  const created = await chrome.tabs.create({ url: "https://www.perplexity.ai/", active: true });
  if (created.id == null) throw new Error("无法创建标签页");
  return chrome.tabs.get(created.id);
}

async function ensureChatGPTTab() {
  for (const pattern of CHATGPT_TAB_URL_PATTERNS) {
    const tabs = await chrome.tabs.query({ url: pattern });
    if (tabs.length > 0 && tabs[0].id != null) {
      const t = tabs[0];
      await chrome.tabs.update(t.id, { active: true });
      return chrome.tabs.get(t.id);
    }
  }
  const created = await chrome.tabs.create({ url: "https://chatgpt.com/", active: true });
  if (created.id == null) throw new Error("无法创建标签页");
  return chrome.tabs.get(created.id);
}

async function ensureGeminiTab() {
  const tabs = await chrome.tabs.query({ url: `${GEMINI_ORIGIN}/*` });
  if (tabs.length > 0 && tabs[0].id != null) {
    const t = tabs[0];
    await chrome.tabs.update(t.id, { active: true });
    const fresh = await chrome.tabs.get(t.id);
    return fresh;
  }
  const created = await chrome.tabs.create({ url: `${GEMINI_ORIGIN}/app`, active: true });
  if (created.id == null) throw new Error("无法创建标签页");
  const fresh = await chrome.tabs.get(created.id);
  return fresh;
}

/**
 * @param {number} tabId
 */
function waitTabComplete(tabId) {
  return new Promise((resolve) => {
    function listener(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((t) => {
      if (t.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    });
  });
}

/**
 * 导航后 URL 可能晚于 status=complete 才更新；轮询避免过早注入/发消息。
 * @param {number} tabId
 * @param {(url: string) => boolean} predicate
 */
async function waitUntilTabUrlMatches(tabId, predicate, timeoutMs = 25000, intervalMs = 180) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const t = await chrome.tabs.get(tabId);
      const u = t.url || "";
      if (predicate(u)) {
        await sleep(450);
        return true;
      }
    } catch (_) {
      /* tab 可能短暂不可用 */
    }
    await sleep(intervalMs);
  }
  await trace("warn", "background", "waitUntilTabUrlMatches 超时", { tabId });
  return false;
}

/**
 * 标签 complete 后再多等一会，减少 SPA 未水合时采到错 DOM。
 * @param {number} tabId
 * @param {number} extraMs
 */
async function waitTabSettled(tabId, extraMs = 900) {
  await waitTabComplete(tabId);
  await sleep(extraMs);
  try {
    const t = await chrome.tabs.get(tabId);
    if (t.status !== "complete") await waitTabComplete(tabId);
  } catch (_) {}
}

/**
 * @param {number} tabId
 * @param {object} message
 */
function sendToTab(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const err = chrome.runtime.lastError;
      if (err) {
        resolve({ ok: false, error: err.message });
        return;
      }
      resolve(response);
    });
  });
}

/**
 * @param {number} tabId
 * @param {number} frameId
 * @param {object} message
 */
function sendToTabFrame(tabId, frameId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, { frameId }, (response) => {
      const err = chrome.runtime.lastError;
      if (err) {
        resolve({ ok: false, error: err.message });
        return;
      }
      resolve(response);
    });
  });
}

/**
 * @param {{ ok?: boolean, error?: string }|undefined} res
 */
function isTransientSendError(res) {
  const err = String(res?.error || "");
  return (
    err.includes("Receiving end does not exist") ||
    err.includes("Could not establish connection") ||
    err.includes("back/forward cache") ||
    err.includes("message channel is closed") ||
    err.includes("message channel closed") ||
    err.includes("asynchronous response by returning true")
  );
}

/**
 * @param {number} tabId
 * @returns {Promise<number[]>}
 */
function getAllFrameIds(tabId) {
  return new Promise((resolve, reject) => {
    chrome.webNavigation.getAllFrames({ tabId }, (frames) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!frames || frames.length === 0) {
        resolve([0]);
        return;
      }
      const ids = [...new Set(frames.map((f) => f.frameId))].sort((a, b) => a - b);
      resolve(ids);
    });
  });
}

/**
 * 默认只发给主框架；若监听器在 iframe 里会 Receiving end。依次尝试每个 frameId。
 *
 * @param {number} tabId
 * @param {object} message
 */
async function sendToTabAnyFrame(tabId, message) {
  let last = /** @type {{ ok?: boolean, error?: string }} */ ({ ok: false, error: "unknown" });

  try {
    const frameIds = await getAllFrameIds(tabId);
    for (const fid of frameIds) {
      const r = await sendToTabFrame(tabId, fid, message);
      last = r;
      if (!isTransientSendError(r)) return r;
    }
    return last;
  } catch (e) {
    await trace("warn", "background", "getAllFrames 失败，退回主框架", String(e));
    return sendToTab(tabId, message);
  }
}

/**
 * @param {number} tabId
 * @param {object} message
 */
/**
 * @param {number} tabId
 * @param {object} message
 * @param {string} csFile 当前站点对应的内容脚本，重试注入时必须一致
 */
/**
 * @param {number} tabId
 * @param {object} message
 * @param {string} [csFile]
 * @param {{ mainFrameOnly?: boolean, injectAllFrames?: boolean }} [opts]
 */
async function sendToTabWithRetry(tabId, message, csFile = GEMINI_CS_FILE, opts = {}) {
  const mainFrameOnly = opts.mainFrameOnly === true;
  const injectAllFrames = opts.injectAllFrames !== false;
  let didInject = false;
  for (let attempt = 0; attempt < 12; attempt++) {
    const res = mainFrameOnly
      ? await sendToTabFrame(tabId, 0, message)
      : await sendToTabAnyFrame(tabId, message);
    if (!isTransientSendError(res)) return res;

    await trace("warn", "background", `sendMessage 重试 ${attempt + 1}/12`, String(res?.error));

    const errStr = String(res?.error || "");
    if (
      errStr.includes("back/forward cache") ||
      errStr.includes("message channel") ||
      errStr.includes("asynchronous response")
    ) {
      await sleep(1800);
    }

    if (!didInject) {
      didInject = true;
      try {
        await chrome.scripting.executeScript({
          target: { tabId, ...(injectAllFrames ? { allFrames: true } : {}) },
          files: [csFile],
        });
        await trace("info", "background", "已注入内容脚本", {
          tabId,
          csFile,
          mainFrameOnly: injectAllFrames ? "allFrames" : "main",
        });
        await sleep(500);
      } catch (e) {
        await trace("warn", "background", "inject 失败", String(e));
      }
    }
    await sleep(450);
  }
  return mainFrameOnly ? sendToTabFrame(tabId, 0, message) : sendToTabAnyFrame(tabId, message);
}

/**
 * 记录失败（写入调试日志 + storage），不自动下载文件，避免每次失败都弹出下载。
 * 完整排查请用弹窗「调试日志 → 导出 JSON」。
 * @param {Record<string, unknown>} context
 */
async function recordRunError(context) {
  const at = new Date().toISOString();
  try {
    await appendLog({
      t: at,
      level: "error",
      source: "background",
      message: `run_error:${String(context.phase ?? "unknown")}`,
      detail: JSON.stringify(context),
    });
  } catch (_) {
    /* ignore */
  }
  try {
    await chrome.storage.local.set({
      lastRunError: {
        at,
        phase: String(context.phase ?? ""),
        error: String(context.error ?? ""),
        ...(context.step != null ? { step: String(context.step) } : {}),
        ...(context.tabUrl != null ? { tabUrl: String(context.tabUrl) } : {}),
      },
    });
  } catch (_) {
    /* ignore */
  }
}

/**
 * @param {object[]} results
 */
/**
 * @param {object[]} results
 * @param {string} site
 */
async function saveRunToStorage(results, site) {
  const data = await chrome.storage.local.get(["history"]);
  const history = Array.isArray(data.history) ? data.history : [];
  const at = new Date().toISOString();
  history.unshift({
    id: crypto.randomUUID(),
    site: site || "unknown",
    at,
    items: results,
  });
  await chrome.storage.local.set({
    history: history.slice(0, 50),
    lastRun: {
      site: site || "unknown",
      completedAt: at,
      results,
    },
    lastRunError: null,
  });
  await maybeAnalyzeWithDify(results, site);
}

/**
 * MV3 Service Worker 中 `URL.createObjectURL` 可能不可用，下载用 data: base64。
 * @param {Uint8Array} bytes
 */
function uint8ArrayToBase64DataUrl(bytes, mime) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  const b64 = btoa(binary);
  return `data:${mime};base64,${b64}`;
}

/**
 * @param {string} csvText
 * @param {string} [filenameBase]
 */
async function downloadCsvText(csvText, filenameBase = "Brand_Visibility_Report") {
  let s = String(csvText || "");
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  const text = `\uFEFF${s}`;
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  let url;
  if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
    url = URL.createObjectURL(blob);
  } else {
    const enc = new TextEncoder().encode(text);
    url = uint8ArrayToBase64DataUrl(enc, "text/csv;charset=utf-8");
  }
  try {
    await chrome.downloads.download({
      url,
      filename: `${filenameBase}-${Date.now()}.csv`,
      saveAs: false,
    });
  } finally {
    if (url.startsWith("blob:") && typeof URL !== "undefined" && URL.revokeObjectURL) {
      URL.revokeObjectURL(url);
    }
  }
}

/**
 * 上传规范化后的 JSON 并执行工作流，下载 CSV；写入 lastDifyRun。
 * @param {Record<string, unknown>} cfg storage：difyBaseUrl, difyApiKey, difyApiUser
 * @param {object} payloadObject 含 results，供工作流解析
 * @param {string} targetBrands
 * @param {string} uploadBaseName 上传文件名前缀
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function runDifyWorkflowWithPayload(cfg, payloadObject, targetBrands, uploadBaseName) {
  const apiBase = normalizeDifyApiBase(cfg.difyBaseUrl || "");
  const apiKey = String(cfg.difyApiKey || "").trim();
  const userId =
    String(cfg.difyApiUser || "ai-autochat-extension").trim() || "ai-autochat-extension";
  const brands = String(targetBrands || "").trim();

  if (!apiBase || !apiKey || !brands) {
    const err = "Dify 配置不完整：请填写 API 根地址、API Key 与目标品牌";
    await trace("warn", "background", "Dify", err);
    await chrome.storage.local.set({
      lastDifyRun: {
        ok: false,
        at: new Date().toISOString(),
        error: err,
      },
    });
    return { ok: false, error: err };
  }

  try {
    const jsonStr = JSON.stringify(payloadObject, null, 2);
    const blob = new Blob([jsonStr], { type: "application/json" });
    const fname = `${uploadBaseName}-${Date.now()}.json`;

    await trace("info", "background", "Dify：上传 JSON 并执行工作流", {
      apiBase,
      userId,
      filename: fname,
    });

    const fileId = await difyUploadFile(apiBase, apiKey, userId, blob, fname);
    let csv;
    try {
      csv = await difyRunWorkflowBlocking(
        apiBase,
        apiKey,
        userId,
        fileId,
        brands,
        "document"
      );
    } catch (firstErr) {
      await trace("warn", "background", "Dify：以 document 执行失败，改用 custom 重试", String(firstErr));
      csv = await difyRunWorkflowBlocking(
        apiBase,
        apiKey,
        userId,
        fileId,
        brands,
        "custom"
      );
    }

    await downloadCsvText(csv, "Brand_Visibility_Report");
    await chrome.storage.local.set({
      lastDifyRun: {
        ok: true,
        at: new Date().toISOString(),
        message: "已从 Dify 工作流下载 Brand_Visibility_Report CSV",
      },
    });
    await trace("info", "background", "Dify：工作流完成并已下载 CSV", {});
    return { ok: true };
  } catch (e) {
    const msg = String(e?.message || e);
    await trace("error", "background", "Dify 工作流失败", msg);
    await chrome.storage.local.set({
      lastDifyRun: {
        ok: false,
        at: new Date().toISOString(),
        error: msg,
      },
    });
    return { ok: false, error: msg };
  }
}

/** 防止并发执行「JSON → Dify」任务 */
let difyJsonJobBusy = false;

/**
 * 在后台完整执行 JSON→Dify→CSV（阻塞模式，无 SSE / 节点追踪）。
 * @param {{ jsonText?: string, targetBrands?: string }} msg
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
async function runDifyJsonJob(msg) {
  const jsonText = typeof msg.jsonText === "string" ? msg.jsonText : "";
  const targetBrands = typeof msg.targetBrands === "string" ? msg.targetBrands : "";

  if (difyJsonJobBusy) {
    return { ok: false, error: "已有 Dify 任务在执行，请稍候" };
  }
  difyJsonJobBusy = true;

  try {
    await chrome.storage.local.set({ difyWorkflowRunInProgress: true });

    const cfg = await chrome.storage.local.get([
      "difyBaseUrl",
      "difyApiKey",
      "difyApiUser",
      "difyTargetBrands",
    ]);
    const apiBase = normalizeDifyApiBase(cfg.difyBaseUrl || "");
    const apiKey = String(cfg.difyApiKey || "").trim();
    const userId =
      String(cfg.difyApiUser || "ai-autochat-extension").trim() || "ai-autochat-extension";
    const brands = String(targetBrands || cfg.difyTargetBrands || "").trim();

    if (!apiBase || !apiKey || !brands) {
      const err =
        "Dify 配置不完整：请在「设置」中填写 API 根地址、API Key，在「运行」中填写 target_brands";
      await chrome.storage.local.set({
        lastDifyRun: { ok: false, at: new Date().toISOString(), error: err },
      });
      return { ok: false, error: err };
    }

    let payload;
    try {
      payload = normalizeWorkflowImportJson(JSON.parse(jsonText));
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      await trace("error", "background", "Dify JSON 解析", err);
      await chrome.storage.local.set({
        lastDifyRun: { ok: false, at: new Date().toISOString(), error: err },
      });
      return { ok: false, error: err };
    }

    const jsonStr = JSON.stringify(payload, null, 2);
    const blob = new Blob([jsonStr], { type: "application/json" });
    const fname = `ai-autochat-import-${Date.now()}.json`;

    await trace("info", "background", "Dify：上传并阻塞执行工作流", {
      apiBase,
      userId,
      filename: fname,
    });

    const fileId = await difyUploadFile(apiBase, apiKey, userId, blob, fname);

    const csv = await difyRunWorkflowBlockingWithTypeRetry(
      apiBase,
      apiKey,
      userId,
      fileId,
      brands
    );

    await downloadCsvText(csv, "Brand_Visibility_Report");
    await chrome.storage.local.set({
      lastDifyRun: {
        ok: true,
        at: new Date().toISOString(),
        message: "已从 Dify 工作流下载 Brand_Visibility_Report CSV",
      },
    });
    await trace("info", "background", "Dify：工作流完成并已下载 CSV", {});
    return { ok: true };
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    await trace("error", "background", "Dify 工作流失败", errMsg);
    await chrome.storage.local.set({
      lastDifyRun: {
        ok: false,
        at: new Date().toISOString(),
        error: errMsg,
      },
    });
    return { ok: false, error: errMsg };
  } finally {
    difyJsonJobBusy = false;
    try {
      await chrome.storage.local.set({ difyWorkflowRunInProgress: false });
    } catch {
      /* ignore */
    }
  }
}

async function maybeAnalyzeWithDify(results, site) {
  let cfg;
  try {
    cfg = await chrome.storage.local.get([
      "difyWorkflowEnabled",
      "difyBaseUrl",
      "difyApiKey",
      "difyApiUser",
      "difyTargetBrands",
    ]);
  } catch {
    return;
  }

  if (!cfg.difyWorkflowEnabled) {
    try {
      await chrome.storage.local.remove("lastDifyRun");
    } catch {
      /* ignore */
    }
    return;
  }

  const targetBrands = String(cfg.difyTargetBrands || "").trim();
  const payload = buildWorkflowExportJson(results, site);
  try {
    await chrome.storage.local.set({ difyWorkflowRunInProgress: true });
    await runDifyWorkflowWithPayload(
      cfg,
      payload,
      targetBrands,
      `ai-autochat-${site || "run"}`
    );
  } finally {
    try {
      await chrome.storage.local.set({ difyWorkflowRunInProgress: false });
    } catch {
      /* ignore */
    }
  }
}

/**
 * @param {{ site?: string, results?: object[] }} lastRun
 * @returns {Uint8Array}
 */
function buildXlsxBuffer(lastRun) {
  const site = String(lastRun?.site || "unknown");
  const rows = Array.isArray(lastRun?.results) ? lastRun.results : [];
  /** @type {(string | number)[][]} */
  const aoa = [
    ["站点", "问题", "回答", "引用链接", "页面 URL", "采集时间"],
  ];
  for (const r of rows) {
    const citations = Array.isArray(r?.citations) ? r.citations.join("\n") : "";
    aoa.push([
      String(r?.site ?? site),
      String(r?.question ?? ""),
      String(r?.answer ?? ""),
      citations,
      String(r?.pageUrl ?? ""),
      String(r?.capturedAt ?? ""),
    ]);
  }
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  XLSX.utils.book_append_sheet(wb, ws, "results");
  const out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  return new Uint8Array(out);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "DEBUG_LOG") {
    appendLog({
      t: new Date().toISOString(),
      level: msg.level || "info",
      source: msg.source || "unknown",
      message: msg.message || "",
      ...(msg.detail != null ? { detail: String(msg.detail) } : {}),
    })
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (msg?.type === "GET_DEBUG_LOG") {
    getLogs()
      .then((lines) => sendResponse({ ok: true, lines }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (msg?.type === "CLEAR_DEBUG_LOG") {
    clearLogs()
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (msg?.type === "START_DIFY_JSON") {
    const jsonText = typeof msg.jsonText === "string" ? msg.jsonText : "";
    const targetBrands = typeof msg.targetBrands === "string" ? msg.targetBrands : "";
    runDifyJsonJob({ jsonText, targetBrands })
      .then((result) => {
        try {
          sendResponse(result);
        } catch {
          /* 弹窗已关闭等 */
        }
      })
      .catch((e) => {
        void trace("error", "background", "runDifyJsonJob 未捕获", String(e));
        try {
          sendResponse({
            ok: false,
            error: String(e instanceof Error ? e.message : e),
          });
        } catch {
          /* ignore */
        }
      });
    return true;
  }

  if (msg?.type === "EXPORT_LAST_RUN") {
    const format = msg.format === "xlsx" ? "xlsx" : "json";
    chrome.storage.local
      .get(["lastRun"])
      .then(async (data) => {
        const last = data.lastRun;
        if (!last || !Array.isArray(last.results) || last.results.length === 0) {
          sendResponse({ ok: false, error: "没有可下载的运行结果" });
          return;
        }
        const site = String(last.site || "unknown");
        const stamp = Date.now();
        if (format === "json") {
          const text = JSON.stringify(
            {
              exportedAt: new Date().toISOString(),
              site,
              completedAt: last.completedAt || "",
              results: last.results,
            },
            null,
            2
          );
          const dataUrl = `data:application/json;charset=utf-8,${encodeURIComponent(text)}`;
          await chrome.downloads.download({
            url: dataUrl,
            filename: `ai-autochat-${site}-${stamp}.json`,
            saveAs: false,
          });
        } else {
          const buf = buildXlsxBuffer(last);
          const mime =
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
          let url;
          if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
            const blob = new Blob([buf], { type: mime });
            url = URL.createObjectURL(blob);
          } else {
            url = uint8ArrayToBase64DataUrl(buf, mime);
          }
          try {
            await chrome.downloads.download({
              url,
              filename: `ai-autochat-${site}-${stamp}.xlsx`,
              saveAs: false,
            });
          } finally {
            if (url.startsWith("blob:") && typeof URL !== "undefined" && URL.revokeObjectURL) {
              URL.revokeObjectURL(url);
            }
          }
        }
        sendResponse({ ok: true });
      })
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (msg?.type === "EXPORT_DEBUG_LOG") {
    getLogs()
      .then(async (lines) => {
        const text = JSON.stringify(
          { exportedAt: new Date().toISOString(), lines },
          null,
          2
        );
        const dataUrl = `data:application/json;charset=utf-8,${encodeURIComponent(text)}`;
        await chrome.downloads.download({
          url: dataUrl,
          filename: `ai-autochat-debug-${Date.now()}.json`,
          saveAs: false,
        });
        sendResponse({ ok: true });
      })
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (msg?.type === "RUN_GEMINI") {
    const questions = Array.isArray(msg.questions) ? msg.questions : [];
    runGeminiQueue(questions)
      .then(sendResponse)
      .catch(async (err) => {
        await trace("error", "background", "runGeminiQueue 异常", String(err));
        await recordRunError({
          phase: "runGeminiQueue_uncaught",
          error: String(err?.message || err),
        });
        sendResponse({ ok: false, error: String(err?.message || err) });
      });
    return true;
  }

  if (msg?.type === "RUN_CHATGPT") {
    const questions = Array.isArray(msg.questions) ? msg.questions : [];
    runChatGPTQueue(questions)
      .then(sendResponse)
      .catch(async (err) => {
        await trace("error", "background", "runChatGPTQueue 异常", String(err));
        await recordRunError({
          phase: "runChatGPTQueue_uncaught",
          error: String(err?.message || err),
        });
        sendResponse({ ok: false, error: String(err?.message || err) });
      });
    return true;
  }

  if (msg?.type === "RUN_PERPLEXITY") {
    const questions = Array.isArray(msg.questions) ? msg.questions : [];
    runPerplexityQueue(questions)
      .then(sendResponse)
      .catch(async (err) => {
        await trace("error", "background", "runPerplexityQueue 异常", String(err));
        await recordRunError({
          phase: "runPerplexityQueue_uncaught",
          error: String(err?.message || err),
        });
        sendResponse({ ok: false, error: String(err?.message || err) });
      });
    return true;
  }

  if (msg?.type === "RUN_GOOGLE_AIO") {
    const questions = Array.isArray(msg.questions) ? msg.questions : [];
    runGoogleSearchQueue(questions, "aio")
      .then(sendResponse)
      .catch(async (err) => {
        await trace("error", "background", "runGoogleSearchQueue aio 异常", String(err));
        await recordRunError({
          phase: "runGoogleSearchQueue_aio_uncaught",
          error: String(err?.message || err),
        });
        sendResponse({ ok: false, error: String(err?.message || err) });
      });
    return true;
  }

  if (msg?.type === "RUN_GOOGLE_AIMODE") {
    const questions = Array.isArray(msg.questions) ? msg.questions : [];
    runGoogleSearchQueue(questions, "aimode")
      .then(sendResponse)
      .catch(async (err) => {
        await trace("error", "background", "runGoogleSearchQueue aimode 异常", String(err));
        await recordRunError({
          phase: "runGoogleSearchQueue_aimode_uncaught",
          error: String(err?.message || err),
        });
        sendResponse({ ok: false, error: String(err?.message || err) });
      });
    return true;
  }

  return false;
});
