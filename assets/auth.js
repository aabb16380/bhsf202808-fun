/* ============================================================
   B8 · 登录门（.fun / .site 共用）
   ------------------------------------------------------------
   一个输入框：班级口令 → 普通成员；管理员密钥 → 管理员。
   令牌存在 localStorage，30 天有效（管理员 1 天）。
   注意：静态站的前端门只能挡「路过的人」，真正的数据边界
   在数据库里 —— 所有写操作都走 RPC，由服务端校验令牌。
   ============================================================ */
(function () {
  'use strict';

  var B8 = window.B8 = window.B8 || {};
  var K_TOK = 'b8.tok';
  var K_KIND = 'b8.kind';
  var K_NICK = 'b8.nick';
  var K_EXP = 'b8.exp';

  var state = { kind: 'none', nick: '', token: '' };
  var listeners = [];
  var resolved = false;

  function store(k, v) {
    try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {}
  }
  function load(k) {
    try { return localStorage.getItem(k); } catch (e) { return null; }
  }

  var auth = B8.auth = {
    state: function () { return state; },
    token: function () { return state.token; },
    nick: function () { return state.nick; },
    kind: function () { return state.kind; },
    isAdmin: function () { return state.kind === 'admin'; }
  };

  function persist(res) {
    state.token = res.token;
    state.kind = res.kind;
    state.nick = res.nick || '';
    store(K_TOK, state.token);
    store(K_KIND, state.kind);
    store(K_NICK, state.nick);
    store(K_EXP, String(new Date(res.expires_at || Date.now() + 2592000000).getTime()));
  }

  function clear() {
    state.token = '';
    state.kind = 'none';
    state.nick = '';
    store(K_TOK, null); store(K_KIND, null); store(K_NICK, null); store(K_EXP, null);
  }

  function broadcast() {
    document.dispatchEvent(new CustomEvent('b8:auth', { detail: { kind: state.kind, nick: state.nick } }));
  }

  function settle() {
    if (resolved) return;
    resolved = true;
    broadcast();
    listeners.splice(0).forEach(function (fn) { try { fn(state); } catch (e) {} });
  }

  auth.ready = function (fn) {
    if (resolved) { try { fn(state); } catch (e) {} return; }
    listeners.push(fn);
  };

  /* ---------- 登录 / 登出 ---------- */

  auth.login = function (secret, nick) {
    if (!B8.sb.ready) return Promise.reject(new Error('未配置数据库'));
    return B8.sb.rpc('b8_login', { p_secret: secret, p_nick: nick || '' })
      .then(function (res) {
        if (!res || !res.token) throw new Error('登录失败：服务端没有返回令牌');
        persist(res);
        // 登录后补一次广播：管理员登录时页面已经 settle 过，靠它刷新各模块
        broadcast();
        return state;
      });
  };

  auth.logout = function () {
    var tok = state.token;
    clear();
    if (tok && B8.sb.ready) {
      B8.sb.rpc('b8_logout', { p_token: tok }).catch(function () {});
    }
    location.reload();
  };

  /* ---------- 门 ---------- */

  function showGate() {
    var gate = B8.qs('#gate');
    if (!gate) return;
    gate.hidden = false;
    gate.classList.remove('is-done');
    var input = B8.qs('#gate-secret');
    if (input && window.innerWidth > 860) setTimeout(function () { input.focus(); }, 120);
  }

  function hideGate() {
    var gate = B8.qs('#gate');
    if (!gate) return;
    gate.classList.add('is-done');
    setTimeout(function () { gate.hidden = true; }, 180);
    document.body.classList.add('authed');
  }

  auth.require_ = function () { showGate(); };

  function initGate() {
    var gate = B8.qs('#gate');
    if (!gate) { settle(); return; }

    var form = B8.qs('#gate-form');
    var secretEl = B8.qs('#gate-secret');
    var nickEl = B8.qs('#gate-nick');
    var errEl = B8.qs('#gate-err');
    var btn = B8.qs('#gate-submit');
    var previewBtn = B8.qs('#gate-preview');
    var hintEl = B8.qs('#gate-hint');

    // 没接数据库：不给登录表单，直接说明并允许预览界面
    if (!B8.sb.ready) {
      if (form) form.hidden = true;
      if (hintEl) {
        hintEl.hidden = false;
        hintEl.innerHTML = '本站还没接数据库。<br>先把 <code>supabase/schema.sql</code> 在 Supabase SQL Editor 里跑一遍，' +
          '再把项目 URL 和 anon key 填进 <code>assets/site-config.js</code>。';
      }
      if (previewBtn) {
        previewBtn.hidden = false;
        B8.on(previewBtn, 'click', function () {
          state.kind = 'preview';
          hideGate();
          settle();
        });
      } else {
        settle();
      }
      return;
    }

    function fail(msg) {
      if (errEl) errEl.textContent = msg || '';
      if (btn) { btn.disabled = false; btn.textContent = '进入'; }
    }

    B8.on(form, 'submit', function (e) {
      e.preventDefault();
      var secret = B8.trim(secretEl ? secretEl.value : '');
      var nick = B8.trim(nickEl ? nickEl.value : '', 16);
      if (errEl) errEl.textContent = '';
      if (secret.length < 4) { fail('口令至少 4 位'); return; }
      if (btn) { btn.disabled = true; btn.textContent = '验证中…'; }

      auth.login(secret, nick).then(function () {
        hideGate();
        settle();
        B8.toast('欢迎回来' + (state.nick ? '，' + state.nick : ''));
      }).catch(function (err) {
        fail(err && err.message ? err.message : '登录失败');
      });
    });

    // 自动记住上次昵称
    var lastNick = load(K_NICK);
    if (nickEl && lastNick) nickEl.value = lastNick;

    showGate();
  }

  /* ---------- 启动 ---------- */
  function boot() {
    var tok = load(K_TOK);
    var exp = Number(load(K_EXP) || 0);

    if (!tok || (exp && exp < Date.now())) {
      clear();
      initGate();
      return;
    }

    state.token = tok;
    state.kind = load(K_KIND) || 'class';
    state.nick = load(K_NICK) || '';

    // 让服务端复核一次令牌（可能已被吊销）
    if (!B8.sb.ready) { hideGate(); settle(); return; }

    B8.sb.rpc('b8_check', { p_token: tok }).then(function (res) {
      if (res && res.ok) {
        state.kind = res.kind || state.kind;
        if (res.nick) state.nick = res.nick;
        hideGate();
        settle();
      } else {
        clear();
        initGate();
      }
    }).catch(function () {
      // 网络异常：先用本地状态进站，写操作会再被服务端拦
      hideGate();
      settle();
    });

    var out = B8.qs('#logout-btn');
    if (out) B8.on(out, 'click', function (e) { e.preventDefault(); auth.logout(); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
