import { appendLog, clearLogs, getLogs } from "../lib/logger.js";
import {
  buildWorkflowExportJson,
  normalizeDifyApiBase,
  normalizeWorkflowImportJson,
  runDifyWorkflowBatched,
} from "../lib/dify-workflow.js";
import {
  BRAND_REPORT_CSV_HEADERS,
  buildStubBrandReportCsv,
  formatCitationsCell,
  isoToUsDate,
  parseBrandReportCsvToResults,
} from "../lib/brand-report-csv.js";
import * as XLSX from "../vendor/xlsx.mjs";
import { DIFY_DEFAULTS, migrateBundledDifyApiKey } from "../lib/dify-settings.js";

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
const DOM_UTILS_FILE = "content/dom-utils.js";
const PAGE_KEEPALIVE_FILE = "content/page-keepalive.js";

/** @type {number | null} */
let collectionTabId = null;

/** @param {string} csFile */
function injectContentScriptFiles(csFile) {
  if (csFile === GOOGLE_SEARCH_CS_FILE) return [GOOGLE_SEARCH_CS_FILE];
  return [DOM_UTILS_FILE, csFile];
}

/**
 * 写入 storage，关闭 popup 后重开仍可恢复进度文案。
 * @param {Record<string, unknown>} partial
 */
async function updateRunProgress(partial) {
  try {
    const data = await chrome.storage.local.get("runProgress");
    const prev =
      data.runProgress && typeof data.runProgress === "object" ? data.runProgress : {};
    await chrome.storage.local.set({
      runProgress: {
        ...prev,
        ...partial,
        updatedAt: new Date().toISOString(),
      },
    });
  } catch (_) {
    /* ignore */
  }
}

/** @type {boolean} */
let collectionAbortRequested = false;
/** @type {boolean} */
let difyAbortRequested = false;
/** @type {boolean} */
let collectionInProgress = false;
/** 防止并发执行 Dify 任务 */
let difyJsonJobBusy = false;
/** 多平台连续任务中（内层队列不单独 begin/end） */
let multiRunActive = false;

const MULTI_PLATFORM_STEPS = [
  { id: "gemini", label: "Gemini", run: (q) => runGeminiQueue(q) },
  { id: "chatgpt", label: "ChatGPT", run: (q) => runChatGPTQueue(q) },
  { id: "perplexity", label: "Perplexity", run: (q) => runPerplexityQueue(q) },
];

function beginCollectionJobIfNeeded() {
  if (!multiRunActive) beginCollectionJob();
}

function endCollectionJobIfNeeded() {
  if (!multiRunActive) endCollectionJob();
}

function beginCollectionJob() {
  collectionAbortRequested = false;
  difyAbortRequested = false;
  collectionInProgress = true;
}

function endCollectionJob() {
  collectionInProgress = false;
  collectionAbortRequested = false;
  void releaseCollectionTab();
}

/**
 * MAIN world 注入 page-keepalive，避免后台标签被 ChatGPT/Gemini 暂停。
 * @param {number} tabId
 */
async function injectPageKeepalive(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: [PAGE_KEEPALIVE_FILE],
      world: "MAIN",
    });
  } catch (e) {
    await trace("warn", "background", "injectPageKeepalive 失败", String(e));
  }
}

/**
 * 采集期间禁止 Chrome 丢弃标签，并注入后台保活脚本。
 * @param {number} tabId
 */
async function keepCollectionTabAlive(tabId) {
  collectionTabId = tabId;
  try {
    await chrome.tabs.update(tabId, { autoDiscardable: false });
  } catch (_) {
    /* ignore */
  }
  await injectPageKeepalive(tabId);
}

/** 采集结束，恢复标签可被自动丢弃 */
async function releaseCollectionTab(tabId) {
  const id = tabId ?? collectionTabId;
  collectionTabId = null;
  if (id == null) return;
  try {
    await chrome.tabs.update(id, { autoDiscardable: true });
  } catch (_) {
    /* ignore */
  }
}

/**
 * @param {object[]} results
 * @param {string} site
 * @param {string} label
 * @param {number} total
 */
async function handleCollectionCancelled(results, site, label, total) {
  const n = results.length;
  if (n > 0) {
    const at = new Date().toISOString();
    await chrome.storage.local.set({
      lastRun: { site, completedAt: at, results, cancelled: true, inProgress: false },
      lastRunError: null,
    });
    await downloadStubCsvIfPossible(buildWorkflowExportJson(results, site));
  }
  const message =
    n > 0
      ? `已停止 · ${label} · 已下载 ${n}/${total} 条 CSV`
      : `已停止 · ${label} · 尚无已采集数据`;
  await updateRunProgress({ status: "done", current: n, total, message });
  await trace("info", "background", "采集已用户停止", { site, n, total });
  return { ok: true, cancelled: true, results };
}

/**
 * @param {object[]} results
 * @param {string} site
 * @param {string} label
 * @param {number} total
 */
async function abortCollectionIfRequested(results, site, label, total) {
  if (!collectionAbortRequested) return null;
  return handleCollectionCancelled(results, site, label, total);
}

/** 采集超时等可刷新页面重试的错误 */
function isRetryableCollectionError(error) {
  const err = String(error || "");
  return (
    err.includes("等待条件超时") ||
    err.includes("等待元素超时") ||
    isTransientSendError({ error: err })
  );
}

/**
 * 刷新标签页并重新注入内容脚本。
 * @param {number} tabId
 * @param {string} csFile
 * @param {{ settleMs?: number, injectAllFrames?: boolean }} [opts]
 */
async function reloadTabAndReinject(tabId, csFile, opts = {}) {
  await chrome.tabs.reload(tabId);
  await waitTabSettled(tabId, opts.settleMs ?? 1400);
  await injectPageKeepalive(tabId);
  try {
    await chrome.scripting.executeScript({
      target: { tabId, ...(opts.injectAllFrames !== false ? { allFrames: true } : {}) },
      files: injectContentScriptFiles(csFile),
    });
    await sleep(350);
  } catch (e) {
    await trace("warn", "background", "刷新后注入内容脚本失败", String(e));
  }
}

/**
 * 发送单题消息；失败且可重试时刷新页面，最多 maxAttempts 次。
 * @param {number} tabId
 * @param {object} message
 * @param {string} csFile
 * @param {{ maxAttempts?: number, injectAllFrames?: boolean, mainFrameOnly?: boolean, onBeforeRetry?: (tabId: number, attempt: number) => Promise<void> }} [opts]
 */
async function sendQuestionWithPageRetry(tabId, message, csFile, opts = {}) {
  const maxAttempts = opts.maxAttempts ?? 3;
  let lastRes = /** @type {{ ok?: boolean, error?: string }} */ ({
    ok: false,
    error: "内容脚本无响应",
  });

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      await trace("warn", "background", `刷新页面重试 ${attempt}/${maxAttempts}`, {
        error: lastRes?.error,
      });
      if (typeof opts.onRetryProgress === "function") {
        await opts.onRetryProgress(attempt, maxAttempts, lastRes?.error);
      }
      if (typeof opts.onBeforeRetry === "function") {
        await opts.onBeforeRetry(tabId, attempt);
      } else {
        await reloadTabAndReinject(tabId, csFile, opts);
      }
    }

    lastRes = await sendToTabWithRetry(tabId, message, csFile, opts);
    if (lastRes?.ok) return lastRes;
    if (!isRetryableCollectionError(lastRes?.error) || attempt >= maxAttempts) break;
  }
  return lastRes;
}

/**
 * 单题失败：保存已完成进度、自动下载占位 CSV，并返回含进度的错误信息。
 * @param {object} ctx
 */
async function handlePartialCollectionFailure(ctx) {
  const {
    results,
    site,
    label,
    total,
    failedIndex,
    question,
    error,
    tabId,
    tabUrl,
    phase,
  } = ctx;

  const completed = results.length;
  const failedNum = failedIndex + 1;
  const errText = String(error || "未知错误");
  const qRaw = String(question || "").trim();
  const qShort = qRaw.length > 55 ? `${qRaw.slice(0, 55)}…` : qRaw;

  await trace("error", "background", `${label} 第 ${failedNum}/${total} 题失败`, {
    error: errText,
    completed,
  });
  await recordRunError({
    phase: phase || "RUN_QUESTION",
    step: `${failedNum}/${total}`,
    tabId,
    tabUrl,
    error: errText,
    completed,
    question: qRaw.slice(0, 200),
  });

  let downloadNote = "";
  if (completed > 0) {
    const at = new Date().toISOString();
    await chrome.storage.local.set({
      lastRun: {
        site,
        completedAt: at,
        results,
        partial: true,
        inProgress: false,
        failedAt: failedNum,
        failedQuestion: qRaw,
      },
      lastRunError: {
        at,
        phase: String(phase || ""),
        step: `${failedNum}/${total}`,
        error: errText,
        completed,
      },
    });
    await downloadStubCsvIfPossible(buildWorkflowExportJson(results, site));
    downloadNote = ` · 已自动下载 ${completed}/${total} 条进度 CSV`;
  } else {
    downloadNote = " · 尚无已完成题目";
  }

  const message = `${label} · 第 ${failedNum}/${total} 题失败（${errText}）${qShort ? `「${qShort}」` : ""} · 已完成 ${completed} 题${downloadNote}`;

  await updateRunProgress({
    status: "error",
    current: failedNum,
    total,
    message,
  });

  return {
    ok: false,
    error: message,
    results,
    partial: true,
    completed,
    failedAt: failedNum,
  };
}

/**
 * 采集开始：标记 inProgress，便于扩展重载后识别中断任务。
 * @param {string} site
 * @param {number} total
 */
async function markCollectionStarted(site, total) {
  const at = new Date().toISOString();
  await chrome.storage.local.set({
    lastRun: {
      site,
      completedAt: at,
      results: [],
      inProgress: true,
      partial: true,
      current: 0,
      total,
    },
  });
}

/**
 * 每完成一题写入 storage，扩展重载时不丢已完成进度。
 * @param {object[]} results
 * @param {string} site
 * @param {{ current?: number, total?: number }} [meta]
 */
async function persistPartialRun(results, site, meta = {}) {
  if (!Array.isArray(results) || results.length === 0) return;
  const at = new Date().toISOString();
  await chrome.storage.local.set({
    lastRun: {
      site: site || "unknown",
      completedAt: at,
      results,
      partial: true,
      inProgress: true,
      current: meta.current ?? results.length,
      total: meta.total ?? results.length,
    },
  });
}

/**
 * @param {string} [message]
 */
async function finalizeJobStop(message) {
  collectionAbortRequested = false;
  difyAbortRequested = false;
  collectionInProgress = false;
  difyJsonJobBusy = false;
  try {
    await chrome.storage.local.set({ difyWorkflowRunInProgress: false });
  } catch {
    /* ignore */
  }
  if (message) {
    await updateRunProgress({ status: "done", message });
  }
}

/** Service Worker 冷启动后 storage 里的 running 已不可信，需清理 */
async function reconcileStaleJobStateOnStartup() {
  try {
    const data = await chrome.storage.local.get([
      "runProgress",
      "difyWorkflowRunInProgress",
      "lastRun",
      "lastDifyRun",
    ]);
    const stale =
      data.runProgress?.status === "running" || Boolean(data.difyWorkflowRunInProgress);
    if (!stale) return;

    const lastRun = data.lastRun;
    const lastDify = data.lastDifyRun;
    const runProgress = data.runProgress;
    const hasResults = Array.isArray(lastRun?.results) && lastRun.results.length > 0;
    const n = hasResults ? lastRun.results.length : 0;
    const total = lastRun?.total ?? runProgress?.total ?? n;
    const interruptedCollection =
      Boolean(lastRun?.inProgress) || runProgress?.status === "running";

    const runAt = String(lastRun?.completedAt || "");
    const difyAt = String(lastDify?.at || "");
    const needsDifyStub =
      hasResults &&
      !lastRun?.inProgress &&
      (!lastDify?.ok || (runAt && (!difyAt || difyAt < runAt)));

    const needsProgressCsv = interruptedCollection && hasResults;

    if (needsProgressCsv || needsDifyStub) {
      await downloadStubCsvIfPossible(
        buildWorkflowExportJson(lastRun.results, String(lastRun.site || "unknown"))
      );
      await trace("info", "background", "中断恢复：已下载采集占位 CSV", {
        rows: n,
        interruptedCollection,
        needsDifyStub,
      });
    }

    let message;
    if (needsProgressCsv) {
      message = `上次采集中断（扩展已重载）· 已完成 ${n}/${total} 题 · 已下载进度 CSV`;
    } else if (needsDifyStub) {
      message = "上次 Dify 未完成 · 已下载采集占位 CSV，可上传补跑";
    } else {
      message = "上次任务已中断（扩展已重载），可重新开始";
    }

    await finalizeJobStop(message);
    await trace("warn", "background", "已清理陈旧 running 状态");
  } catch {
    /* ignore */
  }
}

/**
 * @returns {Promise<{ ok: boolean, isActive: boolean, collectionInProgress: boolean, difyBusy: boolean, runProgress?: object }>}
 */
async function getJobState() {
  const data = await chrome.storage.local.get(["runProgress", "difyWorkflowRunInProgress"]);
  const storageRunning =
    data.runProgress?.status === "running" || Boolean(data.difyWorkflowRunInProgress);
  const isActive = collectionInProgress || difyJsonJobBusy || storageRunning;
  return {
    ok: true,
    isActive,
    collectionInProgress,
    difyBusy: difyJsonJobBusy,
    difyWorkflowRunInProgress: Boolean(data.difyWorkflowRunInProgress),
    runProgress: data.runProgress || null,
  };
}

/**
 * @returns {Promise<{ ok: boolean, message?: string, error?: string }>}
 */
async function stopCurrentJob() {
  if (collectionInProgress) {
    collectionAbortRequested = true;
    return { ok: true, message: "正在停止采集…" };
  }

  const data = await chrome.storage.local.get(["difyWorkflowRunInProgress", "runProgress", "lastRun"]);
  if (difyJsonJobBusy || data.difyWorkflowRunInProgress) {
    difyAbortRequested = true;
    return { ok: true, message: "正在停止 Dify…" };
  }

  if (data.runProgress?.status === "running") {
    if (Array.isArray(data.lastRun?.results) && data.lastRun.results.length > 0) {
      await downloadStubCsvIfPossible(
        buildWorkflowExportJson(
          data.lastRun.results,
          String(data.lastRun.site || "unknown")
        )
      );
    }
    await finalizeJobStop("已停止（已清理陈旧任务状态）");
    return { ok: true, message: "已清理陈旧任务状态" };
  }

  return { ok: false, error: "当前没有进行中的任务" };
}

function initSidePanel() {
  if (!chrome.sidePanel?.setPanelBehavior) return;
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

initSidePanel();
chrome.runtime.onInstalled.addListener(() => {
  void initSidePanel();
  void migrateBundledDifyApiKey();
});
void migrateBundledDifyApiKey();
void reconcileStaleJobStateOnStartup();

/**
 * Dify 失败时下载与成功时同表头的占位 CSV（LLM 列为空）。
 * @param {object} payloadObject
 */
async function downloadStubCsvIfPossible(payloadObject) {
  const results = Array.isArray(payloadObject?.results) ? payloadObject.results : [];
  if (results.length === 0) return;
  try {
    const site =
      typeof payloadObject.site === "string" && payloadObject.site
        ? payloadObject.site
        : "unknown";
    const stub = buildStubBrandReportCsv(results, site);
    await downloadCsvText(stub, "Brand_Visibility_Report");
    await trace("info", "background", "已下载占位 CSV（Dify 未成功，LLM 列为空）", {
      rows: results.length,
    });
  } catch (e) {
    await trace("warn", "background", "占位 CSV 下载失败", String(e));
  }
}

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
 * @param {number} tabId
 * @param {string} url
 */
async function prepareGoogleSearchTab(tabId, url) {
  await chrome.tabs.update(tabId, { url });
  await waitTabComplete(tabId);
  await waitUntilTabUrlMatches(tabId, (u) => {
    const s = u || "";
    return /\.google\./.test(s) && /\/search\?/.test(s);
  });
  await sleep(4500);
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [GOOGLE_SEARCH_CS_FILE],
    });
    await sleep(750);
  } catch (e) {
    await trace("warn", "background", "Google executeScript", String(e));
  }
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
  await injectPageKeepalive(tabId);
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: injectContentScriptFiles(PERPLEXITY_CS_FILE),
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

  await updateRunProgress({
    status: "running",
    site: "gemini",
    label: "Gemini",
    current: 0,
    total: filtered.length,
    message: "正在准备 Gemini 标签页…",
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
  await waitTabSettled(tab.id, 600);
  await keepCollectionTabAlive(tab.id);

  await updateRunProgress({
    message: `Gemini · 开始采集，共 ${filtered.length} 题…`,
  });

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: injectContentScriptFiles(GEMINI_CS_FILE),
    });
    await trace("info", "background", "预注入内容脚本 all_frames（避免 Receiving end）", {
      tabId: tab.id,
    });
    await sleep(250);
  } catch (e) {
    await trace("warn", "background", "预注入跳过或失败（可能已由 manifest 注入）", String(e));
  }

  const results = [];
  beginCollectionJobIfNeeded();
  try {
  await markCollectionStarted("gemini", filtered.length);
  for (let i = 0; i < filtered.length; i++) {
    const early = await abortCollectionIfRequested(results, "gemini", "Gemini", filtered.length);
    if (early) return early;

    const question = filtered[i];
    await updateRunProgress({
      current: i + 1,
      total: filtered.length,
      message: `Gemini · 第 ${i + 1}/${filtered.length} 题…`,
    });
    await trace("info", "background", `发送第 ${i + 1}/${filtered.length} 题`, {
      len: question.length,
    });

    const res = await sendQuestionWithPageRetry(
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
      GEMINI_CS_FILE,
      {
        onRetryProgress: async (attempt, max) => {
          await updateRunProgress({
            message: `Gemini · 第 ${i + 1}/${filtered.length} 题超时，刷新重试 (${attempt}/${max})…`,
          });
        },
      }
    );

    if (!res?.ok) {
      return handlePartialCollectionFailure({
        results,
        site: "gemini",
        label: "Gemini",
        total: filtered.length,
        failedIndex: i,
        question,
        error: res?.error || "内容脚本无响应",
        tabId: tab.id,
        tabUrl: tab.url || "",
        phase: "GEMINI_RUN_QUESTION",
      });
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
    await persistPartialRun(results, "gemini", { current: i + 1, total: filtered.length });

    const after = await abortCollectionIfRequested(results, "gemini", "Gemini", filtered.length);
    if (after) return after;
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

  const difyScheduled = await finishCollectionPhase(
    results,
    "gemini",
    "Gemini",
    filtered.length
  );
  await trace("info", "background", "runGeminiQueue 全部成功", { n: results.length, difyScheduled });
  return { ok: true, results, difyScheduled };
  } finally {
    endCollectionJobIfNeeded();
  }
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

  await updateRunProgress({
    status: "running",
    site: "chatgpt",
    label: "ChatGPT",
    current: 0,
    total: filtered.length,
    message: "正在准备 ChatGPT 标签页…",
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
  await waitTabSettled(tab.id, 700);
  await keepCollectionTabAlive(tab.id);

  await updateRunProgress({
    message: `ChatGPT · 开始采集，共 ${filtered.length} 题…`,
  });

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: injectContentScriptFiles(CHATGPT_CS_FILE),
    });
    await trace("info", "background", "预注入 ChatGPT 内容脚本 all_frames", { tabId: tab.id });
    await sleep(250);
  } catch (e) {
    await trace("warn", "background", "ChatGPT 预注入跳过或失败", String(e));
  }

  const results = [];
  beginCollectionJobIfNeeded();
  try {
  await markCollectionStarted("chatgpt", filtered.length);
  for (let i = 0; i < filtered.length; i++) {
    const early = await abortCollectionIfRequested(results, "chatgpt", "ChatGPT", filtered.length);
    if (early) return early;

    const question = filtered[i];
    await updateRunProgress({
      current: i + 1,
      total: filtered.length,
      message: `ChatGPT · 第 ${i + 1}/${filtered.length} 题…`,
    });
    await trace("info", "background", `ChatGPT 发送第 ${i + 1}/${filtered.length} 题`, {
      len: question.length,
    });

    const res = await sendQuestionWithPageRetry(
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
      CHATGPT_CS_FILE,
      {
        onRetryProgress: async (attempt, max) => {
          await updateRunProgress({
            message: `ChatGPT · 第 ${i + 1}/${filtered.length} 题超时，刷新重试 (${attempt}/${max})…`,
          });
        },
      }
    );

    if (!res?.ok) {
      return handlePartialCollectionFailure({
        results,
        site: "chatgpt",
        label: "ChatGPT",
        total: filtered.length,
        failedIndex: i,
        question,
        error: res?.error || "内容脚本无响应",
        tabId: tab.id,
        tabUrl: tab.url || "",
        phase: "CHATGPT_RUN_QUESTION",
      });
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
    await persistPartialRun(results, "chatgpt", { current: i + 1, total: filtered.length });

    const after = await abortCollectionIfRequested(results, "chatgpt", "ChatGPT", filtered.length);
    if (after) return after;
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

  const difyScheduled = await finishCollectionPhase(
    results,
    "chatgpt",
    "ChatGPT",
    filtered.length
  );
  await trace("info", "background", "runChatGPTQueue 全部成功", { n: results.length, difyScheduled });
  return { ok: true, results, difyScheduled };
  } finally {
    endCollectionJobIfNeeded();
  }
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

  await updateRunProgress({
    status: "running",
    site: "perplexity",
    label: "Perplexity",
    current: 0,
    total: filtered.length,
    message: "正在准备 Perplexity 标签页…",
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
  await waitTabSettled(tab.id, 400);
  await keepCollectionTabAlive(tab.id);

  await updateRunProgress({
    message: `Perplexity · 开始采集，共 ${filtered.length} 题…`,
  });

  const results = [];
  beginCollectionJobIfNeeded();
  try {
  await markCollectionStarted("perplexity", filtered.length);
  for (let i = 0; i < filtered.length; i++) {
    const early = await abortCollectionIfRequested(
      results,
      "perplexity",
      "Perplexity",
      filtered.length
    );
    if (early) return early;

    const question = filtered[i];
    await updateRunProgress({
      current: i + 1,
      total: filtered.length,
      message: `Perplexity · 第 ${i + 1}/${filtered.length} 题…`,
    });
    await trace("info", "background", `Perplexity 发送第 ${i + 1}/${filtered.length} 题`, {
      len: question.length,
    });

    await navigatePerplexityHomeAndInject(tab.id);

    const res = await sendQuestionWithPageRetry(
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
      PERPLEXITY_CS_FILE,
      {
        onRetryProgress: async (attempt, max) => {
          await updateRunProgress({
            message: `Perplexity · 第 ${i + 1}/${filtered.length} 题超时，刷新重试 (${attempt}/${max})…`,
          });
        },
      }
    );

    if (!res?.ok) {
      return handlePartialCollectionFailure({
        results,
        site: "perplexity",
        label: "Perplexity",
        total: filtered.length,
        failedIndex: i,
        question,
        error: res?.error || "内容脚本无响应",
        tabId: tab.id,
        tabUrl: tab.url || "",
        phase: "PERPLEXITY_RUN_QUESTION",
      });
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
    await persistPartialRun(results, "perplexity", { current: i + 1, total: filtered.length });

    const after = await abortCollectionIfRequested(
      results,
      "perplexity",
      "Perplexity",
      filtered.length
    );
    if (after) return after;
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

  const difyScheduled = await finishCollectionPhase(
    results,
    "perplexity",
    "Perplexity",
    filtered.length
  );
  await trace("info", "background", "runPerplexityQueue 全部成功", { n: results.length, difyScheduled });
  return { ok: true, results, difyScheduled };
  } finally {
    endCollectionJobIfNeeded();
  }
}

/**
 * @param {number} [maxMs]
 */
async function waitForDifyJobIdle(maxMs = 7200000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (collectionAbortRequested || difyAbortRequested) {
      return { ok: false, cancelled: true };
    }
    if (!difyJsonJobBusy) {
      const data = await chrome.storage.local.get(["difyWorkflowRunInProgress"]);
      if (!data.difyWorkflowRunInProgress) return { ok: true };
    }
    await sleep(800);
  }
  return { ok: false, error: "等待 Dify 超时" };
}

/**
 * 按固定顺序连续运行多个平台：Gemini → ChatGPT → Perplexity。
 * @param {string[]} questions
 * @param {string[]} platformIds
 */
async function runMultiPlatformQueue(questions, platformIds) {
  const idSet = new Set(platformIds.map((p) => String(p).trim()).filter(Boolean));
  const plan = MULTI_PLATFORM_STEPS.filter((step) => idSet.has(step.id));
  if (plan.length === 0) {
    return { ok: false, error: "请至少选择一个平台" };
  }

  multiRunActive = true;
  beginCollectionJob();
  /** @type {object[]} */
  const summary = [];

  try {
    const chainLabel = plan.map((p) => p.label).join(" → ");
    await updateRunProgress({
      status: "running",
      site: "multi",
      label: "多平台",
      current: 0,
      total: plan.length,
      message: `多平台任务 · ${chainLabel}`,
    });
    await trace("info", "background", "runMultiPlatformQueue 开始", {
      platforms: plan.map((p) => p.id),
      count: questions.length,
    });

    for (let i = 0; i < plan.length; i++) {
      const step = plan[i];
      if (collectionAbortRequested) {
        await updateRunProgress({
          status: "done",
          message: `已停止 · 多平台 · 已完成 ${i}/${plan.length} 个平台`,
        });
        return { ok: true, cancelled: true, summary };
      }

      await updateRunProgress({
        current: i + 1,
        total: plan.length,
        message: `多平台 (${i + 1}/${plan.length}) · 正在运行 ${step.label}…`,
      });

      const result = await step.run(questions);
      summary.push({
        platform: step.id,
        label: step.label,
        ok: Boolean(result?.ok),
        n: result?.results?.length ?? 0,
        difyScheduled: Boolean(result?.difyScheduled),
        error: result?.error,
        cancelled: Boolean(result?.cancelled),
      });

      if (result?.cancelled) {
        return { ok: true, cancelled: true, summary };
      }
      if (!result?.ok) {
        const errText = String(result?.error || "未知错误");
        await updateRunProgress({
          status: "error",
          message: `${step.label} 失败：${errText}`,
        });
        return {
          ok: false,
          error: `${step.label} 失败：${errText}`,
          failedPlatform: step.id,
          summary,
        };
      }

      if (result.difyScheduled) {
        await updateRunProgress({
          message: `多平台 (${i + 1}/${plan.length}) · ${step.label} 完成，等待 Dify…`,
        });
        const difyWait = await waitForDifyJobIdle();
        if (difyWait.cancelled) {
          return { ok: true, cancelled: true, summary };
        }
        if (!difyWait.ok) {
          await updateRunProgress({
            status: "error",
            message: `${step.label} 后 Dify 未完成：${difyWait.error || "超时"}`,
          });
          return {
            ok: false,
            error: `${step.label} 后 Dify 未完成：${difyWait.error || "超时"}`,
            summary,
          };
        }
      }
    }

    await updateRunProgress({
      status: "done",
      message: `全部完成 · ${chainLabel}`,
    });
    await trace("info", "background", "runMultiPlatformQueue 全部成功", { summary });
    return { ok: true, summary, platforms: plan.map((p) => p.id) };
  } catch (e) {
    const msg = String(e?.message || e);
    await trace("error", "background", "runMultiPlatformQueue 异常", msg);
    await updateRunProgress({ status: "error", message: msg });
    return { ok: false, error: msg, summary };
  } finally {
    multiRunActive = false;
    endCollectionJob();
  }
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
  await keepCollectionTabAlive(tab.id);

  const googleLabel = mode === "aimode" ? "AI Mode" : "AIO";
  const results = [];
  beginCollectionJobIfNeeded();
  try {
  await markCollectionStarted(site, filtered.length);
  for (let i = 0; i < filtered.length; i++) {
    const early = await abortCollectionIfRequested(results, site, googleLabel, filtered.length);
    if (early) return early;

    const question = filtered[i];
    const url = buildGoogleSearchUrl(question, mode);
    await updateRunProgress({
      current: i + 1,
      total: filtered.length,
      message: `${googleLabel} · 第 ${i + 1}/${filtered.length} 题…`,
    });
    await trace("info", "background", `Google ${mode} 第 ${i + 1}/${filtered.length} 题`, {
      len: question.length,
    });

    await prepareGoogleSearchTab(tab.id, url);

    const res = await sendQuestionWithPageRetry(
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
      {
        mainFrameOnly: true,
        injectAllFrames: false,
        onRetryProgress: async (attempt, max) => {
          await updateRunProgress({
            message: `${googleLabel} · 第 ${i + 1}/${filtered.length} 题超时，刷新重试 (${attempt}/${max})…`,
          });
        },
        onBeforeRetry: async (tabId) => {
          await prepareGoogleSearchTab(tabId, url);
        },
      }
    );

    if (!res?.ok) {
      return handlePartialCollectionFailure({
        results,
        site,
        label: googleLabel,
        total: filtered.length,
        failedIndex: i,
        question,
        error: res?.error || "内容脚本无响应",
        tabId: tab.id,
        tabUrl: tab.url || "",
        phase: "GOOGLE_SEARCH_RUN",
      });
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
    await persistPartialRun(results, site, { current: i + 1, total: filtered.length });

    const after = await abortCollectionIfRequested(results, site, googleLabel, filtered.length);
    if (after) return after;
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

  const difyScheduled = await finishCollectionPhase(
    results,
    site,
    googleLabel,
    filtered.length
  );
  await trace("info", "background", "runGoogleSearchQueue 全部成功", {
    n: results.length,
    mode,
    difyScheduled,
  });
  return { ok: true, results, difyScheduled };
  } finally {
    endCollectionJobIfNeeded();
  }
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
          files: injectContentScriptFiles(csFile),
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
 * 记录失败（写入调试日志 + storage）。
 * 部分采集失败时由 handlePartialCollectionFailure 另行下载进度 CSV。
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
      inProgress: false,
      partial: false,
    },
    lastRunError: null,
  });
  // Dify 可能耗时数分钟，不可阻塞 RUN_* 的 sendResponse（~30s 通道超时）
  void runDifyAnalysisInBackground(results, site);
}

/**
 * 后台执行 Dify / 占位 CSV，与采集队列响应解耦。
 * @param {object[]} results
 * @param {string} site
 */
async function runDifyAnalysisInBackground(results, site) {
  if (difyJsonJobBusy) {
    await trace("warn", "background", "Dify 后台任务跳过：已有任务在执行");
    return;
  }
  difyJsonJobBusy = true;
  try {
    await maybeAnalyzeWithDify(results, site);
  } catch (e) {
    const msg = String(e?.message || e);
    await trace("error", "background", "Dify 后台任务异常", msg);
    await downloadStubCsvIfPossible(buildWorkflowExportJson(results, site));
    await updateRunProgress({
      status: "done",
      message: "Dify 失败 · 已下载占位 CSV",
    });
  } finally {
    difyJsonJobBusy = false;
  }
}

/**
 * 采集结束后、Dify 启动前更新进度，并返回是否已调度 Dify。
 * @param {object[]} results
 * @param {string} site
 * @param {string} label
 * @param {number} total
 */
async function finishCollectionPhase(results, site, label, total) {
  const cfg = await chrome.storage.local.get(["difyWorkflowEnabled"]);
  const difyScheduled = cfg.difyWorkflowEnabled !== false;
  const n = results.length;
  await updateRunProgress({
    status: difyScheduled ? "running" : "done",
    current: n,
    total,
    message: difyScheduled
      ? `完成 · ${label} · ${n} 条 · Dify 处理中…`
      : `完成 · ${label} · ${n} 条`,
  });
  return difyScheduled;
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
  const apiBase = normalizeDifyApiBase(
    String(cfg.difyBaseUrl || "").trim() || DIFY_DEFAULTS.difyBaseUrl
  );
  const apiKey = String(cfg.difyApiKey || "").trim() || DIFY_DEFAULTS.difyApiKey;
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
    await downloadStubCsvIfPossible(payloadObject);
    return { ok: false, error: err };
  }

  try {
    const resultCount = Array.isArray(payloadObject?.results) ? payloadObject.results.length : 0;
    await trace("info", "background", "Dify：上传 JSON 并执行工作流", {
      apiBase,
      userId,
      resultCount,
      batched: resultCount > 29,
    });

    const csv = await runDifyWorkflowBatched(
      apiBase,
      apiKey,
      userId,
      payloadObject,
      brands,
      uploadBaseName,
      { shouldAbort: () => difyAbortRequested }
    );

    const cancelled = difyAbortRequested;
    await downloadCsvText(csv, "Brand_Visibility_Report");
    await trace("info", "background", "Dify：CSV 已触发下载", {});
    const doneMsg = cancelled
      ? "Dify 已停止 · 已下载已完成批次的 CSV"
      : Array.isArray(payloadObject?.results) && payloadObject.results.length > 29
        ? `已从 Dify 工作流下载 CSV（${Math.ceil(payloadObject.results.length / 29)} 批合并）`
        : "已从 Dify 工作流下载 Brand_Visibility_Report CSV";
    await chrome.storage.local.set({
      lastDifyRun: {
        ok: !cancelled,
        at: new Date().toISOString(),
        message: doneMsg,
        ...(cancelled ? { cancelled: true } : {}),
      },
    });
    if (cancelled) {
      await updateRunProgress({ status: "done", message: doneMsg });
      difyAbortRequested = false;
      return { ok: true, cancelled: true };
    }
    await trace("info", "background", "Dify：工作流完成并已下载 CSV", {});
    return { ok: true };
  } catch (e) {
    const aborted = e?.code === "DIFY_ABORTED" || difyAbortRequested;
    if (aborted) {
      await downloadStubCsvIfPossible(payloadObject);
      const msg = "Dify 已停止 · 已下载占位 CSV";
      await chrome.storage.local.set({
        lastDifyRun: { ok: false, at: new Date().toISOString(), error: msg, cancelled: true },
      });
      await updateRunProgress({ status: "done", message: msg });
      difyAbortRequested = false;
      return { ok: true, cancelled: true };
    }
    const msg = String(e?.message || e);
    await trace("error", "background", "Dify 工作流失败", msg);
    await chrome.storage.local.set({
      lastDifyRun: {
        ok: false,
        at: new Date().toISOString(),
        error: msg,
      },
    });
    await downloadStubCsvIfPossible(payloadObject);
    return { ok: false, error: msg };
  }
}

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
  difyAbortRequested = false;

  try {
    await chrome.storage.local.set({ difyWorkflowRunInProgress: true });

    const cfg = await chrome.storage.local.get([
      "difyBaseUrl",
      "difyApiKey",
      "difyApiUser",
      "difyTargetBrands",
    ]);
    const apiBase = normalizeDifyApiBase(
      String(cfg.difyBaseUrl || "").trim() || DIFY_DEFAULTS.difyBaseUrl
    );
    const apiKey = String(cfg.difyApiKey || "").trim() || DIFY_DEFAULTS.difyApiKey;
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

    return await runDifyWorkflowWithPayload(cfg, payload, brands, "ai-autochat-import");
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

/**
 * 上传占位 CSV，解析后补跑 Dify 填 LLM 列。
 * @param {string} csvText
 * @param {string} [targetBrands]
 */
async function runDifyStubCsvJob(csvText, targetBrands) {
  if (difyJsonJobBusy) {
    return { ok: false, error: "已有 Dify 任务在执行，请稍候" };
  }
  difyJsonJobBusy = true;
  difyAbortRequested = false;

  try {
    await chrome.storage.local.set({ difyWorkflowRunInProgress: true });
    await updateRunProgress({ status: "running", message: "正在解析占位 CSV 并补跑 Dify…" });

    const cfg = await chrome.storage.local.get([
      "difyBaseUrl",
      "difyApiKey",
      "difyApiUser",
      "difyTargetBrands",
    ]);
    const brands = String(targetBrands || cfg.difyTargetBrands || "").trim();

    let parsed;
    try {
      parsed = parseBrandReportCsvToResults(csvText);
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      await chrome.storage.local.set({
        lastDifyRun: { ok: false, at: new Date().toISOString(), error: err },
      });
      return { ok: false, error: err };
    }

    const payload = buildWorkflowExportJson(parsed.results, parsed.site);
    payload.source = "ai-autochat-stub-csv-import";

    return await runDifyWorkflowWithPayload(
      cfg,
      payload,
      brands,
      `ai-autochat-${parsed.site}-stub-retry`
    );
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
    const payload = buildWorkflowExportJson(results, site);
    await downloadStubCsvIfPossible(payload);
    try {
      await chrome.storage.local.remove("lastDifyRun");
    } catch {
      /* ignore */
    }
    return;
  }

  const targetBrands = String(cfg.difyTargetBrands || "").trim();
  const payload = buildWorkflowExportJson(results, site);
  difyAbortRequested = false;
  try {
    await chrome.storage.local.set({ difyWorkflowRunInProgress: true });
    await updateRunProgress({
      status: "running",
      message: "采集已完成，正在执行 Dify 工作流…",
    });
    const result = await runDifyWorkflowWithPayload(
      cfg,
      payload,
      targetBrands,
      `ai-autochat-${site || "run"}`
    );
    if (result.ok) {
      const data = await chrome.storage.local.get(["lastDifyRun"]);
      await updateRunProgress({
        status: "done",
        message: String(data.lastDifyRun?.message || "Dify 完成 · CSV 已下载"),
      });
    } else if (!result.cancelled) {
      await updateRunProgress({
        status: "done",
        message: String(result.error || "Dify 失败 · 已下载占位 CSV"),
      });
    }
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
  const aoa = [BRAND_REPORT_CSV_HEADERS];
  for (const r of rows) {
    const capturedAt = String(r?.capturedAt ?? "");
    aoa.push([
      String(r?.question ?? ""),
      isoToUsDate(capturedAt),
      String(r?.site ?? site),
      "",
      "",
      "",
      "",
      "",
      "",
      String(r?.answer ?? ""),
      formatCitationsCell(r?.citations),
      String(r?.pageUrl ?? ""),
      capturedAt,
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

  if (msg?.type === "START_DIFY_STUB_CSV") {
    const csvText = typeof msg.csvText === "string" ? msg.csvText : "";
    const targetBrands = typeof msg.targetBrands === "string" ? msg.targetBrands : "";
    runDifyStubCsvJob(csvText, targetBrands)
      .then((result) => {
        try {
          sendResponse(result);
        } catch {
          /* ignore */
        }
      })
      .catch((e) => {
        try {
          sendResponse({ ok: false, error: String(e?.message || e) });
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

  if (msg?.type === "GET_JOB_STATE") {
    getJobState()
      .then((state) => sendResponse(state))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (msg?.type === "STOP_CURRENT_JOB") {
    stopCurrentJob()
      .then((result) => sendResponse(result))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  if (msg?.type === "RUN_MULTI") {
    const questions = Array.isArray(msg.questions) ? msg.questions : [];
    const platforms = Array.isArray(msg.platforms) ? msg.platforms : [];
    sendResponse({ ok: true, started: true, platforms });
    void runMultiPlatformQueue(questions, platforms).catch(async (err) => {
      await trace("error", "background", "runMultiPlatformQueue 未捕获异常", String(err));
      await recordRunError({
        phase: "runMultiPlatformQueue_uncaught",
        error: String(err?.message || err),
      });
    });
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
