/**
 * Dify Service API：上传 JSON → 执行工作流 → 取回 csv_report 文本。
 * 与 api/controllers/service_api 下 /v1 路由一致。
 */

/** Dify 迭代节点单次工作流最多约 30 条；留 1 条余量避免整批失败丢数据 */
export const DIFY_MAX_ITEMS_PER_BATCH = 29;

export { BRAND_REPORT_CSV_HEADERS } from "./brand-report-csv.js";

/**
 * @param {string} base
 */
export function normalizeDifyApiBase(base) {
  const s = String(base || "").trim().replace(/\/+$/, "");
  return s;
}

/**
 * @param {unknown} json
 * @returns {string|null}
 */
export function extractCsvReportFromWorkflowResponse(json) {
  if (!json || typeof json !== "object") return null;
  const root = /** @type {Record<string, unknown>} */ (json);
  const data = root.data;
  if (data && typeof data === "object") {
    const outputs = /** @type {Record<string, unknown>} */ (data).outputs;
    if (outputs && typeof outputs === "object") {
      const csv = /** @type {Record<string, unknown>} */ (outputs).csv_report;
      if (typeof csv === "string" && csv.trim()) return csv;
    }
  }
  const direct = root.outputs;
  if (direct && typeof direct === "object") {
    const csv = /** @type {Record<string, unknown>} */ (direct).csv_report;
    if (typeof csv === "string" && csv.trim()) return csv;
  }
  return null;
}

/**
 * @param {string} apiBase normalized, no trailing slash
 * @param {string} apiKey
 * @param {string} userId
 * @param {Blob} fileBlob
 * @param {string} filename
 */
export async function difyUploadFile(apiBase, apiKey, userId, fileBlob, filename) {
  const fd = new FormData();
  fd.append("user", userId);
  fd.append("file", fileBlob, filename);

  const res = await fetch(`${apiBase}/v1/files/upload`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: fd,
  });

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!res.ok) {
    const msg = json?.message || json?.error || text || res.statusText;
    throw new Error(`上传文件失败 HTTP ${res.status}: ${msg}`);
  }

  const id = json?.id;
  if (!id || typeof id !== "string") {
    throw new Error("上传响应缺少文件 id");
  }
  return id;
}

/**
 * @param {string} apiBase
 * @param {string} apiKey
 * @param {string} userId
 * @param {string} uploadFileId
 * @param {string} targetBrands comma-separated
 * @param {"document"|"custom"} [fileType]
 */
export async function difyRunWorkflowBlocking(
  apiBase,
  apiKey,
  userId,
  uploadFileId,
  targetBrands,
  fileType = "document"
) {
  const body = {
    user: userId,
    response_mode: "blocking",
    inputs: {
      target_brands: targetBrands,
      export_file: {
        transfer_method: "local_file",
        upload_file_id: uploadFileId,
        type: fileType,
      },
    },
  };

  const res = await fetch(`${apiBase}/v1/workflows/run`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!res.ok) {
    const msg = json?.message || json?.error || text || res.statusText;
    throw new Error(`工作流执行失败 HTTP ${res.status}: ${msg}`);
  }

  const status =
    json && typeof json === "object" && json.data && typeof json.data === "object"
      ? /** @type {Record<string, unknown>} */ (json.data).status
      : null;

  if (status && status !== "succeeded" && status !== "partial-succeeded") {
    const err =
      json && typeof json === "object" && json.data && typeof json.data === "object"
        ? /** @type {Record<string, unknown>} */ (json.data).error
        : null;
    throw new Error(
      `工作流未成功完成（${String(status)}）${err ? `: ${String(err)}` : ""}`
    );
  }

  const csv = extractCsvReportFromWorkflowResponse(json);
  if (!csv) {
    throw new Error("响应中未找到 outputs.csv_report，请确认结束节点输出变量名为 csv_report");
  }
  return csv;
}

/**
 * 阻塞模式；依次尝试 export_file.type。
 * JSON 上传在 Dify 侧应对应 custom；document 常用于 PDF 等，会先触发 400 再重试，故优先 custom。
 */
export async function difyRunWorkflowBlockingWithTypeRetry(
  apiBase,
  apiKey,
  userId,
  uploadFileId,
  targetBrands
) {
  const tryTypes = /** @type {const} */ (["custom", "document"]);
  let lastErr = "";
  for (let i = 0; i < tryTypes.length; i++) {
    try {
      return await difyRunWorkflowBlocking(
        apiBase,
        apiKey,
        userId,
        uploadFileId,
        targetBrands,
        tryTypes[i]
      );
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      if (i < tryTypes.length - 1) continue;
      throw new Error(lastErr);
    }
  }
  throw new Error(lastErr || "工作流无输出");
}

/**
 * @param {object[]} results
 * @param {string} runSite
 */
export function buildWorkflowExportJson(results, runSite) {
  const rows = Array.isArray(results) ? results : [];
  return {
    exportedAt: new Date().toISOString(),
    source: "ai-autochat-extension",
    site: runSite || "unknown",
    results: rows.map((r) => ({
      question: r?.question ?? "",
      answer: r?.answer ?? "",
      capturedAt: r?.capturedAt ?? "",
      pageUrl: r?.pageUrl ?? "",
      site: r?.site ?? runSite ?? "",
      citations: Array.isArray(r?.citations) ? r.citations : [],
    })),
  };
}

/**
 * @template T
 * @param {T[]} arr
 * @param {number} size
 * @returns {T[][]}
 */
export function chunkArray(arr, size) {
  if (!Array.isArray(arr) || arr.length === 0) return [];
  const n = Math.max(1, Math.floor(size));
  /** @type {T[][]} */
  const out = [];
  for (let i = 0; i < arr.length; i += n) {
    out.push(arr.slice(i, i + n));
  }
  return out;
}

/**
 * 合并多批 Dify 返回的 CSV（保留首段表头，跳过后续段表头）。
 * @param {string[]} csvParts
 * @returns {string}
 */
export function mergeCsvReports(csvParts) {
  const parts = (csvParts || []).map((s) => String(s || "").replace(/^\uFEFF/, "").trim()).filter(Boolean);
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0].startsWith("\uFEFF") ? parts[0] : `\uFEFF${parts[0]}`;

  const lines = [];
  for (let i = 0; i < parts.length; i++) {
    const chunkLines = parts[i].split(/\r?\n/).filter((l) => l.length > 0);
    if (i === 0) {
      lines.push(...chunkLines);
      continue;
    }
    if (chunkLines.length <= 1) continue;
    lines.push(...chunkLines.slice(1));
  }
  const merged = lines.join("\n");
  return merged.startsWith("\uFEFF") ? merged : `\uFEFF${merged}`;
}

/**
 * 超过 Dify 迭代上限时分批上传、执行并合并 CSV。
 * @param {string} apiBase
 * @param {string} apiKey
 * @param {string} userId
 * @param {object} payloadObject 含 results[]
 * @param {string} targetBrands
 * @param {string} uploadBaseName
 * @returns {Promise<string>}
 */
export async function runDifyWorkflowBatched(
  apiBase,
  apiKey,
  userId,
  payloadObject,
  targetBrands,
  uploadBaseName,
  options = {}
) {
  const shouldAbort =
    typeof options.shouldAbort === "function" ? options.shouldAbort : () => false;
  const results = Array.isArray(payloadObject?.results) ? payloadObject.results : [];
  const batches = chunkArray(results, DIFY_MAX_ITEMS_PER_BATCH);

  if (batches.length <= 1) {
    if (shouldAbort()) {
      const err = new Error("DIFY_ABORTED");
      err.code = "DIFY_ABORTED";
      throw err;
    }
    const jsonStr = JSON.stringify(payloadObject, null, 2);
    const blob = new Blob([jsonStr], { type: "application/json" });
    const fname = `${uploadBaseName}-${Date.now()}.json`;
    const fileId = await difyUploadFile(apiBase, apiKey, userId, blob, fname);
    return difyRunWorkflowBlockingWithTypeRetry(apiBase, apiKey, userId, fileId, targetBrands);
  }

  /** @type {string[]} */
  const csvParts = [];
  for (let i = 0; i < batches.length; i++) {
    if (shouldAbort()) {
      if (csvParts.length > 0) return mergeCsvReports(csvParts);
      const err = new Error("DIFY_ABORTED");
      err.code = "DIFY_ABORTED";
      throw err;
    }
    const batchPayload = {
      ...payloadObject,
      results: batches[i],
      exportedAt: new Date().toISOString(),
      source: `${payloadObject.source || "ai-autochat-extension"}-batch-${i + 1}-of-${batches.length}`,
    };
    const jsonStr = JSON.stringify(batchPayload, null, 2);
    const blob = new Blob([jsonStr], { type: "application/json" });
    const fname = `${uploadBaseName}-batch-${i + 1}-of-${batches.length}-${Date.now()}.json`;
    const fileId = await difyUploadFile(apiBase, apiKey, userId, blob, fname);
    const csv = await difyRunWorkflowBlockingWithTypeRetry(
      apiBase,
      apiKey,
      userId,
      fileId,
      targetBrands
    );
    csvParts.push(csv);
  }
  return mergeCsvReports(csvParts);
}

/**
 * 将用户提供的 JSON 规范为工作流「解析导出 JSON」节点可识别的形状（含 results[]）。
 * 支持：扩展导出对象、任意含 results 的对象、或根为对话数组。
 * @param {unknown} parsed
 * @returns {{ exportedAt: string, source: string, site: string, results: object[] }}
 */
export function normalizeWorkflowImportJson(parsed) {
  if (parsed == null || typeof parsed !== "object") {
    throw new Error("JSON 根节点必须是对象或数组");
  }
  /** @type {unknown[]} */
  let results;
  /** @type {Record<string, unknown>} */
  let rootMeta = {};
  if (Array.isArray(parsed)) {
    results = parsed;
  } else {
    rootMeta = /** @type {Record<string, unknown>} */ (parsed);
    const r = rootMeta.results;
    if (!Array.isArray(r)) {
      throw new Error(
        "无法识别格式：需要包含 results 数组（与扩展导出一致），或文件根为对话对象数组"
      );
    }
    results = r;
  }
  if (results.length === 0) {
    throw new Error("results 为空，没有可分析的对话");
  }
  const normalizedRows = results.map((r, i) => {
    if (!r || typeof r !== "object") {
      throw new Error(`results[${i}] 不是对象`);
    }
    const row = /** @type {Record<string, unknown>} */ (r);
    return {
      question: String(row.question ?? ""),
      answer: String(row.answer ?? ""),
      capturedAt: String(row.capturedAt ?? ""),
      pageUrl: String(row.pageUrl ?? ""),
      site: String(row.site ?? ""),
      citations: Array.isArray(row.citations)
        ? row.citations.map((c) => String(c))
        : row.citations
          ? [String(row.citations)]
          : [],
    };
  });
  const metaSite =
    typeof rootMeta.site === "string" && rootMeta.site.trim()
      ? rootMeta.site
      : normalizedRows[0]?.site || "import";
  return {
    exportedAt:
      typeof rootMeta.exportedAt === "string" && rootMeta.exportedAt
        ? rootMeta.exportedAt
        : new Date().toISOString(),
    source:
      typeof rootMeta.source === "string" && rootMeta.source
        ? rootMeta.source
        : "ai-autochat-import",
    site: metaSite,
    results: normalizedRows,
  };
}
