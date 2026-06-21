/**
 * 与 Dify LLM 工作流 brand-visibility-workflow-llm.yml 对齐的 CSV 表头。
 * 采集成功 + Dify 失败时下载占位 CSV；Dify 成功后由工作流输出同结构完整 CSV。
 */
export const BRAND_REPORT_CSV_HEADERS = [
  "Query",
  "Date Checked",
  "Platform",
  "Brand Mentioned",
  "No. of Brands Mentioned",
  "Brands Mentioned",
  "Share Calculation",
  "Sentiment",
  "Notes",
  "Assistant Answer",
  "Citations",
  "Page URL",
  "Captured At",
];

/** @param {string} iso */
export function isoToUsDate(iso) {
  const s = String(iso || "").trim();
  if (!s) return "";
  let norm = s;
  if (norm.endsWith("Z")) norm = `${norm.slice(0, -1)}+00:00`;
  let dt;
  try {
    dt = new Date(norm);
  } catch {
    return "";
  }
  if (Number.isNaN(dt.getTime())) return "";
  return `${dt.getMonth() + 1}/${dt.getDate()}/${dt.getFullYear()}`;
}

/** @param {unknown} citations */
export function formatCitationsCell(citations) {
  if (Array.isArray(citations)) {
    return citations.map((x) => String(x).trim()).filter(Boolean).join("\n");
  }
  return String(citations ?? "").trim();
}

/** @param {unknown} value */
function escapeCsvCell(value) {
  const s = String(value ?? "");
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** @param {unknown[]} values */
function csvRow(values) {
  return values.map(escapeCsvCell).join(",");
}

/**
 * Dify 失败时的占位 CSV：采集字段有值，LLM 分析列留空。
 * @param {object[]} results
 * @param {string} [defaultSite]
 */
export function buildStubBrandReportCsv(results, defaultSite = "unknown") {
  const rows = Array.isArray(results) ? results : [];
  const lines = [csvRow(BRAND_REPORT_CSV_HEADERS)];
  for (const r of rows) {
    const site = String(r?.site ?? defaultSite);
    const capturedAt = String(r?.capturedAt ?? "");
    lines.push(
      csvRow([
        String(r?.question ?? ""),
        isoToUsDate(capturedAt),
        site,
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
      ])
    );
  }
  return `\uFEFF${lines.join("\n")}\n`;
}

/**
 * 解析占位 CSV（或 Dify 成功 CSV）为 results[]，供补跑 Dify。
 * @param {string} csvText
 */
export function parseBrandReportCsvToResults(csvText) {
  const rows = parseCsvRecords(String(csvText || "").replace(/^\uFEFF/, ""));
  if (rows.length === 0) {
    throw new Error("CSV 为空");
  }
  const header = rows[0].map((h) => String(h).trim());
  const idx = (name) => header.findIndex((h) => h.toLowerCase() === name.toLowerCase());

  const iQuery = idx("Query");
  const iAnswer = idx("Assistant Answer");
  const iPlatform = idx("Platform");
  const iCaptured = idx("Captured At");
  const iPageUrl = idx("Page URL");
  const iCitations = idx("Citations");

  if (iQuery < 0 || iAnswer < 0) {
    throw new Error("CSV 缺少 Query / Assistant Answer 列，请使用扩展导出的 Brand Visibility CSV");
  }

  /** @type {object[]} */
  const results = [];
  let site = "import";
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row.some((c) => String(c).trim())) continue;
    const question = String(row[iQuery] ?? "").trim();
    const answer = String(row[iAnswer] ?? "").trim();
    if (!question && !answer) continue;
    const rowSite = iPlatform >= 0 ? String(row[iPlatform] ?? "").trim() : "";
    if (rowSite) site = rowSite;
    const capturedAt = iCaptured >= 0 ? String(row[iCaptured] ?? "").trim() : "";
    const pageUrl = iPageUrl >= 0 ? String(row[iPageUrl] ?? "").trim() : "";
    const citationsRaw = iCitations >= 0 ? String(row[iCitations] ?? "").trim() : "";
    const citations = citationsRaw
      ? citationsRaw
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    results.push({
      question,
      answer,
      site: rowSite || site,
      capturedAt,
      pageUrl,
      citations,
    });
  }
  if (results.length === 0) {
    throw new Error("CSV 中没有可补跑的数据行");
  }
  return { site, results };
}

/**
 * @param {string} text
 * @returns {string[][]}
 */
function parseCsvRecords(text) {
  /** @type {string[][]} */
  const records = [];
  /** @type {string[]} */
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      cell = "";
      if (row.length > 1 || row[0] !== "") records.push(row);
      row = [];
    } else if (ch === "\r") {
      /* skip */
    } else {
      cell += ch;
    }
  }
  row.push(cell);
  if (row.length > 1 || row[0] !== "") records.push(row);
  return records;
}
