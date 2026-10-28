/* 整页翻译测试：语言检测、批量翻译、逐条兜底、还原原文 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SRC = path.join(__dirname, '..', 'src');
const PAGE_JS = fs.readFileSync(path.join(SRC, 'page-translate.js'), 'utf8');

const results = [];
function ok(label, cond, extra) {
  results.push(!!cond);
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + label + (extra !== undefined ? '  → ' + extra : ''));
}

function createDom(bodyHtml, opts) {
  opts = opts || {};
  const dom = new JSDOM('<!doctype html><html lang="' + (opts.lang || '') + '"><body>' + bodyHtml + '</body></html>', {
    url: 'https://example.com/article',
    pretendToBeVisual: true,
    runScripts: 'outside-only'
  });
  const { window } = dom;
  const requests = [];
  const listeners = [];
  const settings = Object.assign({ autoPage: false, targetLang: 'zh-CN', excludeSites: [] }, opts.settings || {});
  let mode = opts.mode || 'marker';
  let channelName = opts.channel || 'google';

  window.chrome = {
    runtime: {
      lastError: null,
      sendMessage(msg, cb) {
        if (msg && msg.type === 'GET_STATE') {
          return cb({ ok: true, config: { channel: channelName === 'ai' ? 'ai' : 'google', targetLang: 'zh-CN' } });
        }
        requests.push(msg);
        if (!msg || msg.type !== 'TRANSLATE') return cb({ ok: false, error: 'unsupported' });
        setTimeout(() => {
          if (mode === 'marker') {
            const out = msg.text.replace(/%%(\d+)%%[ ]?([^\n]*)/g, (m, n) => '%%' + n + '%% 译' + n + '：' + 'X');
            return cb({ ok: true, text: out, src: 'en' });
          }
          if (mode === 'neterr') {
            return cb({ ok: false, error: '无法连接 translate.googleapis.com，请检查网络或系统代理' });
          }
          // flat 模式：批量请求丢失分隔符，逐条请求正常返回
          if (mode === 'flat' && msg.text.indexOf('%%') > -1) {
            return cb({ ok: true, text: '整段译文', src: 'en' });
          }
          return cb({ ok: true, text: '译：' + msg.text, src: 'en' });
        }, 1);
      },
      onMessage: {
        addListener(fn) { listeners.push(fn); }
      }
    },
    storage: {
      sync: {
        get(defaults, cb) { cb(Object.assign({}, defaults, settings)); },
        set() {}
      },
      onChanged: { addListener() {} }
    }
  };

  window.eval(PAGE_JS);
  return { window, requests, listeners, setMode: (m) => { mode = m; } };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  /* ---------------- 1. 语言检测 ---------------- */
  const en = createDom('<p>Chrome handles full page translation natively, but a single sentence still needs a quick popup. This sentence is long enough for script ratio detection.</p>');
  const enDet = en.window.__GT_PAGE.detectPage();
  ok('英文页面判定为非中文', enDet.code === 'en' && enDet.isChinese === false, JSON.stringify(enDet.code));

  const zh = createDom('<p>浏览器自身已经内置了整页翻译功能，但只翻译一句话的时候仍然需要一个即时的弹窗，这段文字足够长以便进行脚本比例判断。</p>');
  const zhDet = zh.window.__GT_PAGE.detectPage();
  ok('中文页面判定为中文', zhDet.code === 'zh' && zhDet.isChinese === true, zhDet.code);

  const ja = createDom('<p>ブラウザにはページ全体の翻訳機能が標準で搭載されていますが、一文だけを翻訳したいときにはポップアップが必要です。</p>');
  const jaDet = ja.window.__GT_PAGE.detectPage();
  ok('日文页面（含假名）判定为日语', jaDet.code === 'ja', jaDet.code);

  const ru = createDom('<p>Встроенный переводчик браузера переводит целые страницы, но для одного предложения нужно всплывающее окно.</p>');
  ok('俄文页面判定为俄语', ru.window.__GT_PAGE.detectPage().code === 'ru');

  const mislabel = createDom('<p>这段页面内容其实是中文，只是网页的语言标记写错了，检测应以文本为准而不是标签。</p>', { lang: 'en' });
  const misDet = mislabel.window.__GT_PAGE.detectPage();
  ok('语言标记误标时以文本为准', misDet.code === 'zh' && misDet.isChinese === true, misDet.code);

  /* ---------------- 2. 批量翻译（带 %%n%% 前缀） ---------------- */
  const paras = [
    'The first paragraph explains why a quick popup beats a full page rewrite.',
    'The second paragraph mentions that reading long articles rarely needs isolation.',
    'A third line keeps the sample page realistic for batching checks.',
    'Batching several nodes into one request keeps the request count low.',
    'Finally, the translation is written back into the original text nodes.'
  ].map((t) => '<p>' + t + '</p>').join('');

  const page = createDom(paras, { mode: 'marker' });
  const P = page.window.__GT_PAGE;
  ok('收集到 5 个文本节点', P.collectNodes(page.window.document.body).length === 5, P.collectNodes(page.window.document.body).length);

  const runRes = await P.runTranslation(true);
  ok('整页翻译成功', runRes.ok === true && runRes.segments === 5, JSON.stringify(runRes));
  ok('请求被合批（少于节点数）', page.requests.length < 5, page.requests.length + ' 次请求');

  const texts = Array.from(page.window.document.querySelectorAll('p')).map((p) => p.textContent);
  ok('每段都写入了独立译文', texts.every((t) => /^译\d：X$/.test(t)), JSON.stringify(texts));
  ok('译文未串段（编号互不重复）', new Set(texts).size === 5);

  const stateRes = await new Promise((resolve) => {
    page.listeners[0]({ type: 'PAGE_STATE' }, {}, resolve);
  });
  ok('PAGE_STATE 报告已翻译', stateRes.ok && stateRes.translated === true && stateRes.segments === 5, JSON.stringify({ t: stateRes.translated, s: stateRes.segments }));

  /* ---------------- 3. 还原原文 ---------------- */
  P.restore(true);
  const restored = Array.from(page.window.document.querySelectorAll('p')).map((p) => p.textContent);
  ok('原文完整还原', restored[0] === 'The first paragraph explains why a quick popup beats a full page rewrite.' && restored[4].indexOf('written back') > -1, restored[0].slice(0, 30));
  ok('还原后状态复位', P.state.translated === false && P.state.originals.size === 0);

  /* ---------------- 4. 前缀丢失 → 逐条兜底 ---------------- */
  const flat = createDom(paras, { mode: 'flat' });
  const F = flat.window.__GT_PAGE;
  await F.runTranslation(true);
  const flatTexts = Array.from(flat.window.document.querySelectorAll('p')).map((p) => p.textContent);
  ok('批量失败时逐条翻译兜底', flatTexts.every((t) => t.indexOf('译：') === 0), JSON.stringify(flatTexts[0]));
  ok('兜底请求数 = 1 次批量 + 5 次逐条', flat.requests.length === 6, flat.requests.length);

  /* ---------------- 5. 中文页面不重复翻译 ---------------- */
  const zhPage = createDom('<p>这是一段已经属于中文的内容，不应该被再次翻译成中文，否则会出现重复劳动。</p>');
  const zhRes = await zhPage.window.__GT_PAGE.runTranslation(true);
  ok('中文内容跳过翻译', zhRes.ok === false && /无需翻译/.test(zhRes.error || ''), JSON.stringify(zhRes));
  ok('中文页面不发请求', zhPage.requests.length === 0);

  /* ---------------- 6. 已翻译页面可重复调用 ---------------- */
  const page2 = createDom(paras, { mode: 'marker' });
  await page2.window.__GT_PAGE.runTranslation(true);
  const again = await page2.window.__GT_PAGE.runTranslation(true);
  ok('重复触发不重复翻译', again.ok === true && again.already === true);
  ok('重复触发不追加请求', page2.requests.length === 1, page2.requests.length);

  /* ---------------- 7. 排除站点 ---------------- */
  const exPage = createDom(paras, { mode: 'marker', settings: { excludeSites: ['example.com'] } });
  const exRes = await exPage.window.__GT_PAGE.runTranslation(true);
  ok('排除站点拒绝翻译', exRes.ok === false && /排除/.test(exRes.error || ''), JSON.stringify(exRes));

  /* ---------------- 8. 网络不可达立即熔断 ---------------- */
  const netPage = createDom(paras, { mode: 'neterr' });
  const netRes = await netPage.window.__GT_PAGE.runTranslation(true);
  ok('网络不可达立即中断', netRes.ok === false && /无法连接/.test(netRes.error || ''), JSON.stringify(netRes));
  ok('熔断后不再逐批重试', netPage.requests.length === 1, netPage.requests.length + ' 次请求');
  ok('熔断后页面保持原文', netPage.window.document.querySelector('p').textContent.indexOf('The first paragraph') === 0);

  /* ---------------- 9. 双语对照模式 ---------------- */
  const bi = createDom(paras, { mode: 'marker', settings: { bilingual: true } });
  const B = bi.window.__GT_PAGE;
  const biRes = await B.runTranslation(true);
  const bp = bi.window.document.querySelector('p');
  ok('双语模式翻译成功', biRes.ok === true && biRes.bilingual === true, JSON.stringify(biRes));
  ok('双语模式保留原文', bp.textContent.indexOf('The first paragraph explains why a quick popup beats a full page rewrite.') === 0, bp.textContent.slice(0, 40));
  ok('双语模式插入对照节点', !!bp.querySelector('span[data-gt-bi]'));
  ok('对照节点带译文', /^\s*译1：X$/.test(bp.querySelector('[data-gt-bi]').textContent), bp.querySelector('[data-gt-bi]').textContent);
  ok('原文文本节点未被改写', bp.firstChild.nodeValue.indexOf('The first paragraph') === 0);
  ok('对照节点不会被重复采集', B.collectNodes(bi.window.document.body).length === 0, B.collectNodes(bi.window.document.body).length);

  B.restore(true);
  ok('关闭双语后对照内容全部移除', bi.window.document.querySelectorAll('[data-gt-bi]').length === 0);
  ok('关闭双语后原文完整', bi.window.document.querySelector('p').textContent === 'The first paragraph explains why a quick popup beats a full page rewrite.');

  /* ---------------- 10. 默认（替换）模式不产生对照节点 ---------------- */
  const plain = createDom(paras, { mode: 'marker' });
  await plain.window.__GT_PAGE.runTranslation(true);
  ok('默认模式不插入对照节点', plain.window.document.querySelectorAll('[data-gt-bi]').length === 0);
  ok('默认模式原文被替换', plain.window.document.querySelector('p').textContent.indexOf('译1：') === 0);

  /* ---------------- 11. AI 通道收紧批次 ---------------- */
  const aiPage = createDom(paras, { mode: 'marker', channel: 'ai' });
  await aiPage.window.__GT_PAGE.runTranslation(true);
  ok('AI 通道批次收紧（5 节点 → 2 批）', aiPage.requests.length === 2, aiPage.requests.length + ' 次请求');
  ok('AI 通道下译文仍正确', aiPage.window.document.querySelector('p').textContent.indexOf('译1：') === 0);

  console.log('---');
  console.log('通过 ' + results.filter(Boolean).length + '/' + results.length);
  if (results.some((x) => !x)) process.exitCode = 1;
})();
