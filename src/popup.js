/* popup.js — 扩展弹窗 */
'use strict';

const DEFAULTS = {
  targetLang: 'zh-CN',
  showBubble: true,
  autoTranslate: false,
  autoPage: true,
  bilingual: false
};
const LOCAL_DEFAULTS = { aiEnabled: false, nonAiEnabled: true };

const $ = (id) => document.getElementById(id);
let pageTimer = 0;
let engineInfo = null;

function fillLangs(select, current) {
  const list = window.__GT_LANGS || [];
  select.innerHTML = '';
  for (const [code, name] of list) {
    const o = document.createElement('option');
    o.value = code;
    o.textContent = name;
    select.appendChild(o);
  }
  select.value = current || 'zh-CN';
}

function tip(text, warn) {
  const el = $('tip');
  el.textContent = text;
  el.classList.toggle('is-warn', !!warn);
}

function resetTip() {
  tip('快捷键 Alt+T · 右键菜单「翻译所选文字」');
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab && tab.id >= 0 ? tab : null;
}

/* -------------------------------------------------------------- 引擎开关 */

const DOMESTIC_TAG = {
  builtin: '国内接口',
  baidu: '国内·百度',
  youdao: '国内·有道',
  tencent: '国内·腾讯云'
};

function nonAiChannelLabel(info) {
  if (!info) return '非 AI';
  if (info.nonAiChannel === 'domestic') {
    return DOMESTIC_TAG[info.domesticProvider] || '国内接口';
  }
  return '免费接口';
}

function engineHintText(info) {
  if (!info) return '检测网络环境…';
  if (info.aiEnabled || info.channel === 'ai') return 'AI 独占 · 非 AI 接口已关闭';
  const net = info.net || {};
  const fb = info.fallback || null;
  if (info.channel === 'domestic') {
    if (fb && fb.reason === 'rate-limit' && Date.now() - fb.at < 10 * 60 * 1000) {
      return 'Google 免费接口限流 · 已切到国内接口';
    }
    if (net.googleReachable === false) return '未检测到 Google 直连 · 已用国内接口';
    if (info.nonAiPreference === 'domestic') return '已固定使用国内接口';
    return '当前使用国内接口';
  }
  if (net.googleReachable === true) return '已检测到 Google 直连 · 使用免费接口';
  return '正在检测网络环境…';
}

function renderEngine() {
  const aiOn = $('aiEnabled').checked;
  const nonAiOn = $('nonAiEnabled').checked;
  const aiTag = $('aiTag');
  const nonTag = $('nonAiTag');

  const configured = !!(engineInfo && engineInfo.aiConfigured);
  if (!configured) {
    aiTag.textContent = '未配置';
    aiTag.className = 'tag' + (aiOn ? ' is-warn' : '');
  } else {
    aiTag.textContent = (engineInfo && engineInfo.aiModel) || '已配置';
    aiTag.className = 'tag' + (aiOn ? ' is-on' : '');
  }

  nonTag.textContent = nonAiChannelLabel(engineInfo);
  nonTag.className = 'tag' + (nonAiOn ? ' is-on' : '');

  const hintEl = $('engineHint');
  if (hintEl) {
    const text = engineHintText(engineInfo);
    hintEl.textContent = text;
    hintEl.classList.toggle('is-warn', /切到国内|切国内|未检测到 Google|限流/.test(text));
  }
}

async function loadEngineInfo() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    if (res && res.ok && res.config) engineInfo = res.config;
  } catch (e) { /* 后台未就绪时沿用旧值 */ }
  renderEngine();
}

function openAiOptions() {
  chrome.tabs.create({ url: chrome.runtime.getURL('options.html#ai') });
  window.close();
}

async function setEngine(mode) {
  const toAi = mode === 'ai';
  if (toAi && !(engineInfo && engineInfo.aiConfigured)) {
    $('aiEnabled').checked = false;
    tip('AI 尚未配置：先在设置里选服务商并填入密钥', true);
    setTimeout(openAiOptions, 900);
    return;
  }
  await chrome.storage.local.set({ aiEnabled: toAi, nonAiEnabled: !toAi });
  $('aiEnabled').checked = toAi;
  $('nonAiEnabled').checked = !toAi;
  await loadEngineInfo();
  tip(toAi ? '已切换到 AI 翻译' : '已切换回' + nonAiChannelLabel(engineInfo) + '翻译');
}

/* ---------------------------------------------------------- 当前页面状态 */

function setPage(hint, btn) {
  $('pageHint').textContent = hint;
  const el = $('pageAction');
  el.textContent = (btn && btn.label) || '翻译此页';
  el.dataset.action = (btn && btn.action) || '';
  el.disabled = !!(btn && btn.disabled);
}

function langName(code) {
  if (!code || code === 'und') return '未知语言';
  const map = window.__GT_LANG_NAME || {};
  return map[code] || String(code).toUpperCase();
}

function renderPage(st) {
  if (!st || !st.ok) {
    setPage('无法读取页面状态', { label: '翻译此页', disabled: true });
    return;
  }
  if (st.excluded) {
    setPage('已在排除列表中', { label: '翻译此页', disabled: true });
    return;
  }
  if (st.running) {
    setPage('正在翻译，进度见页面顶部', { label: '翻译中', disabled: true });
    return;
  }
  if (st.translated) {
    setPage('已翻译' + (st.bilingual ? '（双语对照）' : '') + ' · ' + st.segments + ' 段',
      { label: '显示原文', action: 'restore' });
    return;
  }
  if (st.detected && st.detected.isChinese) {
    setPage('中文页面 · 无需翻译', { label: '重新检测', action: 'translate' });
    return;
  }
  setPage(langName(st.detected && st.detected.code) + ' · 未翻译', { label: '翻译此页', action: 'translate' });
}

async function initPage() {
  const tab = await getActiveTab();
  if (!tab) {
    setPage('当前页面不可用', { label: '翻译此页', disabled: true });
    return;
  }
  try {
    const st = await chrome.tabs.sendMessage(tab.id, { type: 'PAGE_STATE' });
    renderPage(st);
  } catch (e) {
    setPage('该页面不允许脚本注入（chrome:// 或商店页）', { label: '翻译此页', disabled: true });
  }
}

async function onPageAction() {
  const tab = await getActiveTab();
  if (!tab) return;
  const action = $('pageAction').dataset.action;

  if (action === 'restore') {
    try { await chrome.tabs.sendMessage(tab.id, { type: 'PAGE_RESTORE' }); } catch (e) { /* ignore */ }
    setTimeout(initPage, 300);
    return;
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'PAGE_TRANSLATE' });
  } catch (e) {
    setPage('该页面不允许脚本注入', { label: '翻译此页', disabled: true });
    return;
  }

  setPage('正在翻译，进度见页面顶部', { label: '翻译中', disabled: true });
  clearInterval(pageTimer);
  let tries = 0;
  pageTimer = setInterval(async () => {
    tries += 1;
    if (tries > 60) { clearInterval(pageTimer); initPage(); return; }
    try {
      const st = await chrome.tabs.sendMessage(tab.id, { type: 'PAGE_STATE' });
      if (st && !st.running) { clearInterval(pageTimer); renderPage(st); }
    } catch (e) {
      clearInterval(pageTimer);
    }
  }, 700);
}

/* -------------------------------------------------------------- 初始化 */

let inited = false;

async function init() {
  if (inited) return;
  inited = true;
  $('ver').textContent = chrome.runtime.getManifest().version;

  const saved = await chrome.storage.sync.get(DEFAULTS);
  const local = await chrome.storage.local.get(LOCAL_DEFAULTS);

  fillLangs($('target'), saved.targetLang);
  $('bubble').checked = saved.showBubble !== false;
  $('auto').checked = saved.autoTranslate === true;
  $('autoPage').checked = saved.autoPage !== false;
  $('bilingual').checked = saved.bilingual === true;
  $('aiEnabled').checked = local.aiEnabled === true;
  $('nonAiEnabled').checked = local.nonAiEnabled !== false;
  renderEngine();

  $('target').addEventListener('change', (e) => {
    chrome.storage.sync.set({ targetLang: e.target.value });
  });

  $('bubble').addEventListener('change', (e) => {
    chrome.storage.sync.set({ showBubble: e.target.checked });
  });

  $('auto').addEventListener('change', (e) => {
    chrome.storage.sync.set({ autoTranslate: e.target.checked });
    if (e.target.checked && !$('bubble').checked) {
      $('bubble').checked = true;
      chrome.storage.sync.set({ showBubble: true });
    }
  });

  $('autoPage').addEventListener('change', (e) => {
    chrome.storage.sync.set({ autoPage: e.target.checked });
    clearInterval(pageTimer);
    setTimeout(initPage, 400);
  });

  $('bilingual').addEventListener('change', (e) => {
    chrome.storage.sync.set({ bilingual: e.target.checked });
    clearInterval(pageTimer);
    setTimeout(initPage, 500);
  });

  // 两个引擎开关互斥，状态与设置页共用同一份存储
  $('aiEnabled').addEventListener('change', (e) => {
    setEngine(e.target.checked ? 'ai' : 'nonai');
  });
  $('nonAiEnabled').addEventListener('change', (e) => {
    setEngine(e.target.checked ? 'nonai' : 'ai');
  });

  $('translateNow').addEventListener('click', translateNow);
  $('pageAction').addEventListener('click', onPageAction);
  $('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('openAi').addEventListener('click', openAiOptions);
  $('openShortcuts').addEventListener('click', async () => {
    try {
      await chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
      window.close();
    } catch (e) {
      tip('请在地址栏打开 chrome://extensions/shortcuts', true);
    }
  });

  // 设置页改动后弹窗若仍打开，保持同步
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
      if ('aiEnabled' in changes) $('aiEnabled').checked = changes.aiEnabled.newValue === true;
      if ('nonAiEnabled' in changes) $('nonAiEnabled').checked = changes.nonAiEnabled.newValue !== false;
      renderEngine();
    } else if (area === 'sync') {
      if ('bilingual' in changes) $('bilingual').checked = changes.bilingual.newValue === true;
      if ('autoPage' in changes) $('autoPage').checked = changes.autoPage.newValue !== false;
    }
  });

  await loadEngineInfo();
  if (!engineInfo || !engineInfo.net || engineInfo.net.googleReachable === null) {
    setTimeout(loadEngineInfo, 1600);
  }
  resetTip();
  initPage();
}

async function translateNow() {
  const tab = await getActiveTab();
  if (!tab) {
    tip('当前页面不支持翻译', true);
    return;
  }
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'TRANSLATE_SELECTION' });
    if (res && res.ok) {
      window.close();
    } else {
      tip((res && res.error) || '请先在页面上选中文字', true);
    }
  } catch (e) {
    tip('该页面不允许注入脚本（如 chrome:// 或商店页面）', true);
  }
}

document.addEventListener('DOMContentLoaded', init);
