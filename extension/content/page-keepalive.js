/**
 * MAIN world @ document_start：后台标签页仍让 AI 站点继续生成。
 * - 伪装 Page Visibility / hasFocus
 * - 拦截 visibilitychange 等监听（ChatGPT 靠此暂停流式输出）
 * - 静音循环音频（减轻 Chrome 后台标签计时器节流）
 */
(function () {
  if (globalThis.__AI_AUTOCHAT_PAGE_KEEPALIVE__) return;
  globalThis.__AI_AUTOCHAT_PAGE_KEEPALIVE__ = true;

  const visible = () => "visible";
  const notHidden = () => false;
  const focused = () => true;

  /** @param {object | null | undefined} target */
  function patchVisibility(target) {
    if (!target) return;
    try {
      Object.defineProperty(target, "visibilityState", { get: visible, configurable: true });
      Object.defineProperty(target, "hidden", { get: notHidden, configurable: true });
      Object.defineProperty(target, "webkitHidden", { get: notHidden, configurable: true });
    } catch (_) {
      /* ignore */
    }
    try {
      Object.defineProperty(target, "hasFocus", { value: focused, configurable: true });
    } catch (_) {
      /* ignore */
    }
  }

  patchVisibility(typeof Document !== "undefined" ? Document.prototype : null);
  if (typeof document !== "undefined") {
    patchVisibility(document);
    try {
      patchVisibility(Object.getPrototypeOf(document));
    } catch (_) {
      /* ignore */
    }
  }

  /** 阻止 visibilitychange 传到站点（capture 阶段最早注册） */
  try {
    const swallow = (e) => {
      e.stopImmediatePropagation();
    };
    document.addEventListener("visibilitychange", swallow, true);
    window.addEventListener("pagehide", swallow, true);
    window.addEventListener("blur", swallow, true);
    document.addEventListener("freeze", swallow, true);
  } catch (_) {
    /* ignore */
  }

  /** 阻止站点后续注册 visibility / blur 回调 */
  try {
    const origAdd = EventTarget.prototype.addEventListener;
    const blocked = new Set([
      "visibilitychange",
      "pagehide",
      "freeze",
      "resume",
      "blur",
      "focus",
    ]);
    EventTarget.prototype.addEventListener = function patchedAdd(type, listener, options) {
      if (blocked.has(String(type))) return;
      return origAdd.call(this, type, listener, options);
    };
  } catch (_) {
    /* ignore */
  }

  function startSilentAudio() {
    if (globalThis.__AI_AUTOCHAT_SILENT_AUDIO__) return;
    globalThis.__AI_AUTOCHAT_SILENT_AUDIO__ = true;

    try {
      const audio = document.createElement("audio");
      audio.loop = true;
      audio.muted = true;
      audio.volume = 0;
      audio.setAttribute("playsinline", "");
      audio.src =
        "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQQAAAAAAA==";
      audio.style.cssText = "position:fixed;width:0;height:0;opacity:0;pointer-events:none";
      const root = document.documentElement || document.body;
      if (root) root.appendChild(audio);
      const p = audio.play();
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch (_) {
      /* ignore */
    }

    try {
      const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0.00001;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(0);
      globalThis.__AI_AUTOCHAT_AUDIO_CTX__ = ctx;
      if (ctx.state === "suspended") ctx.resume().catch(() => {});
    } catch (_) {
      /* ignore */
    }
  }

  if (document.documentElement) {
    startSilentAudio();
  } else {
    document.addEventListener("readystatechange", () => {
      if (document.documentElement) startSilentAudio();
    });
  }

  setInterval(() => {
    try {
      const ctx = globalThis.__AI_AUTOCHAT_AUDIO_CTX__;
      if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
    } catch (_) {
      /* ignore */
    }
  }, 15000);
})();
