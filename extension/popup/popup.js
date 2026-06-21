const $ = (id) => document.getElementById(id);

const DIFY_DEFAULTS = {
  difyBaseUrl: "https://dify.aiexplorerxj.top",
  difyApiKey: "app-JGuIE0oeaKEguRu3FV79dtm8",
  difyApiUser: "ai-autochat-extension",
};

function parseQuestions(raw) {
  return raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function setStatus(text, isError = false) {
  const el = $("status");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("error", Boolean(isError));
}

/**
 * @param {Record<string, unknown> | null | undefined} runProgress
 */
function applyRunProgress(runProgress) {
  if (!runProgress || typeof runProgress !== "object") return false;
  const status = String(runProgress.status || "");
  const message = String(runProgress.message || "");
  if (!message) return false;

  if (status === "running") {
    setStatus(message, false);
    updateJobUi(true);
    return true;
  }
  if (status === "error") {
    setStatus(message, true);
    updateJobUi(false);
    return true;
  }
  if (status === "done") {
    setStatus(message, false);
    updateJobUi(false);
    return true;
  }
  return false;
}

/** @param {boolean} running */
function updateJobUi(running) {
  setRunButtonsDisabled(running);
  const stop = $("stopJob");
  if (stop instanceof HTMLButtonElement) stop.hidden = !running;
  const upload = $("uploadStubCsv");
  if (upload instanceof HTMLButtonElement) upload.disabled = running;
}

async function syncJobUiFromBackground() {
  try {
    const state = await chrome.runtime.sendMessage({ type: "GET_JOB_STATE" });
    if (!state?.ok) {
      updateJobUi(false);
      return;
    }
    if (state.isActive) {
      updateJobUi(true);
      if (state.runProgress) {
        applyRunProgress(state.runProgress);
      } else if (state.difyWorkflowRunInProgress) {
        setStatus("采集已完成，正在执行 Dify 工作流（请稍候）…");
      }
      return;
    }
    updateJobUi(false);
    await refreshStatusFromStorage();
  } catch {
    updateJobUi(false);
  }
}

async function refreshStatusFromStorage() {
  try {
    const data = await chrome.storage.local.get([
      "runProgress",
      "difyWorkflowRunInProgress",
      "lastDifyRun",
    ]);
    if (data.difyWorkflowRunInProgress) {
      setStatus("采集已完成，正在执行 Dify 工作流（请稍候）…");
      updateJobUi(true);
      return;
    }
    if (applyRunProgress(data.runProgress)) return;
    updateJobUi(false);
    const last = data.lastDifyRun;
    if (last?.ok) {
      setStatus(String(data.runProgress?.message || "已完成 · CSV 已下载"));
    } else if (last && last.ok === false) {
      setStatus(String(last.error || "失败"), true);
    }
  } catch {
    /* ignore */
  }
}

const RUN_BUTTON_IDS = ["runSelected"];

const PLATFORM_PICKS = [
  { checkboxId: "pickGemini", platform: "gemini" },
  { checkboxId: "pickChatgpt", platform: "chatgpt" },
  { checkboxId: "pickPerplexity", platform: "perplexity" },
];

function getSelectedPlatforms() {
  /** @type {string[]} */
  const out = [];
  for (const { checkboxId, platform } of PLATFORM_PICKS) {
    const el = $(checkboxId);
    if (el instanceof HTMLInputElement && el.checked) out.push(platform);
  }
  return out;
}

function setPlatformPickersDisabled(disabled) {
  for (const { checkboxId } of PLATFORM_PICKS) {
    const el = $(checkboxId);
    if (el instanceof HTMLInputElement) el.disabled = disabled;
  }
}

function persistPlatformSelection() {
  chrome.storage.local.set({ selectedPlatforms: getSelectedPlatforms() }).catch(() => {});
}

async function loadPlatformSelection() {
  const data = await chrome.storage.local.get(["selectedPlatforms"]);
  const selected = Array.isArray(data.selectedPlatforms) ? data.selectedPlatforms : [];
  const set = new Set(selected.map(String));
  for (const { checkboxId, platform } of PLATFORM_PICKS) {
    const el = $(checkboxId);
    if (el instanceof HTMLInputElement) {
      el.checked = set.size > 0 ? set.has(platform) : platform === "gemini";
    }
  }
}

function setRunButtonsDisabled(disabled) {
  for (const id of RUN_BUTTON_IDS) {
    const el = $(id);
    if (el) el.disabled = disabled;
  }
  setPlatformPickersDisabled(disabled);
}

async function loadDifySettings() {
  const data = await chrome.storage.local.get([
    "difyBaseUrl",
    "difyApiKey",
    "difyApiUser",
    "difyTargetBrands",
    "difyWorkflowEnabled",
  ]);
  const base = $("difyBaseUrl");
  if (base instanceof HTMLInputElement) {
    base.value =
      typeof data.difyBaseUrl === "string" && data.difyBaseUrl.trim()
        ? data.difyBaseUrl
        : DIFY_DEFAULTS.difyBaseUrl;
  }
  const key = $("difyApiKey");
  if (key instanceof HTMLInputElement) {
    key.value =
      typeof data.difyApiKey === "string" && data.difyApiKey.trim()
        ? data.difyApiKey
        : DIFY_DEFAULTS.difyApiKey;
  }
  const user = $("difyApiUser");
  if (user instanceof HTMLInputElement) {
    user.value =
      typeof data.difyApiUser === "string" && data.difyApiUser.trim()
        ? data.difyApiUser
        : DIFY_DEFAULTS.difyApiUser;
  }
  const brands = $("difyTargetBrands");
  if (brands instanceof HTMLInputElement) {
    brands.value = typeof data.difyTargetBrands === "string" ? data.difyTargetBrands : "";
  }
  const enabled = $("difyWorkflowEnabled");
  if (enabled instanceof HTMLInputElement) {
    enabled.checked = data.difyWorkflowEnabled !== false;
  }
}

function persistDifySettings() {
  const baseEl = $("difyBaseUrl");
  const keyEl = $("difyApiKey");
  const userEl = $("difyApiUser");
  const brandsEl = $("difyTargetBrands");
  const enabledEl = $("difyWorkflowEnabled");
  chrome.storage.local.set({
    difyWorkflowEnabled: enabledEl instanceof HTMLInputElement ? enabledEl.checked : true,
    difyBaseUrl:
      baseEl instanceof HTMLInputElement && String(baseEl.value || "").trim()
        ? String(baseEl.value).trim()
        : DIFY_DEFAULTS.difyBaseUrl,
    difyApiKey:
      keyEl instanceof HTMLInputElement && String(keyEl.value || "").trim()
        ? String(keyEl.value).trim()
        : DIFY_DEFAULTS.difyApiKey,
    difyApiUser:
      userEl instanceof HTMLInputElement && String(userEl.value || "").trim()
        ? String(userEl.value).trim()
        : DIFY_DEFAULTS.difyApiUser,
    difyTargetBrands: brandsEl instanceof HTMLInputElement ? String(brandsEl.value || "").trim() : "",
  });
}

function popupTrace(message, detail) {
  const payload = {
    type: "DEBUG_LOG",
    level: "info",
    source: "popup",
    message,
    ...(detail !== undefined
      ? {
          detail: typeof detail === "string" ? detail : JSON.stringify(detail),
        }
      : {}),
  };
  chrome.runtime.sendMessage(payload).catch(() => {});
}

/**
 * 直接追加到弹窗「调试日志」文本框（不依赖 Service Worker）。格式与 loadLogs 一致。
 * @param {"info"|"warn"|"error"} level
 * @param {string} message
 * @param {unknown} [detail]
 */
function appendLocalDebugLine(level, message, detail) {
  const el = $("logView");
  if (!(el instanceof HTMLTextAreaElement)) return;
  const t = new Date().toISOString();
  let d = "";
  if (detail !== undefined && detail !== null && String(detail) !== "") {
    d = ` ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
  }
  const line = `${t} [${level}] popup: ${message || ""}${d}`;
  const prev = el.value.trim();
  if (!prev || prev === "（暂无日志）") el.value = line;
  else el.value = `${prev}\n${line}`;
  el.scrollTop = el.scrollHeight;
}

async function loadLogs() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "GET_DEBUG_LOG" });
    const lines = res?.ok && Array.isArray(res.lines) ? res.lines : [];
    const text = lines
      .map((l) => {
        const d = l.detail != null ? ` ${l.detail}` : "";
        return `${l.t} [${l.level || "info"}] ${l.source || "?"}: ${l.message || ""}${d}`;
      })
      .join("\n");
    $("logView").value = text || "（暂无日志）";
    $("logView").scrollTop = $("logView").scrollHeight;
  } catch (e) {
    $("logView").value = `读取日志失败: ${e?.message || e}`;
  }
}

async function waitForBackgroundJobIdle(maxMs = 600000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const state = await chrome.runtime.sendMessage({ type: "GET_JOB_STATE" });
      if (!state?.isActive) return;
      await refreshStatusFromStorage();
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, 800));
  }
}

async function runMultiSelected() {
  const raw = $("questions").value;
  const questions = parseQuestions(raw);
  if (questions.length === 0) {
    setStatus("请至少输入一行问题。", true);
    popupTrace("运行被拒绝：无有效问题");
    return;
  }

  const platforms = getSelectedPlatforms();
  if (platforms.length === 0) {
    setStatus("请至少勾选一个平台。", true);
    popupTrace("运行被拒绝：未选平台");
    return;
  }

  setRunButtonsDisabled(true);
  updateJobUi(true);
  setStatus("已提交多平台任务…");
  chrome.storage.local.set({ lastQuestions: raw }).catch(() => {});
  persistDifySettings();
  persistPlatformSelection();
  popupTrace("多平台运行", { platforms, count: questions.length });

  const difyPhasePoll = setInterval(async () => {
    try {
      await refreshStatusFromStorage();
    } catch {
      /* ignore */
    }
  }, 500);

  try {
    const res = await chrome.runtime.sendMessage({
      type: "RUN_MULTI",
      questions,
      platforms,
    });

    if (res === undefined) {
      setStatus(
        "扩展后台无响应（service worker 可能未启动）。请打开 chrome://extensions 查看 Service Worker 控制台。",
        true
      );
      return;
    }

    if (!res?.ok && !res?.started) {
      setStatus(res?.error || "启动失败", true);
      return;
    }

    const PLATFORM_LABELS = {
      gemini: "Gemini",
      chatgpt: "ChatGPT",
      perplexity: "Perplexity",
    };
    const labels = platforms.map((p) => PLATFORM_LABELS[p] || p).join(" → ");
    setStatus(`多平台任务运行中（${labels}）…`);
    await waitForBackgroundJobIdle();
    await refreshStatusFromStorage();
  } catch (e) {
    setStatus(String(e?.message || e), true);
    popupTrace("RUN_MULTI 异常", { message: String(e?.message || e) });
  } finally {
    clearInterval(difyPhasePoll);
    await syncJobUiFromBackground();
    await loadLogs();
  }
}

$("runSelected")?.addEventListener("click", () => {
  void runMultiSelected();
});

for (const { checkboxId } of PLATFORM_PICKS) {
  $(checkboxId)?.addEventListener("change", () => {
    persistPlatformSelection();
  });
}

/**
 * @param {"RUN_GEMINI"|"RUN_CHATGPT"|"RUN_PERPLEXITY"|"RUN_GOOGLE_AIO"|"RUN_GOOGLE_AIMODE"} runtimeType
 * @param {string} runningMsg
 * @param {string} okLabel
 */
async function runQueue(runtimeType, runningMsg, okLabel) {
  const raw = $("questions").value;
  const questions = parseQuestions(raw);
  if (questions.length === 0) {
    setStatus("请至少输入一行问题。", true);
    popupTrace("运行被拒绝：无有效问题");
    return;
  }

  setRunButtonsDisabled(true);
  updateJobUi(true);
  setStatus("已提交，正在启动后台任务…");
  chrome.storage.local.set({ lastQuestions: raw }).catch(() => {});
  persistDifySettings();
  popupTrace(`点击运行`, { type: runtimeType, count: questions.length });

  /** 采集结束后若勾选「自动跑 Dify」，后台会置 difyWorkflowRunInProgress；轮询以切换状态文案 */
  const difyPhasePoll = setInterval(async () => {
    try {
      await refreshStatusFromStorage();
    } catch {
      /* ignore */
    }
  }, 500);

  /** Service Worker 无响应时不要 finally 里 loadLogs，避免冲掉本机写入的日志行 */
  let skipLoadLogsInFinally = false;

  try {
    const res = await chrome.runtime.sendMessage({
      type: runtimeType,
      questions,
    });

    if (res === undefined) {
      skipLoadLogsInFinally = true;
      const err =
        "扩展后台无响应（service worker 可能未启动）。请打开 chrome://extensions 在本扩展下点「Service Worker」查看控制台。";
      setStatus(err, true);
      appendLocalDebugLine("error", `${runtimeType}：扩展后台无响应`, err);
      popupTrace(`${runtimeType} 返回 undefined`, { note: "详见弹窗日志框" });
      return;
    }

    if (!res?.ok) {
      setStatus(res?.error || "运行失败", true);
      popupTrace(`${runtimeType} 失败`, { error: res?.error });
      await loadLogs();
      return;
    }
    const n = res.results?.length ?? 0;
    if (res.difyScheduled) {
      setStatus(`完成 · ${okLabel} · ${n} 条 · Dify 处理中…`);
      popupTrace(`${runtimeType} 采集完成，等待 Dify`, { n });
      await waitForBackgroundJobIdle();
      await refreshStatusFromStorage();
    } else {
      setStatus(`完成 · ${okLabel} · ${n} 条`);
      popupTrace(`${runtimeType} 成功`, { n });
    }
  } catch (e) {
    const msg = String(e?.message || e);
    if (/message channel closed/i.test(msg)) {
      setStatus("采集可能已完成，正在后台等待 Dify…");
      popupTrace(`${runtimeType} 通道超时，继续轮询 Dify`, { message: msg });
      try {
        await waitForBackgroundJobIdle();
        await refreshStatusFromStorage();
      } catch {
        /* ignore */
      }
    } else {
      setStatus(msg, true);
      popupTrace(`${runtimeType} 异常`, { message: msg });
    }
  } finally {
    clearInterval(difyPhasePoll);
    await syncJobUiFromBackground();
    if (!skipLoadLogsInFinally) await loadLogs();
  }
}

/**
 * @param {{ csvText?: string }} [extra]
 */
async function runDifySupplementJob(extra = {}) {
  persistDifySettings();
  const brandsEl = $("difyTargetBrands");
  const targetBrands =
    brandsEl instanceof HTMLInputElement ? String(brandsEl.value || "").trim() : "";

  setRunButtonsDisabled(true);
  updateJobUi(true);
  setStatus("正在上传占位 CSV 并补跑 Dify…");

  const poll = setInterval(() => {
    refreshStatusFromStorage().catch(() => {});
  }, 500);

  try {
    const res = await chrome.runtime.sendMessage({
      type: "START_DIFY_STUB_CSV",
      csvText: extra.csvText || "",
      targetBrands,
    });
    if (!res?.ok) {
      setStatus(res?.error || "Dify 补跑失败", true);
      return;
    }
    setStatus("Dify 补跑完成 · CSV 已下载");
  } catch (e) {
    setStatus(String(e?.message || e), true);
  } finally {
    clearInterval(poll);
    await syncJobUiFromBackground();
    await loadLogs();
  }
}

$("uploadStubCsv")?.addEventListener("click", () => {
  $("stubCsvFile")?.click();
});

$("stopJob")?.addEventListener("click", async () => {
  const stopBtn = $("stopJob");
  if (stopBtn instanceof HTMLButtonElement) stopBtn.disabled = true;
  setStatus("正在停止…");
  try {
    const res = await chrome.runtime.sendMessage({ type: "STOP_CURRENT_JOB" });
    if (!res?.ok) {
      setStatus(res?.error || "停止失败", true);
      updateJobUi(false);
      return;
    }
    setStatus(res.message || "已发送停止请求…");
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const state = await chrome.runtime.sendMessage({ type: "GET_JOB_STATE" });
      if (!state?.isActive) break;
    }
    await syncJobUiFromBackground();
  } catch (e) {
    setStatus(String(e?.message || e), true);
    updateJobUi(false);
  } finally {
    if (stopBtn instanceof HTMLButtonElement) stopBtn.disabled = false;
  }
});

$("stubCsvFile")?.addEventListener("change", async (ev) => {
  const input = ev.target;
  if (!(input instanceof HTMLInputElement) || !input.files?.length) return;
  try {
    const csvText = await input.files[0].text();
    await runDifySupplementJob({ csvText });
  } catch (e) {
    setStatus(String(e?.message || e), true);
  } finally {
    input.value = "";
  }
});

$("logRefresh").addEventListener("click", () => loadLogs());
$("logClear").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "CLEAR_DEBUG_LOG" });
  await loadLogs();
});
$("logExport").addEventListener("click", async () => {
  try {
    const res = await chrome.runtime.sendMessage({ type: "EXPORT_DEBUG_LOG" });
    if (!res?.ok) {
      setStatus(res?.error || "导出失败", true);
      return;
    }
    setStatus("已下载调试日志 JSON。");
  } catch (e) {
    setStatus(String(e?.message || e), true);
  }
});

/** @type {ReturnType<typeof setInterval> | null} */
let difyBgWaitPollId = null;

function stopDifyBgWaitPoll() {
  if (difyBgWaitPollId != null) {
    clearInterval(difyBgWaitPollId);
    difyBgWaitPollId = null;
  }
}

/**
 * 弹窗曾关闭但后台仍在跑阻塞工作流时，根据 difyWorkflowRunInProgress 恢复提示。
 */
async function resumeDifyJobIfBackgroundBusy() {
  await refreshStatusFromStorage();
  const { difyWorkflowRunInProgress, runProgress } = await chrome.storage.local.get([
    "difyWorkflowRunInProgress",
    "runProgress",
  ]);
  if (runProgress?.status === "running" || difyWorkflowRunInProgress) {
    stopDifyBgWaitPoll();
    difyBgWaitPollId = setInterval(async () => {
      await refreshStatusFromStorage();
      const d = await chrome.storage.local.get(["difyWorkflowRunInProgress", "runProgress"]);
      if (d.runProgress?.status === "running" || d.difyWorkflowRunInProgress) return;
      stopDifyBgWaitPoll();
      await loadLogs();
    }, 800);
  }
}

$("questions").addEventListener(
  "change",
  () => {
    chrome.storage.local.set({ lastQuestions: $("questions").value });
  },
  { passive: true }
);

function setActiveTab(name, persist = true) {
  const run = $("panelRun");
  const settings = $("panelSettings");
  const tRun = $("tabRun");
  const tSet = $("tabSettings");
  if (!run || !settings || !tRun || !tSet) return;
  if (name === "settings") {
    run.hidden = true;
    settings.hidden = false;
    tRun.classList.remove("active");
    tSet.classList.add("active");
    tRun.setAttribute("aria-selected", "false");
    tSet.setAttribute("aria-selected", "true");
    loadDifySettings().catch(() => {});
    loadLogs();
  } else {
    run.hidden = false;
    settings.hidden = true;
    tRun.classList.add("active");
    tSet.classList.remove("active");
    tRun.setAttribute("aria-selected", "true");
    tSet.setAttribute("aria-selected", "false");
  }
  if (persist) {
    chrome.storage.local.set({ uiActiveTab: name === "settings" ? "settings" : "run" }).catch(() => {});
  }
}

/** 打开 popup / 侧边栏时从 storage 恢复界面，避免关面板后进度文案丢失 */
async function restoreUiFromStorage() {
  const data = await chrome.storage.local.get([
    "lastQuestions",
    "uiActiveTab",
    "runProgress",
    "difyWorkflowRunInProgress",
    "lastDifyRun",
  ]);

  if (typeof data.lastQuestions === "string" && data.lastQuestions.trim()) {
    $("questions").value = data.lastQuestions;
  }

  const tab = data.uiActiveTab === "settings" ? "settings" : "run";
  setActiveTab(tab, false);

  await syncJobUiFromBackground();
  await resumeDifyJobIfBackgroundBusy();
}

function initTabs() {
  $("tabRun")?.addEventListener("click", () => setActiveTab("run"));
  $("tabSettings")?.addEventListener("click", () => setActiveTab("settings"));
}

restoreUiFromStorage()
  .then(() => loadDifySettings())
  .catch(() => {});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.runProgress?.newValue) {
    applyRunProgress(changes.runProgress.newValue);
  }
  if (changes.difyWorkflowRunInProgress?.newValue === true) {
    setStatus("采集已完成，正在执行 Dify 工作流（请稍候）…");
    updateJobUi(true);
  }
  if (changes.difyWorkflowRunInProgress?.newValue === false) {
    syncJobUiFromBackground().catch(() => {});
  }
});

initTabs();

const difyIds = ["difyBaseUrl", "difyApiKey", "difyApiUser", "difyTargetBrands"];
for (const id of difyIds) {
  const node = $(id);
  if (!node) continue;
  node.addEventListener("change", () => {
    persistDifySettings();
    popupTrace("已更新 Dify 设置", { id });
  });
  node.addEventListener("blur", () => persistDifySettings());
}

$("difyWorkflowEnabled")?.addEventListener("change", () => {
  persistDifySettings();
  popupTrace("已更新 Dify 设置", { id: "difyWorkflowEnabled" });
});

loadLogs();
