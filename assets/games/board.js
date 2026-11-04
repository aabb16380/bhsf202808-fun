/* ============================================================
   B8 · 棋类对弈页面
   ------------------------------------------------------------
   大厅 / 本机对局 / 网络对局 / 观战 / 评论 / 计时 / 围棋点目。
   规则与胜负全部交给 board-engine.js；这一份只管界面和同步。

   网络同步的做法（为什么不会「不走子」）：
   · 走完立刻发 RPC，成功后马上再拉一次；
   · 对局页一直轮询：轮到自己 2.6s，轮到对方 1.1s；
   · 每次同步带 p_since，服务端回增量着法，客户端回放补上；
   · 页面隐藏时暂停，重新可见 / 网络恢复 / 窗口聚焦立刻补一次；
   · 连续失败会显示「重连中」，并在 12 秒没有成功同步时强制重试。
   ============================================================ */
(function () {
  'use strict';

  var B8 = window.B8 = window.B8 || {};
  var E = B8.boardEngine;
  if (!E) return;

  var $ = function (id) { return document.getElementById(id); };
  var GAMES = {
    xiangqi: {
      name: '中国象棋', en: 'XIANGQI', icon: '帅',
      desc: '车马炮 · 将帅不照面', colors: ['红方', '黑方'],
      first: '红方', second: '黑方'
    },
    chess: {
      name: '国际象棋', en: 'CHESS', icon: '♞',
      desc: '易位 · 吃过路兵 · 升变', colors: ['白方', '黑方'],
      first: '白方', second: '黑方'
    },
    go: {
      name: '围棋', en: 'GO', icon: '碁',
      desc: '9 / 13 / 19 路 · 点目', colors: ['黑方', '白方'],
      first: '黑方', second: '白方'
    },
    gomoku: {
      name: '五子棋', en: 'GOMOKU', icon: '五',
      desc: '15×15 · 先连五者胜', colors: ['黑方', '白方'],
      first: '黑方', second: '白方'
    },
    draughts: {
      name: '国际跳棋', en: 'DRAUGHTS', icon: '◉',
      desc: '10×10 · 必须吃最多', colors: ['白方', '黑方'],
      first: '白方', second: '黑方'
    }
  };
  var TIMES = [
    { v: 0, label: '不限时' },
    { v: 5, label: '5 分钟' },
    { v: 10, label: '10 分钟' },
    { v: 15, label: '15 分钟' },
    { v: 30, label: '30 分钟' }
  ];
  var GO_SIZES = [9, 13, 19];

  var LOBBY = { game: 'xiangqi', size: 19, minutes: 0, color: 1, rooms: [], mine: [], history: [], historyApi: true, dbMissing: false, busy: false };
  var LS = { mode1: 'no', mode2: 'no', name1: '', name2: '', resolved1: '', resolved2: '', timer1: 0, timer2: 0 };
  var S = null;                 // 当前对局
  var NET = { offset: 0, lastOk: 0, fails: 0, timer: 0, inflight: false, again: false, lastPing: 0, started: 0 };
  var CHAT = { timer: 0, lastId: 0, inflight: false, items: [], hidden: false };
  var LOCAL_KEY = 'b8.board.local.v1';
  var LAST_KEY = 'b8.board.last.v1';
  var pendingLogin = null;
  var pendingOpen = null;
  var renderer = null;
  var tickTimer = 0;
  var lastLobbyLoad = 0;

  function toast(msg) { if (B8.toast) B8.toast(msg); }
  function txt(id, s) { var n = $(id); if (n) n.textContent = s; }
  function show(id, on) { var n = $(id); if (n) n.hidden = !on; }
  function logged() { return !!(B8.auth && B8.auth.isLogged()); }
  function token() { return (B8.auth && B8.auth.memberToken()) || ''; }

  function readJSON(key) {
    try { var raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
  }
  function writeJSON(key, obj) {
    try {
      if (obj == null) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(obj));
    } catch (e) {}
  }

  function query(name) {
    var m = (location.search || '').match(new RegExp('[?&]' + name + '=([^&]*)'));
    return m ? decodeURIComponent(m[1]) : '';
  }

  function dbMissing(err) {
    if (!err) return false;
    if (err.status === 404) return true;
    return /does not exist|schema cache|Could not find the function|还没建好/i.test(err.message || '');
  }

  function isNight() {
    return document.documentElement.getAttribute('data-mode') === 'night';
  }

  function isOfflineLocal() { return !!(S && S.mode === 'local'); }
  function isLocalRoom() { return !!(S && S.room && S.room.mode === 'local'); }
  function isLocalGame() { return isOfflineLocal() || isLocalRoom(); }
  function isVsRoom() { return !!(S && S.room && S.room.mode !== 'local'); }

  /* ============================================================
     一、登录门
     ============================================================ */
  function showLoginGate() {
    var g = $('gate');
    if (g) {
      g.hidden = false;
      g.classList.remove('is-done');
    }
  }

  function requireLogin(fn) {
    if (logged()) { fn(); return; }
    pendingLogin = fn;
    showLoginGate();
    toast('先登录，再进对局');
  }

  document.addEventListener('b8:auth', function () {
    updateWho();
    if (logged() && pendingLogin) {
      var fn = pendingLogin;
      pendingLogin = null;
      fn();
    }
    if (logged()) loadLists(true);
  });

  function updateWho() {
    var n = $('bd-who');
    if (!n) return;
    n.textContent = logged() ? (B8.auth.nick() || '已登录') : '未登录';
  }

  /* ============================================================
     二、大厅
     ============================================================ */
  function buildGames() {
    var box = $('bd-games');
    box.innerHTML = '';
    E.list.forEach(function (g) {
      var info = GAMES[g];
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'bd-gamecard';
      b.setAttribute('data-game', g);
      b.setAttribute('aria-pressed', g === LOBBY.game ? 'true' : 'false');
      b.innerHTML =
        '<span class="bd-gi">' + info.icon + '</span>' +
        '<b>' + info.name + '</b>' +
        '<span class="bd-gen">' + info.en + '</span>' +
        '<span class="bd-gdesc">' + info.desc + '</span>' +
        '<span class="bd-glive" hidden></span>';
      b.addEventListener('click', function () {
        selectGame(g);
      });
      box.appendChild(b);
    });
  }

  function selectGame(g) {
    LOBBY.game = g;
    if (g === 'go') LOBBY.size = 19;
    else LOBBY.size = GAMES[g].size || 0;
    if (g === 'xiangqi' || g === 'draughts') LOBBY.color = 1;
    var cards = document.querySelectorAll('.bd-gamecard');
    for (var i = 0; i < cards.length; i++) {
      cards[i].setAttribute('aria-pressed', cards[i].getAttribute('data-game') === g ? 'true' : 'false');
    }
    renderGameLiveDots();
    renderOptions();
  }

  function renderGameLiveDots() {
    var live = {};
    (LOBBY.rooms || []).forEach(function (r) {
      if (r.status === 'play') live[r.game] = true;
    });
    var cards = document.querySelectorAll('.bd-gamecard');
    for (var i = 0; i < cards.length; i++) {
      var dot = cards[i].querySelector('.bd-glive');
      if (dot) dot.hidden = !live[cards[i].getAttribute('data-game')];
    }
  }

  function renderOptions() {
    var g = LOBBY.game;
    var info = GAMES[g];
    txt('bd-pick-note', '已选：' + info.name + ' · ' + info.colors[0] + '先行。');

    // 棋盘大小
    var sizeRow = $('bd-size-row');
    var sizes = $('bd-sizes');
    if (g === 'go') {
      sizeRow.hidden = false;
      sizes.innerHTML = '';
      GO_SIZES.forEach(function (n) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'chip';
        b.textContent = n + ' 路';
        b.setAttribute('aria-pressed', n === LOBBY.size ? 'true' : 'false');
        b.addEventListener('click', function () { LOBBY.size = n; renderOptions(); });
        sizes.appendChild(b);
      });
    } else {
      sizeRow.hidden = true;
    }

    // 计时
    var times = $('bd-times');
    times.innerHTML = '';
    TIMES.forEach(function (t) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = t.label;
      b.setAttribute('aria-pressed', t.v === LOBBY.minutes ? 'true' : 'false');
      b.addEventListener('click', function () { LOBBY.minutes = t.v; renderOptions(); });
      times.appendChild(b);
    });

    // 执子
    var colors = $('bd-colors');
    colors.innerHTML = '';
    [1, 2].forEach(function (c) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = '执' + info.colors[c - 1];
      b.setAttribute('aria-pressed', c === LOBBY.color ? 'true' : 'false');
      b.addEventListener('click', function () { LOBBY.color = c; renderOptions(); });
      colors.appendChild(b);
    });

    txt('bd-create-note', LOBBY.minutes > 0
      ? '每方 ' + LOBBY.minutes + ' 分钟，超时判负。本机对局也会进历史。'
      : '不限时。本机对局会先问两位棋手，也会公开、进历史。');
  }

  function fmtAgo(iso) {
    if (!iso) return '';
    var t = new Date(iso).getTime();
    if (isNaN(t)) return '';
    var d = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (d < 60) return '刚刚';
    if (d < 3600) return Math.floor(d / 60) + ' 分钟前';
    if (d < 86400) return Math.floor(d / 3600) + ' 小时前';
    return Math.floor(d / 86400) + ' 天前';
  }

  function roomPlayers(r) {
    var a = r.host_name || '房主';
    var b = r.guest_name || '等待对手';
    return a + '（' + GAMES[r.game].colors[r.host_color - 1] + '） vs ' + b +
      (r.guest_name ? '（' + GAMES[r.game].colors[r.guest_color - 1] + '）' : '');
  }

  function roomRow(r, opts) {
    opts = opts || {};
    var wrap = document.createElement('div');
    wrap.className = 'bd-room';
    var main = document.createElement('div');
    main.className = 'bd-room-main';
    var title = document.createElement('b');
    title.textContent = (r.mode === 'local' ? '本机 · ' : '') + GAMES[r.game].name +
      (r.status === 'wait' ? ' · 等人' : ' · 对弈中');
    var sub = document.createElement('span');
    var watchers = r.watchers ? ' · <i>' + r.watchers + ' 人观战</i>' : '';
    sub.innerHTML = B8.esc(roomPlayers(r)) + ' · ' + (r.seq || 0) + ' 手' +
      (r.timed ? ' · ' + r.minutes + ' 分钟' : ' · 不限时') + watchers;
    main.appendChild(title);
    main.appendChild(sub);
    wrap.appendChild(main);

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'bd-room-btn' + (r.status === 'play' ? ' is-live' : '');
    btn.textContent = opts.mine
      ? (r.status === 'play' ? '继续' : '回到房间')
      : (r.status === 'wait' ? '加入' : '观战');
    btn.addEventListener('click', function () {
      if (opts.mine) openRoom(r.code, { watch: false });
      else openRoom(r.code, { watch: r.status !== 'wait' });
    });
    wrap.appendChild(btn);
    return wrap;
  }

  function renderRooms() {
    var mine = $('bd-mine');
    mine.innerHTML = '';

    var local = readJSON(LOCAL_KEY);
    if (local && local.moves && local.moves.length) {
      var box = document.createElement('div');
      box.className = 'bd-room';
      var main = document.createElement('div');
      main.className = 'bd-room-main';
      var b = document.createElement('b');
      b.textContent = '本机 · ' + (GAMES[local.game] ? GAMES[local.game].name : local.game);
      var span = document.createElement('span');
      span.textContent = local.moves.length + ' 手 · ' +
        (local.minutes > 0 ? local.minutes + ' 分钟' : '不限时') + ' · 上次 ' + fmtAgo(new Date(local.savedAt).toISOString());
      main.appendChild(b);
      main.appendChild(span);
      box.appendChild(main);
      var go = document.createElement('button');
      go.type = 'button';
      go.className = 'bd-room-btn is-live';
      go.textContent = '继续';
      go.addEventListener('click', function () { resumeLocal(local); });
      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'bd-room-btn';
      del.textContent = '放弃';
      del.addEventListener('click', function () {
        writeJSON(LOCAL_KEY, null);
        renderRooms();
        toast('已清掉那盘本机对局');
      });
      box.appendChild(go);
      box.appendChild(del);
      mine.appendChild(box);
    }

    (LOBBY.mine || []).forEach(function (r) { mine.appendChild(roomRow(r, { mine: true })); });
    if (!mine.childNodes.length) {
      var p = document.createElement('p');
      p.className = 'bd-empty';
      p.textContent = LOBBY.dbMissing ? '数据库还没初始化，网络对局暂时不可用；本机对局不受影响。' : '还没有没下完的对局。';
      mine.appendChild(p);
    }

    var live = $('bd-live');
    live.innerHTML = '';
    (LOBBY.rooms || []).forEach(function (r) { live.appendChild(roomRow(r)); });
    if (!live.childNodes.length) {
      var q = document.createElement('p');
      q.className = 'bd-empty';
      q.textContent = LOBBY.dbMissing ? '数据库还没初始化。' : '现在没有人在下棋。开一桌，等人来。';
      live.appendChild(q);
    }
    show('bd-live-dot', (LOBBY.rooms || []).some(function (r) { return r.status === 'play'; }));
  }

  function historyReason(r) {
    return {
      checkmate: '将死', stalemate: '困毙', resign: '认输', timeout: '超时',
      agreement: '和棋', manual: '手动结束', score: '点目', 'no-move': '无子可动',
      nomove: '无子可动', five: '五连', full: '棋盘填满'
    }[r.reason] || '';
  }

  function historyResult(r) {
    if (!r.winner || r.winner === 3) return '和棋';
    var name = r.winner === r.host_color ? r.host_name : r.guest_name;
    return (name || '') + ' 胜';
  }

  function renderHistory() {
    var box = $('bd-history');
    if (!box) return;
    box.innerHTML = '';
    var list = LOBBY.history || [];
    if (!list.length) {
      var empty = document.createElement('p');
      empty.className = 'bd-empty';
      empty.textContent = LOBBY.dbMissing
        ? '数据库还没初始化。'
        : (LOBBY.historyApi ? '还没有下完的棋。下完一盘，这里会留下棋谱。'
          : '历史对局要等数据库更新（重跑 install-all.sql）后才有。');
      box.appendChild(empty);
      return;
    }
    list.forEach(function (r) {
      var info = GAMES[r.game] || { name: r.game, colors: ['先', '后'] };
      var row = document.createElement('div');
      row.className = 'bd-hrow';
      var main = document.createElement('div');
      main.className = 'bd-hrow-main';
      var title = document.createElement('b');
      title.innerHTML = B8.esc(info.name) + (r.mode === 'local' ? '<i>本机</i>' : '');
      var sub = document.createElement('span');
      var when = B8.dateTime ? B8.dateTime(r.ended_at || r.created_at) : '';
      var why = historyReason(r);
      sub.innerHTML = B8.esc(r.host_name || '房主') + ' <em>(' + info.colors[r.host_color - 1] + ')</em> vs ' +
        B8.esc(r.guest_name || '对手') + ' <em>(' + info.colors[r.guest_color - 1] + ')</em> · ' +
        B8.esc(when) + ' · ' + (r.seq || 0) + ' 手' + (why ? ' · ' + why : '');
      main.appendChild(title);
      main.appendChild(sub);

      var res = document.createElement('span');
      res.className = 'bd-hrow-result' + (!r.winner || r.winner === 3 ? ' is-draw' : '');
      res.textContent = historyResult(r);

      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'bd-room-btn';
      btn.textContent = '看棋谱';
      btn.addEventListener('click', function () {
        openRoom(r.code, { watch: true });
      });

      row.appendChild(main);
      row.appendChild(res);
      row.appendChild(btn);
      box.appendChild(row);
    });
  }

  function loadLists(force) {
    if (!B8.sb || !B8.sb.ready) return;
    if (Date.now() - lastLobbyLoad < 2500 && !force) return;
    lastLobbyLoad = Date.now();
    B8.sb.rpc('b8_board_list', { p_token: logged() ? token() : null })
      .then(function (res) {
        LOBBY.dbMissing = false;
        LOBBY.rooms = res.rooms || [];
        LOBBY.mine = res.mine || [];
        LOBBY.history = res.history || [];
        LOBBY.historyApi = Object.prototype.hasOwnProperty.call(res, 'history');
        show('bd-db-note', false);
        renderRooms();
        renderHistory();
        renderGameLiveDots();
      })
      .catch(function (err) {
        if (dbMissing(err)) {
          LOBBY.dbMissing = true;
          LOBBY.rooms = [];
          LOBBY.mine = [];
          LOBBY.history = [];
          var n = $('bd-db-note');
          if (n) {
            n.hidden = false;
            n.textContent = '对局数据库还没初始化：请管理员把最新 supabase/install-all.sql 在 Supabase SQL Editor 跑一遍。' +
              '在那之前，本机对局照常能玩。';
          }
          renderRooms();
          renderHistory();
        } else if (window.console) {
          console.warn('[board] 大厅加载失败', err);
        }
      });
  }

  /* ============================================================
     三、建房 / 加入 / 本机开局
     ============================================================ */
  function createRoom(settings) {
    requireLogin(function () {
      if (LOBBY.busy) return;
      LOBBY.busy = true;
      var btn = $('bd-create');
      if (btn) btn.disabled = true;
      var st = E.init(settings.game, { size: settings.size });
      B8.sb.rpc('b8_board_create', {
        p_token: token(),
        p_game: settings.game,
        p_state: st,
        p_timed: settings.minutes > 0,
        p_minutes: settings.minutes > 0 ? settings.minutes : 0,
        p_host_color: settings.color
      }).then(function (res) {
        enterOnline(res.room.code, res.room, res.state, res.seat);
        toast('房间开好了，把邀请码发给同学');
      }).catch(function (err) {
        var msg = (err && err.message) || '建房失败';
        if (dbMissing(err)) msg = '数据库还没初始化，先跑一遍 supabase/install-all.sql';
        toast(msg);
        var n = $('bd-create-note');
        if (n) n.textContent = msg;
      }).then(function () {
        LOBBY.busy = false;
        if (btn) btn.disabled = false;
      });
    });
  }

  function openRoom(code, opts) {
    opts = opts || {};
    code = String(code || '').toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code)) { toast('邀请码是 6 位字母数字'); return; }
    if (opts.watch) {
      // 观战不坐下、也不需要登录；登录了还能发评论
      enterOnline(code, null, null, 0, { watch: true });
      return;
    }
    requireLogin(function () {
      B8.sb.rpc('b8_board_join', { p_token: token(), p_code: code })
        .then(function (res) {
          enterOnline(code, res.room, res.state, res.seat);
        })
        .catch(function (err) {
          toast((err && err.message) || '进不去这个房间');
        });
    });
  }

  function saveLast(code) {
    writeJSON(LAST_KEY, { code: code, at: Date.now() });
  }
  function clearLast() { writeJSON(LAST_KEY, null); }

  /* ---------- 本机 ---------- */
  function localState() {
    return {
      v: 1, game: S.game, size: S.size,
      board: S.state.board, turn: S.state.turn, status: S.state.status,
      winner: S.state.winner, reason: S.state.reason, seq: S.state.seq,
      last: S.state.last, caps: S.state.caps, half: S.state.half,
      ko: S.state.ko, passes: S.state.passes, komi: S.state.komi,
      castle: S.state.castle, ep: S.state.ep
    };
  }

  function saveLocal() {
    if (!S || S.mode !== 'local') return;
    if (!S.moves.length) { writeJSON(LOCAL_KEY, null); return; }
    writeJSON(LOCAL_KEY, {
      game: S.game,
      size: S.size,
      minutes: S.minutes,
      names: S.playerNames,
      moves: S.moves.map(function (m) { return m.move; }),
      clock: S.timed ? [Math.round(S.clock[1]), Math.round(S.clock[2])] : null,
      savedAt: Date.now(),
      status: S.state.status
    });
  }

  function startOfflineLocal(name1, name2, settings) {
    var g = settings ? settings.game : LOBBY.game;
    var size = settings ? settings.size : LOBBY.size;
    var minutes = settings ? settings.minutes : LOBBY.minutes;
    var st = E.init(g, { size: size });
    S = {
      mode: 'local', game: g, size: st.size,
      minutes: minutes, timed: minutes > 0,
      state: st, moves: [], texts: [], stack: [],
      clock: { 1: minutes * 60000, 2: minutes * 60000 },
      clockStart: 0, clockRunning: 0,
      sel: null, targets: [], drPath: null, drMoves: null,
      score: null, flip: false, resultShown: false, moveBusy: false,
      room: null, code: '', playerNames: [name1 || '玩家一', name2 || '玩家二']
    };
    writeJSON(LOCAL_KEY, null);
    closePromo();
    showGame();
    renderAll();
    toast('本机对局：' + S.playerNames[0] + ' 对 ' + S.playerNames[1] + '，' + GAMES[g].first + '先走');
  }

  function startLocal() { startOfflineLocal('玩家一', '玩家二'); }

  /* ---------- 本机对局也上传成一个公开房间 ---------- */
  function createLocalRoom(name1, name2, settings) {
    if (!logged()) {
      toast('没登录：这盘只在本机，不会保存，别人也看不到');
      startOfflineLocal(name1, name2, settings);
      return;
    }
    if (!B8.sb || !B8.sb.ready) {
      startOfflineLocal(name1, name2, settings);
      toast('没接数据库：这盘只在本机');
      return;
    }
    if (LOBBY.busy) return;
    LOBBY.busy = true;
    var g = settings ? settings.game : LOBBY.game;
    var size = settings ? settings.size : LOBBY.size;
    var minutes = settings ? settings.minutes : LOBBY.minutes;
    var st = E.init(g, { size: size });
    B8.sb.rpc('b8_board_create_local', {
      p_token: token(),
      p_game: g,
      p_state: st,
      p_timed: minutes > 0,
      p_minutes: minutes > 0 ? minutes : 0,
      p_name1: name1,
      p_name2: name2
    }).then(function (res) {
      enterOnline(res.room.code, res.room, res.state, res.seat || 1, { localRoom: true });
      toast('本机对局已开：别人也能观战，下完进历史');
    }).catch(function (err) {
      var msg = (err && err.message) || '开局没成功';
      if (dbMissing(err)) {
        B8.confirm('数据库里还没有本机对局的函数（要重跑一遍 install-all.sql）。\n\n这盘只能在本机下：不会保存，别人也看不到。要继续吗？', {
          title: '只在本机', okText: '继续下'
        }).then(function (ok) { if (ok) startOfflineLocal(name1, name2, settings); });
      } else {
        toast(msg);
      }
    }).then(function () {
      LOBBY.busy = false;
    });
  }

  /* ---------- 本机开局：先填两位棋手 ---------- */
  function setSetupMode(p, mode) {
    if (p === 1) LS.mode1 = mode; else LS.mode2 = mode;
    if (p === 1) LS.resolved1 = ''; else LS.resolved2 = '';
    var btns = document.querySelectorAll('.bd-setup-modes .chip[data-p="' + p + '"]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].setAttribute('aria-pressed', btns[i].getAttribute('data-mode') === mode ? 'true' : 'false');
    }
    var input = $('bd-name' + p);
    var hint = $('bd-hint' + p);
    if (!input) return;
    input.value = '';
    if (mode === 'no') {
      input.setAttribute('inputmode', 'numeric');
      input.setAttribute('placeholder', p === 1 ? '8 位学号（如 20282307）' : '8 位学号（如 20282308）');
    } else {
      input.removeAttribute('inputmode');
      input.setAttribute('placeholder', p === 1 ? '给自己起个昵称（12 字以内）' : '给对手起个昵称（12 字以内）');
    }
    if (hint) { hint.textContent = ''; hint.className = 'bd-setup-hint'; }
  }

  function lookupPlayer(p) {
    var input = $('bd-name' + p);
    var hint = $('bd-hint' + p);
    if (!input || !hint) return;
    var mode = p === 1 ? LS.mode1 : LS.mode2;
    var raw = (input.value || '').trim();
    if (p === 1) LS.resolved1 = ''; else LS.resolved2 = '';
    if (mode !== 'no') return;
    if (raw.length !== 8) {
      hint.textContent = raw ? '学号是 8 位数字' : '';
      hint.className = 'bd-setup-hint' + (raw ? ' is-bad' : '');
      return;
    }
    hint.textContent = '查花名册中…';
    hint.className = 'bd-setup-hint';
    B8.sb.rpc('b8_member_lookup', { p_token: token(), p_no: raw })
      .then(function (res) {
        if ((p === 1 ? LS.mode1 : LS.mode2) !== 'no') return;
        if ((input.value || '').trim() !== raw) return;
        if (res && res.ok && res.name) {
          if (p === 1) LS.resolved1 = res.name; else LS.resolved2 = res.name;
          hint.textContent = '✓ ' + res.name;
          hint.className = 'bd-setup-hint is-good';
        } else {
          hint.textContent = '花名册里没有这个学号，可以切到「昵称」';
          hint.className = 'bd-setup-hint is-bad';
        }
      })
      .catch(function () {
        hint.textContent = '查不到（没登录或数据库没连上？），可以切到「昵称」';
        hint.className = 'bd-setup-hint is-bad';
      });
  }

  function openLocalSetup() {
    var no = (B8.auth && B8.auth.no && B8.auth.no()) || '';
    var nick = (B8.auth && B8.auth.nick && B8.auth.nick()) || '';
    LS.mode1 = no ? 'no' : 'nick';
    LS.mode2 = 'no';
    LS.resolved1 = '';
    LS.resolved2 = '';
    var i1 = $('bd-name1'), i2 = $('bd-name2');
    i1.value = no || nick || '';
    i2.value = '';
    var h1 = $('bd-hint1'), h2 = $('bd-hint2');
    h1.textContent = ''; h1.className = 'bd-setup-hint';
    h2.textContent = ''; h2.className = 'bd-setup-hint';
    var modes1 = document.querySelectorAll('.bd-setup-modes .chip[data-p="1"]');
    for (var i = 0; i < modes1.length; i++) {
      modes1[i].setAttribute('aria-pressed', modes1[i].getAttribute('data-mode') === LS.mode1 ? 'true' : 'false');
    }
    var modes2 = document.querySelectorAll('.bd-setup-modes .chip[data-p="2"]');
    for (var j = 0; j < modes2.length; j++) {
      modes2[j].setAttribute('aria-pressed', modes2[j].getAttribute('data-mode') === 'no' ? 'true' : 'false');
    }
    if (LS.mode1 === 'no') {
      i1.setAttribute('inputmode', 'numeric');
      i1.setAttribute('placeholder', '8 位学号（如 20282307）');
      lookupPlayer(1);
    } else {
      i1.removeAttribute('inputmode');
      i1.setAttribute('placeholder', '给自己起个昵称（12 字以内）');
    }
    i2.setAttribute('inputmode', 'numeric');
    i2.setAttribute('placeholder', '8 位学号（如 20282308）');
    show('bd-local-setup', true);
    setTimeout(function () { (no ? i2 : i1).focus(); }, 80);
  }

  function closeLocalSetup() {
    show('bd-local-setup', false);
  }

  function submitLocalSetup() {
    var names = [];
    for (var p = 1; p <= 2; p++) {
      var mode = p === 1 ? LS.mode1 : LS.mode2;
      var input = $('bd-name' + p);
      var hint = $('bd-hint' + p);
      var raw = (input.value || '').trim();
      if (mode === 'no') {
        var resolved = p === 1 ? LS.resolved1 : LS.resolved2;
        if (!resolved) {
          hint.textContent = raw.length === 8 ? '这个学号没查到姓名，可以切到「昵称」' : '请填 8 位学号，或切到「昵称」';
          hint.className = 'bd-setup-hint is-bad';
          input.focus();
          return;
        }
        names.push(resolved);
      } else {
        if (!raw || raw.length > 12) {
          hint.textContent = raw ? '昵称最多 12 个字' : '请填一个昵称';
          hint.className = 'bd-setup-hint is-bad';
          input.focus();
          return;
        }
        names.push(raw);
      }
    }
    closeLocalSetup();
    createLocalRoom(names[0], names[1]);
  }

  function resumeLocal(saved) {
    var moves = saved.moves || [];
    var st;
    try {
      st = E.replay(saved.game, { size: saved.size }, moves);
    } catch (e) {
      writeJSON(LOCAL_KEY, null);
      renderRooms();
      toast('那盘本机对局的记录坏了，已经清掉');
      return;
    }
    if (st.status !== 'play' || !moves.length) {
      writeJSON(LOCAL_KEY, null);
      toast('这盘已经结束了');
      renderRooms();
      return;
    }
    S = {
      mode: 'local', game: saved.game, size: st.size,
      minutes: saved.minutes || 0, timed: (saved.minutes || 0) > 0,
      state: st, moves: [], texts: [], stack: [],
      clock: {
        1: saved.clock ? saved.clock[0] : (saved.minutes || 0) * 60000,
        2: saved.clock ? saved.clock[1] : (saved.minutes || 0) * 60000
      },
      clockStart: 0, clockRunning: 0,
      sel: null, targets: [], drPath: null, drMoves: null,
      score: null, flip: false, resultShown: false,
      room: null, code: '',
      playerNames: saved.names || ['玩家一', '玩家二']
    };
    var tmp = E.init(saved.game, { size: saved.size });
    for (var i = 0; i < moves.length; i++) {
      S.texts.push({ seq: tmp.seq + 1, color: tmp.turn, text: E.text(tmp, moves[i]) });
      tmp = E.apply(tmp, moves[i]);
      S.moves.push({ seq: tmp.seq, color: 3 - tmp.turn, move: moves[i], at: 0 });
    }
    showGame();
    renderAll();
    toast('接着上次的本机对局');
  }

  /* ============================================================
     四、进入对局
     ============================================================ */
  function enterOnline(code, room, state, seat, opts) {
    opts = opts || {};
    stopChat();
    clearTimeout(NET.timer);
    CHAT.items = [];
    CHAT.lastId = 0;
    CHAT.hidden = false;
    NET.inflight = false;
    NET.again = false;
    NET.fails = 0;
    NET.lastOk = 0;
    S = {
      mode: 'online', code: code, room: room || null, state: state || null,
      game: room ? room.game : '', size: room ? room.size : 0,
      timed: room ? !!room.timed : false, minutes: room ? room.minutes : 0,
      seat: seat || 0, me: null, watchers: 0, offer: null, undo: null, undoPrompted: null, undoBusy: false,
      commentsHidden: false, moves: [], texts: [], moveBusy: false,
      sel: null, targets: [], drPath: null, drMoves: null,
      score: null, flip: seat === 2, resultShown: false, watch: !!opts.watch,
      isHost: false
    };
    saveLast(code);
    try {
      if (history.replaceState) history.replaceState(null, '', 'board.html?code=' + code);
    } catch (e) {}
    closePromo();
    showGame();
    renderAll();
    syncNow();
  }

  function showGame() {
    show('bd-lobby', false);
    show('bd-game', true);
    window.scrollTo(0, 0);
    if (!tickTimer) tickTimer = setInterval(tick, 250);
    setTimeout(draw, 60);
  }

  function backToLobby() {
    stopChat();
    clearTimeout(NET.timer);
    closePromo();
    S = null;
    show('bd-game', false);
    show('bd-lobby', true);
    try {
      if (history.replaceState) history.replaceState(null, '', 'board.html');
    } catch (e) {}
    renderRooms();
    loadLists(true);
    window.scrollTo(0, 0);
  }

  /* ============================================================
     五、同步
     ============================================================ */
  function setNet(kind, label) {
    var n = $('bd-net');
    if (!n) return;
    n.className = 'bd-net' + (kind ? ' is-' + kind : '');
    var s = n.querySelector('span');
    if (s) s.textContent = label;
  }

  function syncNow() {
    if (!S || S.mode !== 'online') return;
    if (NET.inflight) { NET.again = true; return; }
    if (navigator.onLine === false) {
      setNet('bad', '离线');
      schedulePoll(4000);
      return;
    }
    NET.inflight = true;
    NET.started = Date.now();
    var myCode = S.code;
    setNet('', S.room && S.room.status === 'wait' ? '等人中' : '同步中');
    var since = (S.moves && S.moves.length) ? (S.state.seq || 0) : 0;
    var ping = Date.now() - NET.lastPing > 6000;
    if (ping) NET.lastPing = Date.now();
    B8.sb.rpc('b8_board_sync', {
      p_token: logged() ? token() : null,
      p_code: S.code,
      p_since: since,
      p_ping: ping
    }).then(function (res) {
      if (!S || S.mode !== 'online' || S.code !== myCode) return;
      applySync(res);
      NET.inflight = false;
      if (NET.again) { NET.again = false; syncNow(); }
      else schedulePoll();
    }).catch(function (err) {
      if (!S || S.mode !== 'online' || S.code !== myCode) return;
      NET.inflight = false;
      NET.fails++;
      setNet('bad', '重连中…');
      if (NET.fails === 1 && window.console) console.warn('[board] 同步失败', err);
      if (dbMissing(err)) {
        toast('对局数据库还没初始化：先跑一遍 supabase/install-all.sql');
        backToLobby();
        return;
      }
      if (/房间不存在|已解散/.test(err.message || '')) {
        toast('这个房间不存在或已经解散');
        backToLobby();
        return;
      }
      schedulePoll(Math.min(6000, 1800 * NET.fails));
    });
  }

  function applySync(res) {
    if (!S || S.mode !== 'online') return;
    NET.fails = 0;
    NET.lastOk = Date.now();
    NET.offset = (res.server_now || Date.now()) - Date.now();
    setNet('', '已同步');

    var prevSeq = S.room ? S.room.seq : -1;
    S.room = res.room;
    S.me = res.me;
    S.game = res.room.game;
    S.size = res.room.size;
    S.timed = !!res.room.timed;
    S.minutes = res.room.minutes || 0;
    S.isHost = !!(res.me && res.me.host);
    S.watchers = res.watchers || 0;
    S.offer = res.offer || null;
    S.undo = res.undo || null;
    S.undoBusy = false;
    if (!S.undo) S.undoPrompted = null;
    if (res.me) S.seat = res.me.seat || 0;
    S.commentsHidden = !!res.comments_hidden;

    var undoBack = !!(res.room && res.room.seq < prevSeq);
    if (res.state && (!S.state || res.state.seq >= S.state.seq || undoBack || res.room.status === 'over')) {
      S.state = res.state;
    }
    if (undoBack) trimMovesTo(res.room.seq);

    var changed = false;
    (res.moves || []).forEach(function (m) {
      var exists = false;
      for (var i = S.moves.length - 1; i >= 0 && i >= S.moves.length - 8; i--) {
        if (S.moves[i].seq === m.seq) { exists = true; break; }
      }
      if (!exists) {
        S.moves.push(m);
        changed = true;
      }
    });
    if (changed) {
      S.moves.sort(function (a, b) { return a.seq - b.seq; });
      rebuildTexts();
    }

    if (S.room.status === 'over' || S.state.status === 'over') {
      clearTimeout(NET.timer);
      if (!S.resultShown) {
        S.resultShown = true;
        setTimeout(showResult, 160);
      }
      if (CHAT.timer) stopChat();
      initChat();
    } else if (S.room.status === 'wait') {
      setNet('wait', '等人中');
    }

    renderAll();
    promptUndoRequest();

    if (S.room.status === 'play' && S.state.status === 'play' && S.state.turn === S.seat) {
      // 轮到自己时不用轮询得那么勤，但仍要保持连接
    }
  }

  function promptUndoRequest() {
    if (!S || !S.room || !S.undo || S.undo.mine || S.seat === 0) return;
    if (S.state.status !== 'play') return;
    if (S.undoPrompted === S.undo.by) return;
    S.undoPrompted = S.undo.by;
    var name = S.undo.name || '对方';
    B8.confirm(name + ' 想悔一步，撤回上一手。\n\n同意吗？', {
      title: '悔棋请求', okText: '同意悔棋', cancelText: '拒绝'
    }).then(function (ok) {
      if (!S || !S.undo || S.undo.mine) return;
      if (ok) {
        var prev = stateBeforeLast();
        if (prev) acceptUndo(prev);
      } else {
        declineUndo();
      }
    });
  }

  function rebuildTexts() {
    var st = E.init(S.game || (S.room && S.room.game), { size: S.size || (S.room && S.room.size) });
    var out = [];
    for (var i = 0; i < S.moves.length; i++) {
      var m = S.moves[i];
      if (st.status !== 'play') break;
      out.push({ seq: m.seq, color: st.turn, text: E.text(st, m.move) });
      try { st = E.apply(st, m.move); } catch (e) { break; }
    }
    S.texts = out;
    S.moveState = st;
  }

  function schedulePoll(delay) {
    clearTimeout(NET.timer);
    if (!S || S.mode !== 'online') return;
    if (S.room && S.room.status === 'over') return;
    if (typeof delay === 'number') {
      NET.timer = setTimeout(syncNow, delay);
      return;
    }
    if (document.hidden) return;
    var d;
    if (!S.room || S.room.status === 'wait') d = 2200;
    else if (S.state && S.state.turn === S.seat) d = 2600;
    else d = 1100;
    NET.timer = setTimeout(syncNow, d);
  }

  document.addEventListener('visibilitychange', function () {
    if (!S || S.mode !== 'online') return;
    if (!document.hidden) syncNow();
  });
  window.addEventListener('focus', function () {
    if (S && S.mode === 'online' && !document.hidden) syncNow();
  });
  window.addEventListener('online', function () {
    if (S && S.mode === 'online') { NET.fails = 0; syncNow(); }
  });

  /* ============================================================
     六、走子
     ============================================================ */
  function myTurn() {
    if (!S || !S.state || S.state.status !== 'play') return false;
    if (isOfflineLocal()) return true;
    if (isLocalRoom()) return S.seat > 0 && S.room.status === 'play';
    return !!(S.room && S.room.status === 'play' && S.seat > 0 && S.state.turn === S.seat);
  }

  function commit(mv) {
    if (S && S.moveBusy) { toast('上一步还在同步，稍等一下'); return; }
    if (!myTurn()) {
      if (S.mode === 'online' && S.seat === 0) toast('观战中，不能走子');
      else if (S.mode === 'online' && S.room && S.room.status === 'wait') toast('还在等对手进来');
      else if (S.mode === 'online') toast('还没轮到你');
      return;
    }
    if (isOfflineLocal()) commitLocal(mv);
    else commitOnline(mv);
  }

  function commitLocal(mv) {
    var prev = S.state;
    var text = E.text(prev, mv);
    if (S.timed) {
      var now = Date.now();
      if (!S.clockStart) { S.clockStart = now; S.clockRunning = prev.turn; }
      var el = now - S.clockStart;
      S.clock[prev.turn] = Math.max(0, S.clock[prev.turn] - el);
      S.clockStart = now;
      S.clockRunning = 3 - prev.turn;
    }
    S.stack.push(prev);
    if (S.stack.length > 80) S.stack.shift();
    var ns = E.apply(prev, mv);
    S.moves.push({ seq: ns.seq, color: prev.turn, move: mv, at: Date.now() });
    S.texts.push({ seq: ns.seq, color: prev.turn, text: text });
    S.state = ns;
    S.sel = null; S.targets = []; S.drPath = null; S.drMoves = null;
    S.score = null;
    if (S.timed && ns.status === 'over') S.clockRunning = 0;
    saveLocal();
    renderAll();
    if (ns.status === 'over') setTimeout(showResult, 220);
    else if (S.timed && (S.clock[1] <= 0 || S.clock[2] <= 0)) timeoutLocal();
  }

  function commitOnline(mv) {
    var prev = S.state;
    var text = E.text(prev, mv);
    var ns = E.apply(prev, mv);
    S.moves.push({ seq: ns.seq, color: prev.turn, move: mv, at: Date.now() });
    S.texts.push({ seq: ns.seq, color: prev.turn, text: text });
    S.state = ns;
    S.sel = null; S.targets = []; S.drPath = null; S.drMoves = null;
    S.score = null;
    S.offer = null;
    S.undo = null;
    S.moveBusy = true;
    renderAll();

    setNet('', '发送中');
    var myCode = S.code;
    B8.sb.rpc('b8_board_move', {
      p_token: token(),
      p_code: S.code,
      p_seq: ns.seq,
      p_move: mv,
      p_state: ns
    }).then(function (res) {
      if (!S || S.mode !== 'online' || S.code !== myCode) return;
      S.moveBusy = false;
      if (res && res.timeout) {
        S.moves.pop();
        S.texts.pop();
        S.room = res.room;
        S.state = res.state;
        S.resultShown = true;
        renderAll();
        showResult();
        return;
      }
      if (res && res.room) {
        S.room = res.room;
        S.state = res.state;
        if (S.room.status === 'over') {
          S.resultShown = true;
          setTimeout(showResult, 200);
        }
      }
      NET.lastOk = Date.now();
      setNet('', '已同步');
      renderAll();
      syncNow();
    }).catch(function (err) {
      if (!S || S.mode !== 'online' || S.code !== myCode) return;
      // 回滚这一步，避免自己的棋盘和服务器越走越远
      S.moveBusy = false;
      S.moves.pop();
      S.texts.pop();
      S.state = prev;
      renderAll();
      toast((err && err.message) || '这一步没发出去，已还原');
      syncNow();
    });
  }

  function timeoutLocal() {
    if (!S || S.mode !== 'local' || S.state.status !== 'play') return;
    var loser = S.clock[1] <= 0 ? 1 : 2;
    S.state = E.clone(S.state);
    S.state.status = 'over';
    S.state.winner = 3 - loser;
    S.state.reason = 'timeout';
    S.clockRunning = 0;
    saveLocal();
    renderAll();
    showResult();
  }

  /* ============================================================
     七、点击棋盘
     ============================================================ */
  function onBoardClick(ev) {
    if (!S || !renderer || !renderer.g) return;
    var rect = renderer.cv.getBoundingClientRect();
    var px = (ev.clientX - rect.left) * (renderer.w / rect.width);
    var py = (ev.clientY - rect.top) * (renderer.h / rect.height);
    var idx = renderer.g.hit(px, py);
    if (idx < 0) return;
    if (!myTurn()) {
      if (S.mode === 'local') return;
      toast(S.seat === 0 ? '观战中，不能走子' : (S.room && S.room.status === 'wait' ? '还在等对手' : '还没轮到你'));
      return;
    }
    var st = S.state;
    if (st.game === 'go' || st.game === 'gomoku') return tapStone(st, idx);
    if (st.game === 'draughts') return tapDraughts(st, idx);
    return tapPiece(st, idx);
  }

  function tapStone(st, idx) {
    if (st.board[idx] !== 0) return;
    var mv = { t: idx };
    if (!E.legal(st, mv)) {
      if (st.game === 'go' && idx === st.ko) toast('打劫：不能马上提回，先在别处下一手');
      else toast('这里不能下');
      return;
    }
    commit(mv);
  }

  function tapPiece(st, idx) {
    var piece = st.board[idx];
    var side = piece ? (piece < 8 ? 1 : 2) : 0;
    if (side && side === st.turn) {
      S.sel = idx;
      S.targets = E.moves(st).filter(function (m) { return m.f === idx; });
      draw();
      return;
    }
    if (S.sel == null) return;
    var found = null;
    for (var i = 0; i < S.targets.length; i++) {
      if (S.targets[i].t === idx) { found = S.targets[i]; break; }
    }
    if (!found) {
      S.sel = null; S.targets = []; draw();
      return;
    }
    if (st.game === 'chess' && isPromo(st, found)) {
      askPromo(found);
      return;
    }
    commit(found);
  }

  function isPromo(st, mv) {
    var p = st.board[mv.f];
    if (!p || (p !== 1 && p !== 9)) return false;
    var y = Math.floor(mv.t / 8);
    return (p === 1 && y === 0) || (p === 9 && y === 7);
  }

  var promoMove = null;
  function askPromo(mv) {
    promoMove = mv;
    show('bd-promo', true);
  }
  function closePromo() {
    promoMove = null;
    show('bd-promo', false);
  }

  function tapDraughts(st, idx) {
    if (!S.drMoves) {
      // 第一次点：必须是自己的子
      var p = st.board[idx];
      if (!p || (p < 8 ? 1 : 2) !== st.turn) return;
      var all = E.moves(st);
      var from = all.filter(function (m) { return m.p[0] === idx; });
      if (!from.length) { toast('这个子现在不能动'); return; }
      S.sel = idx;
      S.drMoves = all;
      S.drPath = [idx];
      S.targets = nextSteps(all, [idx]);
      draw();
      return;
    }
    var path = S.drPath || [S.sel];
    var next = path.concat([idx]);
    var candidates = S.drMoves.filter(function (m) {
      if (m.p.length < next.length) return false;
      for (var i = 0; i < next.length; i++) if (m.p[i] !== next[i]) return false;
      return true;
    });
    if (!candidates.length) {
      // 点回起点 / 别的子：重选
      if (idx === path[0]) { S.sel = null; S.drPath = null; S.drMoves = null; S.targets = []; draw(); return; }
      var p2 = st.board[idx];
      if (p2 && (p2 < 8 ? 1 : 2) === st.turn) {
        S.sel = null; S.drPath = null; S.drMoves = null; S.targets = [];
        tapDraughts(st, idx);
      }
      return;
    }
    var ended = candidates.filter(function (m) { return m.p.length === next.length; });
    var longer = candidates.some(function (m) { return m.p.length > next.length; });
    if (ended.length && !longer) {
      commit(ended[0]);
      return;
    }
    S.drPath = next;
    S.targets = nextSteps(candidates, next);
    draw();
  }

  function nextSteps(moves, prefix) {
    var seen = {};
    var out = [];
    for (var i = 0; i < moves.length; i++) {
      var m = moves[i];
      if (m.p.length <= prefix.length) continue;
      var ok = true;
      for (var j = 0; j < prefix.length; j++) if (m.p[j] !== prefix[j]) { ok = false; break; }
      if (!ok) continue;
      var nx = m.p[prefix.length];
      if (!seen[nx]) { seen[nx] = 1; out.push(nx); }
    }
    return out;
  }

  /* ============================================================
     八、渲染
     ============================================================ */
  function gameInfo() {
    if (!S) return null;
    return GAMES[S.mode === 'online' ? S.room.game : S.game];
  }

  function colorName(c) {
    var info = gameInfo();
    return info ? info.colors[c - 1] : (c === 1 ? '先手' : '后手');
  }

  function nameForColor(c) {
    if (!S) return '';
    if (isOfflineLocal()) return S.playerNames ? S.playerNames[c - 1] : (c === 1 ? '玩家一' : '玩家二');
    var r = S.room;
    if (!r) return '';
    if (r.host_color === c) return r.host_name || '房主';
    if (r.guest_color === c) return r.guest_name || '等待对手';
    return colorName(c);
  }

  function renderAll() {
    if (!S) return;
    if (!S.state) {
      txt('bd-gname', '棋类对弈');
      txt('bd-gmeta', '房间 ' + S.code + ' · 连接中…');
      return;
    }
    renderMeta();
    renderPlayers();
    renderActions();
    renderOffer();
    renderUndoBox();
    renderMoves();
    renderChat();
    renderStatus();
    renderOverlays();
    if (S.state.game === 'go') renderScorePanel();
    else { var sp = $('bd-scorepanel'); if (sp) sp.hidden = true; }
    draw();
  }

  function renderMeta() {
    var info = gameInfo();
    txt('bd-gname', info ? info.name : '对局');
    var bits = [];
    if (S.mode === 'online') {
      bits.push('房间 ' + S.code);
      if (isLocalRoom()) bits.push('本机双人 · 房主操作两边');
      else bits.push(S.seat > 0 ? '你执' + colorName(S.seat) : '观战');
    } else {
      bits.push('本机双人 · 不上传');
    }
    bits.push(S.timed ? '每方 ' + S.minutes + ' 分钟' : '不限时');
    if (S.room && S.room.status === 'wait') bits.push('等待对手');
    txt('bd-gmeta', bits.join(' · '));
    show('bd-net', S.mode === 'online');
    show('bd-invite', S.mode === 'online' && S.room && S.seat > 0 &&
      (S.room.status === 'wait' || isLocalRoom()));
  }

  function renderPlayers() {
    var st = S.state;
    var info = gameInfo();
    if (!st || !info) return;
    var c1 = 1, c2 = 2;

    var tag1 = $('bd-tag1'), tag2 = $('bd-tag2');
    tag1.textContent = colorName(c1);
    tag2.textContent = colorName(c2);
    $('bd-pl1').className = 'bd-player' +
      (st.status === 'play' && st.turn === c1 ? ' is-active' : '') +
      (S.mode === 'online' && !isLocalRoom() && S.seat === c1 ? ' is-me' : '');
    $('bd-pl2').className = 'bd-player' +
      (st.status === 'play' && st.turn === c2 ? ' is-active' : '') +
      (S.mode === 'online' && !isLocalRoom() && S.seat === c2 ? ' is-me' : '');

    txt('bd-name1', nameForColor(c1));
    txt('bd-name2', nameForColor(c2));

    var cap1 = st.caps ? st.caps[c1 - 1] : 0;
    var cap2 = st.caps ? st.caps[c2 - 1] : 0;
    var verb = S.game === 'go' || (S.room && S.room.game === 'go') ? '提' : '吃';
    txt('bd-cap1', cap1 > 0 ? verb + ' ' + cap1 : '');
    txt('bd-cap2', cap2 > 0 ? verb + ' ' + cap2 : '');

    txt('bd-clock1', clockText(c1));
    txt('bd-clock2', clockText(c2));

    var activeClock = st.status === 'play' && S.timed ? st.turn : 0;
    $('bd-clock1').className = 'bd-clock' + (activeClock === 1 ? ' is-active' : '') + (isLow(c1) ? ' is-low' : '');
    $('bd-clock2').className = 'bd-clock' + (activeClock === 2 ? ' is-active' : '') + (isLow(c2) ? ' is-low' : '');

    show('bd-watchers', S.mode === 'online' && S.watchers > 0);
    txt('bd-watchers', S.watchers > 0 ? S.watchers + ' 人观战' : '');
    txt('bd-turn', turnLine());
  }

  function turnLine() {
    if (!S || !S.state) return '';
    if (S.state.status === 'over') return '已结束';
    if (S.room && S.room.status === 'wait') return '等对手';
    if (S.mode === 'local') return colorName(S.state.turn) + '走';
    if (isLocalRoom()) return nameForColor(S.state.turn) + '走';
    if (S.seat === 0) return '观战 · ' + colorName(S.state.turn) + '走';
    return S.state.turn === S.seat ? '轮到你' : '对方思考';
  }

  function clockText(c) {
    if (!S.timed) return '不限时';
    var ms = clockRemain(c);
    if (ms == null) return '—';
    return fmtClock(ms);
  }

  function isLow(c) {
    if (!S.timed || !S.state || S.state.status !== 'play') return false;
    var ms = clockRemain(c);
    return ms != null && ms < 30000 && S.state.turn === c;
  }

  function fmtClock(ms) {
    ms = Math.max(0, ms || 0);
    var total = Math.ceil(ms / 1000);
    var m = Math.floor(total / 60);
    var s = total % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function clockRemain(c) {
    if (!S || !S.timed) return null;
    if (S.mode === 'local') {
      var v = S.clock[c];
      if (S.state.status === 'play' && S.clockStart && S.clockRunning === c) {
        v -= (Date.now() - S.clockStart);
      }
      return Math.max(0, v);
    }
    var r = S.room;
    if (!r) return null;
    var base = c === 1 ? r.clock1 : r.clock2;
    if (base == null) return null;
    if (r.status === 'play' && S.state && S.state.turn === c && r.turn_started) {
      var now = Date.now() + NET.offset;
      base = base - (now - r.turn_started);
    }
    return Math.max(0, base);
  }

  function renderStatus() {
    var n = $('bd-status');
    if (!n) return;
    var st = S.state;
    if (S.room && S.room.status === 'wait') {
      n.innerHTML = '把邀请码 <b>' + B8.esc(S.code) + '</b> 发给同学，他点进来就坐下。';
      return;
    }
    if (st.status === 'over') {
      n.textContent = E.result(st) || '对局结束';
      return;
    }
    var s = '';
    if (isOfflineLocal()) s = E.turnText(st) + ' · 本机双人';
    else if (isLocalRoom()) s = E.turnText(st) + ' · 本机双人（' + nameForColor(1) + ' / ' + nameForColor(2) + '）';
    else if (S.seat === 0) s = '观战中 · ' + E.turnText(st);
    else s = st.turn === S.seat ? '<b>轮到你走</b>' : '对方思考中…';
    if (S.mode === 'online' && NET.lastOk) s += ' · ' + fmtAgo(new Date(NET.lastOk).toISOString()) + '同步';
    n.innerHTML = s;
  }

  function renderActions() {
    var st = S.state;
    var online = S.mode === 'online';
    var localRoom = isLocalRoom();
    var offline = isOfflineLocal();
    var playing = st.status === 'play' && (offline || (S.room && S.room.status === 'play'));
    var isPlayer = !online || S.seat > 0;
    var canOperate = offline || (isLocalRoom() && S.seat > 0) || (isVsRoom() && S.seat > 0);
    show('bd-resign', playing && online && !localRoom && isPlayer);
    show('bd-draw', playing && online && !localRoom && isPlayer);
    show('bd-pass', playing && st.game === 'go' && canOperate);
    show('bd-undo', playing && canOperate);
    show('bd-end', playing && localRoom && S.seat > 0);
    show('bd-restart', playing && (offline || (localRoom && S.seat > 0)));
    show('bd-score', st.game === 'go');
    show('bd-chat', online);
    show('bd-cancel-room', !!(S.isHost && S.room && S.room.status === 'wait'));
    var passBtn = $('bd-pass');
    if (passBtn) passBtn.disabled = !myTurn();
    var drawBtn = $('bd-draw');
    if (drawBtn) drawBtn.disabled = !!(S.offer && !S.offer.mine);
    var undoBtn = $('bd-undo');
    if (undoBtn) {
      if (isVsRoom()) undoBtn.disabled = S.undoBusy || S.moveBusy || !(st.turn !== S.seat) || !!S.undo;
      else undoBtn.disabled = S.undoBusy || S.moveBusy || !playing;
      undoBtn.title = isVsRoom()
        ? '只有刚走完的一方能申请悔棋，要对方同意'
        : '撤回上一手';
    }
  }

  function renderOffer() {
    var box = $('bd-offer');
    if (!box) return;
    if (!S || S.mode !== 'online' || !S.offer || S.seat === 0 || S.state.status !== 'play') {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    box.hidden = false;
    if (S.offer.mine) {
      box.innerHTML = '<b>已向对方求和</b>，等回应。' +
        '<div class="bd-offer-btns"><button type="button" class="bd-mini" data-offer="cancel">撤回</button></div>';
    } else {
      box.innerHTML = '<b>' + B8.esc(S.offer.name || '对方') + '</b> 提出和棋，同意吗？' +
        '<div class="bd-offer-btns">' +
        '<button type="button" class="bd-mini" data-offer="accept">同意和棋</button>' +
        '<button type="button" class="bd-mini" data-offer="decline">拒绝</button>' +
        '</div>';
    }
  }

  function onOfferClick(ev) {
    var btn = ev.target;
    if (!btn || !btn.getAttribute) return;
    var act = btn.getAttribute('data-offer');
    if (!act || !S || S.mode !== 'online') return;
    B8.sb.rpc('b8_board_draw', {
      p_token: token(),
      p_code: S.code,
      p_accept: act === 'accept'
    }).then(function (res) {
      if (res && res.room) {
        S.room = res.room;
        S.state = res.state;
        S.offer = null;
        if (S.room.status === 'over') {
          S.resultShown = true;
          renderAll();
          showResult();
        } else {
          renderAll();
          syncNow();
        }
      }
    }).catch(function (err) {
      toast((err && err.message) || '操作没成功');
      syncNow();
    });
  }

  function stateBeforeLast() {
    if (!S || !S.moves || !S.moves.length) return null;
    try {
      return E.replay(S.game, { size: S.size }, S.moves.slice(0, -1).map(function (m) { return m.move; }));
    } catch (e) {
      return null;
    }
  }

  function trimMovesTo(seq) {
    S.moves = S.moves.filter(function (m) { return m.seq <= seq; });
    S.texts = S.texts.filter(function (t) { return t.seq <= seq; });
  }

  function acceptUndo(prev) {
    if (!S) return;
    B8.sb.rpc('b8_board_undo', {
      p_token: token(), p_code: S.code, p_accept: true, p_state: prev
    }).then(function (res) {
      if (!S || !res || !res.room) return;
      S.room = res.room;
      S.state = res.state;
      S.undo = null;
      S.undoBusy = false;
      S.resultShown = false;
      trimMovesTo(res.seq || 0);
      renderAll();
      toast('已悔一步');
    }).catch(function (err) {
      if (S) S.undoBusy = false;
      toast((err && err.message) || '悔棋没成功');
      syncNow();
    });
  }

  function renderUndoBox() {
    var box = $('bd-undo-box');
    if (!box) return;
    if (!S || S.mode !== 'online' || !S.undo || S.seat === 0 || S.state.status !== 'play') {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    box.hidden = false;
    if (S.undo.mine) {
      box.innerHTML = '<b>已申请悔棋</b>，等对方同意。' +
        '<div class="bd-offer-btns"><button type="button" class="bd-mini" data-undo="cancel">撤回</button></div>';
    } else {
      box.innerHTML = '<b>' + B8.esc(S.undo.name || '对方') + '</b> 想悔一步，同意吗？' +
        '<div class="bd-offer-btns">' +
        '<button type="button" class="bd-mini" data-undo="accept">同意悔棋</button>' +
        '<button type="button" class="bd-mini" data-undo="decline">拒绝</button>' +
        '</div>';
    }
  }

  function declineUndo(act) {
    if (!S) return;
    B8.sb.rpc('b8_board_undo', {
      p_token: token(), p_code: S.code, p_accept: false
    }).then(function (res) {
      if (!S) return;
      if (res && res.room) S.room = res.room;
      if (res && res.state) S.state = res.state;
      S.undo = null;
      S.undoPrompted = null;
      S.undoBusy = false;
      renderAll();
      toast(act === 'cancel' ? '已撤回悔棋申请' : '已拒绝悔棋');
    }).catch(function (err) {
      if (S) S.undoBusy = false;
      toast((err && err.message) || '操作没成功');
      syncNow();
    });
  }

  function onUndoClick(ev) {
    var btn = ev.target;
    if (!btn || !btn.getAttribute) return;
    var act = btn.getAttribute('data-undo');
    if (!act || !S || S.mode !== 'online') return;
    if (act === 'accept') {
      var prev = stateBeforeLast();
      if (!prev) { toast('算不出上一手，刷新一下再试'); return; }
      acceptUndo(prev);
      return;
    }
    declineUndo(act);
  }

  function requestUndo() {
    if (!S || !S.state || S.state.status !== 'play') return;
    if (isOfflineLocal()) return;
    S.undoBusy = true;
    var btn = $('bd-undo');
    if (btn) btn.disabled = true;
    if (isLocalRoom()) {
      var prev = stateBeforeLast();
      if (!prev) {
        S.undoBusy = false;
        toast('还没有可以悔的棋');
        renderActions();
        return;
      }
      B8.confirm('悔棋？撤回上一手，棋盘回到上一步。', { title: '悔棋', okText: '悔一步' })
        .then(function (ok) {
          if (ok) acceptUndo(prev);
          else { S.undoBusy = false; renderActions(); }
        });
      return;
    }
    if (!isVsRoom()) { S.undoBusy = false; renderActions(); return; }
    if (S.undo && S.undo.mine) { S.undoBusy = false; return; }
    B8.sb.rpc('b8_board_undo', { p_token: token(), p_code: S.code, p_accept: false })
      .then(function (res) {
        if (!S) return;
        if (res && res.room) S.room = res.room;
        S.undo = { mine: true, name: (B8.auth && B8.auth.nick && B8.auth.nick()) || '我' };
        S.undoBusy = false;
        renderAll();
        toast('悔棋请求已发给对方');
        syncNow();
      })
      .catch(function (err) {
        S.undoBusy = false;
        toast((err && err.message) || '申请悔棋失败');
        renderActions();
        syncNow();
      });
  }

  function renderMoves() {
    var box = $('bd-moves');
    if (!box) return;
    box.innerHTML = '';
    txt('bd-move-count', String(S.moves.length));
    if (!S.moves.length) {
      var li = document.createElement('li');
      li.className = 'bd-mv-empty';
      li.textContent = '还没走子。' + (isLocalGame() ? '点棋盘开始。' : '');
      box.appendChild(li);
      return;
    }
    var start = Math.max(0, S.moves.length - 200);
    for (var i = start; i < S.moves.length; i++) {
      var m = S.moves[i];
      var t = S.texts[i - start] || null;
      // texts 与 moves 可能因为增量对不齐，按 seq 找
      for (var k = 0; k < S.texts.length; k++) if (S.texts[k].seq === m.seq) { t = S.texts[k]; break; }
      var li2 = document.createElement('li');
      if (i === S.moves.length - 1) li2.className = 'is-new';
      var no = document.createElement('span');
      no.className = 'bd-mv-no';
      no.textContent = (i + 1) + '.';
      var body = document.createElement('span');
      body.className = 'bd-mv-body';
      body.textContent = t ? t.text : '';
      var who = document.createElement('i');
      who.textContent = colorName(m.color);
      body.appendChild(who);
      li2.appendChild(no);
      li2.appendChild(body);
      box.appendChild(li2);
    }
    box.scrollTop = box.scrollHeight;
  }

  function renderOverlays() {
    var wait = S.room && S.room.status === 'wait';
    show('bd-wait', wait);
    if (wait) txt('bd-wait-code', S.code);
    var over = S.state && S.state.status === 'over';
    if (!over) show('bd-result', false);
    else if (S.resultShown) {
      show('bd-result', true);
      var info = resultInfo();
      txt('bd-result-kicker', isLocalGame() ? '本机对局结束' : '对局结束 · ' + S.code);
      txt('bd-result-title', info.title);
      txt('bd-result-sub', info.sub);
    }
  }

  function resultInfo() {
    var st = S.state, r = S.room;
    var winner = st.winner || (r ? r.winner : 0);
    var title, sub = E.result(st) || '';
    if (winner === 3 || winner === 0 && st.status === 'over') {
      title = '和棋';
    } else if (winner === 1 || winner === 2) {
      title = nameForColor(winner) + ' 胜';
    } else {
      title = '对局结束';
    }
    if (isOfflineLocal()) {
      if (winner === 1 || winner === 2) {
        title = (S.playerNames ? S.playerNames[winner - 1] : colorName(winner)) + ' 胜';
      } else {
        title = '和棋';
      }
    }
    if (!sub && r && r.reason === 'resign') sub = '认输';
    if (!sub && r && r.reason === 'timeout') sub = '超时';
    if (r && r.reason === 'agreement') sub = '双方同意和棋';
    return { title: title, sub: sub };
  }

  function showResult() {
    if (!S || !S.state || S.state.status !== 'over') return;
    S.resultShown = true;
    renderOverlays();
    renderActions();
    initChat();
  }

  function renderScorePanel() {
    var n = $('bd-scorepanel');
    if (!n) return;
    if (!S.score) { n.hidden = true; n.innerHTML = ''; return; }
    var sc = S.score;
    n.hidden = false;
    n.innerHTML =
      '<div class="bd-score-line">' +
        '<span><i class="bd-sq is-b"></i>黑 <b>' + fmtNum(sc.black) + '</b></span>' +
        '<span><i class="bd-sq is-w"></i>白 <b>' + fmtNum(sc.white) + '</b></span>' +
        '<span>贴目 <b>7.5</b></span>' +
        '<span>' + (sc.winner === 0 ? '和棋' : (sc.winner === 1 ? '黑胜 ' : '白胜 ') + fmtNum(Math.abs(sc.diff))) + '</span>' +
      '</div>' +
      '<p class="bd-score-note">中国规则数子：黑 ' + sc.stones[0] + ' 子 + ' + sc.terr[0] + ' 空；白 ' +
        sc.stones[1] + ' 子 + ' + sc.terr[1] + ' 空 + 贴 7.5。' +
        (sc.neutral ? ' 单官 / 未定 ' + sc.neutral + ' 点。' : '') +
        ' 死子请先提干净再点目。</p>';
  }

  function fmtNum(n) {
    var r = Math.round(n * 10) / 10;
    return String(r);
  }

  /* ============================================================
     九、Canvas 渲染
     ============================================================ */
  function Renderer(cv) {
    this.cv = cv;
    this.ctx = cv.getContext('2d');
    this.w = 0;
    this.h = 0;
    this.g = null;
    this.st = null;
    this.opts = {};
  }

  Renderer.prototype.measure = function () {
    var wrap = this.cv.parentNode;
    var st = this.st;
    var aspect = st && st.game === 'xiangqi' ? 0.9 : 1;
    var cap = 100000;
    if (window.innerWidth >= 900) {
      cap = Math.max(280, (window.innerHeight - 280) * aspect);
    }
    wrap.style.maxWidth = Math.min(cap, 720) + 'px';
    var cssW = this.cv.clientWidth || (wrap.clientWidth - 16);
    if (!cssW) cssW = 320;
    var cssH = Math.round(cssW / aspect);
    var dpr = window.devicePixelRatio || 1;
    this.w = cssW;
    this.h = cssH;
    this.cv.style.height = cssH + 'px';
    this.cv.width = Math.round(cssW * dpr);
    this.cv.height = Math.round(cssH * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  Renderer.prototype.set = function (st, opts) {
    this.st = st;
    this.opts = opts || {};
  };

  Renderer.prototype.draw = function () {
    if (!this.st) return;
    this.measure();
    var ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    var fn = { xiangqi: drawXiangqi, chess: drawChess, go: drawGo, gomoku: drawGomoku, draughts: drawDraughts }[this.st.game];
    if (fn) fn.call(this, ctx, this.st, this.opts);
  };

  function pal() {
    var night = isNight();
    return night ? {
      night: true,
      wood: '#33291d', woodEdge: '#6b5636', grid: 'rgba(201,168,106,.55)',
      text: '#ece9f2', ink: '#ece9f2', muted: '#a49e8f',
      sqLight: '#3b3742', sqDark: '#26242c',
      sqLight2: '#332f29', sqDark2: '#4a392a',
      pieceFace: '#e9dcc0', pieceInk: '#1d1b18'
    } : {
      night: false,
      wood: '#e9ca8f', woodEdge: '#b98d4f', grid: 'rgba(94,66,30,.62)',
      text: '#23211c', ink: '#23211c', muted: '#7d6a4b',
      sqLight: '#f0d9b5', sqDark: '#b58863',
      sqLight2: '#f2e2c4', sqDark2: '#9a6a45',
      pieceFace: '#f8ecd2', pieceInk: '#23211c'
    };
  }

  function boardBg(ctx, w, h, p) {
    ctx.fillStyle = p.wood;
    ctx.fillRect(0, 0, w, h);
    // 木纹：几条很淡的横线
    ctx.strokeStyle = p.night ? 'rgba(255,255,255,.03)' : 'rgba(120,80,30,.05)';
    ctx.lineWidth = 1;
    for (var y = 18; y < h; y += 26) {
      ctx.beginPath();
      ctx.moveTo(0, y + Math.sin(y) * 2);
      ctx.lineTo(w, y + Math.cos(y) * 2);
      ctx.stroke();
    }
    ctx.strokeStyle = p.woodEdge;
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, w - 2, h - 2);
  }

  function dot(ctx, x, y, r, color) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }

  function ring(ctx, x, y, r, color, width) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth = width || 2;
    ctx.stroke();
  }

  function drawStone(ctx, x, y, r, color, p) {
    var g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.12, x, y, r);
    if (color === 1) {
      g.addColorStop(0, p.night ? '#5a5a66' : '#5c5c62');
      g.addColorStop(0.55, '#23232a');
      g.addColorStop(1, '#07070a');
    } else {
      g.addColorStop(0, '#ffffff');
      g.addColorStop(0.62, '#f4f1e9');
      g.addColorStop(1, p.night ? '#b9b3a5' : '#cfc9ba');
    }
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = color === 1 ? 'rgba(255,255,255,.14)' : 'rgba(60,50,30,.22)';
    ctx.stroke();
  }

  function drawGo(ctx, st, opts) {
    var p = pal();
    var n = st.size;
    var w = this.w, h = this.h;
    boardBg(ctx, w, h, p);
    var pad = Math.max(10, w * 0.055);
    var cell = (w - pad * 2) / (n - 1);
    var ox = pad;
    var oy = (h - cell * (n - 1)) / 2;
    var flip = !!opts.flip;
    function mx(x) { return flip ? n - 1 - x : x; }
    function my(y) { return flip ? n - 1 - y : y; }
    function P(i) { return [ox + mx(i % n) * cell, oy + my(Math.floor(i / n)) * cell]; }

    ctx.strokeStyle = p.grid;
    ctx.lineWidth = Math.max(1, cell * 0.05);
    for (var i = 0; i < n; i++) {
      ctx.beginPath();
      ctx.moveTo(ox, oy + i * cell);
      ctx.lineTo(ox + (n - 1) * cell, oy + i * cell);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(ox + i * cell, oy);
      ctx.lineTo(ox + i * cell, oy + (n - 1) * cell);
      ctx.stroke();
    }
    // 星位
    var stars = n === 19 ? [3, 9, 15] : (n === 13 ? [3, 6, 9] : [2, 4, 6]);
    for (var a = 0; a < stars.length; a++) {
      for (var b = 0; b < stars.length; b++) {
        var sp = P(stars[b] * n + stars[a]);
        dot(ctx, sp[0], sp[1], Math.max(1.6, cell * 0.08), p.night ? 'rgba(201,168,106,.8)' : 'rgba(70,45,18,.8)');
      }
    }

    var scorePts = opts.score && opts.score.points;
    if (scorePts) {
      for (var q = 0; q < n * n; q++) {
        if (!scorePts[q] || st.board[q] !== 0) continue;
        var pt = P(q);
        var side = Math.round(cell * 0.46);
        ctx.fillStyle = scorePts[q] === 1 ? '#141418' : '#fffdf7';
        ctx.fillRect(pt[0] - side / 2, pt[1] - side / 2, side, side);
        ctx.strokeStyle = scorePts[q] === 1 ? 'rgba(255,255,255,.55)' : 'rgba(35,33,28,.65)';
        ctx.lineWidth = 1.4;
        ctx.strokeRect(pt[0] - side / 2, pt[1] - side / 2, side, side);
      }
    }

    var r = cell * 0.47;
    for (var j = 0; j < n * n; j++) {
      if (!st.board[j]) continue;
      var pp = P(j);
      drawStone(ctx, pp[0], pp[1], r, st.board[j], p);
    }

    if (st.last && st.last.t != null) {
      var lp = P(st.last.t);
      ring(ctx, lp[0], lp[1], r * 1.08, 'rgba(193,82,47,.9)', Math.max(2, cell * 0.07));
    }
    if (opts.sel != null) {
      var sp2 = P(opts.sel);
      ring(ctx, sp2[0], sp2[1], r * 1.2, 'rgba(192,140,44,.95)', Math.max(2, cell * 0.08));
    }
    (opts.targets || []).forEach(function (t) {
      var tp = P(t);
      dot(ctx, tp[0], tp[1], Math.max(2.5, cell * 0.13), 'rgba(193,82,47,.72)');
    });

    this.g = {
      hit: function (px, py) {
        var fx = Math.round((px - ox) / cell);
        var fy = Math.round((py - oy) / cell);
        if (fx < 0 || fy < 0 || fx >= n || fy >= n) return -1;
        var cx = ox + fx * cell, cy = oy + fy * cell;
        var d = Math.sqrt((px - cx) * (px - cx) + (py - cy) * (py - cy));
        if (d > cell * 0.62) return -1;
        return my(fy) * n + mx(fx);
      }
    };
    this.point = P;
  }

  function drawGomoku(ctx, st, opts) {
    var p = pal();
    var n = 15, w = this.w, h = this.h;
    boardBg(ctx, w, h, p);
    var pad = Math.max(10, w * 0.06);
    var cell = (w - pad * 2) / (n - 1);
    var ox = pad, oy = (h - cell * (n - 1)) / 2;
    var flip = !!opts.flip;
    function mx(x) { return flip ? n - 1 - x : x; }
    function my(y) { return flip ? n - 1 - y : y; }
    function P(i) { return [ox + mx(i % n) * cell, oy + my(Math.floor(i / n)) * cell]; }
    ctx.strokeStyle = p.grid;
    ctx.lineWidth = Math.max(1, cell * 0.055);
    for (var i = 0; i < n; i++) {
      ctx.beginPath(); ctx.moveTo(ox, oy + i * cell); ctx.lineTo(ox + (n - 1) * cell, oy + i * cell); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(ox + i * cell, oy); ctx.lineTo(ox + i * cell, oy + (n - 1) * cell); ctx.stroke();
    }
    var pts = [[3, 3], [11, 3], [3, 11], [11, 11], [7, 7]];
    pts.forEach(function (s) {
      var sp = P(s[1] * n + s[0]);
      dot(ctx, sp[0], sp[1], Math.max(1.6, cell * 0.1), p.night ? 'rgba(201,168,106,.85)' : 'rgba(70,45,18,.85)');
    });
    var r = cell * 0.45;
    for (var j = 0; j < n * n; j++) {
      if (!st.board[j]) continue;
      var pp = P(j);
      drawStone(ctx, pp[0], pp[1], r, st.board[j], p);
    }
    if (st.last && st.last.t != null) {
      var lp = P(st.last.t);
      dot(ctx, lp[0], lp[1], Math.max(2.2, cell * 0.1), 'rgba(193,82,47,.95)');
    }
    (opts.targets || []).forEach(function (t) {
      var tp = P(t);
      ring(ctx, tp[0], tp[1], r, 'rgba(193,82,47,.7)', 2);
    });
    this.g = {
      hit: function (px, py) {
        var fx = Math.round((px - ox) / cell), fy = Math.round((py - oy) / cell);
        if (fx < 0 || fy < 0 || fx >= n || fy >= n) return -1;
        var cx = ox + fx * cell, cy = oy + fy * cell;
        if (Math.sqrt((px - cx) * (px - cx) + (py - cy) * (py - cy)) > cell * 0.62) return -1;
        return my(fy) * n + mx(fx);
      }
    };
  }

  function drawXiangqi(ctx, st, opts) {
    var p = pal();
    var w = this.w, h = this.h;
    boardBg(ctx, w, h, p);
    var pad = Math.max(12, w * 0.055);
    var cell = Math.min((w - pad * 2) / 8, (h - pad * 2) / 9);
    var bw = cell * 8, bh = cell * 9;
    var ox = (w - bw) / 2, oy = (h - bh) / 2;
    var flip = !!opts.flip;
    function mx(x) { return flip ? 8 - x : x; }
    function my(y) { return flip ? 9 - y : y; }
    function P(i) { return [ox + mx(i % 9) * cell, oy + my(Math.floor(i / 9)) * cell]; }

    // 外框
    ctx.strokeStyle = p.night ? 'rgba(201,168,106,.9)' : 'rgba(80,52,20,.9)';
    ctx.lineWidth = Math.max(1.4, cell * 0.045);
    ctx.strokeRect(ox - cell * 0.16, oy - cell * 0.16, bw + cell * 0.32, bh + cell * 0.32);
    ctx.strokeStyle = p.grid;
    ctx.lineWidth = Math.max(1, cell * 0.035);

    for (var y = 0; y < 10; y++) {
      ctx.beginPath();
      ctx.moveTo(ox, oy + y * cell);
      ctx.lineTo(ox + bw, oy + y * cell);
      ctx.stroke();
    }
    for (var x = 0; x < 9; x++) {
      if (x === 0 || x === 8) {
        ctx.beginPath(); ctx.moveTo(ox + x * cell, oy); ctx.lineTo(ox + x * cell, oy + bh); ctx.stroke();
      } else {
        ctx.beginPath(); ctx.moveTo(ox + x * cell, oy); ctx.lineTo(ox + x * cell, oy + 4 * cell); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(ox + x * cell, oy + 5 * cell); ctx.lineTo(ox + x * cell, oy + bh); ctx.stroke();
      }
    }
    // 九宫
    [[3, 0], [5, 0], [3, 7], [5, 7]].forEach(function (s) {
      var x1 = ox + s[0] * cell, y1 = oy + s[1] * cell;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x1 + 2 * cell, y1 + 2 * cell);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x1 + 2 * cell, y1);
      ctx.lineTo(x1, y1 + 2 * cell);
      ctx.stroke();
    });

    // 楚河汉界
    ctx.fillStyle = p.night ? 'rgba(201,168,106,.7)' : 'rgba(70,45,18,.72)';
    var fs = Math.max(10, cell * 0.34);
    ctx.font = fs + 'px ' + getComputedStyle(document.body).fontFamily;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('楚  河', ox + xx(2.1), oy + 4.5 * cell);
    ctx.fillText('汉  界', ox + xx(5.9), oy + 4.5 * cell);

    var r = cell * 0.42;
    for (var i = 0; i < 90; i++) {
      var pc = st.board[i];
      if (!pc) continue;
      var pp = P(i);
      drawXqPiece(ctx, pp[0], pp[1], r, pc, p, opts.sel === i);
    }
    if (st.last) {
      if (st.last.f != null) {
        var fp = P(st.last.f);
        ring(ctx, fp[0], fp[1], r * 1.14, 'rgba(192,140,44,.55)', 2);
      }
      if (st.last.t != null) {
        var tp = P(st.last.t);
        ring(ctx, tp[0], tp[1], r * 1.08, 'rgba(193,82,47,.9)', Math.max(2, cell * 0.06));
      }
    }
    (opts.targets || []).forEach(function (m) {
      var p2 = P(m.t);
      if (st.board[m.t]) ring(ctx, p2[0], p2[1], r * 1.12, 'rgba(193,82,47,.75)', 2);
      else dot(ctx, p2[0], p2[1], Math.max(2.4, cell * 0.09), 'rgba(193,82,47,.65)');
    });

    this.g = {
      hit: function (px, py) {
        var fx = Math.round((px - ox) / cell), fy = Math.round((py - oy) / cell);
        if (fx < 0 || fy < 0 || fx > 8 || fy > 9) return -1;
        var cx = ox + fx * cell, cy = oy + fy * cell;
        if (Math.sqrt((px - cx) * (px - cx) + (py - cy) * (py - cy)) > cell * 0.62) return -1;
        return my(fy) * 9 + mx(fx);
      }
    };

    function xx(v) { return v * cell; }
  }

  function drawXqPiece(ctx, x, y, r, pc, p, selected) {
    var red = pc < 8;
    var type = red ? pc : pc - 8;
    var names = red ? ['', '帅', '仕', '相', '马', '车', '炮', '兵'] : ['', '将', '士', '象', '马', '车', '炮', '卒'];
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = p.pieceFace;
    ctx.fill();
    ctx.lineWidth = Math.max(1.4, r * 0.09);
    ctx.strokeStyle = red ? '#b3352a' : '#1f1f22';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, r * 0.84, 0, Math.PI * 2);
    ctx.lineWidth = 1;
    ctx.strokeStyle = red ? 'rgba(179,53,42,.45)' : 'rgba(31,31,34,.4)';
    ctx.stroke();
    ctx.fillStyle = red ? '#b3352a' : '#1f1f22';
    ctx.font = '700 ' + (r * 1.02) + 'px "Songti SC", "SimSun", serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(names[type], x, y + r * 0.04);
    if (selected) {
      ring(ctx, x, y, r * 1.12, 'rgba(192,140,44,.95)', Math.max(2, r * 0.12));
    }
  }

  function drawChess(ctx, st, opts) {
    var p = pal();
    var w = this.w, h = this.h;
    var cell = Math.min(w, h) / 8;
    var ox = (w - cell * 8) / 2, oy = (h - cell * 8) / 2;
    var flip = !!opts.flip;
    function mx(x) { return flip ? 7 - x : x; }
    function my(y) { return flip ? 7 - y : y; }
    function sqRect(i) {
      var x = i % 8, y = Math.floor(i / 8);
      return [ox + mx(x) * cell, oy + my(y) * cell];
    }
    ctx.fillStyle = p.night ? '#1a1a20' : '#f6efdf';
    ctx.fillRect(0, 0, w, h);
    for (var i = 0; i < 64; i++) {
      var x = i % 8, y = Math.floor(i / 8);
      var r0 = sqRect(i);
      ctx.fillStyle = ((x + y) % 2 === 0) ? p.sqLight : p.sqDark;
      ctx.fillRect(r0[0], r0[1], cell, cell);
    }
    if (st.last) {
      [st.last.f, st.last.t].forEach(function (sq) {
        if (sq == null) return;
        var r = sqRect(sq);
        ctx.fillStyle = 'rgba(192,140,44,.32)';
        ctx.fillRect(r[0], r[1], cell, cell);
      });
    }
    if (opts.sel != null) {
      var sr = sqRect(opts.sel);
      ctx.fillStyle = 'rgba(193,82,47,.28)';
      ctx.fillRect(sr[0], sr[1], cell, cell);
    }

    var glyph = {
      1: '♟', 2: '♞', 3: '♝', 4: '♜', 5: '♛', 6: '♚',
      9: '♟', 10: '♞', 11: '♝', 12: '♜', 13: '♛', 14: '♚'
    };
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = (cell * 0.76) + 'px "Segoe UI Symbol", "Arial Unicode MS", "DejaVu Sans", serif';
    for (var j = 0; j < 64; j++) {
      var pc = st.board[j];
      if (!pc) continue;
      var rr = sqRect(j);
      var cx = rr[0] + cell / 2, cy = rr[1] + cell / 2;
      var white = pc < 8;
      ctx.lineWidth = Math.max(1, cell * 0.02);
      ctx.fillStyle = white ? '#fffdf7' : (p.night ? '#111116' : '#1d1b18');
      ctx.strokeStyle = white ? (p.night ? '#cfc9ba' : '#2a2620') : (p.night ? '#b9b3a5' : '#000000');
      var g = glyph[pc] || '?';
      ctx.fillText(g, cx, cy + cell * 0.02);
      ctx.strokeText(g, cx, cy + cell * 0.02);
    }

    (opts.targets || []).forEach(function (m) {
      var rr2 = sqRect(m.t);
      var cx2 = rr2[0] + cell / 2, cy2 = rr2[1] + cell / 2;
      if (st.board[m.t]) ring(ctx, cx2, cy2, cell * 0.4, 'rgba(193,82,47,.8)', Math.max(2, cell * 0.035));
      else dot(ctx, cx2, cy2, cell * 0.12, 'rgba(47,111,94,.7)');
    });

    this.g = {
      hit: function (px, py) {
        var fx = Math.floor((px - ox) / cell), fy = Math.floor((py - oy) / cell);
        if (fx < 0 || fy < 0 || fx > 7 || fy > 7) return -1;
        return my(fy) * 8 + mx(fx);
      }
    };
  }

  function drawDraughts(ctx, st, opts) {
    var p = pal();
    var w = this.w, h = this.h;
    var cell = Math.min(w, h) / 10;
    var ox = (w - cell * 10) / 2, oy = (h - cell * 10) / 2;
    var flip = !!opts.flip;
    function mx(x) { return flip ? 9 - x : x; }
    function my(y) { return flip ? 9 - y : y; }
    function cRect(i) {
      var x = i % 10, y = Math.floor(i / 10);
      return [ox + mx(x) * cell, oy + my(y) * cell];
    }
    ctx.fillStyle = p.night ? '#15151b' : '#f6efdf';
    ctx.fillRect(0, 0, w, h);
    for (var i = 0; i < 100; i++) {
      var x = i % 10, y = Math.floor(i / 10);
      var r0 = cRect(i);
      ctx.fillStyle = ((x + y) % 2 === 1) ? p.sqDark2 : p.sqLight2;
      ctx.fillRect(r0[0], r0[1], cell, cell);
    }
    if (st.last && st.last.pts) {
      st.last.pts.forEach(function (sq) {
        var r = cRect(sq);
        ctx.fillStyle = 'rgba(192,140,44,.3)';
        ctx.fillRect(r[0], r[1], cell, cell);
      });
    }
    for (var j = 0; j < 100; j++) {
      var pc = st.board[j];
      if (!pc) continue;
      var rr = cRect(j);
      drawMan(ctx, rr[0] + cell / 2, rr[1] + cell / 2, cell * 0.36, pc, p, opts.sel === j);
    }
    (opts.targets || []).forEach(function (t) {
      var rr2 = cRect(t);
      var cx = rr2[0] + cell / 2, cy = rr2[1] + cell / 2;
      if (st.board[t]) ring(ctx, cx, cy, cell * 0.4, 'rgba(193,82,47,.8)', 2);
      else dot(ctx, cx, cy, cell * 0.1, 'rgba(47,111,94,.7)');
    });
    this.g = {
      hit: function (px, py) {
        var fx = Math.floor((px - ox) / cell), fy = Math.floor((py - oy) / cell);
        if (fx < 0 || fy < 0 || fx > 9 || fy > 9) return -1;
        return my(fy) * 10 + mx(fx);
      }
    };
  }

  function drawMan(ctx, x, y, r, pc, p, selected) {
    var white = pc < 8;
    var king = (pc === 2 || pc === 10);
    var g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r);
    if (white) {
      g.addColorStop(0, '#fffdf7');
      g.addColorStop(0.6, '#efe4cf');
      g.addColorStop(1, '#c9b99c');
    } else {
      g.addColorStop(0, '#5c5c66');
      g.addColorStop(0.6, '#2a2a31');
      g.addColorStop(1, '#101014');
    }
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.lineWidth = Math.max(1, r * 0.08);
    ctx.strokeStyle = white ? 'rgba(90,70,40,.55)' : 'rgba(0,0,0,.6)';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, r * 0.72, 0, Math.PI * 2);
    ctx.lineWidth = 1;
    ctx.strokeStyle = white ? 'rgba(120,95,60,.35)' : 'rgba(255,255,255,.16)';
    ctx.stroke();
    if (king) {
      ctx.fillStyle = '#c9a23c';
      ctx.font = '700 ' + (r * 1.05) + 'px "Segoe UI Symbol", "Arial Unicode MS", serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('♛', x, y + r * 0.05);
    }
    if (selected) ring(ctx, x, y, r * 1.15, 'rgba(192,140,44,.95)', Math.max(2, r * 0.14));
  }

  function draw() {
    if (!S || !S.state || !renderer) return;
    if (!S.state.board) return;
    renderer.set(S.state, {
      sel: S.sel,
      targets: S.targets,
      flip: S.flip,
      score: S.score
    });
    renderer.draw();
  }

  /* ============================================================
     十、计时
     ============================================================ */
  function tick() {
    if (!S) return;
    if (S.timed && S.state && S.state.status === 'play') {
      if (S.mode === 'local') {
        if (S.clockStart && S.clockRunning && clockRemain(S.clockRunning) <= 0) {
          timeoutLocal();
          return;
        }
      } else if (S.room && S.room.status === 'play' && S.seat > 0) {
        var rem = clockRemain(S.state.turn);
        if (rem != null && rem <= 0) {
          if (!NET.timeoutAt || Date.now() - NET.timeoutAt > 2500) {
            NET.timeoutAt = Date.now();
            syncNow();
          }
        }
      }
    }
    if (S.state) {
      txt('bd-clock1', clockText(1));
      txt('bd-clock2', clockText(2));
      $('bd-clock1').className = 'bd-clock' + (S.state.status === 'play' && S.timed && S.state.turn === 1 ? ' is-active' : '') + (isLow(1) ? ' is-low' : '');
      $('bd-clock2').className = 'bd-clock' + (S.state.status === 'play' && S.timed && S.state.turn === 2 ? ' is-active' : '') + (isLow(2) ? ' is-low' : '');
    }
    // 看门狗：在线对局 15 秒没成功同步就强制拉一次
    if (S.mode === 'online' && !document.hidden && S.room && S.room.status !== 'over') {
      if (NET.inflight && Date.now() - NET.started > 15000) {
        NET.inflight = false;
        NET.fails = 3;
      }
      if (!NET.inflight && Date.now() - (NET.lastOk || 0) > 15000) {
        syncNow();
      }
    }
  }

  /* ============================================================
     十一、评论
     ============================================================ */
  function chatVisible() {
    if (!S || S.mode !== 'online') return false;
    if (!S.room) return false;
    return S.seat === 0 || S.room.status === 'over';
  }

  function initChat() {
    if (!S || S.mode !== 'online') {
      show('bd-chat', false);
      return;
    }
    show('bd-chat', true);
    var vis = chatVisible();
    show('bd-chat-locked', !vis);
    show('bd-chat-list', vis);
    show('bd-chat-form', vis);
    if (!vis) {
      CHAT.items = [];
      CHAT.lastId = 0;
      stopChat();
      return;
    }
    refreshChat(true);
  }

  function stopChat() {
    clearTimeout(CHAT.timer);
    CHAT.timer = 0;
    CHAT.inflight = false;
  }

  function scheduleChat() {
    clearTimeout(CHAT.timer);
    CHAT.timer = setTimeout(function () {
      if (S && chatVisible()) refreshChat(false);
    }, 2600);
  }

  function refreshChat(reset) {
    if (!S || !chatVisible() || CHAT.inflight) return;
    CHAT.inflight = true;
    var myCode = S.code;
    if (reset) { CHAT.items = []; CHAT.lastId = 0; }
    B8.sb.rpc('b8_board_comments', {
      p_token: logged() ? token() : null,
      p_code: S.code,
      p_since: CHAT.lastId
    }).then(function (res) {
      if (!S || S.code !== myCode) return;
      CHAT.inflight = false;
      if (!chatVisible()) return;
      if (res.hidden) {
        show('bd-chat-locked', true);
        show('bd-chat-list', false);
        show('bd-chat-form', false);
        return;
      }
      show('bd-chat-locked', false);
      show('bd-chat-list', true);
      show('bd-chat-form', true);
      (res.comments || []).forEach(function (c) {
        if (CHAT.lastId && c.id <= CHAT.lastId) return;
        CHAT.items.push(c);
        if (c.id > CHAT.lastId) CHAT.lastId = c.id;
      });
      renderChatList();
      scheduleChat();
    }).catch(function (err) {
      if (!S || S.code !== myCode) return;
      CHAT.inflight = false;
      if (dbMissing(err)) return;
      scheduleChat();
    });
  }

  function renderChatList() {
    var box = $('bd-chat-list');
    if (!box) return;
    var nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    box.innerHTML = '';
    if (!CHAT.items.length) {
      var p = document.createElement('p');
      p.className = 'bd-chat-empty';
      p.textContent = '还没有评论。说两句，棋手看不见。';
      box.appendChild(p);
    } else {
      CHAT.items.forEach(function (c) {
        var div = document.createElement('div');
        div.className = 'bd-cmt';
        var head = document.createElement('div');
        head.className = 'bd-cmt-head' + (logged() && c.nick === B8.auth.nick() ? ' is-me' : '');
        var b = document.createElement('b');
        b.textContent = c.nick || '同学';
        var t = document.createElement('span');
        t.textContent = c.at ? fmtAgo(new Date(c.at).toISOString()) : '';
        head.appendChild(b);
        head.appendChild(t);
        var body = document.createElement('div');
        body.className = 'bd-cmt-body';
        body.textContent = c.body;
        div.appendChild(head);
        div.appendChild(body);
        box.appendChild(div);
      });
    }
    txt('bd-chat-count', String(CHAT.items.length));
    if (nearBottom) box.scrollTop = box.scrollHeight;
  }

  function renderChat() {
    if (!S) return;
    if (S.mode !== 'online') {
      show('bd-chat', false);
      return;
    }
    show('bd-chat', true);
    var vis = chatVisible();
    show('bd-chat-locked', !vis);
    show('bd-chat-list', vis);
    show('bd-chat-form', vis);
    var input = $('bd-chat-input');
    if (input) input.placeholder = logged() ? '说两句…（80 字以内）' : '登录后可以评论';
    if (vis) {
      renderChatList();
      if (!CHAT.timer && !CHAT.inflight) refreshChat(false);
    }
  }

  function sendChat(ev) {
    if (ev) ev.preventDefault();
    if (!S || S.mode !== 'online') return;
    if (!logged()) { requireLogin(function () {}); return; }
    var input = $('bd-chat-input');
    var body = (input.value || '').trim();
    if (!body) return;
    input.disabled = true;
    B8.sb.rpc('b8_board_comment_add', {
      p_token: token(), p_code: S.code, p_body: body
    }).then(function (res) {
      input.value = '';
      input.disabled = false;
      if (res && res.comment) {
        if (res.comment.id > CHAT.lastId) CHAT.lastId = res.comment.id;
        CHAT.items.push(res.comment);
        renderChatList();
      }
    }).catch(function (err) {
      input.disabled = false;
      toast((err && err.message) || '评论没发出去');
    });
  }

  /* ============================================================
     十二、按钮
     ============================================================ */
  function bind() {
    // 「← 游乐场」是普通链接，直接回首页；「← 离开」才回大厅
    $('bd-back-lobby').addEventListener('click', backToLobby);
    $('bd-exit').addEventListener('click', backToLobby);
    $('bd-refresh').addEventListener('click', function () { loadLists(true); toast('已刷新'); });
    $('bd-local').addEventListener('click', openLocalSetup);
    $('bd-create').addEventListener('click', function () {
      createRoom({ game: LOBBY.game, size: LOBBY.size, minutes: LOBBY.minutes, color: LOBBY.color });
    });
    $('bd-join-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var v = ($('bd-code').value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      $('bd-code').value = v;
      if (v.length !== 6) { txt('bd-join-note', '邀请码是 6 位'); return; }
      txt('bd-join-note', '');
      openRoom(v, { watch: false });
    });
    $('bd-code').addEventListener('input', function () {
      this.value = this.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    });

    $('bd-canvas').addEventListener('click', onBoardClick);

    var modeChips = document.querySelectorAll('.bd-setup-modes .chip');
    for (var mc = 0; mc < modeChips.length; mc++) {
      modeChips[mc].addEventListener('click', function () {
        setSetupMode(Number(this.getAttribute('data-p')), this.getAttribute('data-mode'));
      });
    }
    [1, 2].forEach(function (p) {
      var input = $('bd-name' + p);
      if (!input) return;
      input.addEventListener('input', function () {
        var mode = p === 1 ? LS.mode1 : LS.mode2;
        if (mode === 'no') {
          this.value = this.value.replace(/[^0-9]/g, '').slice(0, 8);
        }
        if (p === 1) LS.resolved1 = ''; else LS.resolved2 = '';
        var hint = $('bd-hint' + p);
        if (hint) { hint.textContent = ''; hint.className = 'bd-setup-hint'; }
        clearTimeout(p === 1 ? LS.timer1 : LS.timer2);
        var t = setTimeout(function () { lookupPlayer(p); }, 260);
        if (p === 1) LS.timer1 = t; else LS.timer2 = t;
      });
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); submitLocalSetup(); }
      });
    });
    $('bd-setup-cancel').addEventListener('click', closeLocalSetup);
    $('bd-setup-start').addEventListener('click', submitLocalSetup);
    $('bd-undo-box').addEventListener('click', onUndoClick);
    $('bd-view-board').addEventListener('click', function () {
      if (!S) return;
      S.resultShown = false;
      show('bd-result', false);
      renderActions();
    });

    $('bd-flip').addEventListener('click', function () {
      if (!S) return;
      S.flip = !S.flip;
      draw();
    });

    $('bd-score').addEventListener('click', function () {
      if (!S || S.game !== 'go') return;
      if (S.score) {
        S.score = null;
        renderScorePanel();
        draw();
        return;
      }
      S.score = E.scoreGo(S.state);
      renderScorePanel();
      draw();
      toast('点目：黑 ' + fmtNum(S.score.black) + '，白 ' + fmtNum(S.score.white));
    });

    $('bd-pass').addEventListener('click', function () {
      if (!S || S.state.game !== 'go') return;
      if (!myTurn()) { toast('还没轮到你'); return; }
      B8.confirm('停一手？\n\n双方连续停一手就按中国规则数子终局。', { title: '停一手', okText: '停一手' })
        .then(function (ok) { if (ok) commit({ pass: true }); });
    });

    $('bd-undo').addEventListener('click', function () {
      if (!S || S.state.status !== 'play') return;
      if (isOfflineLocal()) {
        if (!S.stack.length) { toast('还没有可以悔的棋'); return; }
        S.state = S.stack.pop();
        S.moves.pop();
        S.texts.pop();
        S.clockRunning = S.state.status === 'play' ? S.state.turn : 0;
        S.clockStart = S.timed ? Date.now() : 0;
        S.score = null;
        S.sel = null; S.targets = []; S.drPath = null; S.drMoves = null;
        S.resultShown = false;
        saveLocal();
        renderAll();
        toast('悔了一步');
        return;
      }
      requestUndo();
    });

    $('bd-restart').addEventListener('click', function () {
      if (!S) return;
      var localRoom = isLocalRoom();
      if (!isOfflineLocal() && !localRoom) return;
      B8.confirm(localRoom ? '重开一局？现在这盘会记成和棋，然后开一盘新的。' : '重开一局？现在这盘会被清掉。',
        { title: '重开', danger: true, okText: '重开' }).then(function (ok) {
        if (!ok) return;
        if (localRoom) {
          var names = [S.room.host_name, S.room.guest_name];
          var settings = { game: S.room.game, size: S.room.size, minutes: S.room.timed ? S.room.minutes : 0 };
          B8.sb.rpc('b8_board_end_local', { p_token: token(), p_code: S.code, p_winner: 3 })
            .then(function () {
              createLocalRoom(names[0], names[1], settings);
            })
            .catch(function (err) { toast((err && err.message) || '重开失败'); });
          return;
        }
        var g = S.game, size = S.size, minutes = S.minutes;
        var nm = S.playerNames || ['玩家一', '玩家二'];
        writeJSON(LOCAL_KEY, null);
        startOfflineLocal(nm[0], nm[1], { game: g, size: size, minutes: minutes });
      });
    });

    $('bd-end').addEventListener('click', function () {
      if (!S || !isLocalRoom() || S.state.status !== 'play') return;
      B8.confirm('结束这盘本机对局？会按和棋记进历史。', { title: '结束对局', danger: true, okText: '结束' })
        .then(function (ok) {
          if (!ok) return;
          B8.sb.rpc('b8_board_end_local', { p_token: token(), p_code: S.code, p_winner: 3 })
            .then(function (res) {
              if (!res || !res.room) return;
              S.room = res.room;
              S.state = res.state;
              S.resultShown = true;
              renderAll();
              showResult();
            })
            .catch(function (err) { toast((err && err.message) || '结束失败'); });
        });
    });

    $('bd-resign').addEventListener('click', function () {
      if (!S) return;
      B8.confirm('确定认输？这盘就结束了。', { title: '认输', danger: true, okText: '认输' })
        .then(function (ok) {
          if (!ok) return;
          if (S.mode === 'local') {
            S.state = E.clone(S.state);
            S.state.status = 'over';
            S.state.winner = 3 - S.state.turn;
            S.state.reason = 'resign';
            S.clockRunning = 0;
            saveLocal();
            renderAll();
            showResult();
            return;
          }
          B8.sb.rpc('b8_board_resign', { p_token: token(), p_code: S.code })
            .then(function (res) {
              S.room = res.room; S.state = res.state;
              S.resultShown = true;
              renderAll();
              showResult();
            })
            .catch(function (err) { toast((err && err.message) || '认输没成功'); });
        });
    });

    $('bd-draw').addEventListener('click', function () {
      if (!S || S.mode !== 'online') return;
      var mine = S.offer && S.offer.mine;
      if (mine) {
        B8.sb.rpc('b8_board_draw', { p_token: token(), p_code: S.code, p_accept: false })
          .then(syncNow).catch(function (err) { toast((err && err.message) || '撤回失败'); });
        return;
      }
      B8.sb.rpc('b8_board_draw', { p_token: token(), p_code: S.code, p_accept: false })
        .then(function () { toast('求和请求已发出'); syncNow(); })
        .catch(function (err) { toast((err && err.message) || '求和失败'); });
    });

    $('bd-copy-code').addEventListener('click', function () { B8.copy(S.code); });
    $('bd-copy-link').addEventListener('click', function () {
      B8.copy(location.origin + location.pathname + '?code=' + S.code);
    });
    $('bd-invite').addEventListener('click', function () {
      if (S) B8.copy(location.origin + location.pathname + '?code=' + S.code);
    });
    $('bd-cancel-room').addEventListener('click', function () {
      if (!S || S.mode !== 'online') return;
      B8.confirm('解散房间？ invited 的同学就进不来了。', { title: '解散房间', danger: true, okText: '解散' })
        .then(function (ok) {
          if (!ok) return;
          B8.sb.rpc('b8_board_cancel', { p_token: token(), p_code: S.code })
            .then(function () { clearLast(); backToLobby(); toast('房间已解散'); })
            .catch(function (err) { toast((err && err.message) || '解散失败'); });
        });
    });

    $('bd-again').addEventListener('click', function () {
      if (!S) return;
      if (isOfflineLocal()) {
        var nm = S.playerNames || ['玩家一', '玩家二'];
        startOfflineLocal(nm[0], nm[1], { game: S.game, size: S.size, minutes: S.minutes });
        return;
      }
      var settings = {
        game: S.room.game,
        size: S.room.size,
        minutes: S.room.timed ? S.room.minutes : 0,
        color: S.seat || 1
      };
      if (isLocalRoom()) {
        createLocalRoom(S.room.host_name, S.room.guest_name, settings);
        return;
      }
      backToLobby();
      setTimeout(function () { createRoom(settings); }, 180);
    });

    $('bd-chat-form').addEventListener('submit', sendChat);
    $('bd-offer').addEventListener('click', onOfferClick);

    $('bd-chat-input').addEventListener('focus', function () {
      if (!logged()) {
        this.blur();
        requireLogin(function () {});
      }
    });

    // 升变
    var pbtns = document.querySelectorAll('.bd-promo-btns button');
    for (var i = 0; i < pbtns.length; i++) {
      pbtns[i].addEventListener('click', function () {
        var promo = Number(this.getAttribute('data-promo'));
        var mv = promoMove;
        closePromo();
        if (mv) {
          mv.promo = promo;
          commit(mv);
        }
      });
    }
    $('bd-promo-cancel').addEventListener('click', function () {
      closePromo();
      S.sel = null; S.targets = []; draw();
    });

    // 窗口尺寸变化
    var rz = 0;
    window.addEventListener('resize', function () {
      clearTimeout(rz);
      rz = setTimeout(draw, 120);
    });
    document.addEventListener('b8:theme', function () { setTimeout(draw, 30); });

    // 离开页面前存本机棋
    window.addEventListener('pagehide', saveLocal);

    setInterval(function () {
      if (!S && !document.hidden && Date.now() - lastLobbyLoad > 18000) loadLists(false);
    }, 18000);
  }

  /* ============================================================
     十三、启动
     ============================================================ */
  function boot() {
    buildGames();
    renderOptions();
    renderRooms();
    renderHistory();
    renderer = new Renderer($('bd-canvas'));
    bind();
    updateWho();

    B8.auth.ready(function () {
      updateWho();
      loadLists(true);
    });

    // 邀请码：登录后自动进房
    var code = query('code');
    if (code) {
      pendingOpen = { code: code.toUpperCase(), watch: query('watch') === '1' };
      B8.auth.ready(function () {
        var o = pendingOpen;
        if (!o) return;
        if (o.watch) {
          pendingOpen = null;
          openRoom(o.code, { watch: true });
          return;
        }
        if (logged()) {
          pendingOpen = null;
          openRoom(o.code, { watch: false });
        } else {
          pendingLogin = function () {
            var p = pendingOpen;
            pendingOpen = null;
            if (p) openRoom(p.code, { watch: p.watch });
          };
          showLoginGate();
          toast('登录后自动进入这盘棋');
        }
      });
      return;
    }

    // 上次没下完的网络对局：自动回去
    B8.auth.ready(function () {
      if (!logged() || code) return;
      setTimeout(function () {
        if (S) return;
        var last = readJSON(LAST_KEY);
        if (!last || !last.code || Date.now() - (last.at || 0) > 12 * 3600 * 1000) return;
        B8.sb.rpc('b8_board_sync', { p_token: token(), p_code: last.code, p_since: 0 })
          .then(function (res) {
            if (S || !res || !res.me || !res.me.seat) { clearLast(); return; }
            if (res.room.status === 'over') { clearLast(); return; }
            toast('回到上次没下完的对局');
            enterOnline(last.code, res.room, res.state, res.me.seat);
          })
          .catch(function () { clearLast(); });
      }, 800);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  /* ---------- ?t= 调试口子（正常访问拿不到） ---------- */
  if (window.B8_TEST) {
    B8.board = {
      engine: E,
      get state() { return S; },
      move: function (mv) { commit(mv); },
      sync: function () { syncNow(); },
      refresh: function () { loadLists(true); },
      open: function (code, watch) { openRoom(code, { watch: !!watch }); },
      chat: function (body) {
        var i = $('bd-chat-input');
        if (i) i.value = body;
        sendChat();
      },
      local: function (game, opts, moves) {
        LOBBY.game = game;
        LOBBY.size = (opts && opts.size) || 19;
        LOBBY.minutes = (opts && opts.minutes) || 0;
        startLocal();
        (moves || []).forEach(function (m) { commitLocal(m); });
        return S;
      },
      demo: function (game) {
        var st = E.init(game, { size: 19 });
        var list = E.moves(st);
        var mv = list[0];
        for (var i = 0; i < list.length; i++) {
          if (!list[i].pass) { mv = list[i]; break; }
        }
        LOBBY.game = game;
        LOBBY.minutes = 10;
        startLocal();
        if (mv) commitLocal(mv);
        return S;
      }
    };
  }
})();
