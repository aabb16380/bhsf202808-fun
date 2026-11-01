/* ============================================================
   B8 · 账号与权限  v2.0
   ------------------------------------------------------------
   两个身份层次，两套令牌：

     member   学号 + 密码 → 30 天，存 localStorage
     admin/super  登录后输入密钥 → 2 小时，只存 sessionStorage
                  （关掉标签页就没了，符合"每次进入都要重新输密钥"）

   B8.auth.token() 会优先返回提权令牌，所以页面里的写操作不用改：
   有管理员权限时自然用管理员身份，没有时用成员身份，服务端再校验。

   公开 API（和 v1 的 auth.js 兼容，页面模块不用动）：
     B8.auth.ready(fn)   B8.auth.token()   B8.auth.nick()
     B8.auth.kind()      B8.auth.isAdmin() B8.auth.isSuper()
     B8.auth.useKey(k)   B8.auth.dropKey() B8.auth.logout()
   ============================================================ */
(function () {
  'use strict';

  var B8 = window.B8 = window.B8 || {};

  var K_MEMBER = 'b8.member';     // localStorage: {no,name,token,exp}
  var K_ELEV = 'b8.elev';         // sessionStorage: {token,kind,label,exp}

  var state = {
    member: null,                 // {no, name, token, exp}
    elev: null,                   // {token, kind, label, exp}
    preview: false,               // 没接数据库时点「先看看界面」
    stage: 'idle',                // gate 流程：idle | name | pass | setpass
    pendingNo: '',
    pendingName: '',
    err: ''
  };

  var resolved = false;
  var listeners = [];
  var autoGate = false;   // 登录门是不是为公开站现造的（.homes）

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} }
  function ssGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function ssSet(k, v) { try { v === null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch (e) {} }

  function readJson(store, key) {
    var raw = store === 'local' ? lsGet(key) : ssGet(key);
    if (!raw) return null;
    try {
      var o = JSON.parse(raw);
      if (o && o.exp && Number(o.exp) < Date.now()) return null;
      return o;
    } catch (e) { return null; }
  }

  function writeJson(store, key, obj) {
    var v = obj ? JSON.stringify(obj) : null;
    if (store === 'local') lsSet(key, v); else ssSet(key, v);
  }

  /* ---------- 对外状态 ---------- */

  var auth = B8.auth = {
    state: function () { return state; },
    // 有提权就用提权，否则用成员
    token: function () { return (state.elev && state.elev.token) || (state.member && state.member.token) || ''; },
    memberToken: function () { return (state.member && state.member.token) || ''; },
    nick: function () { return (state.member && state.member.name) || ''; },
    no: function () { return (state.member && state.member.no) || ''; },
    kind: function () { return state.elev ? state.elev.kind : (state.member ? 'member' : 'none'); },
    isLogged: function () { return !!(state.member && state.member.token); },
    isAdmin: function () { return !!(state.elev && (state.elev.kind === 'admin' || state.elev.kind === 'super')); },
    isSuper: function () { return !!(state.elev && state.elev.kind === 'super'); },
    elevLabel: function () { return (state.elev && state.elev.label) || ''; }
  };

  function broadcast() {
    var s = snapshot();
    document.dispatchEvent(new CustomEvent('b8:auth', {
      detail: {
        kind: s.kind, nick: s.nick, no: s.memberNo,
        isAdmin: s.isAdmin, isSuper: s.isSuper
      }
    }));
    var btn = document.getElementById('acct-btn');
    if (btn) btn.textContent = btnLabel();
  }

  /**
   * 给页面模块用的快照。
   * 注意：形状必须和 v1 的 {kind, nick} 保持一致——
   * photos.js / whispers.js 这些模块里写的都是 `if (st.kind === 'none') return;`，
   * 形状一变，它们会以为已经登录，然后拿着空令牌去打接口。
   */
  function snapshot() {
    var st = auth.state();
    return {
      kind: st.preview ? 'preview' : auth.kind(),   // none | member | admin | super | preview
      nick: auth.nick(),
      token: auth.token(),
      isAdmin: auth.isAdmin(),
      isSuper: auth.isSuper(),
      memberNo: auth.no()
    };
  }

  function settle() {
    if (resolved) return;
    resolved = true;
    broadcast();
    listeners.splice(0).forEach(function (fn) {
      try { fn(snapshot()); } catch (e) {}
    });
  }

  auth.ready = function (fn) {
    if (resolved) { try { fn(snapshot()); } catch (e) {} return; }
    listeners.push(fn);
  };

  /* ---------- 登录 ---------- */

  auth.signin = function (no, name, pass) {
    if (!B8.sb || !B8.sb.ready) return Promise.reject(new Error('未配置数据库'));
    return B8.sb.rpc('b8_signin', {
      p_no: no || '',
      p_name: name || '',
      p_pass: pass || ''
    });
  };

  auth.logout = function () {
    var tok = auth.token();
    var mtok = auth.memberToken();
    writeJson('local', K_MEMBER, null);
    writeJson('session', K_ELEV, null);
    state.member = null;
    state.elev = null;
    if (B8.sb && B8.sb.ready) {
      if (tok) B8.sb.rpc('b8_logout', { p_token: tok }).catch(function () {});
      if (mtok && mtok !== tok) B8.sb.rpc('b8_logout', { p_token: mtok }).catch(function () {});
    }
    location.reload();
  };

  /* ---------- 密钥提权 ---------- */

  auth.useKey = function (key) {
    var mtok = auth.memberToken();
    if (!mtok) return Promise.reject(new Error('先用自己的学号登录，再用密钥'));
    var k = String(key || '').trim();
    if (k.length < 6) return Promise.reject(new Error('密钥太短'));

    return B8.sb.rpc('b8_key_use', { p_token: mtok, p_key: k }).then(function (res) {
      if (!res || !res.token) throw new Error('提权失败：服务端没有返回令牌');
      state.elev = {
        token: res.token,
        kind: res.kind,
        label: res.label || '',
        exp: new Date(res.expires_at || Date.now() + 7200000).getTime()
      };
      writeJson('session', K_ELEV, state.elev);
      broadcast();
      return state.elev;
    });
  };

  auth.dropKey = function () {
    var t = state.elev && state.elev.token;
    state.elev = null;
    writeJson('session', K_ELEV, null);
    if (t && B8.sb && B8.sb.ready) B8.sb.rpc('b8_key_drop', { p_token: t }).catch(function () {});
    broadcast();
    return Promise.resolve();
  };

  /* ---------- 登录门（.fun / .site 用） ---------- */

  var gateEls = {};

  function $(id) { return document.getElementById(id); }

  function setErr(msg) {
    if (gateEls.err) {
      gateEls.err.textContent = msg || '';
      gateEls.err.className = 'gate-err' + (msg ? ' is-on' : '');
    }
  }

  function showFields(stage) {
    state.stage = stage;
    var isFirst = stage === 'name' || stage === 'setpass';
    if (gateEls.nameWrap) gateEls.nameWrap.hidden = !isFirst;
    if (gateEls.passWrap) gateEls.passWrap.hidden = stage === 'name' || stage === 'idle';
    if (gateEls.pass2Wrap) gateEls.pass2Wrap.hidden = stage !== 'setpass';
    if (gateEls.no) gateEls.no.readOnly = stage !== 'idle';

    var label = '下一步';
    if (stage === 'pass') label = '进入';
    if (stage === 'setpass') label = '设置密码并进入';
    if (stage === 'name') label = '核对姓名';
    if (gateEls.submit) gateEls.submit.textContent = label;

    if (stage === 'name' && gateEls.name) gateEls.name.focus();
    if (stage === 'pass' && gateEls.pass) gateEls.pass.focus();
    if (stage === 'setpass' && gateEls.pass) gateEls.pass.focus();
  }

  function resetGate() {
    state.pendingNo = '';
    state.pendingName = '';
    if (gateEls.name) gateEls.name.value = '';
    if (gateEls.pass) gateEls.pass.value = '';
    if (gateEls.pass2) gateEls.pass2.value = '';
    showFields('idle');
    setErr('');
  }

  function onGateSubmit(e) {
    e.preventDefault();
    setErr('');

    if (!B8.sb || !B8.sb.ready) {
      setErr('数据库还没接，先跑 supabase/install-all.sql 并填好 site-config.js');
      return;
    }

    var no = gateEls.no ? String(gateEls.no.value || '').replace(/\s/g, '') : '';
    var name = gateEls.name ? String(gateEls.name.value || '').trim() : '';
    var pass = gateEls.pass ? String(gateEls.pass.value || '') : '';
    var pass2 = gateEls.pass2 ? String(gateEls.pass2.value || '') : '';

    if (!/^\d{6,12}$/.test(no)) { setErr('学号是 8 位数字'); gateEls.no.focus(); return; }
    if (state.stage === 'setpass' && pass !== pass2) { setErr('两次密码不一致'); return; }

    var btn = gateEls.submit;
    if (btn) btn.disabled = true;

    auth.signin(no, state.stage === 'idle' || state.stage === 'pass' ? '' : name, pass)
      .then(function (res) {
        if (!res) throw new Error('服务端没有响应');
        if (res.stage === 'done') {
          state.member = {
            no: res.member_no, name: res.name || res.nick || '',
            token: res.token,
            exp: new Date(res.expires_at || Date.now() + 2592000000).getTime()
          };
          writeJson('local', K_MEMBER, state.member);
          hideGate();
          broadcast();
          settle();
          B8.toast('欢迎，' + state.member.name);
          return;
        }
        if (res.stage === 'name') {
          state.pendingNo = no;
          if (gateEls.hint) {
            gateEls.hint.textContent = res.hint ? '你是 ' + res.hint + ' 吗？请填完整姓名核对。' : '';
          }
          showFields('name');
          return;
        }
        if (res.stage === 'setpass') {
          state.pendingNo = no;
          state.pendingName = res.name || name;
          if (gateEls.hint) gateEls.hint.textContent = '第一次进来，给自己设个密码（至少 6 位）。';
          showFields('setpass');
          return;
        }
        if (res.stage === 'pass') {
          state.pendingNo = no;
          if (gateEls.hint) gateEls.hint.textContent = '欢迎回来，' + (res.name || '');
          showFields('pass');
          return;
        }
        throw new Error('未知的登录阶段：' + res.stage);
      })
      .catch(function (err) {
        setErr(err && err.message ? err.message : '登录失败');
      })
      .then(function () {
        if (btn) btn.disabled = false;
      });
  }

  function showGate() {
    var gate = $('gate');
    if (!gate) return;
    gate.hidden = false;
    gate.classList.remove('is-done');
    setTimeout(function () {
      if (gateEls.no && !gateEls.no.readOnly && window.innerWidth > 860) gateEls.no.focus();
    }, 120);
  }

  function hideGate() {
    var gate = $('gate');
    if (!gate) return;
    gate.classList.add('is-done');
    setTimeout(function () { gate.hidden = true; }, 180);
    document.body.classList.add('authed');
  }

  /**
   * .homes 这类「公开站」页面上没有登录门（它不该一进来就挡住内容），
   * 但管理员还是得能登录。所以页面里没有 #gate 时，这里现造一个。
   * 造出来的门上多一个「先不登录」，点它可以回到页面。
   */
  function ensureGate() {
    if ($('gate')) return $('gate');

    var el = document.createElement('div');
    el.className = 'gate';
    el.id = 'gate';
    el.hidden = true;
    el.innerHTML =
      '<div class="gate-card">' +
        '<img class="gate-logo" src="assets/logo.png" alt="" aria-hidden="true" width="84" height="68">' +
        '<h2>登录八班</h2>' +
        '<p class="gate-sub">用学号登录。第一次进来核对姓名后给自己设个密码。</p>' +
        '<form id="gate-form" novalidate>' +
          '<div class="field">' +
            '<label for="gate-no">学号（8 位）</label>' +
            '<input class="input" id="gate-no" inputmode="numeric" maxlength="8" ' +
              'autocomplete="username" placeholder="20282307">' +
          '</div>' +
          '<div class="field" id="gate-name-wrap" style="margin-top:12px" hidden>' +
            '<label for="gate-name">姓名</label>' +
            '<input class="input" id="gate-name" autocomplete="name" placeholder="第一次登录用来核对身份">' +
          '</div>' +
          '<div class="field" id="gate-pass-wrap" style="margin-top:12px" hidden>' +
            '<label for="gate-pass">密码</label>' +
            '<input class="input" id="gate-pass" type="password" autocomplete="current-password">' +
          '</div>' +
          '<div class="field" id="gate-pass2-wrap" style="margin-top:12px" hidden>' +
            '<label for="gate-pass2">再输一次密码</label>' +
            '<input class="input" id="gate-pass2" type="password" autocomplete="new-password">' +
          '</div>' +
          '<p class="gate-hint" id="gate-hint"></p>' +
          '<button class="btn seal" id="gate-submit" type="submit">下一步</button>' +
          '<p class="gate-err" id="gate-err" role="alert"></p>' +
        '</form>' +
        '<div class="gate-hintbox" id="gate-hintbox" hidden></div>' +
        '<button class="btn ghost sm" id="gate-cancel" type="button" style="margin-top:14px">先不登录</button>' +
        '<p class="gate-foot">密码只存 sha256，登录状态保存在你自己的浏览器里，30 天有效。</p>' +
      '</div>';

    document.body.appendChild(el);

    B8.on($('gate-cancel'), 'click', function () {
      el.hidden = true;
      el.classList.remove('is-done');
    });

    return el;
  }

  function initGate() {
    // 公开站没有登录门：先造一个，逻辑跟真门完全一样
    if (!$('gate')) { autoGate = true; ensureGate(); }

    var gate = $('gate');
    if (!gate) { settle(); return; }

    gateEls = {
      form: $('gate-form'), no: $('gate-no'), name: $('gate-name'), pass: $('gate-pass'),
      pass2: $('gate-pass2'), nameWrap: $('gate-name-wrap'), passWrap: $('gate-pass-wrap'),
      pass2Wrap: $('gate-pass2-wrap'), submit: $('gate-submit'), err: $('gate-err'),
      hint: $('gate-hint'), preview: $('gate-preview'), hintBox: $('gate-hintbox')
    };

    if (!B8.sb || !B8.sb.ready) {
      if (gateEls.form) gateEls.form.hidden = true;
      if (gateEls.hintBox) {
        gateEls.hintBox.hidden = false;
        gateEls.hintBox.innerHTML =
          '本站还没接数据库。<br>先把 <code>supabase/install-all.sql</code> 在 Supabase SQL Editor 里跑一遍，' +
          '再把项目 URL 和 key 填进 <code>assets/site-config.js</code>。';
      }
      if (gateEls.preview) {
        gateEls.preview.hidden = false;
        B8.on(gateEls.preview, 'click', function () {
          state.preview = true;
          state.member = { no: 'preview', name: '预览', token: 'preview', exp: Date.now() + 3600e3 };
          state.elev = null;
          hideGate();
          settle();
        });
      } else {
        settle();
      }
      return;
    }

    B8.on(gateEls.form, 'submit', onGateSubmit);
    B8.on(gateEls.no, 'input', function () {
      if (state.stage !== 'idle') resetGate();
    });

    showFields('idle');

    if (autoGate) {
      // 公开站（.homes）：门备着但不主动弹，同时立刻把「现在是游客」告诉页面，
      // 否则 B8.auth.ready() 的回调会一直等着，管理入口就不会出现。
      settle();
    } else {
      showGate();
    }
  }

  /* ---------- 账号面板（三站共用，点击右上角姓名） ---------- */

  var panel = null;

  function btnLabel() {
    if (!auth.isLogged()) return '登录';
    var n = auth.nick().slice(0, 4);
    return auth.isAdmin() ? n + ' · 管理' : n;
  }

  function closePanel() {
    if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
    panel = null;
  }

  function openPanel() {
    closePanel();
    panel = document.createElement('div');
    panel.className = 'modal';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.innerHTML = '<div class="modal-inner" id="acct-inner"></div>';
    document.body.appendChild(panel);
    B8.on(panel, 'click', function (e) { if (e.target === panel) closePanel(); });
    B8.on(document, 'keydown', function esc(e) {
      if (e.key === 'Escape') { closePanel(); document.removeEventListener('keydown', esc); }
    });
    renderPanel();
  }

  function renderPanel() {
    var host = $('acct-inner');
    if (!host) return;

    var html = '';

    if (!auth.isLogged()) {
      html +=
        '<h3 class="modal-title">登录</h3>' +
        '<p class="modal-note">用学号和密码登录。第一次进来只要学号和姓名，然后给自己设个密码。</p>' +
        '<a class="btn" href="javascript:void(0)" id="acct-switch">去登录</a>';
      host.innerHTML = html;
      B8.on($('acct-switch'), 'click', function () { closePanel(); showGate(); });
      return;
    }

    html +=
      '<h3 class="modal-title">' + B8.esc(auth.nick()) + '</h3>' +
      '<p class="modal-note">学号 ' + B8.esc(auth.no()) +
      (auth.isAdmin() ? ' · <span class="tag">' + B8.esc(auth.elevLabel() || auth.kind()) + '</span>' : '') +
      '</p>';

    if (!auth.isAdmin()) {
      html +=
        '<div class="field" style="margin-top:18px">' +
          '<label for="acct-key">管理员密钥（班委/超管才有）</label>' +
          '<input class="input" id="acct-key" placeholder="B8-XXXX-XXXX-XXXX" autocomplete="off">' +
          '<p class="modal-note" style="margin-top:6px">' +
            '一人一钥：第一次用哪把，以后就固定是你。权限 2 小时，关掉标签页就没了，下次进来要重新输。' +
          '</p>' +
        '</div>' +
        '<div class="modal-actions">' +
          '<button class="btn ghost sm" type="button" id="acct-logout">退出登录</button>' +
          '<button class="btn sm" type="button" id="acct-use">启用密钥</button>' +
        '</div>' +
        '<p class="form-status" id="acct-status"></p>';
    } else {
      html +=
        '<div class="modal-actions" style="margin-top:18px">' +
          '<button class="btn ghost sm" type="button" id="acct-drop">退出管理员</button>' +
          '<button class="btn ghost sm" type="button" id="acct-logout">退出登录</button>' +
        '</div>' +
        '<p class="modal-note" style="margin-top:14px">' +
          '管理员权限到 ' + new Date(auth.state().elev.exp).toLocaleString('zh-CN', { hour12: false }) + ' 失效。' +
        '</p>';
    }

    host.innerHTML = html;

    var st = $('acct-status');
    function status(msg, kind) {
      if (!st) return;
      st.textContent = msg;
      st.className = 'form-status ' + (kind || '');
    }

    var keyInput = $('acct-key');
    if (keyInput) {
      setTimeout(function () { keyInput.focus(); }, 80);
      B8.on(keyInput, 'keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); var b = $('acct-use'); if (b) b.click(); }
      });
    }

    B8.on($('acct-use'), 'click', function () {
      var v = keyInput ? keyInput.value : '';
      var btn = $('acct-use');
      btn.disabled = true;
      status('验证中…');
      auth.useKey(v).then(function (elev) {
        status('已启用：' + (elev.label || elev.kind), 'ok');
        B8.toast('管理员权限已启用');
        renderPanel();
      }).catch(function (err) {
        btn.disabled = false;
        status(err && err.message ? err.message : '密钥不对', 'err');
      });
    });

    B8.on($('acct-drop'), 'click', function () {
      auth.dropKey().then(function () {
        B8.toast('已退出管理员');
        renderPanel();
      });
    });

    B8.on($('acct-logout'), 'click', function () {
      auth.logout();
    });
  }

  function initAccountButton() {
    var host = document.querySelector('.header-tools');
    if (!host) return;
    var btn = document.createElement('button');
    btn.className = 'acct-btn';
    btn.id = 'acct-btn';
    btn.type = 'button';
    btn.textContent = btnLabel();
    host.insertBefore(btn, host.firstChild);
    B8.on(btn, 'click', openPanel);
  }

  /* ---------- 启动 ---------- */

  function getQuery(key) {
    var m = (location.search || '').match(new RegExp('[?&]' + key + '=([^&]+)'));
    return m ? decodeURIComponent(m[1]) : '';
  }

  function stripQuery(key) {
    try {
      var q = location.search.replace(new RegExp('[?&]' + key + '=[^&]+'), '').replace(/^&/, '?');
      if (q === '?') q = '';
      history.replaceState(null, '', location.pathname + q + location.hash);
    } catch (e) {}
  }

  /**
   * 三个站是三个域名，localStorage 天然不互通。
   * 所以在跨站链接上：先换一张 90 秒、一次性的手牌，带着它跳过去，
   * 对面用 b8_handoff_claim 换成本站的会话——用户只需要登录一次。
   * 权限（管理员）不在手牌里带：那是独立的一次 2 小时提权，换站要重新输密钥。
   */
  function initCrossSite() {
    B8.on(document, 'click', function (e) {
      var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (!a) return;

      var href = a.getAttribute('href') || '';
      if (!/^\/\/bhsf202808\.(homes|fun|site)\b/.test(href)) return;

      // 跳到本站自己就不折腾了
      var host = href.replace(/^\/\//, '').split(/[\/?#]/)[0];
      if (host === location.host) return;

      if (!auth.isLogged() || state.preview || state.claiming) return;
      if (!B8.sb || !B8.sb.ready) return;

      e.preventDefault();
      state.claiming = true;

      B8.sb.rpc('b8_handoff_create', { p_token: auth.memberToken() })
        .then(function (res) {
          if (!res || !res.code) throw new Error('no code');
          location.href = href + (href.indexOf('?') >= 0 ? '&' : '?') + 'login=' + encodeURIComponent(res.code);
        })
        .catch(function () {
          // 手牌换不到也别拦着人走，对面最多让他再登一次
          location.href = href;
        });
    });
  }

  function boot() {
    initAccountButton();
    initCrossSite();

    // 从别的站带手牌过来的：先把手牌换成这个站的会话，再走正常启动
    var code = getQuery('login');
    if (code && B8.sb && B8.sb.ready) {
      B8.sb.rpc('b8_handoff_claim', { p_code: code })
        .then(function (res) {
          state.member = {
            no: res.member_no,
            name: res.name || res.nick || '',
            token: res.token,
            exp: new Date(res.expires_at || Date.now() + 2592000000).getTime()
          };
          writeJson('local', K_MEMBER, state.member);
          stripQuery('login');
          B8.toast('已同步登录：' + state.member.name);
        })
        .catch(function (err) {
          stripQuery('login');
          B8.toast(err && err.message ? err.message : '登录同步失败');
        })
        .then(start);
      return;
    }
    start();
  }

  function start() {
    var m = readJson('local', K_MEMBER);
    var e = readJson('session', K_ELEV);
    var ready = B8.sb && B8.sb.ready;

    var verify = function (obj, isElev) {
      if (!obj || !obj.token || !ready) return Promise.resolve(false);
      return B8.sb.rpc('b8_check', { p_token: obj.token })
        .then(function (res) {
          if (!res || !res.ok) return false;
          if (isElev) {
            if (res.kind !== 'admin' && res.kind !== 'super') return false;
            obj.kind = res.kind;
            obj.label = res.label || obj.label || '';
          }
          return true;
        })
        .catch(function () { return 'offline'; });
    };

    Promise.all([verify(m, false), verify(e, true)]).then(function (r) {
      var okM = r[0] === true || r[0] === 'offline';
      var okE = r[1] === true || r[1] === 'offline';

      if (m && m.token && okM) {
        state.member = m;
      } else if (m) {
        writeJson('local', K_MEMBER, null);
      }

      if (e && e.token && okE && state.member) {
        state.elev = e;
      } else if (e) {
        writeJson('session', K_ELEV, null);
      }

      if (state.member) {
        hideGate();
        broadcast();
        settle();
        // 有提权的话，服务端再核一次标签/有效期
        var b = $('acct-btn');
        if (b) b.textContent = btnLabel();
      } else {
        initGate();
      }
      return null;
    }).catch(function (err) {
      if (window.console) console.warn('[auth] 启动失败：', err && err.message);
      initGate();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
