/* content.js — 划词浮标 + 翻译卡片
 * 与原版 Google 翻译扩展一致的交互：选中文字 → 浮动图标 → 点击弹出译文卡片。
 * 所有 UI 挂在 shadow root 内，样式用 adoptedStyleSheets 注入，不污染宿主页面、不受页面 CSP 限制。
 */
(function () {
  'use strict';
  if (window.__GT_CS_LOADED__) return;
  window.__GT_CS_LOADED__ = true;

  var MAX_CHARS = 5000;
  var CHANNEL_BRAND = { ai: 'AI 翻译', domestic: '国内翻译接口', google: 'Google 翻译' };
  var CARD_MIN_W = 300;
  var GAP = 12;

  var LANGS = window.__GT_LANGS || [['zh-CN', '中文（简体）'], ['en', '英语'], ['ja', '日语']];
  var LANG_NAME = window.__GT_LANG_NAME || { 'zh-CN': '中文（简体）', en: '英语', ja: '日语' };

  var DEFAULTS = { targetLang: 'zh-CN', showBubble: true, autoTranslate: false, excludeSites: [] };

  var S = {
    settings: { targetLang: DEFAULTS.targetLang, showBubble: true, autoTranslate: false, excludeSites: [] },
    host: null, shadow: null,
    btn: null, card: null, out: null, orig: null, input: null,
    srcLabel: null, targetSel: null, statusEl: null, toastEl: null, origBlock: null, origHead: null,
    open: false, pinned: false, busy: false,
    text: '', rect: null, truncated: false, result: null,
    toastTimer: 0, reqSeq: 0
  };

  var TEMPLATE = window.__GT_PANEL_HTML || '';

  /* ------------------------------------------------------------------ 设置 */

  function loadSettings() {
    try {
      chrome.storage.sync.get(DEFAULTS, function (v) {
        if (chrome.runtime.lastError) return;
        S.settings = Object.assign({}, DEFAULTS, v || {});
      });
    } catch (e) { /* 扩展上下文失效时静默 */ }
  }
  loadSettings();

  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'sync') return;
      var touched = false;
      Object.keys(DEFAULTS).forEach(function (k) {
        if (k in changes) {
          S.settings[k] = changes[k].newValue;
          touched = true;
        }
      });
      if (!touched) return;
      if (!S.settings.showBubble) hideBtn();
      if (isExcluded() && S.open) closeCard(true);
    });
  } catch (e) { /* ignore */ }

  function isExcluded() {
    var list = (S.settings.excludeSites || []).map(function (s) {
      return String(s).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    }).filter(Boolean);
    if (!list.length) return false;
    var h = location.hostname.toLowerCase();
    return list.some(function (d) { return h === d || h.slice(-(d.length + 1)) === '.' + d; });
  }

  /* -------------------------------------------------------------- UI 构建 */

  function build() {
    if (S.host && S.host.isConnected) return;
    var host = document.createElement('div');
    host.id = 'gt-translate-root';
    var hs = host.style;
    hs.setProperty('position', 'fixed', 'important');
    hs.setProperty('top', '0', 'important');
    hs.setProperty('left', '0', 'important');
    hs.setProperty('width', '0', 'important');
    hs.setProperty('height', '0', 'important');
    hs.setProperty('z-index', '2147483647', 'important');
    hs.setProperty('pointer-events', 'none', 'important');
    hs.setProperty('display', 'block', 'important');
    hs.setProperty('margin', '0', 'important');
    hs.setProperty('padding', '0', 'important');
    hs.setProperty('border', '0', 'important');
    hs.setProperty('background', 'none', 'important');
    (document.documentElement || document.body).appendChild(host);

    var shadow = host.attachShadow({ mode: 'open' });
    try {
      var sheet = new CSSStyleSheet();
      sheet.replaceSync(window.__GT_PANEL_CSS || '');
      shadow.adoptedStyleSheets = [sheet];
    } catch (e) {
      var st = document.createElement('style');
      st.textContent = window.__GT_PANEL_CSS || '';
      shadow.appendChild(st);
    }

    var wrap = document.createElement('div');
    wrap.innerHTML = TEMPLATE;
    shadow.appendChild(wrap);

    S.host = host;
    S.shadow = shadow;
    S.btn = shadow.querySelector('.gt-btn');
    S.card = shadow.querySelector('.gt-card');
    S.out = shadow.querySelector('[data-role="out"]');
    S.orig = shadow.querySelector('[data-role="orig"]');
    S.input = shadow.querySelector('[data-role="input"]');
    S.srcLabel = shadow.querySelector('[data-role="src"]');
    S.statusEl = shadow.querySelector('[data-role="status"]');
    S.origBlock = shadow.querySelector('[data-role="origblock"]');
    S.origHead = shadow.querySelector('.gt-orig-head');
    S.targetSel = shadow.querySelector('[data-role="target"]');
    S.toastEl = shadow.querySelector('.gt-toast');

    // 骨架默认隐藏，由交互触发显示
    S.btn.hidden = true;
    S.card.hidden = true;

    // 目标语言下拉
    LANGS.forEach(function (p) {
      var o = document.createElement('option');
      o.value = p[0];
      o.textContent = p[1];
      S.targetSel.appendChild(o);
    });
    S.targetSel.value = S.settings.targetLang || 'zh-CN';

    // 浮标
    S.btn.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation(); });
    S.btn.addEventListener('click', function (e) { e.stopPropagation(); openCard(); });

    // 卡片：阻止事件冒泡到页面，避免误触关闭或清空选区
    ['mousedown', 'mouseup', 'click', 'dblclick', 'selectstart'].forEach(function (t) {
      S.card.addEventListener(t, function (e) { e.stopPropagation(); });
    });

    S.card.addEventListener('click', onCardClick);
    S.targetSel.addEventListener('change', function () {
      S.settings.targetLang = S.targetSel.value;
      try { chrome.storage.sync.set({ targetLang: S.targetSel.value }); } catch (e) { /* ignore */ }
      retranslate();
    });
    S.input.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); exitEditMode(); }
      else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        var v = S.input.value.trim();
        if (v) { S.text = v.slice(0, MAX_CHARS); exitEditMode(); retranslate(); }
      }
    });
  }

  function onCardClick(e) {
    var btn = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!btn) return;
    var act = btn.getAttribute('data-act');
    if (act === 'close') { closeCard(true); return; }
    if (act === 'pin') { togglePin(); return; }
    if (act === 'edit') { enterEditMode(); return; }
    if (act === 'copy') {
      if (!S.result || !S.result.ok) return;
      copyText(S.result.text).then(function (ok) {
        toast(ok ? '已复制译文' : '复制失败，请手动选择');
      });
      return;
    }
    if (act === 'speak') {
      if (!S.result || !S.result.ok) return;
      var ok = speak(S.result.text, S.result.target);
      if (!ok) toast('当前环境不支持朗读');
      return;
    }
    if (act === 'open') {
      try {
        chrome.runtime.sendMessage({ type: 'OPEN_TRANSLATE', text: S.text, target: S.settings.targetLang });
      } catch (e) { /* ignore */ }
    }
  }

  function togglePin() {
    S.pinned = !S.pinned;
    var b = S.card.querySelector('[data-act="pin"]');
    if (b) b.classList.toggle('is-on', S.pinned);
    if (S.pinned) toast('已固定，点击图钉取消');
  }

  /* -------------------------------------------------------------- 选区读取 */

  function normalize(t) {
    return String(t || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function readSelection() {
    var text = '';
    var anchor = null;
    var sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && String(sel).trim()) {
      text = String(sel);
      var range = sel.getRangeAt(0);
      var rects = typeof range.getClientRects === 'function' ? range.getClientRects() : null;
      var r = rects && rects.length
        ? rects[rects.length - 1]
        : (typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : null);
      if (r && (r.width || r.height)) {
        anchor = { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      }
    }
    if (!text) {
      var el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
        var a = el.selectionStart;
        var b = el.selectionEnd;
        if (typeof a === 'number' && typeof b === 'number' && b > a) {
          text = el.value.slice(a, b);
          var rc = el.getBoundingClientRect();
          anchor = { left: rc.left, right: Math.min(rc.right, rc.left + 60), top: rc.bottom - 22, bottom: rc.bottom };
        }
      }
    }
    text = normalize(text);
    S.truncated = text.length > MAX_CHARS;
    if (S.truncated) text = text.slice(0, MAX_CHARS);
    if (!anchor) anchor = { left: 48, right: 120, top: 56, bottom: 76 };
    return { text: text, anchor: anchor };
  }

  function isInHost(e) {
    if (!S.host) return false;
    if (typeof e.composedPath === 'function') return e.composedPath().indexOf(S.host) !== -1;
    return S.host.contains(e.target);
  }

  /* -------------------------------------------------------------- 浮标控制 */

  function placeBtn(rect) {
    var w = 30, h = 30;
    var x = rect.right + 8;
    var y = rect.bottom + 8;
    if (x + w > window.innerWidth - 8) x = Math.max(8, rect.right - w);
    if (y + h > window.innerHeight - 8) y = Math.max(8, rect.top - h - 8);
    S.btn.style.left = Math.round(x) + 'px';
    S.btn.style.top = Math.round(y) + 'px';
  }

  function showBtn(rect) {
    if (!S.settings.showBubble || S.open) return;
    build();
    placeBtn(rect);
    S.btn.hidden = false;
  }

  function hideBtn() {
    if (S.btn) S.btn.hidden = true;
  }

  /* -------------------------------------------------------------- 卡片控制 */

  function placeCard() {
    if (!S.card) return;
    var rect = S.rect || { left: 48, right: 200, top: 60, bottom: 80 };
    S.card.style.visibility = 'hidden';
    S.card.hidden = false;
    var w = S.card.offsetWidth || 384;
    var h = S.card.offsetHeight || 220;
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var left = Math.min(Math.max(GAP, rect.left), Math.max(GAP, vw - w - GAP));
    var top = rect.bottom + 10;
    if (top + h > vh - GAP) {
      var above = rect.top - h - 10;
      top = above >= GAP ? above : Math.max(GAP, vh - h - GAP);
    }
    S.card.style.left = Math.round(left) + 'px';
    S.card.style.top = Math.round(top) + 'px';
    S.card.style.visibility = 'visible';
  }

  function setLoading() {
    if (S.input && !S.input.hidden) exitEditMode();
    var brandEl = S.card.querySelector('.gt-brand');
    if (brandEl) brandEl.textContent = '翻译中';
    S.out.className = 'gt-out is-loading';
    S.out.textContent = '翻译中…';
    S.statusEl.textContent = S.truncated ? '仅翻译前 ' + MAX_CHARS + ' 字' : '';
    S.srcLabel.textContent = '自动检测';
    if (S.origBlock) S.origBlock.hidden = false;
    if (S.orig) { S.orig.textContent = S.text; S.orig.hidden = false; }
  }

  function renderError(msg) {
    S.out.className = 'gt-out is-error';
    S.out.textContent = msg;
    S.statusEl.textContent = '';
    placeCard();
  }

  function renderResult(res) {
    if (!res || !res.ok) {
      renderError((res && res.error) || '翻译失败，请稍后再试');
      return;
    }
    S.result = res;
    var brand = S.card.querySelector('.gt-brand');
    if (brand) brand.textContent = CHANNEL_BRAND[res.channel] || '翻译引擎';
    S.out.className = 'gt-out';
    S.out.textContent = res.text || '（无译文）';
    var srcName = LANG_NAME[res.src] || (res.src ? String(res.src).toUpperCase() : '自动检测');
    S.srcLabel.textContent = srcName;
    if (S.targetSel.value !== res.target) S.targetSel.value = res.target;
    if (S.orig) S.orig.textContent = S.text;
    var note = '';
    if (S.truncated) note = '仅翻译前 ' + MAX_CHARS + ' 字';
    else if (res.src && res.src === res.target) note = '原文即目标语言';
    else if (res.cached) note = '缓存结果';
    S.statusEl.textContent = note;
    S.card.querySelector('[data-role="origblock"]').hidden = false;
    placeCard();
  }

  function requestTranslate(text, target) {
    return new Promise(function (resolve) {
      var seq = ++S.reqSeq;
      var settled = false;
      function done(v) {
        if (settled || seq !== S.reqSeq) return;
        settled = true;
        resolve(v);
      }
      try {
        chrome.runtime.sendMessage({ type: 'TRANSLATE', text: text, target: target || S.settings.targetLang }, function (res) {
          if (chrome.runtime.lastError) return done({ ok: false, error: '扩展已重新加载，请刷新本页后重试' });
          done(res || { ok: false, error: '翻译服务无响应' });
        });
      } catch (e) {
        done({ ok: false, error: '扩展上下文已失效，请刷新本页后重试' });
        return;
      }
      setTimeout(function () { done({ ok: false, error: '请求超时，请检查网络连接' }); }, 20000);
    });
  }

  async function openCard() {
    if (!S.text) return;
    build();
    hideBtn();
    S.open = true;
    var pinBtn = S.card.querySelector('[data-act="pin"]');
    if (pinBtn) pinBtn.classList.toggle('is-on', S.pinned);
    setLoading();
    placeCard();
    var res = await requestTranslate(S.text, S.settings.targetLang);
    renderResult(res);
  }

  async function retranslate() {
    if (S.busy || !S.text) return;
    S.busy = true;
    S.result = null;
    setLoading();
    placeCard();
    var res = await requestTranslate(S.text, S.settings.targetLang);
    renderResult(res);
    S.busy = false;
  }

  function closeCard(force) {
    if (!S.open) return;
    if (S.pinned && force !== true) return;
    S.open = false;
    S.pinned = false;
    S.result = null;
    S.reqSeq++;
    if (S.card) {
      S.card.hidden = true;
      var b = S.card.querySelector('[data-act="pin"]');
      if (b) b.classList.remove('is-on');
    }
    if (S.input && !S.input.hidden) exitEditMode();
  }

  function enterEditMode() {
    if (!S.input) return;
    S.input.value = S.text;
    S.input.hidden = false;
    S.orig.hidden = true;
    S.origHead.querySelector('[data-act="edit"]').hidden = true;
    S.input.focus();
    S.input.setSelectionRange(S.input.value.length, S.input.value.length);
    placeCard();
  }

  function exitEditMode() {
    if (!S.input) return;
    S.input.hidden = true;
    S.orig.hidden = false;
    var b = S.origHead.querySelector('[data-act="edit"]');
    if (b) b.hidden = false;
    S.input.blur();
    placeCard();
  }

  /* ------------------------------------------------------------ 复制/朗读 */

  function copyText(text) {
    return new Promise(function (resolve) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function () { resolve(true); }, function () { resolve(fallbackCopy(text)); });
          return;
        }
      } catch (e) { /* ignore */ }
      resolve(fallbackCopy(text));
    });
  }

  function fallbackCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0;';
      (S.shadow || document.body).appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) { return false; }
  }

  function speak(text, lang) {
    try {
      if (!window.speechSynthesis) return false;
      window.speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(text);
      u.lang = lang || 'zh-CN';
      u.rate = 1;
      var voices = window.speechSynthesis.getVoices() || [];
      var hit = voices.filter(function (v) { return v.lang && v.lang.replace('_', '-').toLowerCase().indexOf(String(u.lang).toLowerCase()) === 0; })[0];
      if (hit) u.voice = hit;
      window.speechSynthesis.speak(u);
      return true;
    } catch (e) { return false; }
  }

  /* ---------------------------------------------------------------- 轻提示 */

  function hideToast() {
    clearTimeout(S.toastTimer);
    if (!S.toastEl) return;
    S.toastEl.classList.remove('is-show');
    setTimeout(function () { if (S.toastEl) S.toastEl.hidden = true; }, 200);
  }

  function toast(msg, opts) {
    opts = opts || {};
    build();
    if (!S.toastEl) return;
    S.toastEl.textContent = msg;
    if (opts.action) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'gt-toast-act';
      b.textContent = opts.action;
      b.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        hideToast();
        if (typeof opts.onAction === 'function') opts.onAction();
      });
      S.toastEl.appendChild(b);
    }
    S.toastEl.hidden = false;
    requestAnimationFrame(function () { S.toastEl.classList.add('is-show'); });
    clearTimeout(S.toastTimer);
    if (!opts.sticky) {
      S.toastTimer = setTimeout(hideToast, opts.ttl || 1800);
    }
  }

  // 供整页翻译模块复用同一套提示 UI
  window.__GT_UI = { toast: toast, hideToast: hideToast };

  /* ---------------------------------------------------------------- 事件流 */

  document.addEventListener('mouseup', function (e) {
    if (e.button !== 0 || isInHost(e)) return;
    setTimeout(function () {
      if (isExcluded()) return;
      var info = readSelection();
      if (!info.text) { hideBtn(); return; }
      S.text = info.text;
      S.rect = info.anchor;
      if (S.open && S.pinned) { retranslate(); return; }
      if (S.settings.autoTranslate) { openCard(); return; }
      showBtn(info.anchor);
    }, 10);
  }, true);

  document.addEventListener('keyup', function (e) {
    if (e.key !== 'Shift' && e.key !== 'ArrowUp' && e.key !== 'ArrowDown' && e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    if (isInHost(e) || !e.shiftKey) return;
    var info = readSelection();
    if (info.text && !S.open && S.settings.showBubble) { S.text = info.text; S.rect = info.anchor; showBtn(info.anchor); }
  }, true);

  document.addEventListener('mousedown', function (e) {
    if (isInHost(e)) return;
    hideBtn();
    if (S.open && !S.pinned) closeCard(true);
  }, true);

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && S.open) { closeCard(true); }
  }, true);

  window.addEventListener('scroll', function (e) {
    if (isInHost(e)) return;
    if (e.target && e.target.nodeType === 1 && S.host && S.host.contains(e.target)) return;
    hideBtn();
    if (S.open && !S.pinned) closeCard(true);
  }, true);

  window.addEventListener('resize', function () {
    hideBtn();
    if (S.open && !S.pinned) closeCard(true);
  });

  try {
    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'PING') { sendResponse({ ok: true, ready: true }); return; }
      if (msg.type === 'TRANSLATE_SELECTION') {
        if (isExcluded()) { sendResponse({ ok: false, error: '当前站点已排除' }); return; }
        var info = readSelection();
        if (!info.text) { toast('请先选中要翻译的文字'); sendResponse({ ok: false, error: '未选中文字' }); return; }
        S.text = info.text;
        S.rect = info.anchor;
        if (S.open && S.pinned) retranslate(); else openCard();
        sendResponse({ ok: true, length: info.text.length });
      }
    });
  } catch (e) { /* ignore */ }
})();
