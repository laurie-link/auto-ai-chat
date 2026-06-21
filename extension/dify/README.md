# Dify 工作流：Brand Visibility Report

与 **AI AutoChat** 扩展（`extension/lib/dify-workflow.js`）配套的 Dify **工作流应用** DSL。

## 导入步骤

1. 登录 Dify 控制台 → **工作室** → **导入 DSL**（或创建应用 → 导入）。
2. 选择 `brand-visibility-workflow.yml`。
3. 打开应用 → **发布** → **访问 API** → 复制 **API 根地址** 与 **API Key**（`app-` 开头）。
4. 填回扩展弹窗 **设置**；**运行** 页填写 `target_brands`（逗号分隔，如 `Nike,Adidas`）。

## 与扩展的契约

| 项目 | 值 |
|------|-----|
| 工作流输入 `target_brands` | 文本 |
| 工作流输入 `export_file` | 单文件（扩展上传的 JSON，`type: custom`） |
| 工作流输出 `csv_report` | 文本（CSV 正文） |
| API | `POST /v1/files/upload` → `POST /v1/workflows/run`（`response_mode: blocking`） |

## 说明

- **推荐导入** `brand-visibility-workflow-llm.yml`：含 LLM 品牌分析；CSV 表头与扩展占位 CSV 一致（含 Citations / Page URL / Captured At）。
- 采集成功但 Dify 失败时，扩展会自动下载**同表头占位 CSV**（LLM 列为空），可用侧边栏「上传占位 CSV 补跑 Dify」补全。
- 扩展侧超过 29 条自动分批上传 Dify，避免迭代上限导致整批失败。
- 导入后 API Key 与旧服务器不同，扩展里 401 时需更新 Key。

## 关闭自动上传 Dify

运行页勾选 **「采集完成后自动上传 Dify」** 即可控制是否在采集结束后调用 Dify 工作流。取消勾选后仅本地采集，不会上传 Dify。
