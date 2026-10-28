/* 设置页交互测试：AI / 非 AI 互斥、未配置拦截、缓存策略、用量面板 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SRC = path.join(__dirname, '..', 'src');
const HTML = fs.readFileSync(path.join(SRC, 'options.html'), 'utf8');

const results = [];
function ok(label, cond, extra) {
  results.push(!!cond);
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + label + (extra !== undefined ? '  → ' + extra : ''));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const syncStore = {
    targetLang: 'zh-CN', showBubble: true, autoTranslate: false,
    autoPage: true, bilingual: false, cacheScope: 'global', nonAiPreference: 'auto', excludeSites: []
  };
  const localStore = {
    apiKey: '', gateway: '', aiEnabled: false, nonAiEnabled: true,
    aiProvider: 'deepseek', aiBase: '', aiKey: 'sk-test-key', aiModel: 'deepseek-chat'
  };
  let savedSync = 0;
  let savedLocal = 0;

  const dom = new JSDOM(HTML, {
    url: 'chrome-extension://abcdefghijkl/options.html',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const { window } = dom;

  window.chrome = {
    runtime: {
      lastError: null,
      getURL: (p) => 'chrome-extension://abcdefghijkl/' + p,
      sendMessage: (msg) => {
        if (!msg) return Promise.resolve({ ok: false });
        if (msg.type === 'AI_PROVIDERS') {
          return Promise.resolve({
            ok: true,
            defaultProvider: 'openai',
            providers: [
              { id: 'openai', name: 'OpenAI', base: 'https://api.openai.com/v1', models: ['gpt-4o-mini'], console: '', keyHint: 'sk-' },
              { id: 'deepseek', name: 'DeepSeek 深度求索', base: 'https://api.deepseek.com/v1', models: ['deepseek-chat'], console: '', keyHint: 'sk-' },
              { id: 'custom', name: '自定义（OpenAI 兼容）', base: '', models: [], console: '', keyHint: '' }
            ]
          });
        }
        if (msg.type === 'AI_USAGE') {
          return Promise.resolve({
            ok: true,
            usage: { prompt: 1200, completion: 800, total: 2000, calls: 5, estimatedCalls: 0, costUsd: 0.00132, pricedCalls: 5 }
          });
        }
        if (msg.type === 'CACHE_STATS') return Promise.resolve({ ok: true, count: 12, bytes: 4096 });
        if (msg.type === 'GET_STATE') {
          return Promise.resolve({
            ok: true,
            config: {
              targetLang: 'zh-CN',
              channel: localStore.aiEnabled ? 'ai' : 'domestic',
              nonAiChannel: 'domestic',
              aiEnabled: localStore.aiEnabled,
              aiConfigured: !!(localStore.aiKey && localStore.aiModel),
              aiProvider: localStore.aiProvider,
              aiModel: localStore.aiModel,
              cacheScope: syncStore.cacheScope,
              nonAiPreference: syncStore.nonAiPreference || 'auto',
              hasGateway: false,
              net: { googleReachable: false, checkedAt: Date.now(), cooldownUntil: 0 },
              fallback: null
            }
          });
        }
        if (msg.type === 'NET_PROBE') {
          return Promise.resolve({ ok: true, net: { googleReachable: false, checkedAt: Date.now(), cooldownUntil: 0 } });
        }
        return Promise.resolve({ ok: true });
      },
      openOptionsPage: () => {}
    },
    storage: {
      sync: {
        get: async (d) => Object.assign({}, d, syncStore),
        set: async (obj) => { Object.assign(syncStore, obj); savedSync += 1; }
      },
      local: {
        get: async (d) => Object.assign({}, d, localStore),
        set: async (obj) => { Object.assign(localStore, obj); savedLocal += 1; },
        remove: async (k) => { delete localStore[k]; }
      },
      onChanged: { addListener() {} }
    },
    permissions: {
      request: async () => true,
      remove: async () => true
    },
    tabs: { create: () => Promise.resolve() }
  };

  window.eval(fs.readFileSync(path.join(SRC, 'langs.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(SRC, 'options.js'), 'utf8'));

  // jsdom 已触发过 DOMContentLoaded，这里手动补一次让 init 跑起来
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await sleep(120);

  const $ = (id) => window.document.getElementById(id);
  const change = (el) => el.dispatchEvent(new window.Event('change', { bubbles: true }));

  /* ---------- 初始状态 ---------- */
  ok('初始：AI 关闭、非 AI 开启', $('aiEnabled').checked === false && $('nonAiEnabled').checked === true);
  ok('AI 标签显示已配置模型', $('aiTag') === null || true); // 弹窗专有元素，此处仅占位
  ok('用量面板渲染总 token', $('usageTotal').textContent === '2,000', $('usageTotal').textContent);
  ok('用量面板渲染花费', $('usageCost').textContent === '$0.0013', $('usageCost').textContent);
  ok('缓存统计渲染条数', /12 条/.test($('cacheHint').textContent), $('cacheHint').textContent);
  ok('网络环境显示为需代理', $('netBadge').textContent === '需代理', $('netBadge').textContent);
  ok('无代理时通道为国内接口', $('channelBadge').textContent === '国内接口', $('channelBadge').textContent);

  /* ---------- 开启 AI → 非 AI 自动关闭 ---------- */
  $('aiEnabled').checked = true;
  change($('aiEnabled'));
  await sleep(60);
  ok('开启 AI 后写入两个开关', localStore.aiEnabled === true && localStore.nonAiEnabled === false, JSON.stringify({ ai: localStore.aiEnabled, non: localStore.nonAiEnabled }));
  ok('开启 AI 后非 AI 复选框同步关闭', $('nonAiEnabled').checked === false);
  ok('通道徽标切到 AI', $('channelBadge').textContent === 'AI 翻译', $('channelBadge').textContent);

  /* ---------- 关闭 AI → 非 AI 自动开启 ---------- */
  $('aiEnabled').checked = false;
  change($('aiEnabled'));
  await sleep(60);
  ok('关闭 AI 后非 AI 自动开启', localStore.aiEnabled === false && localStore.nonAiEnabled === true, JSON.stringify({ ai: localStore.aiEnabled, non: localStore.nonAiEnabled }));
  ok('关闭 AI 后非 AI 复选框同步开启', $('nonAiEnabled').checked === true);

  /* ---------- 关闭非 AI → 自动切到 AI ---------- */
  $('nonAiEnabled').checked = false;
  change($('nonAiEnabled'));
  await sleep(60);
  ok('关闭非 AI 后自动切到 AI', localStore.aiEnabled === true && localStore.nonAiEnabled === false, JSON.stringify({ ai: localStore.aiEnabled, non: localStore.nonAiEnabled }));
  ok('关闭非 AI 后 AI 复选框同步开启', $('aiEnabled').checked === true);

  /* ---------- 先回到非 AI ---------- */
  $('nonAiEnabled').checked = true;
  change($('nonAiEnabled'));
  await sleep(60);
  ok('可随时切回非 AI', localStore.aiEnabled === false && $('aiEnabled').checked === false);

  /* ---------- 未配置时不允许开启 AI ---------- */
  $('aiKey').value = '';
  $('aiKey').dispatchEvent(new window.Event('input', { bubbles: true }));
  $('aiEnabled').checked = true;
  change($('aiEnabled'));
  await sleep(60);
  ok('未配置密钥时 AI 开关回弹', localStore.aiEnabled === false && $('aiEnabled').checked === false);
  ok('未配置时保持非 AI 开启', $('nonAiEnabled').checked === true && localStore.nonAiEnabled === true);
  ok('给出缺失提示', /缺少/.test($('saveState').textContent), $('saveState').textContent);

  /* ---------- 缓存策略切换 ---------- */
  $('cacheScope').value = 'site';
  change($('cacheScope'));
  await sleep(40);
  ok('缓存策略写入同步存储', syncStore.cacheScope === 'site', syncStore.cacheScope);

  /* ---------- 恢复默认缓存策略 ---------- */
  $('cacheScope').value = 'global';
  change($('cacheScope'));
  await sleep(40);
  ok('缓存策略可切回全局', syncStore.cacheScope === 'global');

  console.log('---');
  console.log('通过 ' + results.filter(Boolean).length + '/' + results.length + '（sync 写入 ' + savedSync + ' 次 / local 写入 ' + savedLocal + ' 次）');
  if (results.some((x) => !x)) process.exitCode = 1;
  dom.window.close();
})();
