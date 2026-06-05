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

- 当前 DSL 使用 **文档提取器 + 代码节点** 做品牌命中统计，**不依赖外部 LLM**，导入即可跑通。
- 若需语义分析，可在 Dify 里在「文档提取器」与「结束」之间再加 **LLM** 节点，并把结束节点的 `csv_report` 改接 LLM 输出。
- 导入后 API Key 与旧服务器不同，扩展里 401 时需更新 Key。

## 关闭自动上传 Dify

`Z:\临时\extension` 版本会在每次打开弹窗时执行 `difyWorkflowEnabled: true`。若只想本地采集：

- 在 `popup.js` 的 `loadDifySettings` / `persistDifySettings` 中去掉强制 `true`，或
- 使用本仓库 `extension/` 中带复选框「采集完成后自动跑 Dify」的版本。
