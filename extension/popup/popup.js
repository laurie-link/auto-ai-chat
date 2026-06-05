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

const RUN_BUTTON_IDS = [
  "runGemini",
  "runChatgpt",
  "runPerplexity",
];

function setRunButtonsDisabled(disabled) {
  for (const id of RUN_BUTTON_IDS) {
    const el = $(id);
    if (el) el.disabled = disabled;
  }
}

async function loadDifySettings() {
  await chrome.storage.local.set({ difyWorkflowEnabled: true });

  const data = await chrome.storage.local.get([
    "difyBaseUrl",
    "difyApiKey",
    "difyApiUser",
    "difyTargetBrands",
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
}

function persistDifySettings() {
  const baseEl = $("difyBaseUrl");
  const keyEl = $("difyApiKey");
  const userEl = $("difyApiUser");
  const brandsEl = $("difyTargetBrands");
  chrome.storage.local.set({
    difyWorkflowEnabled: true,
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
  setStatus(runningMsg);
  popupTrace(`点击运行`, { type: runtimeType, count: questions.length });

  /** 采集结束后若勾选「自动跑 Dify」，后台会置 difyWorkflowRunInProgress；轮询以切换状态文案 */
  const difyPhasePoll = setInterval(async () => {
    try {
      const { difyWorkflowRunInProgress } = await chrome.storage.local.get("difyWorkflowRunInProgress");
      if (difyWorkflowRunInProgress) {
        setStatus("采集已完成，正在执行 Dify 工作流（请稍候）…");
      }
    } catch {
      /* ignore */
    }
  }, 350);

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
    setStatus(`完成 · ${okLabel} · ${n} 条`);
    popupTrace(`${runtimeType} 成功`, { n });
  } catch (e) {
    const msg = String(e?.message || e);
    setStatus(msg, true);
    popupTrace(`${runtimeType} 异常`, { message: msg });
  } finally {
    clearInterval(difyPhasePoll);
    setRunButtonsDisabled(false);
    if (!skipLoadLogsInFinally) await loadLogs();
  }
}

$("runGemini").addEventListener("click", async () => {
  await runQueue(
    "RUN_GEMINI",
    "运行中…（请勿关闭 Gemini 标签页）",
    "Gemini"
  );
});

$("runChatgpt").addEventListener("click", async () => {
  await runQueue(
    "RUN_CHATGPT",
    "运行中…（请勿关闭 ChatGPT 标签页）",
    "ChatGPT"
  );
});

$("runPerplexity").addEventListener("click", async () => {
  await runQueue(
    "RUN_PERPLEXITY",
    "运行中…（请勿关闭 Perplexity 标签页）",
    "Perplexity"
  );
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

chrome.storage.local.get(["lastQuestions"], (data) => {
  if (typeof data.lastQuestions === "string" && data.lastQuestions.trim()) {
    $("questions").value = data.lastQuestions;
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
  const { difyWorkflowRunInProgress } = await chrome.storage.local.get("difyWorkflowRunInProgress");
  if (!difyWorkflowRunInProgress) return;
  setStatus("工作流仍在后台执行，请稍候…");
  stopDifyBgWaitPoll();
  difyBgWaitPollId = setInterval(async () => {
    const d = await chrome.storage.local.get(["difyWorkflowRunInProgress", "lastDifyRun"]);
    if (d.difyWorkflowRunInProgress) return;
    stopDifyBgWaitPoll();
    const last = d.lastDifyRun;
    if (last?.ok) {
      setStatus("已完成 · CSV 已下载");
    } else if (last && last.ok === false) {
      setStatus(String(last.error || "失败"), true);
    } else {
      setStatus("");
    }
    await loadLogs();
  }, 800);
}

$("questions").addEventListener(
  "change",
  () => {
    chrome.storage.local.set({ lastQuestions: $("questions").value });
  },
  { passive: true }
);

function setActiveTab(name) {
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
}

function initTabs() {
  $("tabRun")?.addEventListener("click", () => setActiveTab("run"));
  $("tabSettings")?.addEventListener("click", () => setActiveTab("settings"));
}

loadDifySettings()
  .then(() => resumeDifyJobIfBackgroundBusy())
  .catch(() => {});

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

loadLogs();
