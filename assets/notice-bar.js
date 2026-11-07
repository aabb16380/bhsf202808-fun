/* ============================================================
   B8 · 站内通知（超管在控制台发布，首页和棋室共用）
   ------------------------------------------------------------
   页面里放两个空盒子，脚本自己找：

     <div data-notice="top"></div>     置顶通知：页面最上面
     <div data-notice="inline"></div>  普通通知：放在「正在对弈」上方

   页面没有 top 盒子时，置顶通知退回 inline 盒子，不会丢。

   · 单次通知：发出去一直留着，谁点 × 谁就不再看到
     （登录用户记数据库 b8_notice_seen，换设备也关着；游客只记本机）。
   · 时段通知：只在 starts_at ~ expires_at 之间可见，过点自动消失。
   · 数据来自 b8_notice_list；数据库没跑最新 install-all.sql（函数不存在）
     就静默不显示，不打扰页面其它内容。
   ============================================================ */
(function () {
  'use strict';

  var B8 = window.B8 = window.B8 || {};
  if (B8.noticeBar) return;

  var KEY = 'b8notice.closed';
  var TTL = 45000;
  var state = { items: [], at: 0, busy: false, api: true };
  var mounts = [];
  var timer = 0;

  function esc(s) { return B8.esc ? B8.esc(s == null ? '' : s) : String(s == null ? '' : s); }
  function logged() { return !!(B8.auth && B8.auth.isLogged && B8.auth.isLogged()); }
  function token() { return (B8.auth && B8.auth.memberToken && B8.auth.memberToken()) || ''; }
  function rpcReady() { return !!(B8.sb && B8.sb.ready && B8.sb.rpc); }

  function readClosed() {
    try {
      var raw = localStorage.getItem(KEY);
      var v = raw ? JSON.parse(raw) : null;
      if (!Array.isArray(v)) return [];
      return v.map(Number).filter(function (x) { return isFinite(x); });
    } catch (e) { return []; }
  }

  function writeClosed(ids) {
    try { localStorage.setItem(KEY, JSON.stringify(ids.slice(-200))); } catch (e) {}
  }

  function isClosed(id) { return readClosed().indexOf(Number(id)) >= 0; }

  function rememberClosed(id) {
    var ids = readClosed().filter(function (x) { return x !== Number(id); });
    ids.push(Number(id));
    writeClosed(ids);
  }

  function toast(msg) { if (B8.toast) B8.toast(msg); }

  function missingFn(err) {
    if (!err) return false;
    if (err.status === 404) return true;
    return /does not exist|schema cache|Could not find the function|还没建好/i.test(err.message || '');
  }

  /* ---------- 时间 ---------- */
  function clock(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var hm = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    if (d.toDateString() === new Date().toDateString()) return hm;
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm;
  }

  function ago(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var s = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
    if (s < 60) return '刚刚';
    if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
    if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
    return Math.floor(s / 86400) + ' 天前';
  }

  function metaOf(n) {
    var bits = [];
    if (n.at) bits.push(ago(n.at));
    if (n.kind === 'period' && n.expires) {
      var c = clock(n.expires);
      if (c) bits.push('到 ' + c + ' 前有效');
    }
    return bits.join(' · ');
  }

  /* ---------- 数据 ---------- */
  function load(force) {
    if (!rpcReady()) return;
    if (state.busy) return;
    if (!force && Date.now() - state.at < TTL) return;
    state.busy = true;
    B8.sb.rpc('b8_notice_list', { p_token: logged() ? token() : null })
      .then(function (rows) {
        state.items = (rows || []).map(function (r) {
          return {
            id: Number(r.id),
            kind: r.kind === 'period' ? 'period' : 'once',
            pinned: !!r.pinned,
            level: r.level === 'warn' ? 'warn' : 'info',
            title: String(r.title || ''),
            body: String(r.body || ''),
            at: r.created_at || '',
            expires: r.expires_at || '',
            closed: !!r.dismissed || isClosed(r.id)
          };
        });
        state.api = true;
        state.at = Date.now();
        render();
      })
      .catch(function (err) {
        state.at = Date.now();
        if (missingFn(err)) {
          state.api = false;
          state.items = [];
          render();
        } else if (window.console) {
          console.warn('[notice] 读取失败', err);
        }
      })
      .then(function () { state.busy = false; });
  }

  /* ---------- 渲染 ---------- */
  function nodeFor(n) {
    var wrap = document.createElement('div');
    wrap.className = 'ntc' + (n.pinned ? ' is-pinned' : '') + (n.level === 'warn' ? ' is-warn' : '');

    var main = document.createElement('div');
    main.className = 'ntc-main';

    var kick = document.createElement('span');
    kick.className = 'ntc-kicker';
    kick.textContent = (n.pinned ? '置顶通知' : '通知') + (n.kind === 'period' ? ' · 限时' : '');
    main.appendChild(kick);

    var title = document.createElement('b');
    title.className = 'ntc-title';
    title.textContent = n.title;
    main.appendChild(title);

    if (n.body) {
      var body = document.createElement('p');
      body.className = 'ntc-body';
      body.textContent = n.body;
      main.appendChild(body);
    }

    var meta = metaOf(n);
    if (meta) {
      var m = document.createElement('span');
      m.className = 'ntc-meta';
      m.textContent = meta;
      main.appendChild(m);
    }
    wrap.appendChild(main);

    var x = document.createElement('button');
    x.type = 'button';
    x.className = 'ntc-x';
    x.title = '关闭这条通知';
    x.setAttribute('aria-label', '关闭通知：' + n.title);
    x.textContent = '×';
    x.addEventListener('click', function () { closeNotice(n); });
    wrap.appendChild(x);
    return wrap;
  }

  function fill(box, list) {
    if (!box) return;
    box.innerHTML = '';
    if (!list.length) { box.hidden = true; return; }
    for (var i = 0; i < list.length; i++) box.appendChild(nodeFor(list[i]));
    box.hidden = false;
  }

  function findMounts() {
    var all = document.querySelectorAll('[data-notice]');
    var top = null, inline = null, any = null;
    for (var i = 0; i < all.length; i++) {
      var kind = all[i].getAttribute('data-notice');
      if (kind === 'top') top = all[i];
      else if (kind === 'inline') inline = all[i];
      if (!any) any = all[i];
    }
    mounts = [top, inline || any];
    return mounts;
  }

  function render() {
    if (!mounts.length) findMounts();
    var live = (state.items || []).filter(function (n) { return !n.closed; });
    var pinned = [], plain = [];
    for (var i = 0; i < live.length; i++) (live[i].pinned ? pinned : plain).push(live[i]);

    var top = mounts[0] || null;
    var inline = mounts[1] || null;
    // 没有置顶位就并到普通位，别把通知丢了
    if (!top) { plain = pinned.concat(plain); pinned = []; }

    fill(top, pinned);
    fill(inline, plain);
  }

  function closeNotice(n) {
    if (!n) return;
    n.closed = true;
    rememberClosed(n.id);
    if (logged() && rpcReady()) {
      B8.sb.rpc('b8_notice_dismiss', { p_token: token(), p_id: n.id })
        .catch(function () {});
    }
    render();
    toast('已关闭这条通知');
  }

  /* ---------- 启动 ---------- */
  function start() {
    findMounts();
    if (!mounts.length) return;
    load(true);
    clearInterval(timer);
    timer = setInterval(function () {
      if (!document.hidden) load(false);
    }, 20000);
  }

  var api = {
    load: load,
    render: render,
    closeNotice: closeNotice,
    metaOf: metaOf,
    state: state,
    isClosed: isClosed
  };
  B8.noticeBar = api;

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) load(false);
  });
  if (B8.auth && B8.auth.ready) {
    B8.auth.ready(function () { load(true); });
  }
  document.addEventListener('b8:auth', function () { load(true); });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
