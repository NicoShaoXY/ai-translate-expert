/* 行为测试：在 jsdom 里加载内容脚本，模拟划词并检查卡片渲染 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SRC = path.join(__dirname, '..', 'src');

const dom = new JSDOM(`<!doctype html><html><body>
  <p id="p">Built-in translation rewrites the whole document, which is convenient for long reads.</p>
</body></html>`, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://example.com/article' });

const { window } = dom;

/* ---------- chrome API 桩 ---------- */
const sent = [];
const store = { targetLang: 'zh-CN', showBubble: true, autoTranslate: false, excludeSites: [] };
window.chrome = {
  runtime: {
    lastError: null,
    sendMessage(msg, cb) {
      sent.push(msg);
      setTimeout(() => cb({ ok: true, text: '内置翻译会重写整个文档，读长文很方便，但只翻译一句话时显得过重。', src: 'en', target: msg.target, channel: 'free' }), 5);
    },
    onMessage: { addListener() {} }
  },
  storage: {
    sync: {
      get(defaults, cb) { cb(Object.assign({}, defaults, store)); },
      set(obj) { Object.assign(store, obj); }
    },
    onChanged: { addListener() {} }
  }
};

/* ---------- 载入脚本（顺序与 manifest 一致） ---------- */
for (const f of ['langs.js', 'panel-style.js', 'panel-template.js', 'content.js']) {
  window.eval(fs.readFileSync(path.join(SRC, f), 'utf8'));
}

/* ---------- 模拟划词 + 鼠标松开 ---------- */
const p = window.document.getElementById('p');
const range = window.document.createRange();
range.selectNodeContents(p);
const sel = window.getSelection();
sel.removeAllRanges();
sel.addRange(range);

window.document.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true, button: 0 }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await sleep(60);

  const host = window.document.getElementById('gt-translate-root');
  const ok = (label, cond, extra) => {
    console.log((cond ? 'PASS' : 'FAIL') + '  ' + label + (extra ? '  → ' + extra : ''));
    if (!cond) process.exitCode = 1;
  };

  ok('shadow host 已挂载', !!host);
  const shadow = host && host.shadowRoot;
  ok('shadow root 可访问', !!shadow);

  const btn = shadow.querySelector('.gt-btn');
  ok('浮标已显示', !!btn && !btn.hidden);

  // 点击浮标
  btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, composed: true }));
  await sleep(80);

  const card = shadow.querySelector('.gt-card');
  const out = shadow.querySelector('[data-role="out"]');
  const orig = shadow.querySelector('[data-role="orig"]');
  const src = shadow.querySelector('[data-role="src"]');
  const target = shadow.querySelector('[data-role="target"]');

  ok('卡片已显示', !card.hidden);
  ok('请求已发出且目标语言正确', sent.length === 1 && sent[0].target === 'zh-CN', JSON.stringify(sent[0] || null));
  ok('译文已渲染', /内置翻译会重写整个文档/.test(out.textContent), out.textContent.slice(0, 24));
  ok('原文已回填', /Built-in translation rewrites/.test(orig.textContent));
  ok('源语种已识别为英语', src.textContent === '英语', src.textContent);
  ok('目标语言下拉已选中 zh-CN', target.value === 'zh-CN');
  ok('目标语言选项数量 > 30', target.options.length > 30, String(target.options.length));

  // 切换语言 → 触发重译
  target.value = 'ja';
  target.dispatchEvent(new window.Event('change', { bubbles: true }));
  await sleep(60);
  ok('切换语言会重新请求', sent.length === 2 && sent[1].target === 'ja');

  // Esc 关闭
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(20);
  ok('Esc 可关闭卡片', shadow.querySelector('.gt-card').hidden === true);

  console.log('---');
  console.log('settings 联动：', JSON.stringify(store));
  dom.window.close();
})();
