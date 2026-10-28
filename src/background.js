/* background.js — 翻译调度中心（Service Worker）
 * 通道：AI（用户自备模型） / Google 免费接口（需可访问 Google） / 国内接口（腾讯交互翻译，免密钥）
 * 调度：AI 开启时独占；否则按网络环境自动在 Google 与国内接口之间切换，Google 限流自动降级。
 */
'use strict';

const FREE_HOST = 'https://translate.googleapis.com';
const DOMESTIC_ENDPOINT = 'https://transmart.qq.com/api/imt';
const DOMESTIC_CLIENT_KEY = 'browser-chrome-110.0.0-Mac OS';
const BAIDU_ENDPOINT = 'https://fanyi-api.baidu.com/api/trans/vip/translate';
const YOUDAO_ENDPOINT = 'https://openapi.youdao.com/api';
const TENCENT_ENDPOINT = 'https://tmt.tencentcloudapi.com';
const PROBE_TTL = 3 * 60 * 1000;        // 网络探测结果缓存
const GOOGLE_COOLDOWN = 3 * 60 * 1000;  // Google 限流后的熔断时长
const PROBE_TIMEOUT = 1800;
const AI_TIMEOUT_MS = 30000;

// 服务商预设：用户只选厂家 + 填 Key，地址由此带出
const AI_PROVIDERS = {
  openai: {
    name: 'OpenAI',
    base: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'],
    console: 'https://platform.openai.com/api-keys',
    keyHint: 'sk- 开头'
  },
  deepseek: {
    name: 'DeepSeek 深度求索',
    base: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    console: 'https://platform.deepseek.com/api_keys',
    keyHint: 'sk- 开头'
  },
  dashscope: {
    name: '阿里云百炼（通义千问）',
    base: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-plus', 'qwen-turbo', 'qwen-max', 'qwen-long'],
    console: 'https://bailian.console.aliyun.com/',
    keyHint: 'sk- 开头'
  },
  zhipu: {
    name: '智谱 GLM',
    base: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4-flash', 'glm-4-air', 'glm-4-plus'],
    console: 'https://open.bigmodel.cn/usercenter/apikeys',
    keyHint: '形如 xxxx.xxxx'
  },
  moonshot: {
    name: '月之暗面 Kimi',
    base: 'https://api.moonshot.cn/v1',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k'],
    console: 'https://platform.moonshot.cn/console/api-keys',
    keyHint: 'sk- 开头'
  },
  siliconflow: {
    name: '硅基流动 SiliconFlow',
    base: 'https://api.siliconflow.cn/v1',
    models: ['Qwen/Qwen2.5-7B-Instruct', 'deepseek-ai/DeepSeek-V3'],
    console: 'https://cloud.siliconflow.cn/account/ak',
    keyHint: 'sk- 开头'
  },
  volcengine: {
    name: '火山方舟（豆包）',
    base: 'https://ark.cn-beijing.volces.com/api/v3',
    models: ['doubao-pro-32k', 'doubao-lite-32k'],
    console: 'https://console.volcengine.com/ark',
    keyHint: '需先在方舟控制台开通推理接入点'
  },
  custom: {
    name: '自定义（OpenAI 兼容）',
    base: '',
    models: [],
    console: '',
    keyHint: '按你的服务商要求填写'
  }
};

const AI_DEFAULT_PROVIDER = 'openai';

// 公开价目（美元 / 1M token），仅用于估算，实际以厂商账单为准
const AI_PRICING = {
  'gpt-4o-mini': { in: 0.15, out: 0.6 },
  'gpt-4o': { in: 2.5, out: 10 },
  'gpt-4.1-mini': { in: 0.4, out: 1.6 },
  'deepseek-chat': { in: 0.27, out: 1.1 },
  'deepseek-reasoner': { in: 0.55, out: 2.19 },
  'qwen-plus': { in: 0.4, out: 1.2 },
  'qwen-turbo': { in: 0.05, out: 0.2 },
  'qwen-max': { in: 1.6, out: 6.4 },
  'qwen-long': { in: 0.07, out: 0.28 },
  'glm-4-flash': { in: 0, out: 0 },
  'glm-4-air': { in: 0.1, out: 0.1 },
  'glm-4-plus': { in: 0.7, out: 0.7 },
  'moonshot-v1-8k': { in: 1.68, out: 1.68 },
  'moonshot-v1-32k': { in: 3.36, out: 3.36 },
  'doubao-pro-32k': { in: 0.11, out: 0.28 },
  'doubao-lite-32k': { in: 0.04, out: 0.08 }
};

// AI 通道：目标语言在提示词里用英文名更稳
const LANG_PROMPT = {
  'zh-CN': 'Simplified Chinese', 'zh-TW': 'Traditional Chinese',
  en: 'English', ja: 'Japanese', ko: 'Korean', fr: 'French', de: 'German',
  es: 'Spanish', ru: 'Russian', pt: 'Portuguese', it: 'Italian', ar: 'Arabic',
  th: 'Thai', vi: 'Vietnamese', id: 'Indonesian', ms: 'Malay', hi: 'Hindi',
  tr: 'Turkish', nl: 'Dutch', pl: 'Polish', sv: 'Swedish', uk: 'Ukrainian',
  he: 'Hebrew', fa: 'Persian', el: 'Greek', cs: 'Czech', ro: 'Romanian',
  hu: 'Hungarian', da: 'Danish', fi: 'Finnish', no: 'Norwegian', sk: 'Slovak',
  bg: 'Bulgarian', hr: 'Croatian', sr: 'Serbian', tl: 'Filipino', sw: 'Swahili',
  ur: 'Urdu', bn: 'Bengali', ta: 'Tamil', te: 'Telugu'
};
const MAX_CHARS = 5000;
const CACHE_LIMIT = 400;
const CACHE_PERSIST_LIMIT = 300;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_CACHE_KEY = 'gtCacheV1';
const PERSIST_DEBOUNCE = 1200;
const TIMEOUT_MS = 12000;

const cache = new Map();
const inflight = new Map();
let cacheLoaded = null;
let persistTimer = 0;
let persistPending = false;

const MENU_SELECTION = 'gt-translate-selection';
const MENU_OPTIONS = 'gt-open-options';

let netFailMarked = false;

function markNetFail() {
  if (netFailMarked) return;
  netFailMarked = true;
  try { chrome.storage.local.set({ netFailAt: Date.now() }); } catch (e) { /* ignore */ }
}

function clearNetFail() {
  if (!netFailMarked) return;
  netFailMarked = false;
  try { chrome.storage.local.remove('netFailAt'); } catch (e) { /* ignore */ }
}

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status || 0;
  }
}

/* ------------------------------------------------------------------ 工具 */

// 64 位 FNV-1a：内存与 session 存储都用短键，避免长文本撑爆配额
function fnv1a(str) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 ^ c, 2246822519);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

function cacheKey(text, source, target, channel, host) {
  return [host || '-', channel || 'free', source, target, fnv1a(text), text.length].join('|');
}

function hostOf(sender) {
  try {
    const url = sender && (sender.url || (sender.tab && sender.tab.url));
    return url ? new URL(url).host : '';
  } catch (e) {
    return '';
  }
}

// 服务被唤醒时把上次会话的缓存捞回内存
function ensureCache() {
  if (cacheLoaded) return cacheLoaded;
  cacheLoaded = (async () => {
    try {
      const store = await chrome.storage.session.get(SESSION_CACHE_KEY);
      const raw = store && store[SESSION_CACHE_KEY];
      if (!raw || typeof raw !== 'object') return;
      const now = Date.now();
      Object.keys(raw).forEach((k) => {
        const v = raw[k];
        if (!v || typeof v.text !== 'string' || !v.at) return;
        if (now - v.at > CACHE_TTL_MS) return;
        if (cache.size >= CACHE_PERSIST_LIMIT) return;
        cache.set(k, v);
      });
    } catch (e) {
      // storage.session 不可用时退化为纯内存缓存
    }
  })();
  return cacheLoaded;
}

function schedulePersist() {
  if (persistPending) return;
  persistPending = true;
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persistCache, PERSIST_DEBOUNCE);
}

async function persistCache() {
  persistPending = false;
  try {
    const out = {};
    const entries = Array.from(cache.entries()).slice(-CACHE_PERSIST_LIMIT);
    for (let i = 0; i < entries.length; i++) out[entries[i][0]] = entries[i][1];
    await chrome.storage.session.set({ [SESSION_CACHE_KEY]: out });
  } catch (e) {
    // 配额不足或 session 不可用：保留内存缓存即可
  }
}

function remember(key, value) {
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, Object.assign({}, value, { at: Date.now() }));
  schedulePersist();
}

async function fetchWithTimeout(url, options, timeout) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout || TIMEOUT_MS);
  try {
    return await fetch(url, Object.assign({}, options, { signal: ctrl.signal, cache: 'no-store' }));
  } finally {
    clearTimeout(timer);
  }
}

function statusMessage(status) {
  switch (status) {
    case 400: return '翻译请求被拒绝：文本过长或语言代码无效';
    case 403: return 'API Key 无效或无翻译权限，请在设置中检查';
    case 429: return '请求过于频繁，已触发翻译接口限流，请稍后再试';
    case 500:
    case 502:
    case 503:
    case 504: return '翻译服务暂时不可用，请稍后重试';
    default: return '翻译失败（HTTP ' + status + '）';
  }
}

/* -------------------------------------------------------------- 免费通道 */

function parseFreePayload(data) {
  // dj=1 时返回对象结构
  if (data && Array.isArray(data.sentences)) {
    const text = data.sentences.map((s) => s.trans || '').join('').trim();
    return { text, src: data.src || '' };
  }
  // 兼容未生效 dj 的数组结构
  if (Array.isArray(data)) {
    const segs = Array.isArray(data[0]) ? data[0] : [];
    const text = segs.map((s) => (Array.isArray(s) ? s[0] || '' : '')).join('').trim();
    const src = typeof data[2] === 'string' ? data[2] : '';
    return { text, src };
  }
  throw new ApiError('翻译接口返回了无法识别的数据');
}

function freeUrl(gateway) {
  const base = String(gateway || FREE_HOST).trim().replace(/\/+$/, '') || FREE_HOST;
  return base + '/translate_a/single';
}

async function freeTranslate(text, source, target, gateway) {
  const form = new URLSearchParams();
  form.set('client', 'gtx');
  form.set('sl', source || 'auto');
  form.set('tl', target);
  form.set('dt', 't');
  form.set('dj', '1');
  form.set('ie', 'UTF-8');
  form.set('oe', 'UTF-8');
  form.set('q', text);

  let res;
  try {
    res = await fetchWithTimeout(freeUrl(gateway), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: form.toString()
    });
  } catch (e) {
    markNetFail();
    throw new ApiError(gateway
      ? '无法连接自定义网关，请检查地址、证书与网络'
      : '无法连接 translate.googleapis.com，请检查网络或系统代理（中国大陆网络需代理，或在设置中填写自建网关）');
  }

  if (!res.ok) {
    if (res.status === 413) throw new ApiError('所选文本过长，请缩短后重试', 413);
    throw new ApiError(statusMessage(res.status), res.status);
  }

  let raw;
  try {
    raw = await res.json();
  } catch (e) {
    throw new ApiError('翻译接口返回内容异常，请稍后重试');
  }
  const out = parseFreePayload(raw);
  if (!out.text) throw new ApiError('未获取到译文，请调整文本后重试');
  return out;
}

/* ------------------------------------------------------------ 网络探测 */

let netState = { googleReachable: null, checkedAt: 0, cooldownUntil: 0 };
let lastFallback = null;
let probing = null;

function publicNet() {
  return {
    googleReachable: netState.googleReachable,
    checkedAt: netState.checkedAt,
    cooldownUntil: netState.cooldownUntil || 0
  };
}

async function loadNetState() {
  if (netState.checkedAt) return;
  try {
    const store = await chrome.storage.session.get('netState');
    const saved = store && store.netState;
    if (saved && saved.checkedAt) {
      netState = {
        googleReachable: saved.googleReachable === true ? true : (saved.googleReachable === false ? false : null),
        checkedAt: saved.checkedAt,
        cooldownUntil: saved.cooldownUntil || 0
      };
    }
  } catch (e) { /* session 不可用则每次重新探测 */ }
}

function saveNetState() {
  try { chrome.storage.session.set({ netState: publicNet() }); } catch (e) { /* ignore */ }
}

// 能拿到任何 HTTP 响应就算「可访问 Google」，不比读代理设置差
async function probeGoogle(force) {
  await loadNetState();
  const fresh = netState.checkedAt && Date.now() - netState.checkedAt < PROBE_TTL && netState.googleReachable !== null;
  if (!force && fresh) return netState;
  if (probing) return probing;

  probing = (async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT);
    let reachable = false;
    try {
      const res = await fetch(FREE_HOST + '/generate_204?probe=' + Date.now(), {
        method: 'GET',
        cache: 'no-store',
        signal: ctrl.signal
      });
      reachable = !!res && res.status > 0;
    } catch (e) {
      reachable = false;
    } finally {
      clearTimeout(timer);
      probing = null;
    }
    netState = { googleReachable: reachable, checkedAt: Date.now(), cooldownUntil: netState.cooldownUntil || 0 };
    saveNetState();
    return netState;
  })();
  return probing;
}

/* ------------------------------------------------------- 自定义国产接口 */

// WebCrypto 不含 MD5（百度要用），此处内置一份
function md5Hex(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const n = bytes.length;
  const bitLen = n * 8;
  const paddedLen = (((n + 8) >>> 6) + 1) * 64;
  const buf = new Uint8Array(paddedLen);
  buf.set(bytes);
  buf[n] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(paddedLen - 8, bitLen >>> 0, true);
  view.setUint32(paddedLen - 4, Math.floor(bitLen / 4294967296), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
  ];
  const K = new Int32Array(64);
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
  const rotl = (x, c) => ((x << c) | (x >>> (32 - c))) | 0;

  for (let off = 0; off < paddedLen; off += 64) {
    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;
    for (let i = 0; i < 64; i++) {
      let F;
      let g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      const tmp = D;
      D = C;
      C = B;
      const word = view.getUint32(off + g * 4, true);
      B = (B + rotl((A + F + K[i] + word) | 0, S[i])) | 0;
      A = tmp;
    }
    a0 = (a0 + A) | 0;
    b0 = (b0 + B) | 0;
    c0 = (c0 + C) | 0;
    d0 = (d0 + D) | 0;
  }

  const words = [a0, b0, c0, d0];
  let out = '';
  for (let w = 0; w < 4; w++) {
    for (let i = 0; i < 4; i++) {
      out += ((words[w] >>> (i * 8)) & 0xff).toString(16).padStart(2, '0');
    }
  }
  return out;
}

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  let out = '';
  const arr = new Uint8Array(buf);
  for (let i = 0; i < arr.length; i++) out += arr[i].toString(16).padStart(2, '0');
  return out;
}

async function hmacSha256(keyBytes, msg) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return new Uint8Array(sig);
}

const BAIDU_LANG = {
  auto: 'auto', zh: 'zh', 'zh-cn': 'zh', 'zh-tw': 'cht', en: 'en', ja: 'jp', ko: 'kor',
  fr: 'fra', es: 'spa', ru: 'ru', ar: 'ara', de: 'de', it: 'it', pt: 'pt', th: 'th',
  vi: 'vie', id: 'id', ms: 'may', tr: 'tr', nl: 'nl', pl: 'pl', hi: 'hi'
};
const YOUDAO_LANG = {
  auto: 'auto', zh: 'zh-CHS', 'zh-cn': 'zh-CHS', 'zh-tw': 'zh-CHT', en: 'en', ja: 'ja',
  ko: 'ko', fr: 'fr', es: 'es', ru: 'ru', ar: 'ar', de: 'de', it: 'it', pt: 'pt',
  th: 'th', vi: 'vi', id: 'id', ms: 'ms', tr: 'tr', nl: 'nl', pl: 'pl', hi: 'hi'
};
const TENCENT_LANG = {
  auto: 'auto', zh: 'zh', 'zh-cn': 'zh', 'zh-tw': 'zh-TW', en: 'en', ja: 'ja', ko: 'ko',
  fr: 'fr', es: 'es', ru: 'ru', ar: 'ar', de: 'de', it: 'it', pt: 'pt', th: 'th',
  vi: 'vi', id: 'id', ms: 'ms', tr: 'tr', hi: 'hi'
};

function mapLang(table, code, fallback) {
  const key = String(code || 'auto').toLowerCase();
  return table[key] || (table[String(code || '').toLowerCase()] || fallback || 'auto');
}

const DOMESTIC_PROVIDERS = {
  builtin: { name: '内置（腾讯交互翻译）', fields: [] },
  baidu: { name: '百度翻译开放平台', fields: ['appId', 'key'] },
  youdao: { name: '有道智云', fields: ['appKey', 'appSecret'] },
  tencent: { name: '腾讯云机器翻译', fields: ['secretId', 'secretKey', 'region'] }
};

function domesticCfgOf(cfg) {
  const d = (cfg && cfg.domestic) || {};
  const provider = DOMESTIC_PROVIDERS[d.provider] ? d.provider : 'builtin';
  return {
    provider,
    baidu: d.baidu || {},
    youdao: d.youdao || {},
    tencent: d.tencent || {}
  };
}

function domesticMissing(cfg) {
  const d = domesticCfgOf(cfg);
  const lack = [];
  if (d.provider === 'baidu') {
    if (!String(d.baidu.appId || '').trim()) lack.push('APP ID');
    if (!String(d.baidu.key || '').trim()) lack.push('密钥');
  } else if (d.provider === 'youdao') {
    if (!String(d.youdao.appKey || '').trim()) lack.push('应用 ID');
    if (!String(d.youdao.appSecret || '').trim()) lack.push('应用密钥');
  } else if (d.provider === 'tencent') {
    if (!String(d.tencent.secretId || '').trim()) lack.push('SecretId');
    if (!String(d.tencent.secretKey || '').trim()) lack.push('SecretKey');
  }
  return lack;
}

function domesticProviderName(cfg) {
  return DOMESTIC_PROVIDERS[domesticCfgOf(cfg).provider].name;
}

async function baiduTranslate(text, source, target, d) {
  const appId = String(d.baidu.appId).trim();
  const key = String(d.baidu.key).trim();
  const salt = String(Date.now());
  const sign = md5Hex(appId + text + salt + key);
  const form = new URLSearchParams();
  form.set('q', text);
  form.set('from', mapLang(BAIDU_LANG, source, 'auto'));
  form.set('to', mapLang(BAIDU_LANG, target, 'zh'));
  form.set('appid', appId);
  form.set('salt', salt);
  form.set('sign', sign);

  let res;
  try {
    res = await fetchWithTimeout(BAIDU_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: form.toString()
    }, 15000);
  } catch (e) {
    throw new ApiError('无法连接百度翻译接口，请检查网络');
  }
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  if (!res.ok) throw new ApiError('百度翻译接口异常（HTTP ' + res.status + '）', res.status);
  if (data && data.error_code) {
    const msg = data.error_msg || data.error_code;
    const hint = /54001|52003/.test(String(data.error_code)) ? '（请检查 APP ID 与密钥）' : '';
    throw new ApiError('百度翻译返回错误：' + msg + hint, 400);
  }
  const list = data && data.trans_result;
  if (!Array.isArray(list) || !list.length) throw new ApiError('百度翻译未返回译文');
  return { text: list.map((it) => it.dst || '').join('\n').trim(), src: (data && data.from) || '' };
}

async function youdaoTranslate(text, source, target, d) {
  const appKey = String(d.youdao.appKey).trim();
  const secret = String(d.youdao.appSecret).trim();
  const salt = String(Date.now());
  const curtime = String(Math.floor(Date.now() / 1000));
  const input = text.length <= 20 ? text : text.slice(0, 10) + text.length + text.slice(-10);
  const sign = await sha256Hex(appKey + input + salt + curtime + secret);

  const form = new URLSearchParams();
  form.set('q', text);
  form.set('from', mapLang(YOUDAO_LANG, source, 'auto'));
  form.set('to', mapLang(YOUDAO_LANG, target, 'zh-CHS'));
  form.set('appKey', appKey);
  form.set('salt', salt);
  form.set('sign', sign);
  form.set('signType', 'v3');
  form.set('curtime', curtime);

  let res;
  try {
    res = await fetchWithTimeout(YOUDAO_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: form.toString()
    }, 15000);
  } catch (e) {
    throw new ApiError('无法连接有道翻译接口，请检查网络');
  }
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  if (!res.ok) throw new ApiError('有道翻译接口异常（HTTP ' + res.status + '）', res.status);
  const code = data && data.errorCode !== undefined ? String(data.errorCode) : '';
  if (code && code !== '0') {
    const hint = code === '108' ? '（请检查应用 ID 与密钥）' : '';
    throw new ApiError('有道翻译返回错误：' + code + hint, 400);
  }
  const list = data && data.translation;
  const out = Array.isArray(list) ? list.join('\n').trim() : String(list || '').trim();
  if (!out) throw new ApiError('有道翻译未返回译文');
  return { text: out, src: (data && data.l) || '' };
}

async function tencentTranslate(text, source, target, d) {
  const secretId = String(d.tencent.secretId).trim();
  const secretKey = String(d.tencent.secretKey).trim();
  const region = String(d.tencent.region || 'ap-guangzhou').trim() || 'ap-guangzhou';
  const host = 'tmt.tencentcloudapi.com';
  const service = 'tmt';
  const action = 'TextTranslate';
  const version = '2018-03-21';
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const payload = JSON.stringify({
    SourceText: text,
    Source: mapLang(TENCENT_LANG, source, 'auto'),
    Target: mapLang(TENCENT_LANG, target, 'zh'),
    ProjectId: 0
  });

  // TC3-HMAC-SHA256
  const canonicalRequest = [
    'POST', '/', '',
    'content-type:application/json; charset=utf-8',
    'host:' + host,
    '',
    'content-type;host',
    await sha256Hex(payload)
  ].join('\n');
  const scope = date + '/' + service + '/tc3_request';
  const stringToSign = ['TC3-HMAC-SHA256', String(timestamp), scope, await sha256Hex(canonicalRequest)].join('\n');

  const enc = new TextEncoder();
  const kDate = await hmacSha256(enc.encode('TC3' + secretKey), date);
  const kService = await hmacSha256(kDate, service);
  const kSigning = await hmacSha256(kService, 'tc3_request');
  const sigBytes = await hmacSha256(kSigning, stringToSign);
  let signature = '';
  for (let i = 0; i < sigBytes.length; i++) signature += sigBytes[i].toString(16).padStart(2, '0');

  const authorization = 'TC3-HMAC-SHA256 Credential=' + secretId + '/' + scope
    + ', SignedHeaders=content-type;host, Signature=' + signature;

  let res;
  try {
    res = await fetchWithTimeout(TENCENT_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Host: host,
        Authorization: authorization,
        'X-TC-Action': action,
        'X-TC-Version': version,
        'X-TC-Region': region,
        'X-TC-Timestamp': String(timestamp)
      },
      body: payload
    }, 15000);
  } catch (e) {
    throw new ApiError('无法连接腾讯云翻译接口，请检查网络');
  }
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  if (!res.ok) throw new ApiError('腾讯云翻译接口异常（HTTP ' + res.status + '）', res.status);
  const resp = data && data.Response;
  if (resp && resp.Error) {
    const hint = /AuthFailure|Signature/i.test(resp.Error.Code || '') ? '（请检查 SecretId / SecretKey）' : '';
    throw new ApiError('腾讯云翻译返回错误：' + (resp.Error.Message || resp.Error.Code) + hint, 400);
  }
  const out = resp && resp.TargetText ? String(resp.TargetText).trim() : '';
  if (!out) throw new ApiError('腾讯云翻译未返回译文');
  return { text: out, src: (resp && resp.Source) || '' };
}

/* ------------------------------------------------------------ 国内通道 */

function domesticLang(code) {
  const c = String(code || '').trim();
  if (!c || c === 'auto') return 'auto';
  const low = c.toLowerCase();
  if (low === 'zh' || low === 'zh-cn' || low === 'zh-hans') return 'zh';
  if (low === 'zh-tw' || low === 'zh-hk' || low === 'zh-hant') return 'zh-TW';
  return low.split('-')[0];
}

async function builtinDomesticTranslate(text, source, target) {
  const payload = {
    header: { fn: 'auto_translation', client_key: DOMESTIC_CLIENT_KEY },
    type: 'plain',
    model_category: 'normal',
    source: { lang: domesticLang(source), text_list: [text] },
    target: { lang: domesticLang(target) }
  };

  let res;
  try {
    res = await fetchWithTimeout(DOMESTIC_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }, 15000);
  } catch (e) {
    throw new ApiError('无法连接国内翻译接口，请检查网络');
  }

  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }

  if (!res.ok) {
    if (res.status === 429) throw new ApiError('国内翻译接口触发频率限制，请稍后再试', 429);
    throw new ApiError('国内翻译接口异常（HTTP ' + res.status + '）', res.status);
  }
  const code = data && data.header && data.header.ret_code;
  if (code && code !== 'succ') {
    throw new ApiError('国内翻译接口返回错误：' + ((data && data.message) || code), 400);
  }
  const list = data && data.auto_translation;
  const out = Array.isArray(list)
    ? String(list[0] || '').trim()
    : (typeof list === 'string' ? list.trim() : '');
  if (!out) throw new ApiError('国内翻译接口未返回译文');
  return { text: out, src: (data && data.src_lang) || '' };
}

// 国内通道统一入口：按用户选择的来源分发
async function domesticTranslate(text, source, target, cfg) {
  const d = domesticCfgOf(cfg);
  if (d.provider === 'builtin') return builtinDomesticTranslate(text, source, target);

  const lack = domesticMissing(cfg);
  if (lack.length) {
    throw new ApiError('国内接口（' + domesticProviderName(cfg) + '）配置不完整，缺少：'
      + lack.join('、') + '。请到「设置 → 翻译服务 → 国内接口来源」补充，或改回内置接口。', 412);
  }
  if (d.provider === 'baidu') return baiduTranslate(text, source, target, d);
  if (d.provider === 'youdao') return youdaoTranslate(text, source, target, d);
  return tencentTranslate(text, source, target, d);
}

/* ---------------------------------------------------------------- AI 通道 */

function aiEndpoint(base) {
  let url = String(base || '').trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  url = url.replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(url)) return url;
  if (/\/v\d+[a-z]*$/i.test(url)) return url + '/chat/completions';
  return url + '/v1/chat/completions';
}

function aiPreset(cfg) {
  const id = String(cfg.aiProvider || AI_DEFAULT_PROVIDER);
  return AI_PROVIDERS[id] || AI_PROVIDERS[AI_DEFAULT_PROVIDER];
}

function aiIsCustom(cfg) {
  return String(cfg.aiProvider || '') === 'custom';
}

// 预设服务商：地址由预设带出；自定义：用用户填写的地址
function aiEndpointFor(cfg) {
  const base = aiIsCustom(cfg) ? String(cfg.aiBase || '').trim() : aiPreset(cfg).base;
  return aiEndpoint(base);
}

function aiMissing(cfg) {
  const lack = [];
  if (aiIsCustom(cfg) && !String(cfg.aiBase || '').trim()) lack.push('接口地址');
  if (!String(cfg.aiModel || '').trim()) lack.push('模型名称');
  if (!String(cfg.aiKey || '').trim()) lack.push('API 密钥');
  return lack;
}

function aiConfigured(cfg) {
  return aiMissing(cfg).length === 0;
}

function aiMissingHint(cfg) {
  const lack = aiMissing(cfg);
  const provider = aiPreset(cfg).name;
  return 'AI 翻译尚未配置完整（' + provider + '），缺少：' + lack.join('、')
    + '。请到「设置 → AI 翻译模式」补充后重试。';
}

function stripFence(text) {
  return String(text || '')
    .replace(/^\s*```[a-zA-Z]*\s*\n?/, '')
    .replace(/\n?\s*```\s*$/, '')
    .trim();
}

async function aiTranslate(text, source, target, cfg) {
  if (!aiConfigured(cfg)) throw new ApiError(aiMissingHint(cfg), 412);

  const langName = LANG_PROMPT[target] || target;
  const system = [
    'You are a professional translator.',
    'Translate the user content into ' + langName + '.',
    'Rules:',
    '1. Output only the translation, no explanations, no quotes, no markdown fences.',
    '2. Keep every token of the form %%N%% exactly once, in its original position — never translate, merge or renumber them.',
    '3. Preserve line breaks, numbers, URLs and HTML entities.',
    '4. If the content is already in ' + langName + ', return it unchanged.'
  ].join('\n');

  const payload = {
    model: String(cfg.aiModel).trim(),
    temperature: 0.2,
    stream: false,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: text }
    ]
  };

  let res;
  try {
    res = await fetchWithTimeout(aiEndpointFor(cfg), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + String(cfg.aiKey).trim()
      },
      body: JSON.stringify(payload)
    }, AI_TIMEOUT_MS);
  } catch (e) {
    throw new ApiError('无法连接 AI 接口，请检查接口地址、网络与证书');
  }

  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  const detail = data && data.error && data.error.message ? String(data.error.message) : '';

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new ApiError('AI 接口鉴权失败：密钥无效或无权限' + (detail ? '（' + detail + '）' : ''), res.status);
    if (res.status === 404) throw new ApiError('AI 接口地址不存在，请确认填写的是 Chat Completions 端点', res.status);
    if (res.status === 429) throw new ApiError('AI 接口触发频率限制，请稍后再试' + (detail ? '（' + detail + '）' : ''), res.status);
    if (res.status === 400) throw new ApiError('AI 接口拒绝了请求：' + (detail || '参数或模型名称不被接受'), res.status);
    throw new ApiError('AI 翻译失败（HTTP ' + res.status + '）' + (detail ? '：' + detail : ''), res.status);
  }

  const choice = data && data.choices && data.choices[0];
  let content = choice && choice.message ? choice.message.content : '';
  if (Array.isArray(content)) {
    content = content.map((p) => (typeof p === 'string' ? p : p && p.text ? p.text : '')).join('');
  }
  content = stripFence(content);
  if (!content) throw new ApiError('AI 接口未返回译文，请检查模型名称与接口是否兼容 OpenAI Chat Completions');
  recordUsage(cfg.aiModel, data && data.usage, system + '\n' + text, content);
  return { text: content, src: source === 'auto' ? '' : source };
}

/* -------------------------------------------------------------- 用量统计 */

let usageQueue = Promise.resolve();

function priceOf(model) {
  return AI_PRICING[String(model || '')] || null;
}

// 厂商没回 usage 时按字符粗略折算（拉丁 4 字符≈1 token，CJK 1.5 字符≈1 token）
function estimateTokens(str) {
  const text = String(str || '');
  const latin = (text.match(/[A-Za-z0-9]/g) || []).length;
  const other = Math.max(0, text.length - latin);
  return Math.max(1, Math.round(latin / 4 + other / 1.5));
}

function recordUsage(model, usage, promptText, outputText) {
  const prompt = usage && usage.prompt_tokens ? usage.prompt_tokens : estimateTokens(promptText);
  const completion = usage && usage.completion_tokens ? usage.completion_tokens : estimateTokens(outputText);
  const total = usage && usage.total_tokens ? usage.total_tokens : prompt + completion;

  usageQueue = usageQueue.then(async () => {
    try {
      const store = await chrome.storage.local.get({ aiUsage: null });
      const u = (store.aiUsage && typeof store.aiUsage === 'object') ? store.aiUsage : {
        prompt: 0, completion: 0, total: 0, calls: 0, estimatedCalls: 0,
        costUsd: 0, pricedCalls: 0, models: {}, updatedAt: 0
      };
      u.prompt = (u.prompt || 0) + prompt;
      u.completion = (u.completion || 0) + completion;
      u.total = (u.total || 0) + total;
      u.calls = (u.calls || 0) + 1;
      if (!usage) u.estimatedCalls = (u.estimatedCalls || 0) + 1;
      const price = priceOf(model);
      if (price) {
        u.costUsd = (u.costUsd || 0) + prompt / 1e6 * price.in + completion / 1e6 * price.out;
        u.pricedCalls = (u.pricedCalls || 0) + 1;
      }
      u.models = u.models || {};
      u.models[model] = (u.models[model] || 0) + total;
      u.updatedAt = Date.now();
      await chrome.storage.local.set({ aiUsage: u });
    } catch (e) {
      // 统计失败不影响翻译
    }
  });
  return usageQueue;
}

/* ---------------------------------------------------------------- 主流程 */

async function getConfig() {
  const [sync, local] = await Promise.all([
    chrome.storage.sync.get({ targetLang: 'zh-CN', cacheScope: 'global', nonAiPreference: 'auto' }),
    chrome.storage.local.get({
      gateway: '',
      domestic: null,
      aiEnabled: false, aiProvider: '', aiBase: '', aiKey: '', aiModel: ''
    })
  ]);
  const rawProvider = String(local.aiProvider || '').trim();
  const aiBase = String(local.aiBase || '').trim();
  // 兼容旧配置：只存了接口地址、没有服务商标识时按「自定义」处理
  const aiProvider = rawProvider || (aiBase ? 'custom' : AI_DEFAULT_PROVIDER);
  return {
    targetLang: sync.targetLang || 'zh-CN',
    cacheScope: sync.cacheScope === 'site' ? 'site' : 'global',
    nonAiPreference: ['google', 'domestic'].indexOf(sync.nonAiPreference) > -1 ? sync.nonAiPreference : 'auto',
    gateway: String(local.gateway || '').trim(),
    domestic: (local.domestic && typeof local.domestic === 'object')
      ? local.domestic
      : { provider: 'builtin' },
    aiEnabled: local.aiEnabled === true,
    aiProvider,
    aiBase,
    aiKey: String(local.aiKey || '').trim(),
    aiModel: String(local.aiModel || '').trim()
  };
}

// 通道决策：AI 独占 > 用户指定 > 按网络环境自动
function resolveChannel(cfg, net) {
  if (cfg.aiEnabled) return 'ai';
  const pref = cfg.nonAiPreference || 'auto';
  if (pref === 'domestic') return 'domestic';
  const reach = net ? net.googleReachable : null;
  const cooling = !!(net && net.cooldownUntil && Date.now() < net.cooldownUntil);
  if (pref === 'google') {
    if (reach === false) return 'domestic';
    return cooling ? 'domestic' : 'google';
  }
  if (reach === false) return 'domestic';
  if (cooling) return 'domestic';
  return 'google';
}

function isFallbackable(e) {
  if (!(e instanceof ApiError)) return true;
  return e.status === 0 || e.status === 429 || e.status >= 500;
}

async function callChannel(channel, text, source, target, cfg) {
  if (channel === 'ai') return aiTranslate(text, source, target, cfg);
  if (channel === 'domestic') return domesticTranslate(text, source, target, cfg);
  return freeTranslate(text, source, target, cfg.gateway);
}

async function translateWithChannel(channel, text, source, target, cfg) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await callChannel(channel, text, source, target, cfg);
    } catch (e) {
      lastErr = e;
      const retryable = !(e instanceof ApiError) || e.status === 429 || e.status >= 500 || e.status === 0;
      if (!retryable || attempt === 1) break;
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  throw lastErr || new ApiError('翻译失败');
}

async function translate(input) {
  await ensureCache();
  const cfg = await getConfig();
  const target = input.target || cfg.targetLang || 'zh-CN';
  const source = input.source || 'auto';
  let text = String(input.text || '').replace(/\u00a0/g, ' ').trim();
  if (!text) throw new ApiError('没有可翻译的文本');
  const truncated = text.length > MAX_CHARS;
  if (truncated) text = text.slice(0, MAX_CHARS);

  // AI 通道与网络无关，跳过探测以免白等 1.8 秒
  const net = cfg.aiEnabled ? netState : await probeGoogle(false);
  const channel = resolveChannel(cfg, net);
  // 默认全局共享（跨站点复用）；上下文敏感场景可切到按站点隔离
  const scope = cfg.cacheScope === 'site' ? (input.host || '-') : '*';
  const key = cacheKey(text, source, target, channel, scope);

  const readCache = (k, ch) => {
    if (!cache.has(k)) return null;
    const hit = cache.get(k);
    return {
      text: hit.text,
      src: hit.src || '',
      target: hit.target || target,
      channel: hit.channel || ch,
      cached: true,
      truncated
    };
  };

  const cached = readCache(key, channel);
  if (cached) return cached;
  if (inflight.has(key)) return inflight.get(key);

  const job = (async () => {
    let usedChannel = channel;
    let usedKey = key;
    let out = null;

    try {
      out = await translateWithChannel(channel, text, source, target, cfg);
    } catch (e) {
      // 只有 Google 通道可降级；AI 与国内通道失败直接报错
      const canFallback = channel === 'google' && isFallbackable(e);
      if (!canFallback) throw e;

      const reason = e.status === 429 ? 'rate-limit' : 'unreachable';
      if (reason === 'rate-limit') {
        netState = {
          googleReachable: netState.googleReachable,
          checkedAt: netState.checkedAt,
          cooldownUntil: Date.now() + GOOGLE_COOLDOWN
        };
      } else {
        netState = { googleReachable: false, checkedAt: Date.now(), cooldownUntil: netState.cooldownUntil || 0 };
      }
      saveNetState();
      lastFallback = { at: Date.now(), from: 'google', to: 'domestic', reason };

      usedChannel = 'domestic';
      usedKey = cacheKey(text, source, target, usedChannel, scope);
      const alt = readCache(usedKey, usedChannel);
      if (alt) return Object.assign(alt, { fallback: reason });
      out = await translateWithChannel('domestic', text, source, target, cfg);
    }

    if (usedChannel === 'google') clearNetFail();
    const result = { text: out.text, src: out.src || '', target, channel: usedChannel };
    remember(usedKey, result);
    const ret = Object.assign({}, result, { truncated });
    if (usedChannel !== channel) ret.fallback = lastFallback ? lastFallback.reason : 'fallback';
    return ret;
  })().finally(() => inflight.delete(key));

  inflight.set(key, job);
  return job;
}

/* -------------------------------------------------------------- 消息路由 */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'TRANSLATE') {
    translate(Object.assign({ host: hostOf(sender) }, msg))
      .then((r) => sendResponse(Object.assign({ ok: true }, r)))
      .catch((e) => sendResponse({ ok: false, error: e && e.message ? e.message : '翻译失败' }));
    return true;
  }

  if (msg.type === 'OPEN_TRANSLATE') {
    const target = msg.target || 'zh-CN';
    const url = 'https://translate.google.com/?sl=auto&tl=' + encodeURIComponent(target)
      + '&text=' + encodeURIComponent(String(msg.text || '').slice(0, 5000)) + '&op=translate';
    chrome.tabs.create({ url });
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'DOMESTIC_TEST') {
    (async () => {
      try {
        const cfg = await getConfig();
        const r = await domesticTranslate(String(msg.text || 'Hello, world.'), 'auto', msg.target || cfg.targetLang, cfg);
        sendResponse({ ok: true, text: r.text, provider: domesticProviderName(cfg) });
      } catch (e) {
        sendResponse({ ok: false, error: e && e.message ? e.message : '国内接口请求失败' });
      }
    })();
    return true;
  }

  if (msg.type === 'AI_PROVIDERS') {
    sendResponse({
      ok: true,
      defaultProvider: AI_DEFAULT_PROVIDER,
      providers: Object.keys(AI_PROVIDERS).map((id) => Object.assign({ id }, AI_PROVIDERS[id]))
    });
    return;
  }

  if (msg.type === 'AI_USAGE') {
    usageQueue.then(async () => {
      try {
        const store = await chrome.storage.local.get({ aiUsage: null });
        sendResponse({ ok: true, usage: store.aiUsage || null });
      } catch (e) {
        sendResponse({ ok: false, error: '读取统计失败' });
      }
    });
    return true;
  }

  if (msg.type === 'AI_USAGE_RESET') {
    chrome.storage.local.set({ aiUsage: null })
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg.type === 'CACHE_STATS') {
    ensureCache().then(() => {
      const entries = Array.from(cache.values()).slice(-CACHE_PERSIST_LIMIT);
      const bytes = JSON.stringify(entries).length;
      sendResponse({ ok: true, count: cache.size, bytes });
    });
    return true;
  }

  if (msg.type === 'CACHE_CLEAR') {
    cache.clear();
    inflight.clear();
    clearTimeout(persistTimer);
    persistPending = false;
    try { chrome.storage.session.remove(SESSION_CACHE_KEY); } catch (e) { /* ignore */ }
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'AI_TEST') {
    getConfig()
      .then((cfg) => aiTranslate(String(msg.text || 'Hello, world.'), 'auto', msg.target || cfg.targetLang, cfg))
      .then((r) => sendResponse({ ok: true, text: r.text, channel: 'ai' }))
      .catch((e) => sendResponse({ ok: false, error: e && e.message ? e.message : 'AI 翻译失败' }));
    return true;
  }

  if (msg.type === 'GET_STATE') {
    (async () => {
      const cfg = await getConfig();
      if (!netState.checkedAt) probeGoogle(false); // 后台补探，不阻塞本次响应
      sendResponse({
        ok: true,
        config: {
          targetLang: cfg.targetLang,
          channel: resolveChannel(cfg, netState),
          nonAiChannel: resolveChannel(Object.assign({}, cfg, { aiEnabled: false }), netState),
          aiEnabled: cfg.aiEnabled,
          aiConfigured: aiConfigured(cfg),
          aiProvider: cfg.aiProvider,
          aiModel: cfg.aiModel,
          cacheScope: cfg.cacheScope,
          nonAiPreference: cfg.nonAiPreference,
          domesticProvider: domesticCfgOf(cfg).provider,
          domesticProviderName: domesticProviderName(cfg),
          domesticReady: domesticMissing(cfg).length === 0,
          hasGateway: !!cfg.gateway,
          net: publicNet(),
          fallback: lastFallback
        }
      });
    })();
    return true;
  }

  if (msg.type === 'NET_PROBE') {
    probeGoogle(true)
      .then((n) => sendResponse({ ok: true, net: publicNet(), channel: null, reachable: n.googleReachable }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
});

/* ------------------------------------------------------------ 菜单与快捷键 */

function setupMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_SELECTION,
      title: '翻译所选文字',
      contexts: ['selection']
    });
    chrome.contextMenus.create({
      id: MENU_OPTIONS,
      title: 'AI翻译专家设置',
      contexts: ['action']
    });
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  setupMenus();
  probeGoogle(true);
  const sync = await chrome.storage.sync.get({ targetLang: 'zh-CN', showBubble: true, autoTranslate: false, excludeSites: [] });
  await chrome.storage.sync.set(sync);
});

chrome.runtime.onStartup.addListener(() => {
  setupMenus();
  probeGoogle(true);
});

async function sendToTab(tabId, frameId, message) {
  const opts = typeof frameId === 'number' ? { frameId } : undefined;
  try {
    return await chrome.tabs.sendMessage(tabId, message, opts);
  } catch (e) {
    try {
      await chrome.scripting.executeScript({
        target: typeof frameId === 'number' ? { tabId, frameIds: [frameId] } : { tabId },
        files: ['langs.js', 'panel-style.js', 'panel-template.js', 'content.js', 'page-translate.js']
      });
      return await chrome.tabs.sendMessage(tabId, message, opts);
    } catch (e2) {
      console.warn('[AI翻译专家] 无法在当前页面注入脚本：', e2 && e2.message);
      return null;
    }
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_SELECTION && tab && tab.id >= 0) {
    sendToTab(tab.id, info.frameId, { type: 'TRANSLATE_SELECTION' });
  } else if (info.menuItemId === MENU_OPTIONS) {
    chrome.runtime.openOptionsPage();
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'translate-selection') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.id >= 0) sendToTab(tab.id, undefined, { type: 'TRANSLATE_SELECTION' });
});
