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

  /* ---------- 页面内确认框 ----------
     所有站点统一用这个，不再用 window.confirm（浏览器会在标题栏带网址）。
     返回 Promise<boolean>；点确定 resolve(true)，取消 / Esc / 点遮罩 resolve(false)。 */
  var confirmLock = 0;

  function ensureConfirmStyle() {
    if (document.getElementById('b8-confirm-css')) return;
    var s = document.createElement('style');
    s.id = 'b8-confirm-css';
    s.textContent =
      '.b8-confirm{position:fixed;inset:0;z-index:4000;display:flex;align-items:center;justify-content:center;padding:18px;background:rgba(16,14,22,.52);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);opacity:1;transition:opacity .14s ease}' +
      '.b8-confirm.is-out{opacity:0}' +
      '.b8-confirm-card{width:min(380px,100%);max-height:calc(100vh - 36px);overflow:auto;padding:20px 18px 16px;background:var(--card,#fffdf7);color:var(--ink,#23211c);border:1px solid var(--line,#e4dcc6);border-radius:12px;box-shadow:0 26px 70px -36px rgba(0,0,0,.65);font-family:var(--sans,"PingFang SC","Microsoft YaHei",system-ui,sans-serif);text-align:left}' +
      '.b8-confirm-title{margin:0 0 8px;font-family:var(--serif,"Songti SC","SimSun",serif);font-size:18px;font-weight:700;letter-spacing:.03em;color:var(--ink,#23211c)}' +
      '.b8-confirm-msg{margin:0;white-space:pre-line;font-size:13px;line-height:1.85;color:var(--ink-2,#5b574d);overflow-wrap:anywhere}' +
      '.b8-confirm-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}' +
      '.b8-confirm-btn{min-height:38px;padding:8px 18px;font-family:inherit;font-size:13px;border:1px solid var(--line-2,#d3c7ac);border-radius:999px;background:transparent;color:var(--ink-2,#5b574d);cursor:pointer}' +
      '.b8-confirm-btn:active{transform:translateY(1px)}' +
      '.b8-confirm-btn.ok{color:#fff;background:var(--seal,#c1522f);border-color:var(--seal,#c1522f)}' +
      '.b8-confirm-btn.ok.is-danger{background:#a33228;border-color:#a33228}' +
      '.b8-confirm-btn:focus-visible{outline:2px solid var(--seal,#c1522f);outline-offset:2px}' +
      'body.b8-confirm-lock{overflow:hidden}';
    document.head.appendChild(s);
  }

  B8.confirm = function (message, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      ensureConfirmStyle();
      confirmLock++;
      document.body.classList.add('b8-confirm-lock');

      var wrap = document.createElement('div');
      wrap.className = 'b8-confirm';
      wrap.setAttribute('role', 'dialog');
      wrap.setAttribute('aria-modal', 'true');
      wrap.innerHTML =
        '<div class="b8-confirm-card">' +
          '<h3 class="b8-confirm-title" id="b8-confirm-title">' + B8.esc(opts.title || '请确认') + '</h3>' +
          '<p class="b8-confirm-msg" id="b8-confirm-msg"></p>' +
          '<div class="b8-confirm-actions">' +
            '<button class="b8-confirm-btn cancel" type="button">' + B8.esc(opts.cancelText || '取消') + '</button>' +
            '<button class="b8-confirm-btn ok' + (opts.danger ? ' is-danger' : '') + '" type="button">' +
              B8.esc(opts.okText || '确定') + '</button>' +
          '</div>' +
        '</div>';
      wrap.setAttribute('aria-labelledby', 'b8-confirm-title');
      wrap.setAttribute('aria-describedby', 'b8-confirm-msg');
      wrap.querySelector('.b8-confirm-msg').textContent = String(message == null ? '' : message);
      document.body.appendChild(wrap);

      var lastFocus = document.activeElement;
      var closed = false;
      var okBtn = wrap.querySelector('.b8-confirm-btn.ok');
      var cancelBtn = wrap.querySelector('.b8-confirm-btn.cancel');

      function close(value) {
        if (closed) return;
        closed = true;
        document.removeEventListener('keydown', onKey, true);
        confirmLock = Math.max(0, confirmLock - 1);
        if (!confirmLock) document.body.classList.remove('b8-confirm-lock');
        wrap.classList.add('is-out');
        setTimeout(function () {
          if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
          if (lastFocus && lastFocus.focus) {
            try { lastFocus.focus({ preventScroll: true }); } catch (e) { try { lastFocus.focus(); } catch (e2) {} }
          }
        }, 140);
        resolve(!!value);
      }

      function onKey(ev) {
        if (ev.key === 'Escape') { ev.preventDefault(); close(false); }
        else if (ev.key === 'Enter') {
          ev.preventDefault();
          close(document.activeElement === cancelBtn ? false : true);
        }
      }

      B8.on(cancelBtn, 'click', function () { close(false); });
      B8.on(okBtn, 'click', function () { close(true); });
      B8.on(wrap, 'click', function (ev) { if (ev.target === wrap) close(false); });
      document.addEventListener('keydown', onKey, true);
      setTimeout(function () { try { okBtn.focus({ preventScroll: true }); } catch (e) { try { okBtn.focus(); } catch (e2) {} } }, 40);
    });
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

  /* ---------- 把「主导航」和「⋯ 菜单」合成一个 ----------
     页头只留一个 ⋯ 按钮：站点内导航、跨站链接、日/夜、管理入口、
     调试相关入口全在同一个面板里。原来的 ▤ 抽屉不再出现。 */
  function initMergeMenus() {
    var nav = B8.qs('#nav');
    var menu = B8.qs('#more-menu');
    if (!nav || !menu) return;

    var group = document.createElement('div');
    group.className = 'menu-group';

    // 夜间模式放菜单第一项（它原来藏在跨站链接后面）
    var theme = menu.querySelector('#theme-btn');
    if (theme && theme.parentNode === menu) {
      menu.insertBefore(theme, menu.firstChild);
    }

    var links = B8.qsa('a', nav);
    links.forEach(function (a) {
      var copy = document.createElement('a');
      copy.href = a.getAttribute('href');
      copy.textContent = a.textContent;
      var cls = a.getAttribute('class');
      if (cls) copy.className = cls;
      group.appendChild(copy);
    });

    if (group.childNodes.length) {
      if (theme && theme.parentNode === menu) {
        menu.insertBefore(group, theme.nextSibling);
      } else {
        menu.insertBefore(group, menu.firstChild);
      }
      var sep = document.createElement('span');
      sep.className = 'menu-sep';
      menu.insertBefore(sep, group.nextSibling);
    }

    document.body.classList.add('menu-merged');
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

  /* ---------- 页头「更多」菜单 ---------- */
  function initMore() {
    var btn = B8.qs('#more-menu-btn');
    var menu = B8.qs('#more-menu');
    if (!btn || !menu) return;

    function close() {
      menu.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
    }

    B8.on(btn, 'click', function (e) {
      e.stopPropagation();
      var willOpen = menu.hidden;
      menu.hidden = !willOpen;
      btn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    });

    // 点菜单外面 / 按 Esc 收起
    B8.on(document, 'click', function (e) {
      if (menu.hidden) return;
      if (menu.contains(e.target) || e.target === btn) return;
      close();
    });
    B8.on(document, 'keydown', function (e) {
      if (e.key === 'Escape') close();
    });

    B8.qsa('a, button', menu).forEach(function (el) {
      // 夜间模式按钮是连续切换用的，点一下不能把菜单关掉
      if (el.id === 'theme-btn') return;
      B8.on(el, 'click', close);
    });
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
      badge.title = '本次加载已绕过缓存';
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

  /* ---------- 超管控制台：只有超管才下载 ----------
     以前三个站都在首屏 document.write 里加载 console.js（17 KB），
     99% 的同学永远用不到。现在等 auth 解析完，确认是超管再补进来。 */
  var consoleLoading = false;

  function loadConsole() {
    if (consoleLoading || document.getElementById('console-js')) return;
    if (!B8.auth || !B8.auth.isSuper || !B8.auth.isSuper()) return;
    consoleLoading = true;

    var s = document.createElement('script');
    s.id = 'console-js';
    s.async = true;
    s.src = 'assets/console.js?v=' + encodeURIComponent(window.B8_BUILD || '0') + (window.B8_T || '');
    s.onerror = function () {
      consoleLoading = false;
      if (s.parentNode) s.parentNode.removeChild(s);
      if (window.console) console.warn('[b8] 控制台模块没加载上');
    };
    document.head.appendChild(s);
  }

  /* ---------- 启动 ---------- */
  function boot() {
    initNav();
    initMergeMenus();
    initMore();
    initReveal();
    initYear();
    initBuild();
    initLinks();
    loadConsole();
    document.addEventListener('b8:auth', loadConsole);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
