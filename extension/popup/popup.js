const $ = (id) => document.getElementById(id);

function parseQuestions(raw) {
  return raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function setStatus(text, isError = false) {
  const el = $("status");
  el.textContent = text;
  el.classList.toggle("error", Boolean(isError));
}

const RUN_BUTTON_IDS = [
  "runGemini",
  "runChatgpt",
  "runPerplexity",
  "runGoogleAio",
  "runGoogleAimode",
];

function setRunButtonsDisabled(disabled) {
  for (const id of RUN_BUTTON_IDS) {
    const el = $(id);
    if (el) el.disabled = disabled;
  }
}

function getExportFormat() {
  const checked = document.querySelector('input[name="exportFormat"]:checked');
  return checked?.value === "xlsx" ? "xlsx" : "json";
}

async function refreshLastRunHint() {
  const btn = $("downloadLastRun");
  const hint = $("lastRunHint");
  try {
    const data = await chrome.storage.local.get(["lastRun"]);
    const last = data.lastRun;
    const n = Array.isArray(last?.results) ? last.results.length : 0;
    if (n > 0 && last?.site) {
      btn.disabled = false;
      const at = last.completedAt ? String(last.completedAt).replace("T", " ").slice(0, 19) : "";
      hint.textContent = `可下载：${last.site} · ${n} 条${at ? ` · ${at}` : ""}`;
    } else {
      btn.disabled = true;
      hint.textContent = "暂无完整运行结果（成功跑完一轮后会出现）";
    }
  } catch (e) {
    btn.disabled = true;
    hint.textContent = `读取失败: ${e?.message || e}`;
  }
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

  try {
    const res = await chrome.runtime.sendMessage({
      type: runtimeType,
      questions,
    });

    if (res === undefined) {
      const err =
        "扩展后台无响应（service worker 可能未启动）。请打开 chrome://extensions 在本扩展下点「Service Worker」查看控制台。";
      setStatus(err, true);
      popupTrace(`${runtimeType} 返回 undefined`, {});
      await loadLogs();
      return;
    }

    if (!res?.ok) {
      setStatus(res?.error || "运行失败", true);
      popupTrace(`${runtimeType} 失败`, { error: res?.error });
      await loadLogs();
      return;
    }
    const n = res.results?.length ?? 0;
    setStatus(`完成：${okLabel} 已处理 ${n} 个问题。请在下方选择格式并点击「下载上次运行结果」导出。`);
    popupTrace(`${runtimeType} 成功`, { n });
  } catch (e) {
    const msg = String(e?.message || e);
    setStatus(msg, true);
    popupTrace(`${runtimeType} 异常`, { message: msg });
  } finally {
    setRunButtonsDisabled(false);
    await loadLogs();
    await refreshLastRunHint();
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

$("runGoogleAio").addEventListener("click", async () => {
  await runQueue(
    "RUN_GOOGLE_AIO",
    "运行中…（请勿关闭 Google 标签页）",
    "Google AI Overview"
  );
});

$("runGoogleAimode").addEventListener("click", async () => {
  await runQueue(
    "RUN_GOOGLE_AIMODE",
    "运行中…（请勿关闭 Google 标签页）",
    "Google AI Mode"
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

chrome.storage.local.get(["lastQuestions", "exportFormat"], (data) => {
  if (typeof data.lastQuestions === "string" && data.lastQuestions.trim()) {
    $("questions").value = data.lastQuestions;
  }
  if (data.exportFormat === "xlsx" || data.exportFormat === "json") {
    const radio = document.querySelector(`input[name="exportFormat"][value="${data.exportFormat}"]`);
    if (radio instanceof HTMLInputElement) radio.checked = true;
  }
});

document.querySelectorAll('input[name="exportFormat"]').forEach((el) => {
  el.addEventListener("change", () => {
    chrome.storage.local.set({ exportFormat: getExportFormat() });
  });
});

$("downloadLastRun").addEventListener("click", async () => {
  try {
    const format = getExportFormat();
    const res = await chrome.runtime.sendMessage({ type: "EXPORT_LAST_RUN", format });
    if (!res?.ok) {
      setStatus(res?.error || "下载失败", true);
      return;
    }
    setStatus(`已下载（${format === "xlsx" ? "Excel" : "JSON"}）。`);
    popupTrace("下载上次运行结果", { format });
  } catch (e) {
    setStatus(String(e?.message || e), true);
  }
});

$("questions").addEventListener(
  "change",
  () => {
    chrome.storage.local.set({ lastQuestions: $("questions").value });
  },
  { passive: true }
);

loadLogs();
refreshLastRunHint();
