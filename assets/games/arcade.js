/* ============================================================
   B8 多人大厅（arcade.html）
   ------------------------------------------------------------
   三个游戏一个壳：
     · quoridor 步步为营（2-4 人）
     · graphwar 函数大战（2-8 人）
     · mines    无猜扫雷（单人，直接挂在大厅）
   游戏规则全在各个 arcade-*.js 模块里；这里负责大厅、房间、座位、
   同步（Supabase 权威 + 引擎 API 的 /ws/room 广播「变了」）、聊天、排行榜。

   模块契约见 arcade-*.js 顶部注释；壳这边只保证：
     A.games[key] = { key, title, icon, sub, mode, seats, mount(root, ctx), destroy() }
   ============================================================ */
(function () {
  'use strict';

  var B8 = window.B8;
  if (!B8) return;

  var A = window.B8Arcade = window.B8Arcade || {};
  A.games = A.games || {};

  var $ = function (id) { return document.getElementById(id); };
  function txt(id, s) { var n = $(id); if (n) n.textContent = s; }
  function show(id, on) { var n = $(id); if (n) n.hidden = !on; }
  function esc(s) { return B8.esc ? B8.esc(s == null ? '' : s) : String(s == null ? '' : s); }
  function logged() { return !!(B8.auth && B8.auth.isLogged()); }
  function token() { return (B8.auth && B8.auth.memberToken()) || ''; }
  function nick() { return (B8.auth && B8.auth.nick && B8.auth.nick()) || ''; }

  var META = {
    quoridor: { title: '步步为营', icon: '墙', sub: '2-4 人 · 放墙堵路', seats: [2, 3, 4] },
    graphwar: { title: '函数大战', icon: 'ƒ', sub: '2-8 人 · 输入函数打炮', seats: [2, 3, 4, 5, 6, 7, 8] },
    mines: { title: '扫雷', icon: '雷', sub: '单人 · 无猜版 · 三档', seats: [1] }
  };

  var S = {
    view: 'lobby',
    game: 'quoridor',
    seats: 2,
    teamMode: 'ffa',
    isPrivate: false,
    room: null,
    seat: 0,
    chat: [],
    mod: null,
    modKey: '',
    subs: [],
    ws: null,
    wsCode: '',
    wsRetry: 0,
    wsQueue: [],
    pollTimer: 0,
    syncBusy: false,
    joined: false,
    result: '',
    dbMissing: false,
    lastList: 0,
    round: 0,
    overShown: false,
    soloMounted: false,
    lastMinesLevel: ''
  };

  function mod(key) { return A.games[key] || null; }

  // 人数选项：模块可以给 [min,max] 区间（quoridor [2,4]），也可以给完整列表。
  // 认 minSeats/maxSeats，认 seatList，也认长度 > 2 的显式数组；只有 [2,2] 这种两元组才当区间。
  function seatChoices(m, d) {
    var out = [];
    if (m && Array.isArray(m.seatList) && m.seatList.length) return m.seatList.slice();
    var arr = (m && Array.isArray(m.seats)) ? m.seats : (d.seats || [2]);
    var mn = Number(m && m.minSeats) || Number(arr[0]);
    var mx = Number(m && m.maxSeats) || Number(arr[arr.length - 1]);
    if (arr.length > 2) return arr.slice();
    if (isFinite(mn) && isFinite(mx) && mx >= mn && mn >= 1) {
      for (var n = mn; n <= mx; n++) out.push(n);
      return out;
    }
    return arr.slice();
  }

  function meta(key) {
    var m = mod(key) || {};
    var d = META[key] || { title: key, icon: '?', sub: '', seats: [2] };
    return {
      key: key,
      title: m.title || d.title,
      icon: m.icon || d.icon,
      sub: m.sub || d.sub,
      mode: m.mode || (key === 'mines' ? 'solo' : 'multi'),
      seats: seatChoices(m, d)
    };
  }

  function errText(err) {
    var msg = (err && err.message) || '网络异常';
    if (/Could not find the function|schema cache|does not exist|还没建好/i.test(msg)) {
      return '数据库还没更新：请管理员跑一遍 supabase/install-all.sql';
    }
    return msg;
  }

  function rpc(name, args) {
    if (!B8.sb || !B8.sb.ready) return Promise.reject(new Error('还没连上数据库'));
    return B8.sb.rpc(name, args);
  }

  /* ============================================================
     一、大厅
     ============================================================ */

  function renderGames() {
    var box = $('ag-games');
    if (!box) return;
    box.innerHTML = '';
    ['graphwar', 'quoridor', 'mines'].forEach(function (key) {
      var m = meta(key);
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ag-gamecard';
      btn.setAttribute('data-game', key);
      btn.setAttribute('aria-pressed', S.game === key ? 'true' : 'false');
      btn.innerHTML = '<span class="ag-gicon">' + esc(m.icon) + '</span>' +
        '<span><b>' + esc(m.title) + '</b><span>' + esc(m.sub) + '</span></span>';
      btn.addEventListener('click', function () { selectGame(key); });
      box.appendChild(btn);
    });
  }

  function selectGame(key) {
    S.game = key;
    var m = meta(key);
    if (m.mode === 'solo') {
      S.seats = 1;
    } else if (m.seats.indexOf(S.seats) < 0) {
      S.seats = m.seats[0];
    }
    renderGames();
    renderOptions();
    if (m.mode === 'solo') showSolo();
    else hideSolo();
  }

  function renderOptions() {
    var m = meta(S.game);
    var multi = m.mode === 'multi';
    txt('ag-start-title', multi ? '开一局' + m.title : '无猜扫雷');
    txt('ag-start-note', multi
      ? '选人数，然后建房或快速匹配。房号 4 位，发同学就能进来。'
      : '三档难度，每局棋盘都经过逻辑求解器校验：一定能靠推理推完。得分 = 难度系数 × 基础分 − 用时秒数。');

    show('ag-seat-row', multi);
    show('ag-mode-row', multi && S.game === 'graphwar');
    show('ag-private-row', multi);
    show('ag-name-row', multi);
    show('ag-create', multi);
    show('ag-quick', multi);
    show('ag-solo-start', !multi);
    show('ag-join-form', multi);

    var seats = $('ag-seats');
    if (seats) {
      seats.innerHTML = '';
      m.seats.forEach(function (n) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'chip' + (S.seats === n ? ' is-on' : '');
        b.textContent = n + ' 人';
        b.setAttribute('aria-pressed', S.seats === n ? 'true' : 'false');
        b.addEventListener('click', function () { S.seats = n; renderOptions(); });
        seats.appendChild(b);
      });
    }

    var ffa = $('ag-mode-ffa');
    var team = $('ag-mode-team');
    if (ffa && team) {
      ffa.classList.toggle('is-on', S.teamMode !== 'team');
      team.classList.toggle('is-on', S.teamMode === 'team');
      ffa.setAttribute('aria-pressed', S.teamMode !== 'team' ? 'true' : 'false');
      team.setAttribute('aria-pressed', S.teamMode === 'team' ? 'true' : 'false');
    }

    var pub = $('ag-public');
    var priv = $('ag-private');
    if (pub && priv) {
      pub.classList.toggle('is-on', !S.isPrivate);
      priv.classList.toggle('is-on', S.isPrivate);
      pub.setAttribute('aria-pressed', !S.isPrivate ? 'true' : 'false');
      priv.setAttribute('aria-pressed', S.isPrivate ? 'true' : 'false');
    }
  }

  function loadLists(force) {
    if (!B8.sb || !B8.sb.ready) return;
    if (!force && Date.now() - S.lastList < 4000) return;
    S.lastList = Date.now();
    rpc('b8_arcade_list', { p_token: logged() ? token() : null })
      .then(function (res) {
        S.dbMissing = false;
        show('ag-db-note', false);
        renderRooms((res && res.rooms) || [], (res && res.mine) || []);
      })
      .catch(function (err) {
        S.dbMissing = true;
        var n = $('ag-db-note');
        if (n) {
          n.hidden = false;
          n.textContent = '多人大厅的数据库还没初始化：请管理员在 Supabase SQL Editor 跑一遍最新 install-all.sql。';
        }
        renderRooms([], []);
        if (window.console) console.warn('[arcade] 列表失败', err);
      });
  }

  function roomLine(r) {
    var m = meta(r.game);
    var seats = r.seats || [];
    var names = seats.map(function (x) { return x.name || x.no; }).join(' vs ');
    return {
      title: m.title + (r.is_private ? ' · 私密' : '') + (r.status === 'wait' ? ' · 等人' : ' · 对局中'),
      sub: (r.name ? esc(r.name) + ' · ' : '') + '房号 ' + esc(r.code) + ' · ' +
        seats.length + '/' + r.max_seats + ' 人' + (names ? ' · ' + esc(names) : '')
    };
  }

  function roomRow(r, mine) {
    var wrap = document.createElement('div');
    wrap.className = 'ag-room';
    var main = document.createElement('div');
    main.className = 'ag-room-main';
    var info = roomLine(r);
    var b = document.createElement('b');
    b.textContent = info.title;
    var sp = document.createElement('span');
    sp.innerHTML = info.sub;
    main.appendChild(b);
    main.appendChild(sp);
    wrap.appendChild(main);

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ag-room-btn' + (r.status === 'play' ? ' is-live' : '');
    btn.textContent = mine ? '回到房间' : (r.status === 'wait' ? '加入' : '观战');
    btn.addEventListener('click', function () { joinRoom(r.code); });
    wrap.appendChild(btn);
    return wrap;
  }

  function renderRooms(rooms, mine) {
    var mineBox = $('ag-mine');
    if (mineBox) {
      mineBox.innerHTML = '';
      if (!mine.length) {
        var p = document.createElement('p');
        p.className = 'ag-empty';
        p.textContent = logged() ? '你还没开房间。' : '登录后这里显示你在的房间。';
        mineBox.appendChild(p);
      } else {
        mine.forEach(function (r) { mineBox.appendChild(roomRow(r, true)); });
      }
    }

    var box = $('ag-rooms');
    if (!box) return;
    box.innerHTML = '';
    var open = rooms.filter(function (r) { return r.status === 'wait' && !r.is_private; });
    if (!open.length) {
      var q = document.createElement('p');
      q.className = 'ag-empty';
      q.textContent = S.dbMissing ? '数据库还没初始化。' : '现在没有公开房间。自己开一个，等人来。';
      box.appendChild(q);
      return;
    }
    open.forEach(function (r) { box.appendChild(roomRow(r, false)); });
  }

  /* ============================================================
     二、建房 / 加入 / 离开
     ============================================================ */

  function requireLogin(msg) {
    if (logged()) return true;
    if (B8.auth && B8.auth.openLogin) B8.auth.openLogin();
    B8.toast(msg || '多人房间要登录');
    return false;
  }

  function createRoom(quick) {
    if (!requireLogin('多人房间要登录（要记座位和分数）')) return;
    var m = meta(S.game);
    if (m.mode !== 'multi') return;
    var args = {
      p_token: token(),
      p_game: S.game,
      p_name: ($('ag-room-name') || {}).value || '',
      p_private: S.isPrivate,
      p_max_seats: S.seats,
      p_team_mode: S.teamMode
    };
    var call = quick ? rpc('b8_arcade_quick', {
      p_token: args.p_token, p_game: S.game,
      p_max_seats: S.seats, p_team_mode: S.teamMode
    }) : rpc('b8_arcade_create', args);

    var btn = $(quick ? 'ag-quick' : 'ag-create');
    if (btn) btn.disabled = true;
    call.then(function (res) {
      if (btn) btn.disabled = false;
      enterRoom(res.room, res.seat || 0, true);
    }).catch(function (err) {
      if (btn) btn.disabled = false;
      B8.toast(errText(err));
    });
  }

  function joinRoom(code) {
    code = String(code == null ? '' : code).toUpperCase().replace(/\s/g, '');
    if (!/^[A-Z0-9]{4}$/.test(code)) { B8.toast('房号是 4 位字母数字'); return; }
    if (!requireLogin('进去要先登录')) return;
    rpc('b8_arcade_join', { p_token: token(), p_code: code })
      .then(function (res) { enterRoom(res.room, res.seat || 0, true); })
      .catch(function (err) { B8.toast(errText(err)); });
  }

  function enterRoom(room, seat, remember) {
    S.room = room;
    S.seat = seat || 0;
    S.chat = [];
    S.view = 'room';
    S.result = '';
    S.round = 0;
    S.overShown = false;
    if (remember) {
      try { history.replaceState(null, '', 'arcade.html?room=' + encodeURIComponent(room.code)); } catch (e) {}
    }
    show('ag-lobby', false);
    show('ag-room', true);
    showGame('ag-over', false);
    S.subs = [];
    if (S.mod && S.mod.destroy) { try { S.mod.destroy(); } catch (e) {} }
    S.mod = null;
    S.modKey = '';
    renderRoom();
    syncRoom(true);
    wsConnect(room.code);
    schedulePoll();
  }

  function leaveRoom(silent) {
    var room = S.room;
    if (room && logged() && S.seat > 0) {
      rpc('b8_arcade_leave', { p_token: token(), p_code: room.code }).catch(function () {});
    }
    if (!silent) wsSend({ type: 'changed' });
    wsClose();
    clearTimeout(S.pollTimer);
    if (S.mod && S.mod.destroy) { try { S.mod.destroy(); } catch (e) {} }
    S.mod = null;
    S.modKey = '';
    S.subs = [];
    S.room = null;
    S.seat = 0;
    S.view = 'lobby';
    try { history.replaceState(null, '', 'arcade.html'); } catch (e) {}
    show('ag-room', false);
    show('ag-lobby', true);
    showGame('ag-over', false);
    showGame('ag-wait', false);
    loadLists(true);
    if (S.game === 'mines') showSolo();
  }

  /* ============================================================
     三、同步 / WebSocket
     ============================================================ */

  function applyRoom(room, seat) {
    if (!room) return;
    var prev = S.room || {};
    // 再来一局：别人开的新一局也要重挂载，否则停在上一局的结算画面
    if (prev.status === 'over' && room.status === 'play') S.round = (S.round || 0) + 1;
    S.room = room;
    if (typeof seat === 'number' && seat >= 0) S.seat = seat;
    if (room.status === 'wait') showGame('ag-wait', true);
    else showGame('ag-wait', false);
    renderRoom();
    if (room.status === 'play' || room.status === 'over') ensureModule();
    else destroyModule();
  }

  function syncRoom(force) {
    if (!S.room || S.syncBusy) return;
    if (!force && Date.now() - (S.lastSync || 0) < 900) return;
    S.syncBusy = true;
    S.lastSync = Date.now();
    rpc('b8_arcade_sync', {
      p_token: logged() ? token() : null,
      p_code: S.room.code
    }).then(function (res) {
      S.syncBusy = false;
      if (!res || !res.room) return;
      S.chat = res.chat || [];
      applyRoom(res.room, typeof res.seat === 'number' ? res.seat : S.seat);
      renderChat();
      notify();
    }).catch(function (err) {
      S.syncBusy = false;
      if (S.dbMissing) return;
      if (/房间不存在/.test((err && err.message) || '')) {
        B8.toast('房间已经关了');
        leaveRoom(true);
      }
    });
  }

  function schedulePoll() {
    clearTimeout(S.pollTimer);
    S.pollTimer = setTimeout(function () {
      if (S.view !== 'room' || !S.room) return;
      if (!document.hidden) syncRoom(false);
      schedulePoll();
    }, S.ws ? 9000 : 3500);
  }

  function wsUrl(code) {
    var base = (window.B8_CONFIG && B8_CONFIG.engineApi) || '';
    if (!/^https?:/i.test(base)) return '';
    return base.replace(/^http/i, 'ws').replace(/\/+$/, '') + '/ws/room/' + encodeURIComponent(code);
  }

  function wsConnect(code) {
    wsClose();
    var url = wsUrl(code);
    if (!url) return;
    var sock;
    try { sock = new WebSocket(url); } catch (e) { return; }
    S.ws = sock;
    S.wsCode = code;
    sock.onopen = function () {
      if (S.ws !== sock) return;
      S.wsRetry = 0;
      while (S.wsQueue.length) {
        var m = S.wsQueue.shift();
        try { sock.send(JSON.stringify(m)); } catch (e) { break; }
      }
      syncRoom(true);
      schedulePoll();
    };
    sock.onmessage = function (ev) {
      if (S.ws !== sock) return;
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg && msg.type === 'changed') syncRoom(true);
    };
    sock.onclose = function () {
      if (S.ws !== sock) return;
      S.ws = null;
      schedulePoll();
      if (S.view === 'room' && S.room && S.room.code === code) {
        S.wsRetry = Math.min(6, S.wsRetry + 1);
        setTimeout(function () { if (S.view === 'room' && S.room) wsConnect(S.room.code); },
          1500 * S.wsRetry);
      }
    };
    sock.onerror = function () {};
  }

  function wsClose() {
    if (S.ws) {
      var s = S.ws;
      S.ws = null;
      s.onopen = null;
      s.onmessage = null;
      s.onclose = null;
      s.onerror = null;
      try { s.close(); } catch (e) {}
    }
    S.wsQueue = [];
  }

  function wsSend(obj) {
    if (S.ws && S.ws.readyState === 1) {
      try { S.ws.send(JSON.stringify(obj)); return; } catch (e) {}
    }
    S.wsQueue.push(obj);
    if (S.wsQueue.length > 20) S.wsQueue.shift();
  }

  /* ============================================================
     四、对局外壳
     ============================================================ */

  function renderRoom() {
    var r = S.room;
    if (!r) return;
    var m = meta(r.game);
    var seats = r.seats || [];
    txt('ag-room-title', m.title + (r.name ? ' · ' + r.name : ''));
    txt('ag-room-meta', '房号 ' + r.code + ' · ' + seats.length + '/' + r.max_seats + ' 人 · ' +
      (r.status === 'wait' ? '等人' : (r.status === 'play' ? '对局中' : '已结束')) +
      (r.team_mode === 'team' ? ' · 组队' : '') +
      (S.seat > 0 ? ' · 你坐 ' + S.seat + ' 号' : ' · 观战'));

    var box = $('ag-players');
    if (box) {
      box.innerHTML = '';
      seats.forEach(function (p) {
        var el = document.createElement('span');
        el.className = 'ag-player' +
          (r.turn === p.seat && r.status === 'play' ? ' is-turn' : '') +
          (p.seat === S.seat ? ' is-me' : '');
        var i = document.createElement('i');
        i.textContent = String(p.seat);
        var b = document.createElement('span');
        b.textContent = (p.name || p.no || '同学') + (p.seat === S.seat ? '（你）' : '');
        el.appendChild(i);
        el.appendChild(b);
        box.appendChild(el);
      });
      if (S.seat === 0) {
        var w = document.createElement('span');
        w.className = 'ag-player';
        w.textContent = '观战中';
        box.appendChild(w);
      }
    }

    var isHost = S.seat === 1;
    show('ag-close-room', isHost || (B8.auth && B8.auth.isSuper && B8.auth.isSuper()));
    show('ag-start-now', isHost && r.status === 'wait' && seats.length >= 2);
    show('ag-again', isHost && r.status === 'over');
    txt('ag-chat-count', String((S.chat || []).length));
    if (r.status === 'wait') {
      var codeEl = $('ag-wait-code');
      if (codeEl) codeEl.textContent = r.code;
    }
    if (r.status === 'over') {
      if (!S.overShown) {
        S.overShown = true;
        renderOver();
      }
    } else {
      S.overShown = false;
      showGame('ag-over', false);
    }
  }

  function renderOver() {
    var r = S.room;
    if (!r) return;
    var seats = r.seats || [];
    var win = r.winner;
    var who = '';
    for (var i = 0; i < seats.length; i++) if (seats[i].seat === win) who = seats[i].name || seats[i].no;
    txt('ag-over-kicker', '对局结束 · 房号 ' + r.code);
    txt('ag-over-title', who ? who + ' 获胜' : '对局结束');
    var sub = [];
    if (S.seat > 0) {
      sub.push(S.seat === win ? '你赢了！' : (who ? '这局 ' + who + ' 赢了。' : ''));
    } else {
      sub.push('观战结束。');
    }
    if (r.team_mode === 'team') sub.push('组队模式（红 1/3/5/7 · 蓝 2/4/6/8）');
    txt('ag-over-sub', sub.join(' '));
    showGame('ag-over', true);
    var again = $('ag-over-again');
    if (again) {
      again.hidden = !(S.seat === 1);
      again.disabled = !(S.seat === 1);
      again.textContent = S.seat === 1 ? '再来一局' : '等房主再开';
    }
  }

  function showGame(id, on) {
    var n = $(id);
    if (n) n.hidden = !on;
  }

  function ensureModule() {
    var r = S.room;
    if (!r || r.status === 'wait') return;
    // 只换局（重新开局）才重挂载；wait→play→over 之间不动，免得把结算画面刷掉
    var key = r.id + '#' + (S.round || 0);
    if (S.mod && S.modKey === key) return;
    destroyModule();
    var m = mod(r.game);
    if (!m || typeof m.mount !== 'function') {
      var stage = $('ag-stage');
      if (stage) {
        stage.innerHTML = '<p class="ag-empty">这个游戏还没加载好（arcade-' + esc(r.game) +
          '.js 没找到或报错）。</p>';
      }
      return;
    }
    S.mod = m;
    S.modKey = key;
    try {
      m.mount($('ag-stage'), makeCtx());
    } catch (e) {
      if (window.console) console.warn('[arcade] 模块挂载失败', e);
      var st = $('ag-stage');
      if (st) st.innerHTML = '<p class="ag-empty">游戏画面出错：' + esc(e && e.message) + '</p>';
      S.mod = null;
    }
    notify();
  }

  function destroyModule() {
    if (S.mod && typeof S.mod.destroy === 'function') {
      try { S.mod.destroy(); } catch (e) {}
    }
    S.mod = null;
    S.modKey = '';
    S.subs = [];
    var stage = $('ag-stage');
    if (stage) stage.innerHTML = '';
  }

  function notify() {
    if (!S.subs.length) return;
    var ctx = makeCtx();
    S.subs.slice().forEach(function (fn) {
      try { fn(ctx); } catch (e) { if (window.console) console.warn('[arcade] onChange', e); }
    });
  }

  function makeCtx() {
    var r = S.room || {};
    var seats = r.seats || [];
    var me = null;
    for (var i = 0; i < seats.length; i++) if (seats[i].seat === S.seat) me = seats[i];
    return {
      game: r.game,
      seat: S.seat,
      room: r,
      state: (r.state && typeof r.state === 'object') ? r.state : {},
      me: me,
      isHost: S.seat === 1,
      players: seats,
      isMyTurn: r.status === 'play' && r.turn === S.seat && S.seat > 0,
      send: sendAction,
      onChange: function (fn) {
        if (typeof fn !== 'function') return function () {};
        S.subs.push(fn);
        return function () {
          var k = S.subs.indexOf(fn);
          if (k >= 0) S.subs.splice(k, 1);
        };
      },
      refresh: function () { return syncRoom(true); },
      toast: function (msg) { B8.toast(msg); },
      setStatus: function (msg) { txt('ag-status', msg || '—'); },
      chat: {
        send: sendChat,
        items: S.chat
      }
    };
  }

  function sendAction(action, nextState, opts) {
    opts = opts || {};
    if (!S.room) return Promise.reject(new Error('还没进房间'));
    if (S.seat <= 0) return Promise.reject(new Error('观战不能操作'));
    return rpc('b8_arcade_action', {
      p_token: token(),
      p_code: S.room.code,
      p_act: action || {},
      p_state: nextState || null,
      p_turn: opts.turn == null ? null : opts.turn,
      p_status: opts.status || null,
      p_winner: opts.winner == null ? null : opts.winner
    }).then(function (res) {
      if (res && res.room) {
        applyRoom(res.room, S.seat);
      }
      wsSend({ type: 'changed' });
      return res;
    }).catch(function (err) {
      B8.toast(errText(err));
      throw err;
    });
  }

  function startGame() {
    var r = S.room;
    if (!r) return;
    if (S.seat !== 1) { B8.toast('只有房主可以开局'); return; }
    var seats = r.seats || [];
    if (seats.length < 2) { B8.toast('至少两个人才能开局'); return; }
    var m = mod(r.game);
    var init = null;
    try {
      if (m && typeof m.newState === 'function') {
        init = m.newState({ players: seats.length, seats: seats, teamMode: r.team_mode });
      } else if (m && m._test) {
        if (r.game === 'quoridor' && typeof m._test.init === 'function') init = m._test.init(seats.length);
        if (r.game === 'graphwar' && typeof m._test.newState === 'function') {
          init = m._test.newState(seats.length, r.team_mode);
        }
      }
    } catch (e) {
      B8.toast('开局局面算不出来：' + ((e && e.message) || ''));
      return;
    }
    if (!init) { B8.toast('这个游戏还没准备好'); return; }
    rpc('b8_arcade_start', { p_token: token(), p_code: r.code, p_state: init })
      .then(function (res) {
        if (res && res.room) {
          S.round = (S.round || 0) + 1;
          S.overShown = false;
          showGame('ag-over', false);
          applyRoom(res.room, S.seat);
        }
        wsSend({ type: 'changed' });
      })
      .catch(function (err) { B8.toast(errText(err)); });
  }

  /* ============================================================
     五、聊天
     ============================================================ */

  function renderChat() {
    var box = $('ag-chat-list');
    if (!box) return;
    box.innerHTML = '';
    (S.chat || []).forEach(function (c) {
      var div = document.createElement('div');
      div.className = 'ag-chat-item' + (c.seat && c.seat === S.seat ? ' is-me' : '');
      var b = document.createElement('b');
      b.textContent = (c.nick || '同学') + (c.seat ? ' ' + c.seat + '号' : '');
      var sp = document.createElement('span');
      sp.textContent = c.body || '';
      div.appendChild(b);
      div.appendChild(sp);
      box.appendChild(div);
    });
    box.scrollTop = box.scrollHeight;
    txt('ag-chat-count', String((S.chat || []).length));
  }

  function sendChat(text) {
    text = String(text == null ? '' : text).trim();
    if (!text || !S.room) return;
    if (!logged()) { B8.toast('登录后才能聊天'); return; }
    rpc('b8_arcade_chat_send', { p_token: token(), p_code: S.room.code, p_body: text })
      .then(function (res) {
        if (res && res.body) {
          S.chat.push({ seat: S.seat, nick: res.nick, body: res.body, at: new Date().toISOString() });
          renderChat();
        }
        wsSend({ type: 'changed' });
      })
      .catch(function (err) { B8.toast(errText(err)); });
  }

  /* ============================================================
     六、扫雷（单人）
     ============================================================ */

  function showSolo() {
    show('ag-solo', true);
    if (S.soloMounted) return;
    var m = mod('mines');
    var stage = $('ag-stage-solo');
    if (!m || !stage) return;
    S.soloMounted = true;
    try {
      m.mount(stage, {
        game: 'mines',
        toast: function (msg) { B8.toast(msg); },
        setStatus: function (msg) { txt('ag-solo-note', msg || '难度系数 × 基础分 − 用时 = 本局得分'); },
        onFinish: onSoloFinish,
        submitScore: function (score, detail) { return submitMinesScore(score, detail); },
        best: function (level, cb) {
          if (typeof level === 'function') { cb = level; level = ''; }
          return loadMinesBest(level, cb);
        }
      });
    } catch (e) {
      stage.innerHTML = '<p class="ag-empty">扫雷模块出错：' + esc(e && e.message) + '</p>';
    }
  }

  function hideSolo() {
    show('ag-solo', false);
    if (S.soloMounted) {
      var m = mod('mines');
      if (m && typeof m.destroy === 'function') { try { m.destroy(); } catch (e) {} }
      S.soloMounted = false;
      var stage = $('ag-stage-solo');
      if (stage) stage.innerHTML = '';
    }
  }

  function onSoloFinish(res) {
    res = res || {};
    if (!res.won) return;
    var score = Math.max(0, Math.floor(Number(res.score) || 0));
    S.lastMinesLevel = res.level || 'easy';
    if (!logged()) {
      B8.toast('本局 ' + score + ' 分。登录后能上榜');
      return;
    }
    submitMinesScore(score, res).then(function () {
      B8.toast('上榜：' + (res.level || '') + ' ' + score + ' 分');
    }).catch(function () {});
  }

  function submitMinesScore(score, detail) {
    if (!logged() || !B8.sb || !B8.sb.ready) return Promise.resolve(null);
    var game = 'mines:' + ((detail && detail.level) || S.lastMinesLevel || 'easy');
    return rpc('b8_score_add', { p_token: token(), p_game: game, p_score: Math.floor(score) })
      .catch(function (err) { if (window.console) console.warn('[arcade] 上榜失败', err); return null; });
  }

  function loadMinesBest(level, cb) {
    if (typeof cb !== 'function') return;
    if (!logged() || !B8.sb || !B8.sb.ready) { cb([]); return; }
    var games = level ? ['mines:' + level] : ['mines:easy', 'mines:medium', 'mines:hard'];
    Promise.all(games.map(function (g) {
      return rpc('b8_score_top', { p_token: token(), p_game: g, p_limit: 5 })
        .then(function (rows) { return rows || []; })
        .catch(function () { return []; });
    })).then(function (lists) {
      var all = [];
      lists.forEach(function (rows, i) {
        rows.forEach(function (r) {
          all.push({ nick: r.nick, score: r.score, level: games[i].split(':')[1], created_at: r.created_at });
        });
      });
      all.sort(function (a, b) { return b.score - a.score; });
      cb(all.slice(0, 5));
    }).catch(function () { cb([]); });
  }

  /* ============================================================
     七、绑定 / 启动
     ============================================================ */

  function bind() {
    var quick = $('ag-quick');
    if (quick) quick.addEventListener('click', function () { createRoom(true); });
    var create = $('ag-create');
    if (create) create.addEventListener('click', function () { createRoom(false); });
    var solo = $('ag-solo-start');
    if (solo) solo.addEventListener('click', showSolo);

    var ffa = $('ag-mode-ffa');
    if (ffa) ffa.addEventListener('click', function () { S.teamMode = 'ffa'; renderOptions(); });
    var team = $('ag-mode-team');
    if (team) team.addEventListener('click', function () { S.teamMode = 'team'; renderOptions(); });

    var pub = $('ag-public');
    if (pub) pub.addEventListener('click', function () { S.isPrivate = false; renderOptions(); });
    var priv = $('ag-private');
    if (priv) priv.addEventListener('click', function () { S.isPrivate = true; renderOptions(); });

    var refresh = $('ag-refresh');
    if (refresh) refresh.addEventListener('click', function () { loadLists(true); });

    var joinForm = $('ag-join-form');
    if (joinForm) {
      joinForm.addEventListener('submit', function (e) {
        e.preventDefault();
        joinRoom(($('ag-code') || {}).value || '');
      });
    }

    var exit = $('ag-exit');
    if (exit) exit.addEventListener('click', function () { leaveRoom(false); });
    var waitLeave = $('ag-wait-leave');
    if (waitLeave) waitLeave.addEventListener('click', function () { leaveRoom(false); });

    var startNow = $('ag-start-now');
    if (startNow) startNow.addEventListener('click', startGame);

    var copyCode = $('ag-copy-code');
    if (copyCode) {
      copyCode.addEventListener('click', function () {
        if (S.room && B8.copy) B8.copy(S.room.code);
      });
    }

    var copyLink = $('ag-copy-link');
    if (copyLink) {
      copyLink.addEventListener('click', function () {
        if (!S.room) return;
        var url = location.origin + location.pathname + '?room=' + encodeURIComponent(S.room.code);
        if (B8.copy) B8.copy(url);
      });
    }

    var closeRoom = $('ag-close-room');
    if (closeRoom) {
      closeRoom.addEventListener('click', function () {
        if (!S.room) return;
        B8.confirm('关掉这个房间？里面的人都会被请出去。', { title: '关房', okText: '关房', danger: true })
          .then(function (ok) {
            if (!ok) return;
            rpc('b8_arcade_close', { p_token: token(), p_code: S.room.code })
              .then(function () { leaveRoom(true); })
              .catch(function (err) { B8.toast(errText(err)); });
          });
      });
    }

    var again = $('ag-again');
    if (again) again.addEventListener('click', startGame);

    var overAgain = $('ag-over-again');
    if (overAgain) {
      overAgain.addEventListener('click', function () {
        showGame('ag-over', false);
        if (S.room && S.room.status === 'over' && S.seat === 1) startGame();
        else B8.toast('等房主再开一局');
      });
    }

    var overLobby = $('ag-over-lobby');
    if (overLobby) overLobby.addEventListener('click', function () { leaveRoom(false); });

    var chatForm = $('ag-chat-form');
    if (chatForm) {
      chatForm.addEventListener('submit', function (e) {
        e.preventDefault();
        var input = $('ag-chat-input');
        if (!input) return;
        var v = input.value;
        input.value = '';
        sendChat(v);
      });
    }

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && S.view === 'room') syncRoom(true);
    });
    window.addEventListener('online', function () {
      if (S.view === 'room') syncRoom(true);
    });
  }

  function updateWho() {
    var el = $('ag-who');
    if (!el) return;
    if (logged()) el.textContent = (nick() || '我') + ' · 已登录';
    else el.textContent = '未登录（只能扫雷/观战）';
  }

  function boot() {
    renderGames();
    renderOptions();
    bind();
    updateWho();
    loadLists(true);

    if (B8.auth && B8.auth.ready) {
      B8.auth.ready(function () {
        updateWho();
        loadLists(true);
      });
    }

    var room = (location.search || '').match(/[?&]room=([A-Za-z0-9]{4})/);
    if (room) {
      if (B8.auth && B8.auth.ready) {
        B8.auth.ready(function () { joinRoom(room[1]); });
      } else {
        joinRoom(room[1]);
      }
    }

    setInterval(function () {
      if (S.view === 'lobby' && !document.hidden) loadLists(false);
    }, 15000);
  }

  A.boot = boot;
  A.state = S;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
