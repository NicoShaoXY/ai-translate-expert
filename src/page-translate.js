/* page-translate.js — 整页翻译引擎
 * 1) 检测页面语言（html lang + 文本脚本比例），非中文才触发
 * 2) 遍历可见文本节点 → 去重 → 按块合并请求（%%n%% 分隔）→ 回写译文
 * 3) 支持一键还原原文，并对动态加载内容做增量翻译
 */
(function () {
  'use strict';
  if (window.__GT_PAGE_LOADED__) return;
  window.__GT_PAGE_LOADED__ = true;

  var MAX_NODES = 1500;
  var MAX_UNITS = 900;
  var BATCH_CHARS = 1400;
  var BATCH_NODES = 8;
  var CONCURRENCY = 2;
  var MIN_PAGE_CHARS = 80;

  var SKIP_TAGS = {
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, CODE: 1, PRE: 1, KBD: 1, SAMP: 1, VAR: 1,
    TEXTAREA: 1, INPUT: 1, SELECT: 1, OPTION: 1, SVG: 1, MATH: 1, CANVAS: 1,
    VIDEO: 1, AUDIO: 1, IFRAME: 1, OBJECT: 1, EMBED: 1, TEMPLATE: 1, HEAD: 1
  };

  var BI_STYLE = 'display:inline;margin:0 0 0 4px;padding:0 3px;'
    + 'border-left:2px solid rgba(26,115,232,.45);background:rgba(26,115,232,.07);'
    + 'border-radius:2px;color:inherit;font-family:inherit;font-size:inherit;'
    + 'font-style:inherit;font-weight:inherit;line-height:inherit;'
    + 'letter-spacing:inherit;text-decoration:none;white-space:normal;';

  var LETTER_RE = /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u0900-\u097F\u0E00-\u0E7F\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/;
  var CJK_RE = /[\u3400-\u4DBF\u4E00-\u9FFF]/g;

  var ST = {
    auto: true,
    bilingual: false,
    target: 'zh-CN',
    exclude: [],
    running: false,
    translated: false,
    applying: false,
    detected: null,
    runId: 0,
    totalBatches: 0,
    done: 0,
    failed: 0,
    batchNodes: BATCH_NODES,
    batchChars: BATCH_CHARS,
    applied: 0,
    originals: new Map(),
    processed: new Set(),
    biNodes: [],
    observer: null,
    pendingTimer: 0,
    aborted: ''
  };

  /* ------------------------------------------------------------ 基础工具 */

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  function toast(msg, opts) {
    if (window.__GT_UI && typeof window.__GT_UI.toast === 'function') {
      window.__GT_UI.toast(msg, opts);
    } else {
      console.info('[AI翻译专家]', msg);
    }
  }

  function isExcluded() {
    var host = location.hostname.toLowerCase();
    if (!host) return false;
    return (ST.exclude || []).some(function (raw) {
      var d = String(raw || '').trim().toLowerCase()
        .replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      return d && (host === d || host.slice(-(d.length + 1)) === '.' + d);
    });
  }

  /* -------------------------------------------------------------- 语言检测 */

  function scriptStats(text) {
    var cjk = (text.match(CJK_RE) || []).length;
    var kana = (text.match(/[\u3040-\u30FF]/g) || []).length;
    var hangul = (text.match(/[\uAC00-\uD7AF]/g) || []).length;
    var latin = (text.match(/[A-Za-z]/g) || []).length;
    var cyr = (text.match(/[\u0400-\u04FF]/g) || []).length;
    var arab = (text.match(/[\u0600-\u06FF]/g) || []).length;
    var thai = (text.match(/[\u0E00-\u0E7F]/g) || []).length;
    return {
      cjk: cjk, kana: kana, hangul: hangul, latin: latin,
      cyr: cyr, arab: arab, thai: thai,
      total: cjk + kana + hangul + latin + cyr + arab + thai
    };
  }

  function sampleText(limit) {
    var out = '';
    if (!document.body) return out;
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    while (walker.nextNode()) {
      var n = walker.currentNode;
      var p = n.parentElement;
      if (!p || SKIP_TAGS[p.tagName]) continue;
      if (p.closest && p.closest('#gt-translate-root,[data-gt-bi]')) continue;
      var t = n.nodeValue;
      if (t && /\S/.test(t)) out += ' ' + t.trim();
      if (out.length >= limit) break;
    }
    return out.slice(0, limit);
  }

  function detectPage() {
    var langAttr = (document.documentElement.getAttribute('lang') || '').trim().toLowerCase();
    var text = sampleText(1400);
    var s = scriptStats(text);
    var code = '';
    var source = '';

    if (s.total >= 30) {
      source = 'heuristic';
      if (s.kana > 0 && s.kana * 15 > s.cjk) code = 'ja';
      else if (s.hangul > 0 && s.hangul * 4 > s.latin) code = 'ko';
      else if (s.cjk / s.total > 0.35) code = 'zh';
      else if (s.cyr > s.latin) code = 'ru';
      else if (s.arab > s.latin) code = 'ar';
      else if (s.thai > s.latin) code = 'th';
      else if (s.latin / s.total > 0.4) code = (langAttr.split('-')[0] || 'en');
      else code = langAttr.split('-')[0] || 'und';
      // 拉丁字母为主但语言标记写的是中文（误标站），以文本为准
      if (code === 'zh' && s.cjk / s.total < 0.2) code = langAttr.split('-')[0] || 'en';
    } else if (langAttr) {
      source = 'html-lang';
      code = langAttr.split('-')[0] || 'und';
    } else {
      source = 'none';
      code = 'und';
    }

    return {
      code: code,
      source: source,
      isChinese: code === 'zh',
      sampleLength: text.trim().length,
      stats: s
    };
  }

  /* ------------------------------------------------------------ 节点收集 */

  function collectNodes(root) {
    var out = [];
    if (!root) return out;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        var v = node.nodeValue;
        if (!v) return NodeFilter.FILTER_REJECT;
        var t = v.trim();
        if (t.length < 2) return NodeFilter.FILTER_REJECT;
        if (!LETTER_RE.test(t)) return NodeFilter.FILTER_REJECT;
        if (ST.processed.has(node)) return NodeFilter.FILTER_REJECT;
        var p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (SKIP_TAGS[p.tagName]) return NodeFilter.FILTER_REJECT;
        if (p.closest && p.closest('#gt-translate-root,[data-gt-bi],[translate="no"],.notranslate,[data-gt-skip],[contenteditable=""],[contenteditable="true"]')) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    while (walker.nextNode()) {
      out.push(walker.currentNode);
      if (out.length >= MAX_NODES) break;
    }
    return out;
  }

  function isMostlyChinese(text) {
    var s = scriptStats(text);
    if (!s.total) return false;
    return s.cjk / s.total > 0.5 && s.kana === 0;
  }

  function buildUnits(nodes, target) {
    var byText = new Map();
    var units = [];
    var skipChinese = String(target).indexOf('zh') === 0;
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var key = String(node.nodeValue).replace(/\s+/g, ' ').trim();
      if (!key) continue;
      if (skipChinese && isMostlyChinese(key)) { ST.processed.add(node); continue; }
      var hit = byText.get(key);
      if (hit) { hit.nodes.push(node); continue; }
      if (units.length >= MAX_UNITS) break;
      var unit = { text: key.length > 4000 ? key.slice(0, 4000) : key, nodes: [node] };
      byText.set(key, unit);
      units.push(unit);
    }
    return units;
  }

  /* ------------------------------------------------------------ 批次与前缀 */

  function buildBatches(units) {
    var batches = [];
    var cur = [];
    var chars = 0;
    for (var i = 0; i < units.length; i++) {
      var cost = units[i].text.length + 8;
      if (cur.length && (chars + cost > ST.batchChars || cur.length >= ST.batchNodes)) {
        batches.push(cur);
        cur = [];
        chars = 0;
      }
      cur.push(units[i]);
      chars += cost;
    }
    if (cur.length) batches.push(cur);
    return batches;
  }

  function batchPayload(batch) {
    return batch.map(function (u, i) {
      return '%%' + (i + 1) + '%% ' + u.text;
    }).join('\n');
  }

  // 按 %%n%% 前缀切回，数量或顺序不符即判定失败（交给逐条兜底）
  function splitBatch(translated, count) {
    var re = /%%\s*(\d+)\s*%%/g;
    var hits = [];
    var m;
    while ((m = re.exec(translated))) {
      hits.push({ idx: parseInt(m[1], 10), start: m.index, end: re.lastIndex });
    }
    if (hits.length !== count) return null;
    var out = [];
    for (var i = 0; i < hits.length; i++) {
      if (hits[i].idx !== i + 1) return null;
      var stop = i + 1 < hits.length ? hits[i + 1].start : translated.length;
      var seg = translated.slice(hits[i].end, stop).replace(/\s+/g, ' ').trim();
      if (!seg) return null;
      out.push(seg);
    }
    return out;
  }

  // AI 通道按 token 计费且更容易丢标记，批次收紧，失败时逐条兜底的代价也可控
  function loadChannel() {
    return new Promise(function (resolve) {
      var done = false;
      function fin() {
        if (done) return;
        done = true;
        resolve();
      }
      setTimeout(fin, 1500);
      try {
        chrome.runtime.sendMessage({ type: 'GET_STATE' }, function (res) {
          if (!chrome.runtime.lastError && res && res.ok && res.config) {
            ST.channel = res.config.channel || 'free';
            if (ST.channel === 'ai') {
              ST.batchNodes = 4;
              ST.batchChars = 900;
            } else {
              ST.batchNodes = BATCH_NODES;
              ST.batchChars = BATCH_CHARS;
            }
          }
          fin();
        });
      } catch (e) {
        fin();
      }
    });
  }

  /* -------------------------------------------------------------- 请求通道 */

  function askTranslate(text, target) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage({ type: 'TRANSLATE', text: text, target: target }, function (res) {
          if (chrome.runtime.lastError) {
            return resolve({ ok: false, error: '扩展已重新加载，请刷新本页' });
          }
          resolve(res || { ok: false, error: '翻译服务无响应' });
        });
      } catch (e) {
        resolve({ ok: false, error: '扩展上下文已失效，请刷新本页' });
      }
    });
  }

  function isNetError(msg) {
    return /无法连接|网络|超时|Failed to fetch|ERR_/.test(String(msg || ''));
  }

  async function askWithRetry(text, target) {
    var res = await askTranslate(text, target);
    if (!res.ok && /频繁|限流|429/.test(String(res.error || ''))) {
      await sleep(1600);
      res = await askTranslate(text, target);
    }
    return res;
  }

  /* -------------------------------------------------------------- 回写与还原 */

  function insertBilingual(node, text) {
    var parent = node.parentNode;
    if (!parent) return;
    var raw = node.nodeValue || '';
    var span = document.createElement('span');
    span.setAttribute('data-gt-bi', '1');
    span.setAttribute('translate', 'no');
    try { span.style.cssText = BI_STYLE; } catch (e) { /* 忽略样式失败 */ }
    span.textContent = /\s$/.test(raw) ? text : ' ' + text;
    parent.insertBefore(span, node.nextSibling);
    ST.biNodes.push(span);
  }

  function applyUnit(unit, text) {
    if (!text) return;
    ST.applying = true;
    for (var i = 0; i < unit.nodes.length; i++) {
      var node = unit.nodes[i];
      if (!node.isConnected) continue;

      if (ST.bilingual) {
        insertBilingual(node, text);
        ST.processed.add(node);
        ST.applied++;
        continue;
      }

      var raw = node.nodeValue;
      var lead = (raw.match(/^\s*/) || [''])[0];
      var trail = (raw.match(/\s*$/) || [''])[0];
      if (!ST.originals.has(node)) ST.originals.set(node, raw);
      node.nodeValue = lead + text + trail;
      ST.processed.add(node);
      ST.applied++;
    }
    ST.applying = false;
  }

  function restore(silent) {
    ST.runId++;
    ST.running = false;
    stopObserver();
    ST.originals.forEach(function (orig, node) {
      try {
        if (node.isConnected) node.nodeValue = orig;
      } catch (e) { /* 忽略已脱离的节点 */ }
    });
    for (var i = 0; i < ST.biNodes.length; i++) {
      var el = ST.biNodes[i];
      try { if (el.parentNode) el.parentNode.removeChild(el); } catch (e) { /* ignore */ }
    }
    ST.biNodes = [];
    ST.originals.clear();
    ST.processed.clear();
    ST.translated = false;
    ST.applied = 0;
    ST.done = 0;
    ST.totalBatches = 0;
    if (!silent) toast('已恢复原文', { ttl: 2200 });
  }

  /* ---------------------------------------------------------------- 主流程 */

  function progress() {
    if (ST.runId !== ST.currentRun) return;
    toast('正在翻译页面… ' + ST.done + '/' + ST.totalBatches, { sticky: true });
  }

  async function translateBatch(batch, runId) {
    if (runId !== ST.runId) return;

    if (batch.length === 1) {
      var single = await askWithRetry(batch[0].text, ST.target);
      if (single.ok) applyUnit(batch[0], String(single.text || '').trim());
      else if (isNetError(single.error)) { ST.aborted = single.error; }
      else ST.failed += batch[0].nodes.length;
      return;
    }

    var res = await askWithRetry(batchPayload(batch), ST.target);
    if (!res.ok && isNetError(res.error)) {
      ST.aborted = res.error;
      return;
    }
    if (res.ok) {
      var parts = splitBatch(String(res.text || ''), batch.length);
      if (parts) {
        for (var i = 0; i < batch.length; i++) applyUnit(batch[i], parts[i]);
        return;
      }
    }

    // 批量通道不可用（分隔符丢失/限流）→ 逐条退回，保证覆盖率
    for (var j = 0; j < batch.length; j++) {
      if (runId !== ST.runId) return;
      var one = await askWithRetry(batch[j].text, ST.target);
      if (one.ok) applyUnit(batch[j], String(one.text || '').trim());
      else if (isNetError(one.error)) { ST.aborted = one.error; return; }
      else ST.failed += batch[j].nodes.length;
      await sleep(50);
    }
  }

  async function runBatches(batches, runId) {
    var cursor = 0;
    var total = batches.length;
    var workers = [];
    var limit = Math.min(CONCURRENCY, total);

    async function worker() {
      while (true) {
        if (runId !== ST.runId) return;
        var i = cursor++;
        if (i >= total) return;
        await translateBatch(batches[i], runId);
        if (runId !== ST.runId || ST.aborted) return;
        ST.done++;
        if (ST.done % 3 === 0 || ST.done === total) progress();
      }
    }

    for (var w = 0; w < limit; w++) workers.push(worker());
    await Promise.all(workers);
  }

  async function runTranslation(manual) {
    if (ST.running) return { ok: false, error: '正在翻译中' };
    if (isExcluded()) {
      if (manual) toast('当前站点已在排除列表中', { ttl: 2600 });
      return { ok: false, error: '站点已排除' };
    }
    if (!document.body) return { ok: false, error: '页面尚未就绪' };
    if (ST.translated) {
      if (manual) toast('当前页面已翻译为中文', { ttl: 2200 });
      return { ok: true, already: true };
    }

    await loadChannel();

    ST.detected = ST.detected || detectPage();
    var nodes = collectNodes(document.body);
    if (!nodes.length) {
      if (manual) toast('没有找到可翻译的文字', { ttl: 2400 });
      return { ok: false, error: '无可翻译内容' };
    }

    var units = buildUnits(nodes, ST.target);
    if (!units.length) {
      if (manual) toast('页面内容已是中文或无需翻译', { ttl: 2400 });
      return { ok: false, error: '无需翻译' };
    }

    var batches = buildBatches(units);
    var runId = ++ST.runId;
    ST.currentRun = runId;
    ST.running = true;
    ST.failed = 0;
    ST.done = 0;
    ST.aborted = '';
    ST.totalBatches = batches.length;
    toast('正在翻译页面… 0/' + batches.length, { sticky: true });

    await runBatches(batches, runId);
    if (runId !== ST.runId) return { ok: false, error: '已取消' };
    if (ST.aborted) {
      var reason = ST.aborted;
      ST.aborted = '';
      ST.running = false;
      toast(reason, { ttl: 6000 });
      return { ok: false, error: reason };
    }

    ST.running = false;
    ST.translated = ST.applied > 0;

    if (!ST.translated) {
      toast('翻译失败，请检查网络或翻译通道设置', { ttl: 4000 });
      return { ok: false, error: '翻译失败' };
    }

    startObserver();
    var label = ST.target.indexOf('zh') === 0 ? '中文' : ST.target;
    var extra = ST.failed ? '，' + ST.failed + ' 段失败' : '';
    var mode = ST.bilingual ? '（双语对照）' : '';
    toast('已翻译为' + label + mode + ' · ' + ST.applied + ' 段' + extra, {
      action: '显示原文',
      onAction: function () { restore(); },
      ttl: 9000
    });
    return { ok: true, segments: ST.applied, failed: ST.failed, bilingual: ST.bilingual };
  }

  // 切换双语开关后按新模式重排（翻译结果命中缓存，代价很小）
  function reapplyMode() {
    restore(true);
    runTranslation(false);
  }

  /* -------------------------------------------------------- 动态内容增量翻译 */

  function startObserver() {
    if (ST.observer || !document.body || typeof MutationObserver === 'undefined') return;
    ST.observer = new MutationObserver(function (records) {
      if (ST.applying || !ST.translated) return;
      for (var i = 0; i < records.length; i++) {
        var t = records[i].target;
        if (t && t.nodeType === 1 && t.closest && t.closest('#gt-translate-root')) continue;
        scheduleIncrement();
        return;
      }
    });
    ST.observer.observe(document.body, { childList: true, subtree: true });
  }

  function stopObserver() {
    if (ST.observer) {
      ST.observer.disconnect();
      ST.observer = null;
    }
    clearTimeout(ST.pendingTimer);
  }

  function scheduleIncrement() {
    clearTimeout(ST.pendingTimer);
    ST.pendingTimer = setTimeout(translateNewNodes, 700);
  }

  async function translateNewNodes() {
    if (!ST.translated || ST.running) return;
    var nodes = collectNodes(document.body);
    if (!nodes.length) return;
    var units = buildUnits(nodes, ST.target);
    if (!units.length) return;
    var batches = buildBatches(units);
    var runId = ST.runId;
    ST.currentRun = runId;
    ST.running = true;
    ST.totalBatches = batches.length;
    ST.done = 0;
    await runBatches(batches, runId);
    if (runId === ST.runId) ST.running = false;
  }

  /* ---------------------------------------------------------------- 消息接口 */

  try {
    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'PAGE_STATE') {
        if (!ST.detected) ST.detected = detectPage();
        sendResponse({
          ok: true,
          detected: ST.detected,
          translated: ST.translated,
          running: ST.running,
          bilingual: ST.bilingual,
          segments: ST.applied,
          target: ST.target,
          excluded: isExcluded()
        });
        return;
      }

      if (msg.type === 'PAGE_TRANSLATE') {
        runTranslation(true);
        sendResponse({ ok: true, started: true });
        return;
      }

      if (msg.type === 'PAGE_RESTORE') {
        restore();
        sendResponse({ ok: true });
        return;
      }
    });
  } catch (e) { /* 扩展上下文失效 */ }

  /* -------------------------------------------------------------- 设置与启动 */

  function boot() {
    if (!ST.auto || ST.translated || ST.running) return;
    if (isExcluded()) return;
    if (!document.body) return;
    if (document.designMode === 'on') return;

    try {
      chrome.storage.local.get({ netFailAt: 0, apiKey: '', gateway: '' }, function (v) {
        if (chrome.runtime.lastError) return;
        var hasOwnChannel = !!(v.apiKey || v.gateway);
        if (!hasOwnChannel && v.netFailAt && Date.now() - v.netFailAt < 10 * 60 * 1000) {
          return; // 十分钟内直连失败过，先不自动打扰
        }
        var info = detectPage();
        ST.detected = info;
        if (info.isChinese) return;
        if (info.sampleLength < MIN_PAGE_CHARS) return;
        setTimeout(function () {
          if (!ST.translated && !ST.running) runTranslation(false);
        }, 500);
      });
    } catch (e) { /* ignore */ }
  }

  try {
    chrome.storage.sync.get({ autoPage: true, targetLang: 'zh-CN', excludeSites: [], bilingual: false }, function (v) {
      if (chrome.runtime.lastError) return;
      ST.auto = v.autoPage !== false;
      ST.bilingual = v.bilingual === true;
      ST.target = v.targetLang || 'zh-CN';
      ST.exclude = Array.isArray(v.excludeSites) ? v.excludeSites : [];
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 300); }, { once: true });
      } else {
        setTimeout(boot, 300);
      }
    });

    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'sync') return;
      if ('autoPage' in changes) ST.auto = changes.autoPage.newValue !== false;
      if ('targetLang' in changes && changes.targetLang.newValue) {
        ST.target = changes.targetLang.newValue;
      }
      if ('bilingual' in changes) {
        var wantBi = changes.bilingual.newValue === true;
        if (wantBi !== ST.bilingual) {
          ST.bilingual = wantBi;
          if (ST.translated || ST.running) reapplyMode();
        }
      }
      if ('excludeSites' in changes && Array.isArray(changes.excludeSites.newValue)) {
        ST.exclude = changes.excludeSites.newValue;
        if (isExcluded() && ST.translated) restore(true);
      }
    });
  } catch (e) { /* ignore */ }

  // 调试与测试入口
  window.__GT_PAGE = {
    state: ST,
    detectPage: detectPage,
    collectNodes: collectNodes,
    buildUnits: buildUnits,
    buildBatches: buildBatches,
    splitBatch: splitBatch,
    insertBilingual: insertBilingual,
    runTranslation: runTranslation,
    restore: restore
  };
})();
