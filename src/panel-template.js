/* panel-template.js — 翻译面板 DOM 骨架（content script 与 demo 预览共用）
 * 纯静态字符串，不含任何用户数据；文案一律通过 textContent 写入，避免注入。
 */
(function () {
  'use strict';

  var ICONS = {
    arrow: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.8 8h9.4M9 4.6L12.4 8 9 11.4"/></svg>',
    pin: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5.6 2.6h4.8M8 2.6v3.2l1.9 2.4v.9H6.1v-.9L8 5.8V2.6"/><path d="M8 9.1v4.3"/></svg>',
    close: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6"/></svg>',
    speak: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4.2 6.2h2l3-2.4v8.4l-3-2.4h-2z"/><path d="M11.4 6a2.9 2.9 0 010 4"/><path d="M12.9 4.4a5.1 5.1 0 010 7.2"/></svg>',
    copy: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="5.6" y="5.6" width="7.2" height="7.2" rx="1.6"/><path d="M10.6 3.6H4.7A1.1 1.1 0 003.6 4.7v5.9"/></svg>',
    open: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9.2 3h3.8v3.8M12.8 3.2L7.6 8.4"/><path d="M11.8 9.6V12a1.2 1.2 0 01-1.2 1.2H4.2A1.2 1.2 0 013 12V5.4A1.2 1.2 0 014.2 4.2h2.4"/></svg>'
  };

  var HTML = ''
    + '<div class="gt-btn" role="button" tabindex="-1" aria-label="翻译所选文字"><span class="gt-btn-glyph">译</span></div>'
    + '<div class="gt-card" role="dialog" aria-label="AI翻译专家">'
    + '  <div class="gt-head">'
    + '    <div class="gt-langs">'
    + '      <span class="gt-src" data-role="src">自动检测</span>'
    + '      <span class="gt-arrow">' + ICONS.arrow + '</span>'
    + '      <select class="gt-target" data-role="target" aria-label="目标语言"></select>'
    + '    </div>'
    + '    <div class="gt-head-acts">'
    + '      <button class="gt-icon" data-act="pin" title="固定位置" aria-label="固定位置">' + ICONS.pin + '</button>'
    + '      <button class="gt-icon" data-act="close" title="关闭（Esc）" aria-label="关闭">' + ICONS.close + '</button>'
    + '    </div>'
    + '  </div>'
    + '  <div class="gt-body">'
    + '    <div class="gt-out" data-role="out"></div>'
    + '    <div class="gt-orig-block" data-role="origblock">'
    + '      <div class="gt-orig-head">'
    + '        <span class="gt-orig-label">原文</span>'
    + '        <button class="gt-orig-edit" data-act="edit" title="编辑原文后重新翻译">编辑</button>'
    + '      </div>'
    + '      <div class="gt-orig" data-role="orig"></div>'
    + '      <textarea class="gt-input" data-role="input" hidden spellcheck="false"></textarea>'
    + '    </div>'
    + '  </div>'
    + '  <div class="gt-foot">'
    + '    <span class="gt-brand">翻译引擎</span>'
    + '    <span class="gt-status" data-role="status"></span>'
    + '    <div class="gt-foot-acts">'
    + '      <button class="gt-icon" data-act="speak" title="朗读译文" aria-label="朗读译文">' + ICONS.speak + '</button>'
    + '      <button class="gt-icon" data-act="copy" title="复制译文" aria-label="复制译文">' + ICONS.copy + '</button>'
    + '      <button class="gt-icon" data-act="open" title="在 Google 翻译中打开" aria-label="在 Google 翻译中打开">' + ICONS.open + '</button>'
    + '    </div>'
    + '  </div>'
    + '</div>'
    + '<div class="gt-toast" hidden></div>';

  window.__GT_PANEL_HTML = HTML;
})();
