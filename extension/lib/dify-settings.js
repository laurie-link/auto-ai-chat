/**
 * 内置 Dify 默认配置。revision 递增时会强制覆盖 chrome.storage 中的 difyApiKey。
 */
export const DIFY_DEFAULTS = {
  difyBaseUrl: "https://dify.aiexplorerxj.top",
  difyApiKey: "app-kmyivo1GHp5879hsCU8Yd06V",
  difyApiUser: "ai-autochat-extension",
};

/** 递增后：已安装用户下次启动/打开侧边栏时，storage 里的 API Key 会被替换为 DIFY_DEFAULTS.difyApiKey */
export const DIFY_API_KEY_REVISION = 1;

/**
 * 将 bundled API Key 写入 storage（覆盖旧值与缓存）。
 */
export async function migrateBundledDifyApiKey() {
  const data = await chrome.storage.local.get(["difyApiKeyRevision"]);
  const rev = Number(data.difyApiKeyRevision) || 0;
  if (rev >= DIFY_API_KEY_REVISION) return false;
  await chrome.storage.local.set({
    difyApiKey: DIFY_DEFAULTS.difyApiKey,
    difyApiKeyRevision: DIFY_API_KEY_REVISION,
  });
  return true;
}
