/* options.js — 设置页 */
'use strict';

const SYNC_DEFAULTS = { targetLang: 'zh-CN', showBubble: true, autoTranslate: false, autoPage: true, bilingual: false, cacheScope: 'global', nonAiPreference: 'auto', excludeSites: [] };
const $ = (id) => document.getElementById(id);

let saveTimer = 0;
let lastState = null;
let savedDomestic = { provider: 'builtin' };

function flashSaved(text, warn) {
  const el = $('saveState');
  el.textContent = text || '已保存';
  el.classList.remove('is-saved', 'is-warn');
  el.classList.add(warn ? 'is-warn' : 'is-saved');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    el.classList.remove('is-saved', 'is-warn');
    el.textContent = '修改会自动保存';
  }, 2200);
}

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

function parseSites(raw) {
  return String(raw || '')
    .split(/[\n,，;；\s]+/)
    .map((s) => s.trim().toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, ''))
    .filter(Boolean)
    .filter((v, i, arr) => arr.indexOf(v) === i);
}

function channelLabel(ch) {
  if (ch === 'ai') return 'AI 翻译';
  if (ch === 'domestic') return '国内接口';
  return '免费接口（Google）';
}

function renderChannel(cfg) {
  const badge = $('channelBadge');
  const hint = $('channelHint');
  const ch = cfg && cfg.channel ? cfg.channel : 'google';
  const net = cfg && cfg.net ? cfg.net : null;
  const fb = cfg && cfg.fallback ? cfg.fallback : null;

  badge.textContent = channelLabel(ch);
  badge.classList.toggle('ok', ch !== 'google' || (net && net.googleReachable === true));

  if (ch === 'ai') {
    hint.textContent = 'AI 独占：所有非 AI 接口已关闭';
  } else if (ch === 'domestic') {
    if (fb && fb.reason === 'rate-limit' && Date.now() - fb.at < 10 * 60 * 1000) {
      hint.textContent = 'Google 免费接口触发限流，已自动切到国内接口（3 分钟内保持）';
    } else if (net && net.googleReachable === false) {
      hint.textContent = '未检测到 Google 直连，已自动使用国内接口';
    } else if (cfg && cfg.nonAiPreference === 'domestic') {
      hint.textContent = '已按设置固定使用国内接口';
    } else {
      hint.textContent = '当前使用国内接口';
    }
  } else {
    hint.textContent = '已检测到可访问 Google，使用免费接口';
  }

  // 网络环境
  const netBadge = $('netBadge');
  const netHint = $('netHint');
  if (!net || net.googleReachable === null) {
    netBadge.textContent = '检测中';
    netBadge.className = 'badge';
    netHint.textContent = '正在检测能否直连 Google…';
  } else if (net.googleReachable) {
    netBadge.textContent = '可访问 Google';
    netBadge.className = 'badge ok';
    netHint.textContent = '检测到可直连 Google，优先使用免费接口';
  } else {
    netBadge.textContent = '需代理';
    netBadge.className = 'badge is-warn';
    netHint.textContent = '未检测到 Google 直连，已自动改用国内接口（也可能有代理但当前不可用）';
  }
}

let inited = false;

async function init() {
  if (inited) return;   // 防止重复触发导致监听器叠加
  inited = true;
  const sync = await chrome.storage.sync.get(SYNC_DEFAULTS);
  const local = await chrome.storage.local.get({
    gateway: '',
    domestic: null,
    aiEnabled: false, nonAiEnabled: true,
    aiProvider: '', aiBase: '', aiKey: '', aiModel: ''
  });

  fillLangs($('target'), sync.targetLang);
  $('bubble').checked = sync.showBubble !== false;
  $('auto').checked = sync.autoTranslate === true;
  $('autoPage').checked = sync.autoPage !== false;
  $('bilingual').checked = sync.bilingual === true;
  $('exclude').value = (sync.excludeSites || []).join('\n');
  $('gateway').value = local.gateway || '';
  $('nonAiPreference').value = sync.nonAiPreference || 'auto';
  initDomestic(local.domestic);

  $('aiEnabled').checked = local.aiEnabled === true;
  $('aiKey').value = local.aiKey || '';
  $('nonAiEnabled').checked = local.nonAiEnabled !== false;
  $('cacheScope').value = sync.cacheScope === 'site' ? 'site' : 'global';
  await initAiPanel(local);
  refreshChannel();
  loadUsage();

  $('target').addEventListener('change', async (e) => {
    await chrome.storage.sync.set({ targetLang: e.target.value });
    flashSaved();
  });

  $('bubble').addEventListener('change', async (e) => {
    await chrome.storage.sync.set({ showBubble: e.target.checked });
    flashSaved();
  });

  $('auto').addEventListener('change', async (e) => {
    await chrome.storage.sync.set({ autoTranslate: e.target.checked });
    if (e.target.checked && !$('bubble').checked) {
      $('bubble').checked = true;
      await chrome.storage.sync.set({ showBubble: true });
    }
    flashSaved();
  });

  $('autoPage').addEventListener('change', async (e) => {
    await chrome.storage.sync.set({ autoPage: e.target.checked });
    flashSaved(e.target.checked ? '已开启：非中文页面将自动翻译' : '已关闭：仅手动翻译');
  });

  let siteTimer = 0;
  $('exclude').addEventListener('input', () => {
    clearTimeout(siteTimer);
    siteTimer = setTimeout(async () => {
      const sites = parseSites($('exclude').value);
      await chrome.storage.sync.set({ excludeSites: sites });
      flashSaved('已保存 ' + sites.length + ' 个排除域名');
    }, 500);
  });

  $('bilingual').addEventListener('change', async (e) => {
    await chrome.storage.sync.set({ bilingual: e.target.checked });
    flashSaved(e.target.checked ? '已开启双语对照' : '已关闭双语对照');
  });

  // AI 与非 AI 互斥：同一时刻只有一个通道生效
  $('aiEnabled').addEventListener('change', async (e) => {
    const enabled = e.target.checked;
    const cfg = aiForm();

    if (!enabled) {
      await chrome.storage.local.set({ aiEnabled: false, nonAiEnabled: true });
      $('nonAiEnabled').checked = true;
      renderAi(false, cfg);
      refreshChannel();
      flashSaved('已关闭 AI 翻译，切换回非 AI 通道');
      return;
    }

    const lack = aiMissing(cfg);
    if (lack.length) {
      e.target.checked = false;
      await chrome.storage.local.set({ aiEnabled: false, nonAiEnabled: true });
      $('nonAiEnabled').checked = true;
      renderAi(false, cfg);
      refreshChannel();
      focusAiField(lack[0]);
      flashSaved('还不能启用：缺少 ' + lack.join('、'), true);
      return;
    }

    await chrome.storage.local.set({ aiEnabled: true, nonAiEnabled: false });
    $('nonAiEnabled').checked = false;
    renderAi(true, cfg);
    refreshChannel();
    flashSaved('已切换到 AI 翻译，非 AI 通道已关闭');
  });

  $('nonAiEnabled').addEventListener('change', async (e) => {
    const on = e.target.checked;
    const cfg = aiForm();

    if (on) {
      await chrome.storage.local.set({ nonAiEnabled: true, aiEnabled: false });
      $('aiEnabled').checked = false;
      renderAi(false, cfg);
      refreshChannel();
      flashSaved('已关闭 AI 翻译，切换回非 AI 通道');
      return;
    }

    // 不允许两个都关：自动切到 AI；AI 未配置时保持非 AI
    const lack = aiMissing(cfg);
    if (lack.length) {
      e.target.checked = true;
      await chrome.storage.local.set({ nonAiEnabled: true, aiEnabled: false });
      $('aiEnabled').checked = false;
      flashSaved('AI 尚未配置，无法单独关闭非 AI 翻译', true);
      return;
    }
    await chrome.storage.local.set({ nonAiEnabled: false, aiEnabled: true });
    $('aiEnabled').checked = true;
    renderAi(true, cfg);
    refreshChannel();
    flashSaved('已切换到 AI 翻译');
  });

  $('cacheScope').addEventListener('change', async (e) => {
    await chrome.storage.sync.set({ cacheScope: e.target.value });
    flashSaved(e.target.value === 'site' ? '缓存已改为按站点隔离' : '缓存已改为全局共享');
    loadCacheStats();
  });

  $('resetUsage').addEventListener('click', resetUsage);

  $('saveAi').addEventListener('click', saveAi);
  $('testAi').addEventListener('click', testAi);
  $('domesticProvider').addEventListener('change', () => renderDomestic());
  ['baiduAppId', 'baiduKey', 'youdaoAppKey', 'youdaoAppSecret', 'tcSecretId', 'tcSecretKey', 'tcRegion'].forEach((id) => {
    $(id).addEventListener('input', () => renderDomestic());
    $(id).addEventListener('change', () => renderDomestic());
  });
  $('saveDomestic').addEventListener('click', saveDomestic);
  $('testDomestic').addEventListener('click', testDomestic);

  $('nonAiPreference').addEventListener('change', async (e) => {
    const v = e.target.value;
    await chrome.storage.sync.set({ nonAiPreference: v });
    flashSaved(v === 'auto' ? '已改为自动切换' : (v === 'domestic' ? '已固定使用国内接口' : '已固定使用 Google 免费接口'));
    refreshChannel();
  });

  $('probeBtn').addEventListener('click', async () => {
    const btn = $('probeBtn');
    btn.disabled = true;
    $('netBadge').textContent = '检测中';
    $('netBadge').className = 'badge';
    $('netHint').textContent = '正在检测能否直连 Google…';
    try { await chrome.runtime.sendMessage({ type: 'NET_PROBE' }); } catch (e) { /* ignore */ }
    btn.disabled = false;
    refreshChannel();
  });

  $('clearCache').addEventListener('click', clearCache);
  $('saveGateway').addEventListener('click', saveGateway);
  $('testBtn').addEventListener('click', testTranslate);

  loadCacheStats();

  if (location.hash === '#ai') {
    setTimeout(() => {
      const card = $('ai');
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
      $('aiBase').focus();
    }, 120);
  }

  $('shortcuts').addEventListener('click', async () => {
    try {
      await chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
    } catch (e) {
      $('testResult').textContent = '请在地址栏手动打开 chrome://extensions/shortcuts';
    }
  });
}

async function saveGateway() {
  const out = $('gatewayResult');
  out.className = 'test-result';
  const raw = $('gateway').value.trim();
  if (!raw) {
    await chrome.storage.local.set({ gateway: '' });
    try { await chrome.permissions.remove({ origins: ['https://*/*', 'http://*/*'] }); } catch (e) { /* ignore */ }
    refreshChannel();
    out.className = 'test-result is-ok';
    out.textContent = '已清除网关';
    return;
  }
  let origin;
  try {
    origin = new URL(raw).origin + '/*';
  } catch (e) {
    out.className = 'test-result is-err';
    out.textContent = '地址格式无效，请填写完整的 https:// 地址';
    return;
  }
  // 必须在用户手势内直接调用，避免 await 打断手势链
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: [origin] });
  } catch (e) {
    granted = false;
  }
  if (!granted) {
    out.className = 'test-result is-err';
    out.textContent = '未获得该地址的访问权限，网关未保存';
    return;
  }
  await chrome.storage.local.set({ gateway: new URL(raw).origin });
  refreshChannel();
  $('gateway').value = new URL(raw).origin;
  out.className = 'test-result is-ok';
  out.textContent = '已保存，点「测试」验证连通性';
}

// 通道徽标与网络环境由后台统一裁决，这里只负责渲染
async function refreshChannel() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    if (res && res.ok && res.config) {
      lastState = res.config;
      renderChannel(res.config);
      return;
    }
  } catch (e) { /* 后台未就绪 */ }
  renderChannel(lastState || {});
}

async function testTranslate() {
  const out = $('testResult');
  const btn = $('testBtn');
  out.className = 'test-result';
  out.textContent = '正在测试…';
  btn.disabled = true;
  const started = Date.now();
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'TRANSLATE',
      text: 'The extension is working. Select any text to translate it.',
      target: $('target').value || 'zh-CN'
    });
    if (res && res.ok) {
      const label = res.channel === 'ai' ? 'AI 翻译'
        : (res.channel === 'domestic' ? '国内接口' : '免费接口（Google）');
      out.className = 'test-result is-ok';
      out.textContent = '成功（' + label + '，' + (Date.now() - started) + 'ms）\n' + res.text;
    } else {
      out.className = 'test-result is-err';
      out.textContent = '失败：' + ((res && res.error) || '未知错误');
    }
  } catch (e) {
    out.className = 'test-result is-err';
    out.textContent = '失败：' + (e && e.message ? e.message : '无法连接后台');
  } finally {
    btn.disabled = false;
  }
}

/* ---------------------------------------------------------------- 用量统计 */

function fmtNum(n) {
  const v = Number(n || 0);
  return v.toLocaleString('zh-CN');
}

function fmtCost(usd) {
  const v = Number(usd || 0);
  if (!v) return '$0.00';
  if (v < 0.01) return '$' + v.toFixed(4);
  if (v < 1) return '$' + v.toFixed(3);
  return '$' + v.toFixed(2);
}

function focusAiField(label) {
  const map = { '接口地址': 'aiBase', '模型名称': 'aiModelInput', 'API 密钥': 'aiKey' };
  const el = $(map[label]);
  if (el) el.focus();
}

async function loadUsage() {
  const hint = $('aiUsageHint');
  try {
    const res = await chrome.runtime.sendMessage({ type: 'AI_USAGE' });
    const u = res && res.ok ? res.usage : null;
    $('usageTotal').textContent = fmtNum(u && u.total);
    $('usageIn').textContent = fmtNum(u && u.prompt);
    $('usageOut').textContent = fmtNum(u && u.completion);
    $('usageCost').textContent = fmtCost(u && u.costUsd);

    if (!u || !u.calls) {
      hint.className = 'test-result';
      hint.textContent = '还没有调用记录（仅统计 AI 通道）';
      return;
    }
    const parts = [u.calls + ' 次调用'];
    if (u.estimatedCalls) parts.push(u.estimatedCalls + ' 次按字符估算');
    if (!u.pricedCalls) parts.push('当前模型单价未收录，仅统计 token');
    parts.push('按公开单价估算，实际以厂商账单为准');
    hint.className = 'test-result';
    hint.textContent = parts.join(' · ');
  } catch (e) {
    hint.className = 'test-result is-err';
    hint.textContent = '统计读取失败';
  }
}

async function resetUsage() {
  try {
    await chrome.runtime.sendMessage({ type: 'AI_USAGE_RESET' });
    flashSaved('用量统计已重置');
  } catch (e) {
    flashSaved('重置失败', true);
  }
  loadUsage();
}

/* ------------------------------------------------------------ 国内接口来源 */

const DOMESTIC_LABEL = {
  builtin: '内置接口（腾讯交互翻译）',
  baidu: '百度翻译开放平台',
  youdao: '有道智云',
  tencent: '腾讯云机器翻译'
};

function domesticForm() {
  return {
    provider: $('domesticProvider').value || 'builtin',
    baidu: {
      appId: $('baiduAppId').value.trim(),
      key: $('baiduKey').value.trim()
    },
    youdao: {
      appKey: $('youdaoAppKey').value.trim(),
      appSecret: $('youdaoAppSecret').value.trim()
    },
    tencent: {
      secretId: $('tcSecretId').value.trim(),
      secretKey: $('tcSecretKey').value.trim(),
      region: $('tcRegion').value || 'ap-guangzhou'
    }
  };
}

function domesticMissingOf(cfg) {
  const lack = [];
  if (cfg.provider === 'baidu') {
    if (!cfg.baidu.appId) lack.push('APP ID');
    if (!cfg.baidu.key) lack.push('密钥');
  } else if (cfg.provider === 'youdao') {
    if (!cfg.youdao.appKey) lack.push('应用 ID');
    if (!cfg.youdao.appSecret) lack.push('应用密钥');
  } else if (cfg.provider === 'tencent') {
    if (!cfg.tencent.secretId) lack.push('SecretId');
    if (!cfg.tencent.secretKey) lack.push('SecretKey');
  }
  return lack;
}

function renderDomestic() {
  const cfg = domesticForm();
  $('domesticFields').hidden = cfg.provider === 'builtin';
  ['baidu', 'youdao', 'tencent'].forEach((p) => {
    const el = $('fields-' + p);
    if (el) el.hidden = cfg.provider !== p;
  });

  const note = $('domesticNote');
  if (cfg.provider === 'builtin') {
    note.className = 'sub-note';
    note.textContent = '当前使用内置接口（腾讯交互翻译），无需任何配置。';
    return;
  }
  const lack = domesticMissingOf(cfg);
  if (lack.length) {
    note.className = 'sub-note is-warn';
    note.textContent = '还需填写：' + lack.join('、') + '。未补齐前国内接口不可用，可随时切回内置。';
    return;
  }
  if (savedDomestic.provider === cfg.provider) {
    note.className = 'sub-note is-ok';
    note.textContent = '已使用 ' + DOMESTIC_LABEL[cfg.provider] + '。';
  } else {
    note.className = 'sub-note is-warn';
    note.textContent = '配置已填写，点「保存」后生效。';
  }
}

function initDomestic(saved) {
  const d = (saved && typeof saved === 'object') ? saved : { provider: 'builtin' };
  savedDomestic = d;
  $('domesticProvider').value = d.provider || 'builtin';
  if (d.baidu) {
    $('baiduAppId').value = d.baidu.appId || '';
    $('baiduKey').value = d.baidu.key || '';
  }
  if (d.youdao) {
    $('youdaoAppKey').value = d.youdao.appKey || '';
    $('youdaoAppSecret').value = d.youdao.appSecret || '';
  }
  if (d.tencent) {
    $('tcSecretId').value = d.tencent.secretId || '';
    $('tcSecretKey').value = d.tencent.secretKey || '';
    $('tcRegion').value = d.tencent.region || 'ap-guangzhou';
  }
  renderDomestic();
}

async function saveDomestic() {
  const out = $('domesticResult');
  const cfg = domesticForm();
  out.className = 'test-result';
  out.textContent = '';

  const lack = domesticMissingOf(cfg);
  if (cfg.provider !== 'builtin' && lack.length) {
    out.className = 'test-result is-err';
    out.textContent = '请先补齐：' + lack.join('、');
    renderDomestic();
    flashSaved('国内接口配置不完整', true);
    return;
  }

  await chrome.storage.local.set({ domestic: cfg });
  savedDomestic = cfg;
  renderDomestic();
  flashSaved(cfg.provider === 'builtin' ? '已改回内置接口' : '已切换到 ' + DOMESTIC_LABEL[cfg.provider]);
  refreshChannel();
  if (cfg.provider !== 'builtin') testDomestic();
}

async function testDomestic() {
  const out = $('domesticResult');
  const btn = $('testDomestic');
  const cfg = domesticForm();
  if (cfg.provider === 'builtin') {
    out.className = 'test-result';
    out.textContent = '内置接口无需配置，直接翻译即可验证。';
    return;
  }
  if (domesticMissingOf(cfg).length) {
    out.className = 'test-result is-err';
    out.textContent = '请先补齐：' + domesticMissingOf(cfg).join('、');
    return;
  }

  out.className = 'test-result';
  out.textContent = '正在请求 ' + DOMESTIC_LABEL[cfg.provider] + '…';
  btn.disabled = true;
  const started = Date.now();
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'DOMESTIC_TEST',
      text: 'The quick brown fox jumps over the lazy dog.',
      target: $('target').value || 'zh-CN'
    });
    if (res && res.ok) {
      out.className = 'test-result is-ok';
      out.textContent = '成功（' + (res.provider || '') + '，' + (Date.now() - started) + 'ms）\n' + res.text;
    } else {
      out.className = 'test-result is-err';
      out.textContent = '失败：' + ((res && res.error) || '未知错误');
    }
  } catch (e) {
    out.className = 'test-result is-err';
    out.textContent = '失败：' + (e && e.message ? e.message : '无法连接后台');
  } finally {
    btn.disabled = false;
  }
}

/* ---------------------------------------------------------------- 缓存管理 */

function formatBytes(n) {
  if (!n) return '0 KB';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

async function loadCacheStats() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'CACHE_STATS' });
    if (res && res.ok) {
      $('cacheHint').textContent = res.count
        ? res.count + ' 条译文 · 约 ' + formatBytes(res.bytes) + '（按站点隔离，7 天过期）'
        : '暂无缓存（按站点隔离，7 天过期）';
    }
  } catch (e) {
    $('cacheHint').textContent = '无法读取缓存状态';
  }
}

async function clearCache() {
  try {
    await chrome.runtime.sendMessage({ type: 'CACHE_CLEAR' });
    flashSaved('缓存已清除');
  } catch (e) {
    flashSaved('清除失败', true);
  }
  loadCacheStats();
}

/* ------------------------------------------------------------ AI 翻译模式 */

let providers = [];
let currentProviderId = 'openai';

function providerById(id) {
  return providers.find((p) => p.id === id)
    || providers.find((p) => p.id === currentProviderId)
    || providers[0]
    || { id: 'custom', name: '自定义', base: '', models: [], console: '', keyHint: '' };
}

async function loadProviders() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'AI_PROVIDERS' });
    if (res && res.ok && Array.isArray(res.providers) && res.providers.length) {
      providers = res.providers;
      return res.defaultProvider || providers[0].id;
    }
  } catch (e) { /* 后台不可用时退化为自定义 */ }
  providers = [{ id: 'custom', name: '自定义（OpenAI 兼容）', base: '', models: [], console: '', keyHint: '' }];
  return 'custom';
}

function fillProviderSelect() {
  const sel = $('aiProvider');
  sel.innerHTML = '';
  providers.forEach((p) => {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.name;
    sel.appendChild(o);
  });
}

function fillModelSelect(provider, savedModel) {
  const sel = $('aiModelSel');
  const custom = $('aiModelInput');
  const list = provider.models || [];
  sel.innerHTML = '';
  // 无预设模型（自定义服务商）时只留手动输入框，避免出现只有一项的下拉
  sel.hidden = list.length === 0;
  list.forEach((m) => {
    const o = document.createElement('option');
    o.value = m;
    o.textContent = m;
    sel.appendChild(o);
  });
  const other = document.createElement('option');
  other.value = '__custom__';
  other.textContent = list.length ? '其他（手动填写）' : '手动填写模型 ID';
  sel.appendChild(other);

  if (savedModel && list.indexOf(savedModel) === -1) {
    sel.value = '__custom__';
    custom.hidden = false;
    custom.value = savedModel;
  } else if (savedModel) {
    sel.value = savedModel;
    custom.hidden = true;
    custom.value = '';
  } else if (list.length) {
    sel.value = list[0];
    custom.hidden = true;
    custom.value = '';
  } else {
    sel.value = '__custom__';
    custom.hidden = false;
    custom.value = '';
  }
}

function applyProvider(id, savedModel) {
  currentProviderId = id || providers[0].id;
  const p = providerById(currentProviderId);
  $('aiProvider').value = p.id;
  fillModelSelect(p, savedModel);

  $('aiBaseWrap').hidden = p.id !== 'custom';
  $('aiModelHint').textContent = (p.models && p.models.length)
    ? '从预设模型中选择，或选「其他」手动填写'
    : '手动填写模型 ID，例如 deepseek-chat';

  const link = $('aiKeyLink');
  if (p.console) {
    link.hidden = false;
    link.dataset.url = p.console;
  } else {
    link.hidden = true;
    link.dataset.url = '';
  }
  $('aiKeyHint').textContent = p.keyHint || '粘贴密钥即可';
}

function aiForm() {
  const sel = $('aiModelSel');
  const manualOnly = !sel || sel.hidden;
  const model = manualOnly || sel.value === '__custom__'
    ? $('aiModelInput').value.trim()
    : sel.value;
  const isCustom = ($('aiProvider').value || '') === 'custom';
  return {
    aiProvider: $('aiProvider').value || 'openai',
    aiBase: isCustom ? $('aiBase').value.trim() : '',
    aiModel: model,
    aiKey: $('aiKey').value.trim()
  };
}

function aiMissing(cfg) {
  const lack = [];
  if (cfg.aiProvider === 'custom' && !cfg.aiBase) lack.push('接口地址');
  if (!cfg.aiModel) lack.push('模型名称');
  if (!cfg.aiKey) lack.push('API 密钥');
  return lack;
}

function effectiveBase(cfg) {
  if (cfg.aiProvider === 'custom') return cfg.aiBase;
  return providerById(cfg.aiProvider).base || '';
}

function renderAi(enabled, cfg) {
  const lack = aiMissing(cfg);
  const total = cfg.aiProvider === 'custom' ? 3 : 2;
  const badge = $('aiBadge');
  const hint = $('aiHint');
  refreshChannel();

  if (!enabled) {
    badge.textContent = '未启用';
    badge.className = 'badge';
    hint.className = 'test-result';
    hint.textContent = lack.length
      ? '已填写 ' + (total - lack.length) + '/' + total + ' 项，开启开关后才会使用'
      : '配置完整，开启开关即可使用';
    return;
  }
  if (lack.length) {
    badge.textContent = '配置不完整';
    badge.className = 'badge is-warn';
    hint.className = 'test-result is-err';
    hint.textContent = '缺少：' + lack.join('、') + '。补齐并保存后 AI 翻译才会生效，此期间翻译请求会直接报错。';
    return;
  }
  badge.textContent = '已启用';
  badge.className = 'badge ok';
  hint.className = 'test-result is-ok';
  hint.textContent = '当前走 AI 通道 · ' + providerById(cfg.aiProvider).name + ' / ' + cfg.aiModel;
}

async function initAiPanel(local) {
  const def = await loadProviders();
  fillProviderSelect();

  const provider = local.aiProvider
    || (local.aiBase ? 'custom' : def);
  $('aiBase').value = local.aiBase || '';
  applyProvider(provider, local.aiModel || '');
  renderAi(local.aiEnabled === true, {
    aiProvider: provider,
    aiBase: local.aiBase || '',
    aiModel: local.aiModel || '',
    aiKey: local.aiKey || ''
  });

  $('aiProvider').addEventListener('change', (e) => {
    applyProvider(e.target.value, '');
    renderAi($('aiEnabled').checked, aiForm());
  });

  $('aiModelSel').addEventListener('change', (e) => {
    const custom = $('aiModelInput');
    custom.hidden = e.target.value !== '__custom__';
    if (!custom.hidden) custom.focus();
    renderAi($('aiEnabled').checked, aiForm());
  });

  $('aiModelInput').addEventListener('input', () => {
    renderAi($('aiEnabled').checked, aiForm());
  });

  $('aiKey').addEventListener('input', () => {
    renderAi($('aiEnabled').checked, aiForm());
  });

  $('aiKeyLink').addEventListener('click', () => {
    const url = $('aiKeyLink').dataset.url;
    if (url) chrome.tabs.create({ url });
  });
}

async function saveAi() {
  const out = $('aiResult');
  const cfg = aiForm();
  out.className = 'test-result';
  out.textContent = '';

  const base = effectiveBase(cfg);
  if (base) {
    let origin;
    let host;
    try {
      const u = new URL(base);
      origin = u.origin + '/*';
      host = u.host;
    } catch (e) {
      out.className = 'test-result is-err';
      out.textContent = '接口地址格式无效，请填写完整的 https:// 地址';
      return;
    }
    let granted = false;
    try {
      granted = await chrome.permissions.request({ origins: [origin] });
    } catch (e) {
      granted = false;
    }
    if (!granted) {
      out.className = 'test-result is-err';
      out.textContent = '未获得 ' + host + ' 的访问权限，AI 配置未保存';
      return;
    }
  }

  await chrome.storage.local.set({
    aiProvider: cfg.aiProvider,
    aiBase: cfg.aiBase,
    aiModel: cfg.aiModel,
    aiKey: cfg.aiKey
  });

  const saved = Object.assign({}, cfg, { aiKey: cfg.aiKey });
  renderAi($('aiEnabled').checked, saved);

  const lack = aiMissing(cfg);
  if (lack.length) {
    out.className = 'test-result is-err';
    out.textContent = '已保存，但仍缺少：' + lack.join('、');
    flashSaved('AI 配置不完整', true);
    return;
  }
  flashSaved('AI 配置已保存');
  testAi();
}

async function testAi() {
  const out = $('aiResult');
  const btn = $('testAi');
  const lack = aiMissing(aiForm());
  if (lack.length) {
    out.className = 'test-result is-err';
    out.textContent = '请先补齐：' + lack.join('、');
    return;
  }

  out.className = 'test-result';
  out.textContent = '正在请求 AI 接口…';
  btn.disabled = true;
  const started = Date.now();
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'AI_TEST',
      text: 'The quick brown fox jumps over the lazy dog.',
      target: $('target').value || 'zh-CN'
    });
    if (res && res.ok) {
      out.className = 'test-result is-ok';
      out.textContent = '成功（' + (Date.now() - started) + 'ms）\n' + res.text;
      loadUsage();
    } else {
      out.className = 'test-result is-err';
      out.textContent = '失败：' + ((res && res.error) || '未知错误');
    }
  } catch (e) {
    out.className = 'test-result is-err';
    out.textContent = '失败：' + (e && e.message ? e.message : '无法连接后台');
  } finally {
    btn.disabled = false;
  }
}

document.addEventListener('DOMContentLoaded', init);
