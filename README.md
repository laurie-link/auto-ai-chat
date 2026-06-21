# AI AutoChat — Brand Visibility

Chrome 浏览器扩展：按预设问题批量访问各 AI 站点，自动开启新对话、发送问题、采集回答与引用链接，并可选上传至 **Dify** 工作流生成品牌可见度 CSV 报告。

---

## 重要提醒

### 必须保持 AI 标签页在前台

采集依赖内容脚本在 **Gemini / ChatGPT / Perplexity** 页面内模拟输入、等待回复、提取引用。Chrome 与各家 AI 站点都会对**后台标签**做节流或暂停流式输出。

**运行任务期间，请让当前正在采集的 AI 标签页保持在前台（可见、处于激活状态）。** 切换到其他标签页或最小化浏览器窗口，可能导致任务卡住、超时或采集不完整。侧边栏可以关闭或切到别的页面，但 **AI 站点标签页本身需要留在前台**。

### 多平台连续运行（实验功能）

勾选多个平台后按 **Gemini → ChatGPT → Perplexity** 顺序连续执行，属于**实验功能**，可能存在进度衔接、Dify 等待、停止恢复等方面的 bug。若遇到问题，建议改为**每次只勾选一个平台**运行。

### 其他注意事项

- 采集中请勿在 `chrome://extensions` **手动重载扩展**，否则内存中的任务会中断（扩展会尽量恢复已落盘的进度并下载部分 CSV）。
- 首次使用前请先在对应 AI 站点**登录账号**。
- Dify 工作流需自行部署并导入 DSL，见 [`extension/dify/README.md`](extension/dify/README.md)。

---

## 功能概览

| 功能 | 说明 |
|------|------|
| 批量提问 | 侧边栏文本框每行一个问题，自动逐题采集 |
| 多平台支持 | **Gemini**、**ChatGPT**、**Perplexity**（UI 可选）；代码另含 Google **AI Overview / AI Mode** 采集能力 |
| 新对话 | 每题自动开启新对话，避免上下文串题 |
| 回答采集 | 保留 Markdown 结构（标题、列表、粗体、链接等） |
| 引用链接 | 采集回答中的引用 URL（含 Gemini 行内来源 chip 等） |
| 侧边栏界面 | 点击扩展图标打开右侧侧边栏，进度写入 storage，关闭后重开可恢复状态 |
| 停止任务 | 运行中可点「停止」；已采集部分会尝试保存并下载占位 CSV |
| 超时重试 | 单题等待超时自动刷新页面重试，最多 3 次；仍失败则报错并下载已完成进度 |
| 进度落盘 | 每完成一题写入本地 storage，扩展意外中断后可恢复部分结果 |
| Dify 品牌分析 | 采集完成后可选自动上传 JSON 至 Dify，输出带 LLM 分析列的 CSV |
| 占位 CSV | Dify 失败时自动下载同表头 CSV（LLM 列为空） |
| 补跑 Dify | 上传占位 CSV，无需重新采集即可补跑 Dify 填全 LLM 列 |
| 多平台连续跑 | 勾选多个平台按固定顺序依次跑完（**实验功能**） |
| 调试日志 | 设置页可查看、清空、导出 JSON 日志 |

---

## 安装

1. 克隆或下载本仓库。
2. 打开 Chrome → `chrome://extensions` → 开启**开发者模式**。
3. 点击**加载已解压的扩展程序**，选择项目根目录（含 `manifest.json` 的目录）。
4. 点击工具栏扩展图标，打开**侧边栏**。

> 仓库中 `extension/` 目录为与根目录同步的副本，加载根目录或 `extension/` 均可，开发时请保持两处一致。

---

## 使用说明

### 1. 准备问题

在侧边栏 **运行** 页输入问题，**每行一个**。

### 2. 选择平台并运行

- 勾选 **Gemini** / **ChatGPT** / **Perplexity**（可多选）。
- 点击 **运行已选平台**。
- 多选时执行顺序：**Gemini → ChatGPT → Perplexity**（仅运行已勾选项）。

### 3. Dify 相关（可选）

**运行** 页：

- **采集完成后自动上传 Dify**：勾选后每批采集结束会上传 Dify；取消则仅本地采集。
- **target_brands**：传给 Dify 工作流的目标品牌，逗号分隔，如 `Nike,Adidas`。

**设置** 页：

- **API 根地址**、**API Key**、**API user**：Dify 工作流 API 配置。

Dify 导入与 API 契约见 [`extension/dify/README.md`](extension/dify/README.md)。推荐使用 `brand-visibility-workflow-llm.yml`。

### 4. Dify 失败时补跑

采集成功但 Dify 失败时，扩展会自动下载 **占位 CSV**。之后可在侧边栏点击 **上传占位 CSV 补跑 Dify**，选择该文件重新走 Dify 流程，无需重新采集。

### 5. 输出 CSV 表头（13 列）

| 列名 | 说明 |
|------|------|
| Query | 问题 |
| Date Checked | 采集日期 |
| Platform | 平台（gemini / chatgpt / perplexity 等） |
| Brand Mentioned | 是否提及品牌（Dify LLM） |
| No. of Brands Mentioned | 提及品牌数 |
| Brands Mentioned | 品牌列表 |
| Share Calculation | 份额计算 |
| Sentiment | 情感 |
| Notes | 备注 |
| Assistant Answer | 完整回答 |
| Citations | 引用链接（多条换行） |
| Page URL | 对话页 URL |
| Captured At | ISO 采集时间 |

占位 CSV 中 LLM 相关列为空；Dify 成功后下载完整 CSV。

---

## 项目结构

```
AI-autochat/
├── manifest.json           # 扩展清单
├── background/
│   └── service-worker.js   # 任务队列、Dify、下载 CSV
├── content/
│   ├── gemini.js           # Gemini 自动化
│   ├── chatgpt.js          # ChatGPT 自动化
│   ├── perplexity.js       # Perplexity 自动化
│   ├── google-search.js    # Google AIO / AI Mode
│   ├── page-keepalive.js   # 后台标签保活（效果有限）
│   └── dom-utils.js        # HTML → Markdown
├── popup/                  # 侧边栏 UI
├── lib/
│   ├── dify-workflow.js    # Dify API 与分批上传
│   ├── brand-report-csv.js # CSV 构建与解析
│   └── logger.js           # 调试日志
├── extension/              # 与根目录同步的扩展副本
└── extension/dify/         # Dify 工作流 DSL 与说明
```

---

## 开发与调试

- **日志**：侧边栏 → 设置 → 日志 → 刷新 / 导出 JSON。
- **Service Worker 控制台**：`chrome://extensions` → 本扩展 → 「Service Worker」链接。
- 修改代码后需在扩展管理页**重新加载扩展**；采集中重载会中断任务。
- Dify 单次工作流建议不超过 29 条；扩展会自动分批上传。

---

## 许可证

见仓库根目录及子目录中的许可证文件（如有）。
