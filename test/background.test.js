/* 后台逻辑测试：通道调度、网络探测、限流降级、缓存、AI 通道与用量 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src', 'background.js');
const code = fs.readFileSync(SRC, 'utf8');

const results = [];
function ok(label, cond, extra) {
  results.push(!!cond);
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + label + (extra !== undefined ? '  → ' + extra : ''));
}

/* ------------------------------------------------------------ 可变的桩状态 */
let localCfg = {
  gateway: '', aiEnabled: false, aiProvider: 'openai', aiBase: '', aiKey: '', aiModel: ''
};
let syncCfg = { targetLang: 'zh-CN', cacheScope: 'global', nonAiPreference: 'auto' };
const sessionStore = {};

const net = { reachable: false, probeCalls: 0 };
let googleResponse = null;
let googleThrows = false;
let domesticResponse = null;
let lastReq = null;
let lastDomesticBody = null;
let googleCalls = 0;
let domesticCalls = 0;
let aiCalls = 0;
let aiResponse = null;
const providerResponses = { baidu: null, youdao: null, tencent: null };
const providerReqs = { baidu: null, youdao: null, tencent: null };
let providerCalls = { baidu: 0, youdao: 0, tencent: 0 };

function makeResponse(payload, status) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

const chromeStub = {
  runtime: {
    onMessage: { addListener() {} },
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    openOptionsPage() {}
  },
  contextMenus: { removeAll(cb) { cb && cb(); }, create() {}, onClicked: { addListener() {} } },
  commands: { onCommand: { addListener() {} } },
  storage: {
    sync: { get: async (d) => Object.assign({}, d, syncCfg), set: async () => {} },
    local: {
      get: async (d) => Object.assign({}, d, localCfg),
      set: async (obj) => { Object.assign(localCfg, obj); },
      remove: async (k) => { delete localCfg[k]; }
    },
    session: {
      get: async (k) => ({ [k]: sessionStore[k] }),
      set: async (obj) => { Object.assign(sessionStore, obj); },
      remove: async (k) => { delete sessionStore[k]; }
    }
  },
  tabs: { create() {}, query: async () => [{}], sendMessage: async () => null },
  scripting: { executeScript: async () => {} }
};

async function fakeFetch(url, opts) {
  if (String(url).indexOf('generate_204') > -1) {
    net.probeCalls += 1;
    if (!net.reachable) throw new Error('ERR_BLOCKED_BY_CLIENT');
    return makeResponse({}, 204);
  }
  if (String(url).indexOf('fanyi-api.baidu.com') > -1) {
    providerCalls.baidu += 1;
    providerReqs.baidu = { url, body: new URLSearchParams(opts.body) };
    return providerResponses.baidu;
  }
  if (String(url).indexOf('openapi.youdao.com') > -1) {
    providerCalls.youdao += 1;
    providerReqs.youdao = { url, body: new URLSearchParams(opts.body) };
    return providerResponses.youdao;
  }
  if (String(url).indexOf('tmt.tencentcloudapi.com') > -1) {
    providerCalls.tencent += 1;
    providerReqs.tencent = { url, headers: opts.headers, body: opts.body };
    return providerResponses.tencent;
  }
  if (String(url).indexOf('transmart.qq.com') > -1) {
    domesticCalls += 1;
    lastDomesticBody = JSON.parse(opts.body);
    return domesticResponse;
  }
  if (String(url).indexOf('translate.googleapis.com') > -1) {
    googleCalls += 1;
    lastReq = { url, opts };
    if (googleThrows) throw new Error('network');
    return googleResponse;
  }
  // AI 通道（各家兼容端点）
  aiCalls += 1;
  lastReq = { url, opts };
  return aiResponse;
}

const ctx = {
  console, setTimeout, clearTimeout, AbortController, URLSearchParams, URL,
  TextEncoder, TextDecoder, crypto: globalThis.crypto, Date, Math, JSON, Promise,
  chrome: chromeStub,
  fetch: fakeFetch
};
ctx.globalThis = ctx;
vm.createContext(ctx);
const exportLine = '\n;globalThis.__T = { translate, parseFreePayload, freeUrl, aiEndpoint, resolveChannel, AI_PROVIDERS, domesticLang, cacheKey, md5Hex, sha256Hex, domesticMissing, domesticProviderName,'
  + ' resetNet: function () { netState = { googleReachable: null, checkedAt: 0, cooldownUntil: 0 }; probing = null; lastFallback = null; } };';
vm.runInContext(code + exportLine, ctx);
const T = ctx.__T;

const DJ = {
  sentences: [{ trans: '你好，', orig: 'Hello, ' }, { trans: '世界。', orig: 'world.' }],
  src: 'en'
};
const DOM = { header: { ret_code: 'succ' }, auto_translation: ['国内译文'], src_lang: 'en' };

function resetCounters() {
  googleCalls = 0;
  domesticCalls = 0;
  aiCalls = 0;
}

(async () => {
  /* ---------------- 1. 解析 ---------------- */
  const parsed = T.parseFreePayload(DJ);
  ok('解析 dj=1 结构', parsed.text === '你好，世界。' && parsed.src === 'en', JSON.stringify(parsed));
  const arrParsed = T.parseFreePayload([[['译文一', '原文一'], ['译文二', '原文二']], null, 'ja']);
  ok('兼容数组结构', arrParsed.text === '译文一译文二' && arrParsed.src === 'ja');

  /* ---------------- 2. 无代理：探测失败 → 直连国内接口 ---------------- */
  net.reachable = false;
  sessionStore.netState = null;
  T.resetNet();
  googleResponse = makeResponse(DJ, 200);
  domesticResponse = makeResponse(DOM, 200);
  resetCounters();
  const noProxy = await T.translate({ text: 'No proxy text', target: 'zh-CN', host: 'a.com' });
  ok('无代理时走国内接口', noProxy.channel === 'domestic' && noProxy.text === '国内译文', JSON.stringify({ ch: noProxy.channel, text: noProxy.text }));
  ok('无代理时不会请求 Google', googleCalls === 0, 'google=' + googleCalls);
  ok('已探测网络', net.probeCalls > 0, 'probes=' + net.probeCalls);

  /* ---------------- 3. 国内接口请求体 ---------------- */
  ok('国内接口字段正确',
    lastDomesticBody.header.fn === 'auto_translation' &&
    lastDomesticBody.source.lang === 'auto' &&
    lastDomesticBody.target.lang === 'zh' &&
    Array.isArray(lastDomesticBody.source.text_list) &&
    lastDomesticBody.source.text_list[0] === 'No proxy text',
    JSON.stringify(lastDomesticBody).slice(0, 160));
  ok('语言码映射', T.domesticLang('zh-CN') === 'zh' && T.domesticLang('zh-TW') === 'zh-TW' && T.domesticLang('auto') === 'auto' && T.domesticLang('pt-BR') === 'pt');

  /* ---------------- 4. 有代理：走 Google ---------------- */
  net.reachable = true;
  sessionStore.netState = null;
  T.resetNet();
  googleResponse = makeResponse(DJ, 200);
  resetCounters();
  const withProxy = await T.translate({ text: 'Proxy text', target: 'zh-CN', host: 'a.com' });
  ok('可访问 Google 时走免费接口', withProxy.channel === 'google' && withProxy.text === '你好，世界。', withProxy.channel);
  ok('走 Google 时不请求国内接口', domesticCalls === 0, 'domestic=' + domesticCalls);
  const body = new URLSearchParams(lastReq.opts.body);
  ok('Google 请求参数完整', body.get('tl') === 'zh-CN' && body.get('dj') === '1', body.toString().slice(0, 80));

  /* ---------------- 5. Google 限流 → 自动降级 ---------------- */
  sessionStore.netState = null;
  T.resetNet();
  googleResponse = makeResponse({}, 429);
  domesticResponse = makeResponse({ header: { ret_code: 'succ' }, auto_translation: ['降级译文'], src_lang: 'en' }, 200);
  resetCounters();
  const fb = await T.translate({ text: 'Rate limited text', target: 'zh-CN', host: 'a.com' });
  ok('Google 429 自动降级国内接口', fb.channel === 'domestic' && fb.text === '降级译文' && fb.fallback === 'rate-limit', JSON.stringify({ ch: fb.channel, f: fb.fallback }));

  resetCounters();
  const afterFb = await T.translate({ text: 'After cooldown text', target: 'zh-CN', host: 'a.com' });
  ok('熔断期内直接走国内接口', afterFb.channel === 'domestic' && googleCalls === 0, 'google=' + googleCalls);

  /* ---------------- 6. Google 网络异常 → 降级并标记不可达 ---------------- */
  sessionStore.netState = null;
  T.resetNet();
  net.reachable = true;
  googleThrows = true;
  domesticResponse = makeResponse(DOM, 200);
  resetCounters();
  const netErr = await T.translate({ text: 'Google broken text', target: 'zh-CN', host: 'a.com' });
  ok('Google 网络异常时降级', netErr.channel === 'domestic' && netErr.fallback === 'unreachable', JSON.stringify({ ch: netErr.channel, f: netErr.fallback }));
  googleThrows = false;

  /* ---------------- 7. 用户优先级 ---------------- */
  net.reachable = true;
  sessionStore.netState = null;
  T.resetNet();
  syncCfg.nonAiPreference = 'domestic';
  googleResponse = makeResponse(DJ, 200);
  domesticResponse = makeResponse(DOM, 200);
  resetCounters();
  const prefDom = await T.translate({ text: 'Prefer domestic text', target: 'zh-CN', host: 'a.com' });
  ok('锁定国内接口时无视网络', prefDom.channel === 'domestic' && googleCalls === 0, 'google=' + googleCalls);

  net.reachable = false;
  sessionStore.netState = null;
  T.resetNet();
  syncCfg.nonAiPreference = 'google';
  resetCounters();
  const prefGoogleNoNet = await T.translate({ text: 'Prefer google but offline', target: 'zh-CN', host: 'a.com' });
  ok('优先 Google 但不可达时回退国内', prefGoogleNoNet.channel === 'domestic', prefGoogleNoNet.channel);

  syncCfg.nonAiPreference = 'auto';
  net.reachable = true;
  sessionStore.netState = null;
  T.resetNet();

  /* ---------------- 8. 国内接口错误 ---------------- */
  sessionStore.netState = null;
  T.resetNet();
  net.reachable = false;
  domesticResponse = makeResponse({ header: { ret_code: 'error' }, message: 'Unrecognized target language' }, 200);
  let dErr = '';
  try { await T.translate({ text: 'Domestic error text', target: 'zh-CN', host: 'a.com' }); } catch (e) { dErr = e.message; }
  ok('国内接口错误有明确提示', /国内翻译接口返回错误/.test(dErr), dErr);
  domesticResponse = makeResponse(DOM, 200);

  /* ---------------- 9. 缓存：全局共享 / 站点隔离 ---------------- */
  sessionStore.netState = null;
  T.resetNet();
  net.reachable = false;
  syncCfg.cacheScope = 'global';
  resetCounters();
  await T.translate({ text: 'Same sentence on two sites', target: 'zh-CN', host: 'a.com' });
  const globalHit = await T.translate({ text: 'Same sentence on two sites', target: 'zh-CN', host: 'b.com' });
  ok('全局共享：跨站点直接命中', globalHit.cached === true && domesticCalls === 1, 'domestic=' + domesticCalls);

  syncCfg.cacheScope = 'site';
  resetCounters();
  await T.translate({ text: 'Site scoped sentence', target: 'zh-CN', host: 'a.com' });
  const siteHit = await T.translate({ text: 'Site scoped sentence', target: 'zh-CN', host: 'a.com' });
  const siteMiss = await T.translate({ text: 'Site scoped sentence', target: 'zh-CN', host: 'b.com' });
  ok('站点隔离：同站点仍命中', siteHit.cached === true);
  ok('站点隔离：跨站点各翻一次', siteMiss.cached !== true && domesticCalls === 2, 'domestic=' + domesticCalls);
  syncCfg.cacheScope = 'global';

  /* ---------------- 10. 缓存命中与持久化 ---------------- */
  const before = domesticCalls;
  const r2 = await T.translate({ text: 'Same sentence on two sites', target: 'zh-CN', host: 'b.com' });
  ok('重复请求命中缓存', r2.cached === true && domesticCalls === before);

  await T.translate({ text: 'Persist this sentence', target: 'zh-CN', host: 'a.com' });
  await new Promise((r) => setTimeout(r, 1500));
  ok('缓存写入 storage.session', !!sessionStore.gtCacheV1 && Object.keys(sessionStore.gtCacheV1).length > 0);
  ok('网络探测结果已持久化', !!sessionStore.netState && sessionStore.netState.googleReachable === false, JSON.stringify(sessionStore.netState));

  const ctx2 = {
    console, setTimeout, clearTimeout, AbortController, URLSearchParams, URL,
    TextEncoder, TextDecoder, crypto: globalThis.crypto, Date, Math, JSON, Promise,
    chrome: chromeStub, fetch: fakeFetch
  };
  ctx2.globalThis = ctx2;
  vm.createContext(ctx2);
  vm.runInContext(code + '\n;globalThis.__T = { translate };', ctx2);
  const beforeRestart = domesticCalls;
  const afterRestart = await ctx2.__T.translate({ text: 'Persist this sentence', target: 'zh-CN', host: 'a.com' });
  ok('重启后仍命中缓存', afterRestart.cached === true && domesticCalls === beforeRestart);

  /* ---------------- 11. AI 通道 ---------------- */
  localCfg = { gateway: '', aiEnabled: true, nonAiEnabled: false, aiProvider: 'openai', aiBase: '', aiKey: '', aiModel: '' };
  let aiErr = '';
  try { await T.translate({ text: 'AI config missing text', target: 'zh-CN' }); } catch (e) { aiErr = e.message; }
  ok('AI 未配置时提示缺失项', /AI 翻译尚未配置完整/.test(aiErr) && /模型名称/.test(aiErr) && /API 密钥/.test(aiErr), aiErr);

  localCfg = { gateway: '', aiEnabled: true, nonAiEnabled: false, aiProvider: 'openai', aiBase: '', aiKey: 'sk-test', aiModel: 'gpt-4o-mini' };
  aiResponse = makeResponse({ choices: [{ message: { content: 'AI 译文' } }] }, 200);
  domesticResponse = makeResponse(DOM, 200);
  resetCounters();
  const aiRes = await T.translate({ text: 'AI channel text', target: 'zh-CN', host: 'a.com' });
  ok('AI 通道被启用', aiRes.channel === 'ai', aiRes.channel);
  ok('AI 开启时不请求 Google/国内接口', googleCalls === 0 && domesticCalls === 0 && aiCalls === 1, JSON.stringify({ g: googleCalls, d: domesticCalls, ai: aiCalls }));

  /* ---------------- 12. AI 端点 ---------------- */
  ok('补全：只填域名', T.aiEndpoint('api.openai.com') === 'https://api.openai.com/v1/chat/completions');
  ok('补全：以 /v1 结尾', T.aiEndpoint('https://api.deepseek.com/v1') === 'https://api.deepseek.com/v1/chat/completions');
  ok('保持：已是完整端点', T.aiEndpoint('https://x.com/chat/completions') === 'https://x.com/chat/completions');
  ok('服务商预设存在', !!T.AI_PROVIDERS.openai && !!T.AI_PROVIDERS.deepseek && !!T.AI_PROVIDERS.custom);

  /* ---------------- 13. 通道决策函数 ---------------- */
  const cfgBase = { aiEnabled: false, nonAiPreference: 'auto' };
  ok('决策：AI 独占', T.resolveChannel({ aiEnabled: true }, { googleReachable: true }) === 'ai');
  ok('决策：无代理走国内', T.resolveChannel(cfgBase, { googleReachable: false }) === 'domestic');
  ok('决策：有代理走 Google', T.resolveChannel(cfgBase, { googleReachable: true, cooldownUntil: 0 }) === 'google');
  ok('决策：熔断期走国内', T.resolveChannel(cfgBase, { googleReachable: true, cooldownUntil: Date.now() + 60000 }) === 'domestic');
  ok('决策：锁定国内', T.resolveChannel({ nonAiPreference: 'domestic' }, { googleReachable: true }) === 'domestic');
  ok('决策：锁定 Google 但不可达', T.resolveChannel({ nonAiPreference: 'google' }, { googleReachable: false }) === 'domestic');

  /* ---------------- 14. Token 用量 ---------------- */
  localCfg = {
    gateway: '', aiEnabled: true, nonAiEnabled: false,
    aiProvider: 'openai', aiBase: '', aiKey: 'sk-usage', aiModel: 'gpt-4o-mini', aiUsage: null
  };
  aiResponse = makeResponse({
    choices: [{ message: { content: '用量测试译文' } }],
    usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 }
  }, 200);
  await T.translate({ text: 'Usage metering text', target: 'zh-CN', host: 'a.com' });
  await new Promise((r) => setTimeout(r, 80));
  const u1 = localCfg.aiUsage || {};
  ok('记录总 token', u1.total === 1500 && u1.prompt === 1000 && u1.completion === 500);
  ok('按价目估算花费', Math.abs((u1.costUsd || 0) - 0.00045) < 1e-6, String(u1.costUsd));

  aiResponse = makeResponse({ choices: [{ message: { content: '无用量信息' } }] }, 200);
  await T.translate({ text: 'No usage field text', target: 'zh-CN', host: 'a.com' });
  await new Promise((r) => setTimeout(r, 80));
  ok('无 usage 时按字符估算', localCfg.aiUsage.calls === 2 && localCfg.aiUsage.estimatedCalls === 1);

  /* ---------------- 15. 自定义国产接口：MD5 与签名 ---------------- */
  const crypto = require('crypto');
  ok('MD5 已知向量', T.md5Hex('abc') === '900150983cd24fb0d6963f7d28e17f72', T.md5Hex('abc'));
  ok('MD5 中文与 Node 一致', T.md5Hex('中文测试&符号') === crypto.createHash('md5').update('中文测试&符号', 'utf8').digest('hex'));

  /* ---------------- 16. 百度 ---------------- */
  localCfg = {
    gateway: '', domestic: { provider: 'baidu', baidu: { appId: '202401', key: 'baidu-secret' } },
    aiEnabled: false, nonAiEnabled: true
  };
  sessionStore.netState = null;
  T.resetNet();
  net.reachable = false;
  providerResponses.baidu = makeResponse({ from: 'en', to: 'zh', trans_result: [{ src: 'Hello', dst: '百度译文' }] }, 200);
  providerCalls = { baidu: 0, youdao: 0, tencent: 0 };
  const baiduRes = await T.translate({ text: 'Baidu channel text', target: 'zh-CN', host: 'a.com' });
  ok('百度通道被启用', baiduRes.channel === 'domestic' && baiduRes.text === '百度译文', JSON.stringify({ ch: baiduRes.channel, t: baiduRes.text }));
  const bq = providerReqs.baidu.body;
  ok('百度请求字段完整', bq.get('appid') === '202401' && bq.get('from') === 'auto' && bq.get('to') === 'zh', bq.toString().slice(0, 90));
  const expectedSign = crypto.createHash('md5')
    .update(bq.get('appid') + bq.get('q') + bq.get('salt') + 'baidu-secret', 'utf8').digest('hex');
  ok('百度签名正确', bq.get('sign') === expectedSign, bq.get('sign'));

  providerResponses.baidu = makeResponse({ error_code: '54001', error_msg: 'Invalid Sign' }, 200);
  let bErr = '';
  try { await T.translate({ text: 'Baidu error text', target: 'zh-CN', host: 'a.com' }); } catch (e) { bErr = e.message; }
  ok('百度错误提示含排查方向', /百度翻译返回错误/.test(bErr) && /APP ID/.test(bErr), bErr);

  /* ---------------- 17. 有道 ---------------- */
  localCfg = {
    gateway: '', domestic: { provider: 'youdao', youdao: { appKey: 'yd-key', appSecret: 'yd-secret' } },
    aiEnabled: false, nonAiEnabled: true
  };
  sessionStore.netState = null;
  T.resetNet();
  providerResponses.youdao = makeResponse({ errorCode: '0', translation: ['有道译文'], l: 'en' }, 200);
  providerCalls = { baidu: 0, youdao: 0, tencent: 0 };
  const ydRes = await T.translate({ text: 'Youdao channel text', target: 'zh-CN', host: 'a.com' });
  ok('有道通道被启用', ydRes.channel === 'domestic' && ydRes.text === '有道译文', ydRes.text);
  const yq = providerReqs.youdao.body;
  const truncInput = (() => {
    const t = 'Youdao channel text';
    return t.length <= 20 ? t : t.slice(0, 10) + t.length + t.slice(-10);
  })();
  const expectedYdSign = crypto.createHash('sha256')
    .update('yd-key' + truncInput + yq.get('salt') + yq.get('curtime') + 'yd-secret', 'utf8').digest('hex');
  ok('有道签名为 SHA256 v3', yq.get('signType') === 'v3' && yq.get('sign') === expectedYdSign, yq.get('sign'));

  providerResponses.youdao = makeResponse({ errorCode: '108' }, 200);
  let yErr = '';
  try { await T.translate({ text: 'Youdao error text', target: 'zh-CN', host: 'a.com' }); } catch (e) { yErr = e.message; }
  ok('有道错误提示含排查方向', /有道翻译返回错误/.test(yErr) && /108/.test(yErr), yErr);

  /* ---------------- 18. 腾讯云 ---------------- */
  localCfg = {
    gateway: '', domestic: { provider: 'tencent', tencent: { secretId: 'AKIDtest', secretKey: 'tc-secret', region: 'ap-guangzhou' } },
    aiEnabled: false, nonAiEnabled: true
  };
  sessionStore.netState = null;
  T.resetNet();
  providerResponses.tencent = makeResponse({ Response: { TargetText: '腾讯译文', Source: 'en', RequestId: 'r1' } }, 200);
  providerCalls = { baidu: 0, youdao: 0, tencent: 0 };
  const tcRes = await T.translate({ text: 'Tencent channel text', target: 'zh-CN', host: 'a.com' });
  ok('腾讯云通道被启用', tcRes.channel === 'domestic' && tcRes.text === '腾讯译文', tcRes.text);

  const tcHeaders = providerReqs.tencent.headers;
  const tcBody = providerReqs.tencent.body;
  const ts = tcHeaders['X-TC-Timestamp'];
  const date = new Date(Number(ts) * 1000).toISOString().slice(0, 10);
  const sha256 = (x) => crypto.createHash('sha256').update(x, 'utf8').digest('hex');
  const canonical = ['POST', '/', '',
    'content-type:application/json; charset=utf-8',
    'host:tmt.tencentcloudapi.com', '', 'content-type;host', sha256(tcBody)].join('\n');
  const sts = ['TC3-HMAC-SHA256', ts, date + '/tmt/tc3_request', sha256(canonical)].join('\n');
  const hmac = (key, msg) => crypto.createHmac('sha256', key).update(msg, 'utf8').digest();
  const kSigning = hmac(hmac(hmac('TC3tc-secret', date), 'tmt'), 'tc3_request');
  const expectedSig = crypto.createHmac('sha256', kSigning).update(sts, 'utf8').digest('hex');
  ok('腾讯云 TC3 签名正确',
    tcHeaders.Authorization.indexOf('Credential=AKIDtest/' + date + '/tmt/tc3_request') > -1 &&
    tcHeaders.Authorization.indexOf('Signature=' + expectedSig) > -1,
    tcHeaders.Authorization.slice(0, 60) + '…');
  ok('腾讯云请求头与动作正确',
    tcHeaders['X-TC-Action'] === 'TextTranslate' && tcHeaders['X-TC-Version'] === '2018-03-21' && JSON.parse(tcBody).Target === 'zh',
    JSON.stringify({ a: tcHeaders['X-TC-Action'], v: tcHeaders['X-TC-Version'] }));

  providerResponses.tencent = makeResponse({ Response: { Error: { Code: 'AuthFailure.SignatureFailure', Message: 'signature error' } } }, 200);
  let tErr = '';
  try { await T.translate({ text: 'Tencent error text', target: 'zh-CN', host: 'a.com' }); } catch (e) { tErr = e.message; }
  ok('腾讯云鉴权错误提示', /腾讯云翻译返回错误/.test(tErr) && /SecretId/.test(tErr), tErr);

  /* ---------------- 19. 默认内置 & 缺配置拦截 ---------------- */
  localCfg = { gateway: '', domestic: { provider: 'builtin' }, aiEnabled: false, nonAiEnabled: true };
  sessionStore.netState = null;
  T.resetNet();
  domesticResponse = makeResponse(DOM, 200);
  providerCalls = { baidu: 0, youdao: 0, tencent: 0 };
  const builtinRes = await T.translate({ text: 'Builtin default text', target: 'zh-CN', host: 'a.com' });
  ok('默认仍走内置接口', builtinRes.channel === 'domestic' && builtinRes.text === '国内译文');
  ok('默认不触碰官方接口', providerCalls.baidu + providerCalls.youdao + providerCalls.tencent === 0);

  localCfg = { gateway: '', domestic: { provider: 'baidu', baidu: { appId: '', key: '' } }, aiEnabled: false, nonAiEnabled: true };
  sessionStore.netState = null;
  T.resetNet();
  let lackErr = '';
  try { await T.translate({ text: 'Missing config text', target: 'zh-CN', host: 'a.com' }); } catch (e) { lackErr = e.message; }
  ok('官方接口缺配置时明确报错', /配置不完整/.test(lackErr) && /APP ID/.test(lackErr) && /密钥/.test(lackErr), lackErr);
  ok('缺配置时不发请求', providerCalls.baidu === 0);

  ok('无代理默认 provider 为 builtin', T.domesticProviderName({}) === '内置（腾讯交互翻译）', T.domesticProviderName({}));
  ok('缺项枚举正确', T.domesticMissing({ domestic: { provider: 'tencent', tencent: { secretId: 'a' } } }).join(',') === 'SecretKey');

  console.log('---');
  console.log('通过 ' + results.filter(Boolean).length + '/' + results.length);
  if (results.some((x) => !x)) process.exitCode = 1;
})();
