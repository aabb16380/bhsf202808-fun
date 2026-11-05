/* ============================================================
   超管控制台（三站共用）
   ------------------------------------------------------------
   只有超级管理员看得见：⋯ 菜单里会多一项「控制台」。
   三个 tab：成员（加人 / 重置密码 / 停用 / 看登录状态）
             密钥（看状态 / 停用 / 解绑）
             排行（删单条 / 清空某个游戏）
   普通管理员和普通同学都看不到入口；就算手动调 RPC，服务端也会按 super 拒绝。
   ============================================================ */
(function () {
  'use strict';

  var B8 = window.B8;
  if (!B8) return;

  var panel = null;
  var tab = 'members';
  var members = [];
  var keys = [];
  var scores = [];
  var worship = [];
  var scoreGame = '';
  var deletions = [];
  var visits = [];

  var GAMES = [
    { key: '', name: '全部' },
    { key: '2048', name: '2048' },
    { key: 'memory', name: '记忆翻牌' },
    { key: 'schulte', name: '舒尔特方格' },
    { key: 'piano', name: '钢琴辉' },
    { key: 'suika', name: '合成小辉辉' },
    { key: 'memnum', name: '记忆数字' },
    { key: 'reflex', name: '反应速度' },
    { key: 'clickspeed2', name: '手速测试' },
    { key: 'sudoku', name: '数独' },
    { key: '__worship', name: '膜宙金' }
  ];

  function tok() { return B8.auth.token(); }
  function esc(s) { return B8.esc(s == null ? '' : s); }
  function errText(e) { return esc(e && e.message ? e.message : '网络异常'); }

  /* ---------- 外壳 ---------- */
  function close() {
    if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
    panel = null;
  }

  function open() {
    close();
    panel = document.createElement('div');
    panel.className = 'modal';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.innerHTML = '<div class="modal-inner console-inner" id="console-inner"></div>';
    document.body.appendChild(panel);
    B8.on(panel, 'click', function (e) { if (e.target === panel) close(); });
    B8.on(document, 'keydown', function esc2(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc2); }
    });
    render();
  }

  function render() {
    var host = document.getElementById('console-inner');
    if (!host) return;

    var tabs = [
      { key: 'members', name: '成员' },
      { key: 'keys', name: '密钥' },
      { key: 'scores', name: '排行' },
      { key: 'deletions', name: '最近删除' },
      { key: 'visits', name: '上线' }
    ];

    // 永久管理员没有提权会话（auth.state().elev 是 null），
    // 以前这里直接读 .exp 会抛错，整块面板就只剩一条空边框。
    var st0 = null;
    try { st0 = B8.auth.state ? B8.auth.state() : null; } catch (e) { st0 = null; }
    var elev = st0 && st0.elev;
    var sub = esc(B8.auth.nick()) + ' · ' + esc(B8.auth.elevLabel() || '超级管理员');
    if (elev && elev.exp) {
      sub += '　权限到 ' + new Date(elev.exp).toLocaleString('zh-CN', { hour12: false }) + ' 失效';
    } else {
      sub += '　永久管理员';
    }

    var html = '<div class="console-head">' +
      '<h3 class="modal-title">控制台</h3>' +
      '<button class="btn ghost sm" type="button" id="console-close">关闭</button>' +
      '</div>' +
      '<p class="modal-note">' + sub + '</p>' +
      '<div class="chip-row console-tabs">';
    tabs.forEach(function (t) {
      html += '<button class="chip' + (tab === t.key ? ' on' : '') + '" type="button" data-tab="' +
        t.key + '" aria-pressed="' + (tab === t.key) + '">' + t.name + '</button>';
    });
    html += '</div><div id="console-body"><p class="form-note">读取中…</p></div>';
    host.innerHTML = html;

    B8.on(document.getElementById('console-close'), 'click', close);
    B8.qsa('.console-tabs .chip', host).forEach(function (b) {
      B8.on(b, 'click', function () {
        tab = b.getAttribute('data-tab');
        render();
      });
    });

    if (tab === 'members') loadMembers();
    else if (tab === 'keys') loadKeys();
    else if (tab === 'deletions') loadDeletions();
    else if (tab === 'visits') loadVisits();
    else loadScores();
  }

  function body() { return document.getElementById('console-body'); }

  function fail(err) {
    var b = body();
    if (b) b.innerHTML = '<p class="form-status err">读取失败：' + errText(err) + '</p>';
  }

  /* ---------- 成员 ---------- */
  function loadMembers() {
    return B8.sb.rpc('b8_super_members', { p_token: tok() }).then(function (rows) {
      members = rows || [];
      paintMembers();
    }, fail);
  }

  function loginState(m) {
    if (!m.has_pass) return '<span class="tag plain">还没设密码</span>';
    if (!m.last_login) return '<span class="tag">已认领 · 从未登录</span>';
    var d = new Date(m.last_login);
    var t = isNaN(d.getTime()) ? B8.date(m.last_login) : d.toLocaleString('zh-CN', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
    });
    return '<span class="tag jade">在用 · ' + esc(t) + '</span>';
  }

  function paintMembers() {
    var b = body();
    if (!b) return;

    var never = members.filter(function (m) { return !m.last_login; }).length;

    var html = '<div class="console-add">' +
      '<div class="field"><label for="cm-no">学号</label>' +
      '<input class="input" id="cm-no" inputmode="numeric" maxlength="12" placeholder="20282351"></div>' +
      '<div class="field"><label for="cm-name">姓名</label>' +
      '<input class="input" id="cm-name" maxlength="16" placeholder="新同学"></div>' +
      '<button class="btn sm" type="button" id="cm-add">加进花名册</button>' +
      '</div>' +
      '<p class="form-note">共 ' + members.length + ' 人，其中 ' + never + ' 人还没登录过。</p>' +
      '<div class="console-list">';

    members.forEach(function (m) {
      html += '<div class="console-row">' +
        '<div class="console-main">' +
          '<div class="console-title">' + esc(m.name) + ' <span class="console-dim">' + esc(m.student_no) + '</span></div>' +
          '<div class="console-meta">' + loginState(m) +
            (m.claimed_at ? ' · 认领于 ' + esc(B8.date(m.claimed_at)) : '') +
          '</div>' +
        '</div>' +
        '<div class="chip-row">' +
          '<button class="btn ghost sm" type="button" data-reset="' + esc(m.student_no) + '" title="生成一个随机临时密码">临时密码</button>' +
          '<button class="btn ghost sm" type="button" data-clear-pass="' + esc(m.student_no) + '" title="清空密码，变成未注册状态">清空密码</button>' +
          '<button class="btn ghost sm" type="button" data-toggle="' + esc(m.student_no) + '" data-active="' + (m.active ? '1' : '0') + '">' +
            (m.active ? '停用' : '启用') + '</button>' +
        '</div>' +
      '</div>';
    });
    html += '</div>';
    b.innerHTML = html;

    B8.on(document.getElementById('cm-add'), 'click', function () {
      var no = (document.getElementById('cm-no').value || '').replace(/\s/g, '');
      var name = (document.getElementById('cm-name').value || '').trim();
      if (!/^\d{6,12}$/.test(no)) { B8.toast('学号是 6–12 位数字'); return; }
      if (name.length < 2) { B8.toast('姓名至少两个字'); return; }
      this.disabled = true;
      var btn = this;
      B8.sb.rpc('b8_super_member_add', { p_token: tok(), p_no: no, p_name: name })
        .then(function () {
          B8.toast('已加入：' + name);
          loadMembers();
        })
        .catch(function (err) { btn.disabled = false; B8.toast(errText(err)); });
    });

    B8.qsa('[data-reset]', b).forEach(function (btn) {
      B8.on(btn, 'click', function () {
        var no = btn.getAttribute('data-reset');
        // 原密码是 sha256，取不回来，只能重置成一个新的临时密码
        B8.confirm('把 ' + no + ' 的密码重置成随机临时密码？\n原密码是哈希，取不回来，只能重置。\n\n重置后临时密码会显示在列表最上面，复制转告本人。', {
          title: '重置成临时密码', okText: '重置', danger: true
        }).then(function (ok) {
          if (!ok) return;
          btn.disabled = true;
          B8.sb.rpc('b8_super_temp_pass', { p_token: tok(), p_no: no })
            .then(function (res) {
              var tempNo = res.student_no;
              var tempPwd = res.temp_pass;
              // 必须等列表重画完再插临时密码，否则会被 paintMembers 的 innerHTML 冲掉
              return loadMembers().then(function () {
                showTemp(tempNo, tempPwd);
                B8.toast('临时密码已生成，看列表最上面');
                // 再弹一次，避免列表刷新或切 tab 后找不到；点「复制密码」直接进剪贴板
                B8.confirm('临时密码（' + tempNo + '）：\n\n' + tempPwd +
                  '\n\n把它告诉本人。本人登录后可以在右上角姓名 →「修改密码」里自己改。', {
                  title: '临时密码', okText: '复制密码', cancelText: '关闭'
                }).then(function (copyIt) {
                  if (copyIt) B8.copy(tempPwd);
                });
              });
            })
            .catch(function (err) { btn.disabled = false; B8.toast(errText(err)); });
        });
      });
    });

    B8.qsa('[data-clear-pass]', b).forEach(function (btn) {
      B8.on(btn, 'click', function () {
        var no = btn.getAttribute('data-clear-pass');
        B8.confirm('把 ' + no + ' 的密码清空，变成「未注册」？\n\n' +
          '本人下次用学号登录时，会重新核对姓名并设置新密码；' +
          '当前所有登录会话也会被踢掉。', {
          title: '清空密码', okText: '清空', danger: true
        }).then(function (ok) {
          if (!ok) return;
          btn.disabled = true;
          B8.sb.rpc('b8_super_pass_clear', { p_token: tok(), p_no: no })
            .then(function () {
              B8.toast(no + ' 已变成未注册，等本人重新设置密码');
              loadMembers();
            })
            .catch(function (err) {
              btn.disabled = false;
              B8.toast(errText(err));
            });
        });
      });
    });

    B8.qsa('[data-toggle]', b).forEach(function (btn) {
      B8.on(btn, 'click', function () {
        var no = btn.getAttribute('data-toggle');
        var active = btn.getAttribute('data-active') === '1';
        btn.disabled = true;
        B8.sb.rpc('b8_super_member_toggle', { p_token: tok(), p_no: no, p_active: !active })
          .then(function () { B8.toast(active ? '已停用' : '已启用'); loadMembers(); })
          .catch(function (err) { btn.disabled = false; B8.toast(errText(err)); });
      });
    });
  }


  /** 把新生成的密钥/密码显示在列表最上面，方便复制转告 */
  function showSecret(title, value) {
    var b = body();
    if (!b) return;
    var old = document.getElementById('console-temp');
    if (old && old.parentNode) old.parentNode.removeChild(old);

    var box = document.createElement('div');
    box.id = 'console-temp';
    box.className = 'console-temp';
    box.innerHTML = esc(title) + '：<code>' + esc(value) + '</code>';
    var cp = document.createElement('button');
    cp.type = 'button';
    cp.className = 'btn ghost sm';
    cp.textContent = '复制';
    B8.on(cp, 'click', function () { B8.copy(value); });
    box.appendChild(cp);
    b.insertBefore(box, b.firstChild);
  }
  /** 把重置出来的临时密码显示在列表最上面，方便复制转告 */
  function showTemp(no, pwd) {
    var b = body();
    if (!b) return;
    var old = document.getElementById('console-temp');
    if (old && old.parentNode) old.parentNode.removeChild(old);

    var box = document.createElement('div');
    box.id = 'console-temp';
    box.className = 'console-temp';
    box.innerHTML = '临时密码（' + esc(no) + '）：<code>' + esc(pwd) + '</code>';
    var cp = document.createElement('button');
    cp.type = 'button';
    cp.className = 'btn ghost sm';
    cp.textContent = '复制';
    B8.on(cp, 'click', function () { B8.copy(pwd); });
    box.appendChild(cp);
    b.insertBefore(box, b.firstChild);
  }
  /* ---------- 上线记录 ---------- */
  function loadVisits() {
    B8.sb.rpc('b8_super_visits', { p_token: tok(), p_limit: 3000 }).then(function (rows) {
      visits = rows || [];
      paintVisits();
    }, fail);
  }

  function visitDate(t) {
    var d = new Date(t);
    return isNaN(d.getTime()) ? null : d;
  }

  function visitClock(t) {
    var d = visitDate(t);
    if (!d) return '—';
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  }

  function visitFull(t) {
    var d = visitDate(t);
    if (!d) return '—';
    return d.toLocaleString('zh-CN', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
    });
  }

  function paintVisits() {
    var b = body();
    if (!b) return;
    if (!visits.length) {
      b.innerHTML = '<p class="form-note">还没有上线记录。等大家打开一次站点就会有了。</p>';
      return;
    }

    // 先按时间正序，同一个人 30 分钟内连续打开合并成一组；组按最新时间倒序。
    var items = visits.map(function (v) {
      var d = visitDate(v.opened_at);
      return {
        member_no: v.member_no,
        name: v.name || v.member_no,
        path: v.path || '首页',
        at: d ? d.getTime() : 0,
        raw: v.opened_at
      };
    }).filter(function (v) { return v.at > 0; }).sort(function (a, b) { return a.at - b.at; });

    var groups = [];
    var last = {};
    items.forEach(function (v) {
      var key = v.member_no || v.name;
      var g = last[key];
      if (g && v.at - g.end <= 30 * 60 * 1000) {
        g.end = v.at;
        g.items.push(v);
      } else {
        g = {
          member_no: v.member_no,
          name: v.name,
          start: v.at,
          end: v.at,
          items: [v]
        };
        groups.push(g);
        last[key] = g;
      }
    });
    groups.sort(function (a, b) { return b.end - a.end; });

    var html = '<p class="form-note">同一人 30 分钟内连续打开合并成一组；点开可看每次。共 ' +
      items.length + ' 次打开。</p><div class="console-list">';

    groups.forEach(function (g) {
      var sd = new Date(g.start);
      var ed = new Date(g.end);
      var sameDay = sd.toDateString() === ed.toDateString();
      var range;
      if (g.items.length === 1) {
        range = visitClock(g.start);
      } else if (sameDay) {
        range = visitClock(g.start) + '–' + visitClock(g.end);
      } else {
        range = visitFull(g.start) + '–' + visitFull(g.end);
      }

      html += '<details class="visit-group">' +
        '<summary class="visit-summary">' +
          '<span class="visit-who">' + esc(g.name) +
            ' <span class="console-dim">' + esc(g.member_no) + '</span></span>' +
          '<span class="visit-when">' + esc(range) + ' · ' + g.items.length + ' 次</span>' +
        '</summary>' +
        '<div class="visit-items">';

      g.items.slice().reverse().forEach(function (v) {
        html += '<div class="visit-item">' +
          '<span class="visit-time">' + esc(visitFull(v.at)) + '</span>' +
          '<span class="visit-path">' + esc(v.path) + '</span>' +
        '</div>';
      });

      html += '</div></details>';
    });

    html += '</div>';
    b.innerHTML = html;
  }
  /* ---------- 密钥 ---------- */
  function loadKeys() {
    B8.sb.rpc('b8_super_keys', { p_token: tok() }).then(function (rows) {
      keys = rows || [];
      paintKeys();
    }, fail);
  }

  function paintKeys() {
    var b = body();
    if (!b) return;

    var used = keys.filter(function (k) { return k.bound_no; }).length;

    var html = '<p class="form-note">共 ' + keys.length + ' 把，已绑出去 ' + used + ' 把。停用会立刻踢掉用这把密钥提权的会话。</p>' +
      '<div class="console-list">';

    keys.forEach(function (k) {
      html += '<div class="console-row' + (k.active ? '' : ' is-off') + '">' +
        '<div class="console-main">' +
          '<div class="console-title">' +
            '<span class="tag ' + (k.kind === 'super' ? '' : 'jade') + '">' +
              (k.kind === 'super' ? '超管' : '管理') + '</span> ' +
            esc(k.label) +
          '</div>' +
          '<div class="console-meta">' +
            (k.bound_no
              ? '绑给 ' + esc(k.bound_name || '') + '（' + esc(k.bound_no) + '）'
              : '<span class="console-dim">还没人用</span>') +
            (k.last_used ? ' · 最后使用 ' + esc(B8.date(k.last_used)) + ' · ' + (k.use_count || 0) + ' 次' : '') +
            (k.active ? '' : ' · <b>已停用</b>') +
          '</div>' +
        '</div>' +
        '<div class="chip-row">' +
          '<button class="btn ghost sm" type="button" data-key-toggle="' + k.id + '" data-active="' + (k.active ? '1' : '0') + '">' +
            (k.active ? '停用' : '启用') + '</button>' +
          (k.bound_no ? '<button class="btn ghost sm" type="button" data-unbind="' + k.id + '">解绑</button>' : '') +
          '<button class="btn ghost sm" type="button" data-reissue="' + k.id + '">重发</button>' +
        '</div>' +
      '</div>';
    });
    html += '</div>';
    b.innerHTML = html;

    B8.qsa('[data-key-toggle]', b).forEach(function (btn) {
      B8.on(btn, 'click', function () {
        var id = Number(btn.getAttribute('data-key-toggle'));
        var active = btn.getAttribute('data-active') === '1';
        btn.disabled = true;
        B8.sb.rpc('b8_super_key_toggle', { p_token: tok(), p_id: id, p_active: !active })
          .then(function () { B8.toast(active ? '已停用，相关会话已踢掉' : '已启用'); loadKeys(); })
          .catch(function (err) { btn.disabled = false; B8.toast(errText(err)); });
      });
    });

    B8.qsa('[data-reissue]', b).forEach(function (btn) {
      B8.on(btn, 'click', function () {
        var id = Number(btn.getAttribute('data-reissue'));
        B8.confirm('重发之后旧密钥立刻作废（正在用它的管理员会被踢下线），确定？', {
          title: '重发密钥', okText: '重发', danger: true
        }).then(function (ok) {
          if (!ok) return;
          btn.disabled = true;
          B8.sb.rpc('b8_super_key_reissue', { p_token: tok(), p_id: id })
            .then(function (res) {
              showSecret('新密钥（' + (res.label || '') + '）', res.plain);
              loadKeys();
            })
            .catch(function (err) { btn.disabled = false; B8.toast(errText(err)); });
        });
      });
    });
    B8.qsa('[data-unbind]', b).forEach(function (btn) {
      B8.on(btn, 'click', function () {
        var id = Number(btn.getAttribute('data-unbind'));
        B8.confirm('解绑之后这把密钥可以给别人用，确定？', {
          title: '解绑密钥', okText: '解绑', danger: true
        }).then(function (ok) {
          if (!ok) return;
          btn.disabled = true;
          B8.sb.rpc('b8_super_key_unbind', { p_token: tok(), p_id: id })
            .then(function () { B8.toast('已解绑'); loadKeys(); })
            .catch(function (err) { btn.disabled = false; B8.toast(errText(err)); });
        });
      });
    });
  }

  /* ---------- 最近删除 ---------- */
  function loadDeletions() {
    B8.sb.rpc('b8_super_photo_deletions', { p_token: tok(), p_limit: 40 })
      .then(function (rows) {
        deletions = rows || [];
        paintDeletions();
      }, function (err) {
        var b = body();
        if (!b) return;
        var msg = err && err.message ? err.message : '网络异常';
        if (/Could not find the function|schema cache|does not exist/i.test(msg)) {
          msg = '「最近删除」要更新数据库：请在 Supabase SQL Editor 里跑一遍 supabase/install-all.sql（只需一次）。';
        }
        b.innerHTML = '<p class="form-status err">读取失败：' + esc(msg) + '</p>';
      });
  }

  function kindName(k) {
    if (k === 'super') return '超管';
    if (k === 'admin') return '管理员';
    return '本人';
  }

  function gameLabel(g) {
    var map = { easy: '简单', normal: '普通', hard: '困难', expert: '极难' };
    var key = String(g);
    if (key.indexOf('sudoku:') === 0) return '数独 · ' + (map[key.slice(7)] || '');
    if (key.indexOf('piano:') === 0) return '钢琴辉';
    var names = {
      '2048': '2048', memory: '记忆翻牌', schulte: '舒尔特方格',
      suika: '合成小辉辉', memnum: '记忆数字', reflex: '反应速度',
      clickspeed2: '手速测试', clickspeed: '手速测试'
    };
    return names[key] || key;
  }

  function paintDeletions() {
    var b = body();
    if (!b) return;

    if (!deletions.length) {
      b.innerHTML = '<p class="form-note">还没有删除记录。管理员在照片墙上删掉的合影会出现在这里。</p>';
      return;
    }

    var html = '<p class="form-note">最近 ' + deletions.length +
      ' 条。记录保留照片、原上传者、删除者和时间；照片文件仍在 Storage 里，没有一起删。</p>' +
      '<div class="console-list">';

    deletions.forEach(function (d) {
      var thumb = d.url
        ? '<img class="console-thumb" src="' + esc(d.url) + '" alt="" loading="lazy" decoding="async">'
        : '<span class="console-thumb is-empty" aria-hidden="true">无图</span>';
      var title = d.caption ? esc(d.caption) : '（没写说明）';
      var link = d.url
        ? ' · <a href="' + esc(d.url) + '" target="_blank" rel="noopener noreferrer">看原图 ↗</a>'
        : '';
      html += '<div class="console-row is-del">' +
        thumb +
        '<div class="console-main">' +
          '<div class="console-title">' + title +
            ' <span class="console-dim">#' + esc(d.photo_id) + ' · ' + esc(d.category || '合影') + '</span>' +
          '</div>' +
          '<div class="console-meta">' +
            '原上传：' + esc(d.uploader || d.uploader_no || '同学') +
            ' · 删除：<b>' + esc(d.deleted_by_name || d.deleted_by_no || '未知') + '</b>' +
            '（' + kindName(d.deleted_by_kind) + '）' +
            ' · ' + esc(B8.dateTime(d.deleted_at)) +
          '</div>' +
          '<div class="console-meta">' +
            '原上传时间 ' + esc(B8.dateTime(d.photo_created_at) || '—') +
            ' · 点赞 ' + esc(d.likes || 0) + link +
          '</div>' +
        '</div>' +
      '</div>';
    });
    html += '</div>';
    b.innerHTML = html;
  }

  /* ---------- 排行 ---------- */
  function loadScores() {
    if (scoreGame === '__worship') {
      B8.sb.rpc('b8_super_worship', { p_token: tok(), p_limit: 500 }).then(function (rows) {
        worship = rows || [];
        paintScores();
      }, fail);
      return;
    }
    B8.sb.rpc('b8_super_scores', { p_token: tok(), p_game: scoreGame || null, p_limit: 100 })
      .then(function (rows) {
        scores = rows || [];
        paintScores();
      }, fail);
  }

  function bindScoreTabs(b) {
    B8.qsa('[data-game]', b).forEach(function (btn) {
      B8.on(btn, 'click', function () {
        scoreGame = btn.getAttribute('data-game');
        loadScores();
      });
    });
  }

  function paintScores() {
    var b = body();
    if (!b) return;

    var html = '<div class="chip-row console-tabs">';
    GAMES.forEach(function (g) {
      html += '<button class="chip' + (scoreGame === g.key ? ' on' : '') + '" type="button" data-game="' +
        g.key + '" aria-pressed="' + (scoreGame === g.key) + '">' + g.name + '</button>';
    });
    html += '</div>';

    if (scoreGame === '__worship') {
      html += '<p class="form-note">膜宙金按每个人累计膜拜的次数排序，括号里是当前剩余点数。</p>';
      html += '<div class="console-list">';
      if (!worship.length) {
        html += '<p class="form-note">还没有人膜过。</p>';
      }
      worship.forEach(function (w, i) {
        html += '<div class="console-row">' +
          '<div class="console-main">' +
            '<div class="console-title">' + (i + 1) + '. ' + esc(w.nick || '同学') +
              ' <span class="console-dim">' + esc(w.total) + ' 次</span></div>' +
            '<div class="console-meta">剩余 ' + esc(w.points || 0) + ' 点' +
              (w.member_no ? ' · ' + esc(w.member_no) : '') +
              (w.updated_at ? ' · ' + esc(B8.dateTime(w.updated_at)) : '') +
            '</div>' +
          '</div>' +
        '</div>';
      });
      html += '</div>';
      b.innerHTML = html;
      bindScoreTabs(b);
      return;
    }

    html += '<div class="console-list">';
    if (!scores.length) {
      html += '<p class="form-note">这个范围里还没有成绩。</p>';
    }
    scores.forEach(function (s, i) {
      html += '<div class="console-row">' +
        '<div class="console-main">' +
          '<div class="console-title">' + (i + 1) + '. ' + esc(s.nick || '匿名') +
            ' <span class="console-dim">' + esc(s.score) + ' 分 · ' + esc(gameLabel(s.game)) + '</span></div>' +
          '<div class="console-meta">' + esc(B8.dateTime(s.created_at)) +
            (s.member_no ? ' · ' + esc(s.member_no) : '') + '</div>' +
        '</div>' +
        '<div class="chip-row">' +
          '<input class="input" type="number" inputmode="numeric" min="0" max="10000000" step="1" ' +
            'style="width:110px" value="' + esc(s.score) + '" data-score-input="' + s.id + '" ' +
            'aria-label="修改 ' + esc(s.nick || '匿名') + ' 的分数">' +
          '<button class="btn ghost sm" type="button" data-score-save="' + s.id + '">保存分数</button>' +
          '<button class="btn ghost sm" type="button" data-score-del="' + s.id + '">删除</button>' +
        '</div>' +
      '</div>';
    });
    html += '</div>';

    html += '<div class="console-foot">' +
      '<span class="form-note">清空只删这一个游戏的成绩，删了就回不来了。</span>' +
      '<button class="btn ghost sm" type="button" id="score-clear">清空' +
        (scoreGame ? '「' + (GAMES.filter(function (g) { return g.key === scoreGame; })[0] || {}).name + '」' : '全部') +
      '</button></div>';
    b.innerHTML = html;

    bindScoreTabs(b);

    B8.qsa('[data-score-save]', b).forEach(function (btn) {
      B8.on(btn, 'click', function () {
        var id = Number(btn.getAttribute('data-score-save'));
        var input = b.querySelector('[data-score-input="' + id + '"]');
        var v = Math.floor(Number(input ? input.value : NaN));
        if (!isFinite(v) || v < 0 || v > 10000000) {
          B8.toast('分数要是 0–10000000 的整数');
          if (input) input.focus();
          return;
        }
        btn.disabled = true;
        B8.sb.rpc('b8_super_score_set', { p_token: tok(), p_id: id, p_score: v })
          .then(function () { B8.toast('已改成分数 ' + v); loadScores(); })
          .catch(function (err) { btn.disabled = false; B8.toast(errText(err)); });
      });
    });

    B8.qsa('[data-score-del]', b).forEach(function (btn) {
      B8.on(btn, 'click', function () {
        btn.disabled = true;
        B8.sb.rpc('b8_super_score_delete', { p_token: tok(), p_id: Number(btn.getAttribute('data-score-del')) })
          .then(function () { B8.toast('已删除'); loadScores(); })
          .catch(function (err) { btn.disabled = false; B8.toast(errText(err)); });
      });
    });

    var clearBtn = document.getElementById('score-clear');
    if (clearBtn) {
      B8.on(clearBtn, 'click', function () {
        B8.confirm('确定清空？删了就回不来了。', {
          title: '清空排行', okText: '清空', danger: true
        }).then(function (ok) {
          if (!ok) return;
          clearBtn.disabled = true;
          B8.sb.rpc('b8_super_score_clear', { p_token: tok(), p_game: scoreGame || null })
            .then(function (n) { B8.toast('清掉了 ' + (Number(n) || 0) + ' 条'); loadScores(); })
            .catch(function (err) { clearBtn.disabled = false; B8.toast(errText(err)); });
        });
      });
    }
  }

  /* ---------- 挂到 ⋯ 菜单 ---------- */
  function mount() {
    var menu = document.getElementById('more-menu');
    if (!menu || !B8.auth || !B8.auth.isSuper()) return;
    if (document.getElementById('console-open')) return;

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'console-open';
    btn.textContent = '控制台';
    var sep = menu.querySelector('.menu-sep');
    if (sep) menu.insertBefore(btn, sep);
    else menu.appendChild(btn);

    B8.on(btn, 'click', open);
  }

  function boot() {
    if (!B8.auth) return;
    B8.auth.ready(mount);
    document.addEventListener('b8:auth', mount);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
