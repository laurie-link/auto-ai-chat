/* global globalThis */
(function () {
  if (globalThis.__AI_AUTOCHAT_DOM_UTILS) return;
  globalThis.__AI_AUTOCHAT_DOM_UTILS = true;

  /**
   * 将 DOM 子树转为保留结构的 Markdown（列表、标题、链接、粗体等）。
   * @param {Node | null | undefined} root
   * @returns {string}
   */
  function nodeToMarkdown(node) {
    if (!node) return "";
    if (node.nodeType === Node.TEXT_NODE) {
      return (node.textContent || "").replace(/\s+/g, " ");
    }
    if (!(node instanceof HTMLElement)) return "";

    const tag = node.tagName.toLowerCase();
    const children = () =>
      [...node.childNodes]
        .map((c) => nodeToMarkdown(c))
        .join("")
        .replace(/\u00a0/g, " ");

    if (tag === "br") return "\n";

    if (tag === "p" || tag === "div") {
      const inner = children().trim();
      if (!inner) return "";
      if (node.closest("li, td, th, pre, code")) return inner;
      return `${inner}\n\n`;
    }

    if (tag === "h1") return `# ${children().trim()}\n\n`;
    if (tag === "h2") return `## ${children().trim()}\n\n`;
    if (tag === "h3") return `### ${children().trim()}\n\n`;
    if (tag === "h4") return `#### ${children().trim()}\n\n`;
    if (tag === "h5") return `##### ${children().trim()}\n\n`;
    if (tag === "h6") return `###### ${children().trim()}\n\n`;

    if (tag === "strong" || tag === "b") return `**${children().trim()}**`;
    if (tag === "em" || tag === "i") return `*${children().trim()}*`;

    if (tag === "code") {
      if (node.parentElement?.tagName.toLowerCase() === "pre") return children();
      const t = children().trim();
      return t ? `\`${t}\`` : "";
    }

    if (tag === "pre") {
      const code = (node.textContent || "").replace(/\n+$/, "");
      return `\`\`\`\n${code}\n\`\`\`\n\n`;
    }

    if (tag === "a") {
      const href = node.getAttribute("href") || "";
      const text = children().trim() || href;
      if (!href || href.startsWith("#")) return text;
      return `[${text}](${href})`;
    }

    if (tag === "ul" || tag === "ol") {
      let idx = 0;
      const lines = [...node.children]
        .filter((el) => el instanceof HTMLElement && el.tagName.toLowerCase() === "li")
        .map((li) => {
          const body = nodeToMarkdown(li).trim().replace(/\n+/g, " ");
          if (!body) return "";
          if (tag === "ol") {
            idx += 1;
            return `${idx}. ${body}`;
          }
          return `- ${body}`;
        })
        .filter(Boolean);
      return lines.length ? `${lines.join("\n")}\n\n` : "";
    }

    if (tag === "li") return children().trim();

    if (tag === "blockquote") {
      const q = children().trim().replace(/\n+/g, " ");
      return q ? `> ${q}\n\n` : "";
    }

    if (tag === "hr") return "---\n\n";

    if (tag === "table") {
      const rows = [...node.querySelectorAll("tr")];
      if (!rows.length) return "";
      const mdRows = rows.map((tr) => {
        const cells = [...tr.querySelectorAll("th, td")].map((c) =>
          (c.textContent || "").trim().replace(/\|/g, "\\|")
        );
        return `| ${cells.join(" | ")} |`;
      });
      if (mdRows.length > 1) {
        const sep = `| ${mdRows[0]
          .slice(1, -1)
          .split("|")
          .map(() => "---")
          .join(" | ")} |`;
        mdRows.splice(1, 0, sep);
      }
      return `${mdRows.join("\n")}\n\n`;
    }

    return children();
  }

  /**
   * @param {HTMLElement | null | undefined} root
   * @returns {string}
   */
  function htmlToMarkdown(root) {
    if (!root) return "";
    const md = nodeToMarkdown(root)
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]+\n/g, "\n")
      .trim();
    return md;
  }

  globalThis.aiAutoChatHtmlToMarkdown = htmlToMarkdown;
})();
