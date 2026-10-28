/* panel-style.js — AI翻译专家 面板样式（content script 与 demo 预览共用）
 * 通过 window.__GT_PANEL_CSS 暴露纯 CSS 字符串，由 shadow root 的 adoptedStyleSheets 载入，
 * 不向宿主页面注入 <style> 标签，因此不受页面 CSP 限制。
 */
(function () {
  'use strict';

  var CSS = String.raw`
:host {
  --gt-bg: #ffffff;
  --gt-bg-soft: #f6f8fa;
  --gt-fg: #1f2328;
  --gt-muted: #6b7280;
  --gt-faint: #9aa3ad;
  --gt-line: #e4e7eb;
  --gt-line-strong: #d3d9e0;
  --gt-accent: #1a73e8;
  --gt-accent-soft: #edf3ff;
  --gt-err: #d93025;
  --gt-radius: 12px;
  --gt-shadow: 0 12px 32px rgba(16, 24, 40, 0.14), 0 2px 6px rgba(16, 24, 40, 0.06);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
    "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif;
  font-size: 14px;
  line-height: 1.5;
  color: var(--gt-fg);
  -webkit-font-smoothing: antialiased;
}

@media (prefers-color-scheme: dark) {
  :host {
    --gt-bg: #1b1e23;
    --gt-bg-soft: #23272e;
    --gt-fg: #e7eaee;
    --gt-muted: #9aa3ad;
    --gt-faint: #767e88;
    --gt-line: #31363d;
    --gt-line-strong: #3d434b;
    --gt-accent: #8ab4f8;
    --gt-accent-soft: #1e2c3d;
    --gt-err: #f28b82;
    --gt-shadow: 0 14px 36px rgba(0, 0, 0, 0.55), 0 2px 6px rgba(0, 0, 0, 0.4);
  }
}

*, *::before, *::after { box-sizing: border-box; }

button { font-family: inherit; }

/* ---------------- 划词浮标 ---------------- */
.gt-btn {
  position: fixed;
  z-index: 2;
  width: 30px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1px solid var(--gt-line-strong);
  border-radius: 9px;
  background: var(--gt-bg);
  box-shadow: 0 2px 10px rgba(16, 24, 40, 0.16);
  cursor: pointer;
  pointer-events: auto;
  user-select: none;
  transition: transform 0.12s ease, box-shadow 0.12s ease, border-color 0.12s ease;
}
.gt-btn:hover {
  transform: translateY(-1px);
  border-color: var(--gt-accent);
  box-shadow: 0 5px 16px rgba(16, 24, 40, 0.22);
}
.gt-btn:active { transform: translateY(0); }
.gt-btn .gt-btn-glyph {
  font-size: 14px;
  font-weight: 700;
  line-height: 1;
  color: var(--gt-accent);
  letter-spacing: 0;
  transform: translateY(0.5px);
}
.gt-btn[hidden] { display: none; }

/* ---------------- 翻译卡片 ---------------- */
.gt-card {
  position: fixed;
  z-index: 3;
  width: 384px;
  max-width: calc(100vw - 24px);
  max-height: min(62vh, 540px);
  display: flex;
  flex-direction: column;
  background: var(--gt-bg);
  border: 1px solid var(--gt-line);
  border-radius: var(--gt-radius);
  box-shadow: var(--gt-shadow);
  pointer-events: auto;
  overflow: hidden;
  animation: gt-pop 0.14s cubic-bezier(0.2, 0.7, 0.3, 1);
}
.gt-card[hidden] { display: none; }

@keyframes gt-pop {
  from { opacity: 0; transform: translateY(-4px) scale(0.99); }
  to { opacity: 1; transform: none; }
}

/* 头部 */
.gt-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 8px 8px 12px;
  border-bottom: 1px solid var(--gt-line);
  background: var(--gt-bg);
  flex: 0 0 auto;
}
.gt-langs {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex: 1 1 auto;
}
.gt-src {
  font-size: 12px;
  color: var(--gt-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 96px;
}
.gt-arrow {
  color: var(--gt-faint);
  flex: 0 0 auto;
  display: flex;
}
.gt-target {
  appearance: none;
  -webkit-appearance: none;
  border: 1px solid transparent;
  background-color: transparent;
  background-image: url("data:image/svg+xml;charset=utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 10 10'%3E%3Cpath d='M2 3.5L5 6.5L8 3.5' fill='none' stroke='%236b7280' stroke-width='1.3' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 6px center;
  background-size: 10px 10px;
  color: var(--gt-fg);
  font-size: 12.5px;
  font-weight: 600;
  padding: 4px 20px 4px 6px;
  border-radius: 6px;
  cursor: pointer;
  max-width: 168px;
  transition: background-color 0.12s ease, border-color 0.12s ease;
}
.gt-target:hover { background-color: var(--gt-bg-soft); border-color: var(--gt-line); }
.gt-target:focus { outline: 2px solid var(--gt-accent-soft); border-color: var(--gt-accent); }

.gt-head-acts {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: 0 0 auto;
}

.gt-icon {
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--gt-muted);
  cursor: pointer;
  flex: 0 0 auto;
  transition: background-color 0.12s ease, color 0.12s ease;
}
.gt-icon:hover { background: var(--gt-bg-soft); color: var(--gt-fg); }
.gt-icon:active { background: var(--gt-line); }
.gt-icon.is-on { color: var(--gt-accent); background: var(--gt-accent-soft); }
.gt-icon svg { display: block; }

/* 正文 */
.gt-body {
  padding: 12px 14px 10px;
  overflow-y: auto;
  overscroll-behavior: contain;
  flex: 1 1 auto;
}
.gt-out {
  font-size: 16px;
  line-height: 1.66;
  color: var(--gt-fg);
  word-break: break-word;
  white-space: pre-wrap;
  min-height: 24px;
  user-select: text;
  cursor: text;
}
.gt-out.is-loading {
  color: var(--gt-muted);
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 22px;
}
.gt-out.is-loading::before {
  content: "";
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 2px solid var(--gt-line-strong);
  border-top-color: var(--gt-accent);
  animation: gt-spin 0.7s linear infinite;
  flex: 0 0 auto;
}
@keyframes gt-spin { to { transform: rotate(360deg); } }
.gt-out.is-error { color: var(--gt-err); font-size: 13px; line-height: 1.6; }

.gt-orig-block {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--gt-line);
}
.gt-orig-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}
.gt-orig-label {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--gt-faint);
  text-transform: uppercase;
}
.gt-orig-edit {
  border: none;
  background: none;
  padding: 0;
  font-size: 11.5px;
  color: var(--gt-faint);
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.gt-orig-edit:hover { color: var(--gt-accent); }
.gt-orig {
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--gt-muted);
  max-height: 108px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
  user-select: text;
}
.gt-input {
  display: block;
  width: 100%;
  min-height: 68px;
  max-height: 160px;
  resize: vertical;
  padding: 8px 10px;
  border: 1px solid var(--gt-line-strong);
  border-radius: 8px;
  background: var(--gt-bg-soft);
  color: var(--gt-fg);
  font-family: inherit;
  font-size: 12.5px;
  line-height: 1.6;
}
.gt-input:focus { outline: none; border-color: var(--gt-accent); background: var(--gt-bg); }
.gt-input[hidden] { display: none; }

/* 底部 */
.gt-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px 6px 14px;
  border-top: 1px solid var(--gt-line);
  background: var(--gt-bg);
  flex: 0 0 auto;
}
.gt-brand {
  font-size: 11px;
  color: var(--gt-faint);
  white-space: nowrap;
  flex: 0 0 auto;
}
.gt-status {
  font-size: 11px;
  color: var(--gt-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1 1 auto;
  text-align: right;
  padding-right: 2px;
}
.gt-foot-acts { display: flex; align-items: center; gap: 2px; flex: 0 0 auto; }

/* 轻提示 */
.gt-toast {
  position: fixed;
  z-index: 4;
  left: 50%;
  top: 18px;
  display: flex;
  align-items: center;
  gap: 2px;
  transform: translate(-50%, -6px);
  padding: 8px 14px;
  border-radius: 8px;
  background: rgba(32, 36, 42, 0.94);
  color: #fff;
  font-size: 12.5px;
  line-height: 1.4;
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.25);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.16s ease, transform 0.16s ease;
  max-width: min(380px, calc(100vw - 32px));
}
.gt-toast.is-show { opacity: 1; transform: translate(-50%, 0); }
.gt-toast-act {
  margin-left: 10px;
  padding: 2px 9px;
  border: 1px solid rgba(255, 255, 255, 0.34);
  border-radius: 5px;
  background: transparent;
  color: #fff;
  font-family: inherit;
  font-size: 12px;
  line-height: 1.5;
  cursor: pointer;
  white-space: nowrap;
  pointer-events: auto;
}
.gt-toast-act:hover { background: rgba(255, 255, 255, 0.16); }
.gt-toast[hidden] { display: none; }

/* 窄屏适配 */
@media (max-width: 460px) {
  .gt-card { width: calc(100vw - 16px); max-height: 70vh; }
}
`;

  try {
    window.__GT_PANEL_CSS = CSS;
  } catch (e) {
    /* 非浏览器环境忽略 */
  }
})();
