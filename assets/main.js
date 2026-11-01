/* ============================================================
   B8 · 公共脚本
   ------------------------------------------------------------
   零依赖。提供：小工具、导航、入场动画、提示条、构建号。
   必须在其它模块之前加载。
   ============================================================ */
(function () {
  'use strict';

  var B8 = window.B8 = window.B8 || {};

  /* ---------- 选择器 ---------- */
  B8.qs = function (sel, root) { return (root || document).querySelector(sel); };
  B8.qsa = function (sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  };
  B8.on = function (el, ev, fn, opt) {
    if (el) el.addEventListener(ev, fn, opt || false);
    return el;
  };

  /* ---------- 文本 ---------- */
  B8.esc = function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  };

  B8.nl2br = function (s) {
    return B8.esc(s).replace(/\r?\n/g, '<br>');
  };

  B8.trim = function (s, max) {
    s = String(s == null ? '' : s).trim();
    if (max && s.length > max) s = s.slice(0, max);
    return s;
  };

  B8.num = function (n) {
    return Number(n || 0).toLocaleString('zh-CN');
  };

  /* ---------- 时间 ---------- */
  // 去掉前导零：09 月 → 9 月
  B8.date = function (iso) {
    if (!iso) return '';
    var s = String(iso).slice(0, 10).split('-');
    if (s.length < 3) return String(iso);
    return Number(s[1]) + ' 月 ' + Number(s[2]) + ' 日';
  };

  B8.dateFull = function (iso) {
    if (!iso) return '';
    var s = String(iso).slice(0, 10).split('-');
    if (s.length < 3) return String(iso);
    return s[0] + ' 年 ' + Number(s[1]) + ' 月 ' + Number(s[2]) + ' 日';
  };

  B8.dateTime = function (iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return B8.date(iso);
    var p = function (n) { return n < 10 ? '0' + n : '' + n; };
    return B8.date(iso) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  };

  B8.ago = function (iso) {
    var t = new Date(iso).getTime();
    if (isNaN(t)) return '';
    var d = Math.floor((Date.now() - t) / 1000);
    if (d < 60) return '刚刚';
    if (d < 3600) return Math.floor(d / 60) + ' 分钟前';
    if (d < 86400) return Math.floor(d / 3600) + ' 小时前';
    if (d < 86400 * 30) return Math.floor(d / 86400) + ' 天前';
    return B8.date(iso);
  };

  B8.daysLeft = function (iso) {
    var t = new Date(iso).getTime();
    if (isNaN(t)) return 0;
    return Math.ceil((t - Date.now()) / 86400000);
  };

  /* ---------- 提示条 ---------- */
  var toastEl = null, toastTimer = 0;
  B8.toast = function (msg) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'toast';
      toastEl.setAttribute('role', 'status');
      toastEl.setAttribute('aria-live', 'polite');
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 2600);
  };

  /* ---------- 复制 ---------- */
  B8.copy = function (text) {
    var done = function () { B8.toast('已复制'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { B8.toast('复制失败'); });
      return;
    }
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { B8.toast('复制失败'); }
    document.body.removeChild(ta);
  };

  /* ---------- 导航 ---------- */
  function initNav() {
    var toggle = B8.qs('#nav-toggle');
    var nav = B8.qs('#nav');
    if (!toggle || !nav) return;

    B8.on(toggle, 'click', function () {
      var open = nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggle.setAttribute('aria-label', open ? '收起菜单' : '打开菜单');
    });

    B8.qsa('a', nav).forEach(function (a) {
      B8.on(a, 'click', function () {
        nav.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
      });
    });

    B8.on(document, 'keydown', function (e) {
      if (e.key === 'Escape') {
        nav.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
      }
    });
  }

  /* ---------- 入场动画 ---------- */
  function initReveal() {
    var items = B8.qsa('.reveal');
    if (!items.length) return;

    if (!('IntersectionObserver' in window)) {
      items.forEach(function (el) { el.classList.add('in'); });
      return;
    }

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        en.target.classList.add('in');
        io.unobserve(en.target);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.06 });

    items.forEach(function (el) { io.observe(el); });

    // 兜底：1.2 秒后仍在视口内的直接显示，避免动画失灵导致内容透明
    setTimeout(function () {
      items.forEach(function (el) {
        var r = el.getBoundingClientRect();
        if (r.top < window.innerHeight && r.bottom > 0) el.classList.add('in');
      });
    }, 1200);
  }

  /* ---------- 年份 ---------- */
  function initYear() {
    var y = B8.qs('#year');
    if (y) y.textContent = new Date().getFullYear();
  }

  /* ---------- 版本 / TEST 标记 ---------- */
  function initBuild() {
    var ver = B8.qs('#brand-ver');
    if (ver) {
      var cfg = window.B8_CONFIG || {};
      ver.textContent = (cfg.site && cfg.site.version) || window.B8_BUILD || 'v1.0';
    }

    if (window.B8_TEST) {
      var badge = document.createElement('span');
      badge.className = 'build-test';
      badge.textContent = 'TEST';
      badge.title = '调试入口：本次加载已绕过缓存';
      var host = B8.qs('.header-tools') || B8.qs('.brand-text');
      if (host) host.appendChild(badge);
      var banner = B8.qs('#build-banner');
      if (banner) banner.hidden = false;
    }
  }

  /* ---------- 外链统一 rel ---------- */
  function initLinks() {
    B8.qsa('a[target="_blank"]').forEach(function (a) {
      a.rel = 'noopener noreferrer';
    });
  }

  /* ---------- 启动 ---------- */
  function boot() {
    initNav();
    initReveal();
    initYear();
    initBuild();
    initLinks();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
