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

  var LOBBY = {
    game: 'xiangqi', size: 19, minutes: 0, color: 1, forbid: false, rematch: null,
    historyFilter: '', historySort: 'time', historyLimit: 100,
    rankGame: 'xiangqi', rankSort: 'wins', rankRows: [],
    rooms: [], dormant: [], mine: [], history: [], historyApi: true, dormantApi: true,
    dbMissing: false, busy: false
  };
  var LS = { mode1: 'no', mode2: 'no', name1: '', name2: '', resolved1: '', resolved2: '', timer1: 0, timer2: 0, busy: false };
  var DEADSTONES = { loading: null };
  var ANALYSIS = {
    on: false, data: [], cur: 0, hover: -1,
    liveKey: '', liveCode: '', liveStates: null,
    practiceKey: '', practiceStates: null,
    baseSig: '', lastSig: ''
  };
  var SPECT = { last: 0, inflight: false };
  var S = null;                 // 当前对局
  var NET = { offset: 0, lastOk: 0, fails: 0, timer: 0, inflight: false, again: false, lastPing: 0, started: 0, paused: false };
  var CHAT = { timer: 0, lastId: 0, inflight: false, items: [], hidden: false, inited: false, sig: null };
  var LOCAL_KEY = 'b8.board.local.v1';
  var LAST_KEY = 'b8.board.last.v1';
  var pendingLogin = null;
  var pendingOpen = null;
  var renderer = null;
  var tickTimer = 0;
  var lastLobbyLoad = 0;
  var animRAF = 0;

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

    // 五子棋禁手
    var gomokuRow = $('bd-gomoku-row'), forbidBtn = $('bd-forbid');
    if (gomokuRow) gomokuRow.hidden = g !== 'gomoku';
    if (forbidBtn) {
      forbidBtn.setAttribute('aria-pressed', LOBBY.forbid ? 'true' : 'false');
      forbidBtn.textContent = LOBBY.forbid ? '黑棋禁手：开' : '黑棋禁手：关';
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

  function isShortCode(code) {
    return /^[0-9]{3}$/.test(String(code == null ? '' : code).toUpperCase());
  }

  // 旧版 6 位房间只能只读回看：不坐下、不参与对局，避免「邀请码是 3 位数字」
  function openLegacy(code, review) {
    openRoom(code, { watch: true, review: review !== false, legacy: true });
  }

  function roomRow(r, opts) {
    opts = opts || {};
    var legacy = !isShortCode(r.code);
    var wrap = document.createElement('div');
    wrap.className = 'bd-room';
    wrap.setAttribute('data-code', r.code);
    var main = document.createElement('div');
    main.className = 'bd-room-main';
    var title = document.createElement('b');
    title.textContent = (r.mode === 'local' ? '本机 · ' : '') + GAMES[r.game].name +
      (r.status === 'wait' ? ' · 等人' : (r.dormant ? ' · 休眠' : ' · 对弈中')) +
      (legacy ? ' · 旧版' : '');
    var sub = document.createElement('span');
    var watchers = r.watchers ? ' · <i>' + r.watchers + ' 人观战</i>' : '';
    sub.innerHTML = B8.esc(roomPlayers(r)) + ' · ' + (r.seq || 0) + ' 手' +
      (r.timed ? ' · ' + r.minutes + ' 分钟' : ' · 不限时') + (r.dormant ? ' · 双方离线，等你回来' : '') + watchers;
    main.appendChild(title);
    main.appendChild(sub);
    wrap.appendChild(main);

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'bd-room-btn' + (r.status === 'play' && !r.dormant ? ' is-live' : '');
    btn.textContent = legacy
      ? (r.status === 'over' ? '看棋谱' : '观战')
      : (opts.dormant
        ? '查看'
        : (opts.mine
          ? (r.status === 'play' ? '继续' : '回到房间')
          : (r.status === 'wait' ? '加入' : '观战')));
    btn.title = legacy ? '旧版 6 位房间 · 只读回看' : (opts.dormant ? '双方离线 · 只读查看' : '');
    btn.addEventListener('click', function () {
      if (legacy) { openLegacy(r.code, r.status === 'over'); return; }
      if (opts.dormant) { openRoom(r.code, { watch: true }); return; }
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

    // 休眠对局：单独一栏，所有人可见（数据库没更新时就是空）
    var dorm = $('bd-dormant');
    dorm.innerHTML = '';
    (LOBBY.dormant || []).forEach(function (r) { dorm.appendChild(roomRow(r, { dormant: true })); });
    if (!dorm.childNodes.length) {
      var dq = document.createElement('p');
      dq.className = 'bd-empty';
      dq.textContent = LOBBY.dormantApi === false
        ? '休眠对局要等数据库更新（重跑 install-all.sql）后才有。'
        : '现在没有休眠中的对局。';
      dorm.appendChild(dq);
    }
    txt('bd-dormant-count', (LOBBY.dormant || []).length ? '（' + LOBBY.dormant.length + ' 盘）' : '');
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

  function renderBoardRank() {
    var box = $('bd-board-rank');
    if (!box) return;
    box.innerHTML = '';
    var rows = (LOBBY.rankRows || []).slice(0, 40);
    if (!rows.length) {
      var p = document.createElement('p');
      p.className = 'bd-muted';
      p.textContent = '还没有这个棋种的下棋记录。';
      box.appendChild(p);
      return;
    }
    rows.forEach(function (r, i) {
      var row = document.createElement('div');
      row.className = 'bd-board-rank-row';
      var left = document.createElement('b');
      left.textContent = (i + 1) + '. ' + (r.name || r.no || '棋手');
      var right = document.createElement('span');
      right.innerHTML = r.wins + ' 胜 · ' + r.losses + ' 负' +
        (r.draws ? ' · ' + r.draws + ' 和' : '') +
        ' · ' + r.games + ' 场 · 胜率 ' + Number(r.rate || 0).toFixed(1) + '%';
      row.appendChild(left);
      row.appendChild(right);
      box.appendChild(row);
    });
  }

  function loadBoardRank() {
    if (!B8.sb || !B8.sb.ready) return;
    B8.sb.rpc('b8_board_leaderboard', {
      p_game: LOBBY.rankGame || 'xiangqi',
      p_sort: LOBBY.rankSort || 'wins'
    }).then(function (res) {
      LOBBY.rankRows = (res && res.rows) || [];
      renderBoardRank();
    }).catch(function (err) {
      LOBBY.rankRows = [];
      renderBoardRank();
      var box = $('bd-board-rank');
      if (box && /does not exist|Could not find the function|schema cache/i.test((err && err.message) || '')) {
        box.innerHTML = '<p class="bd-muted">排行榜还没初始化：先跑最新 install-all.sql。</p>';
      }
    });
  }

  function historyTime(r) {
    var t = Date.parse(r.ended_at || r.created_at);
    return isNaN(t) ? 0 : t;
  }

  function historySortList(list) {
    var arr = list.slice();
    var sort = LOBBY.historySort || 'time';
    if (sort === 'likes') {
      arr.sort(function (a, b) {
        return (b.likes || 0) - (a.likes || 0) || historyTime(b) - historyTime(a);
      });
    } else if (sort === 'rating') {
      arr.sort(function (a, b) {
        return (b.rating_avg || 0) - (a.rating_avg || 0) ||
          (b.rating_count || 0) - (a.rating_count || 0) ||
          historyTime(b) - historyTime(a);
      });
    } else {
      arr.sort(function (a, b) { return historyTime(b) - historyTime(a); });
    }
    return arr;
  }

  function historyRowByCode(code) {
    var arr = LOBBY.history || [];
    for (var i = 0; i < arr.length; i++) if (arr[i].code === code) return arr[i];
    return null;
  }

  function redrawHistoryKeepScroll() {
    var box = $('bd-history');
    var top = box ? box.scrollTop : 0;
    renderHistory();
    if (box) box.scrollTop = top;
  }

  function toggleHistoryLike(code) {
    if (!logged()) {
      requireLogin(function () { toggleHistoryLike(code); });
      return;
    }
    B8.sb.rpc('b8_board_like', { p_token: token(), p_code: code })
      .then(function (res) {
        var r = historyRowByCode(code);
        if (r && res) {
          r.likes = res.likes || 0;
          r.mine_like = !!res.liked;
        }
        redrawHistoryKeepScroll();
        toast(res && res.liked ? '已点赞' : '已取消点赞');
      })
      .catch(function (err) { toast((err && err.message) || '点赞失败'); });
  }

  function rateHistory(code, stars) {
    if (!logged()) {
      requireLogin(function () { rateHistory(code, stars); });
      return;
    }
    B8.sb.rpc('b8_board_rate', { p_token: token(), p_code: code, p_stars: stars })
      .then(function (res) {
        var r = historyRowByCode(code);
        if (r && res) {
          r.rating_avg = Number(res.avg) || 0;
          r.rating_count = res.count || 0;
          r.my_stars = stars;
        }
        redrawHistoryKeepScroll();
        toast('已评 ' + stars + ' 星');
      })
      .catch(function (err) { toast((err && err.message) || '评分失败'); });
  }

  function bumpHistoryView(code) {
    if (!B8.sb || !B8.sb.ready) return;
    B8.sb.rpc('b8_board_view', { p_code: code }).then(function (n) {
      var r = historyRowByCode(code);
      if (r) r.views = Number(n) || (r.views || 0) + 1;
    }).catch(function () {});
  }

  function renderHistory() {
    var box = $('bd-history');
    if (!box) return;
    box.innerHTML = '';
    var all = LOBBY.history || [];
    var list = all.filter(function (r) {
      return !LOBBY.historyFilter || r.game === LOBBY.historyFilter;
    });
    list = historySortList(list);

    var hbtns = document.querySelectorAll('#bd-history-filter [data-hg]');
    for (var hi = 0; hi < hbtns.length; hi++) {
      var on = (hbtns[hi].getAttribute('data-hg') || '') === (LOBBY.historyFilter || '');
      hbtns[hi].className = 'chip' + (on ? ' is-on' : '');
      hbtns[hi].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    var sbtns = document.querySelectorAll('#bd-history-sort [data-hs]');
    for (var si = 0; si < sbtns.length; si++) {
      var son = (sbtns[si].getAttribute('data-hs') || 'time') === (LOBBY.historySort || 'time');
      sbtns[si].className = 'chip' + (son ? ' is-on' : '');
      sbtns[si].setAttribute('aria-pressed', son ? 'true' : 'false');
    }

    var meta = $('bd-history-meta');
    if (meta) {
      var label = LOBBY.historyFilter ? (GAMES[LOBBY.historyFilter] ? GAMES[LOBBY.historyFilter].name : LOBBY.historyFilter) : '全部棋类';
      var sortLabel = LOBBY.historySort === 'likes' ? '按点赞' : (LOBBY.historySort === 'rating' ? '按评分' : '按时间');
      meta.textContent = '所有人可见 · ' + label + ' ' + list.length + ' / ' + all.length + ' 局 · ' + sortLabel +
        (LOBBY.historyApi === false ? ' · 数据库待更新' : ' · 最多保留 1000 局');
    }

    if (!list.length) {
      var empty = document.createElement('p');
      empty.className = 'bd-empty';
      empty.textContent = LOBBY.dbMissing
        ? '数据库还没初始化。'
        : (LOBBY.historyApi ? '还没有下完的棋。下完一盘，这里会留下棋谱。'
          : '历史对局要等数据库更新（重跑 install-all.sql）后才有。');
      box.appendChild(empty);
      show('bd-history-more', false);
      return;
    }

    var limit = Math.max(50, LOBBY.historyLimit || 100);
    var shown = list.slice(0, limit);
    shown.forEach(function (r) {
      var info = GAMES[r.game] || { name: r.game, colors: ['先', '后'] };
      var row = document.createElement('div');
      row.className = 'bd-hrow';
      row.setAttribute('data-code', r.code);
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

      // 点赞 / 评分 / 浏览量
      var social = document.createElement('div');
      social.className = 'bd-hsocial';

      var like = document.createElement('button');
      like.type = 'button';
      like.className = 'bd-hlike' + (r.mine_like ? ' is-on' : '');
      like.textContent = '👍 ' + (r.likes || 0);
      like.title = r.mine_like ? '取消点赞' : '点赞';
      like.addEventListener('click', function () { toggleHistoryLike(r.code); });
      social.appendChild(like);

      var stars = document.createElement('span');
      stars.className = 'bd-hstars';
      stars.title = r.my_stars ? '我的评分：' + r.my_stars + ' 星' : '点星星评分';
      var filled = Math.round(r.my_stars || r.rating_avg || 0);
      for (var s = 1; s <= 5; s++) {
        var star = document.createElement('button');
        star.type = 'button';
        star.className = 'bd-star' + (s <= filled ? ' is-on' : '');
        star.textContent = '★';
        star.setAttribute('aria-label', s + ' 星');
        star.addEventListener('click', (function (n) {
          return function () { rateHistory(r.code, n); };
        })(s));
        stars.appendChild(star);
      }
      social.appendChild(stars);

      var rateTxt = document.createElement('span');
      rateTxt.className = 'bd-hstat';
      rateTxt.textContent = (r.rating_count ? Number(r.rating_avg || 0).toFixed(1) + ' 分（' + r.rating_count + ' 人）' : '还没评分');
      social.appendChild(rateTxt);

      var view = document.createElement('span');
      view.className = 'bd-hview';
      view.textContent = '👁 ' + (r.views || 0);
      view.title = '浏览量：点开棋谱的次数';
      social.appendChild(view);

      main.appendChild(social);

      var res = document.createElement('span');
      res.className = 'bd-hrow-result' + (!r.winner || r.winner === 3 ? ' is-draw' : '');
      res.textContent = historyResult(r);

      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'bd-room-btn';
      btn.textContent = '看棋谱';
      btn.title = /^[0-9]{3}$/.test(r.code) ? '只读回看这盘棋' : '旧版 6 位棋谱 · 只读回看';
      btn.addEventListener('click', function () {
        bumpHistoryView(r.code);
        openRoom(r.code, { watch: true, review: true, legacy: !/^[0-9]{3}$/.test(r.code) });
      });

      row.appendChild(main);
      row.appendChild(res);
      row.appendChild(btn);
      if (B8.auth && B8.auth.isSuper && B8.auth.isSuper()) {
        var del = document.createElement('button');
        del.type = 'button';
        del.className = 'bd-room-btn bd-del';
        del.textContent = '删除';
        del.title = '超级管理员：删除这盘记录';
        del.addEventListener('click', (function (code) {
          return function () { deleteHistory(code); };
        })(r.code));
        row.appendChild(del);
      }
      box.appendChild(row);
    });

    show('bd-history-more', list.length > limit);
    var more = $('bd-history-more');
    if (more) more.textContent = '再显示 100 局（还有 ' + (list.length - limit) + ' 局）';
  }

  function deleteHistory(code) {
    B8.confirm('删除这盘棋谱？对局记录、着法、观战评论都会删掉，不能恢复。', {
      title: '删除对局', danger: true, okText: '删除'
    }).then(function (ok) {
      if (!ok) return;
      B8.sb.rpc('b8_board_admin_delete', {
        p_token: (B8.auth && B8.auth.token && B8.auth.token()) || '',
        p_code: code
      }).then(function (res) {
        if (!res || !res.ok) throw new Error('删除没成功');
        toast('已删除 ' + code);
        loadLists(true);
      }).catch(function (err) {
        toast((err && err.message) || '删除没成功');
      });
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
        LOBBY.dormant = res.dormant || [];
        LOBBY.dormantApi = Object.prototype.hasOwnProperty.call(res, 'dormant');
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
          LOBBY.dormant = [];
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
    LOBBY.rematch = null;
    requireLogin(function () {
      if (LOBBY.busy) return;
      LOBBY.busy = true;
      var btn = $('bd-create');
      if (btn) btn.disabled = true;
      var st = E.init(settings.game, { size: settings.size, forbid: settings.forbid });
      B8.sb.rpc('b8_board_create', {
        p_token: token(),
        p_game: settings.game,
        p_state: st,
        p_timed: settings.minutes > 0,
        p_minutes: settings.minutes > 0 ? settings.minutes : 0,
        p_host_color: settings.color
      }).then(function (res) {
        enterOnline(res.room.code, res.room, res.state, res.seat);
        S.isHost = true;
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
    // 输入框只收 3 位；老棋谱（6 位码）只允许只读回看，不能坐下
    if (!isShortCode(code)) {
      if (!opts.legacy && !opts.watch) { toast('邀请码是 3 位数字'); return; }
      opts.legacy = true;
      opts.watch = true;
      if (opts.review == null) opts.review = true;
    }
    if (opts.watch) {
      // 观战不坐下、也不需要登录；登录了还能发评论
      enterOnline(code, null, null, 0, { watch: true, review: !!opts.review });
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

  function inviteRematch() {
    if (!S || S.mode !== 'online' || isLocalRoom()) return;
    if (S.rematchOffered) { toast('已经邀请了，等对方同意'); return; }
    B8.sb.rpc('b8_board_rematch', { p_token: token(), p_code: S.code })
      .then(function () {
        S.rematchOffered = true;
        toast('已邀请对方再来一局，等他点同意');
        showResult();
        renderActions();
      })
      .catch(function (err) {
        toast((err && err.message) || '邀请没发出去');
      });
  }

  function acceptRematch() {
    if (!S || S.seat === 0) return;
    var st = E.init(S.game, { size: S.size, forbid: !!(S.state && S.state.forbid) });
    B8.sb.rpc('b8_board_rematch_accept', {
      p_token: token(), p_code: S.code, p_state: st
    }).then(function (res) {
      if (!res || !res.room) throw new Error('重开没成功');
      var oldSeat = S.seat;
      S.room = res.room;
      S.state = res.state;
      S.seat = oldSeat ? 3 - oldSeat : 0;
      S.flip = S.seat === 2;
      S.moves = [];
      S.texts = [];
      S.stack = [];
      S.score = null;
      S.scoreBusy = false;
      S.undo = null;
      S.offer = null;
      S.reviewing = false;
      S.reviewIndex = 0;
      S.reviewStates = null;
      S.reviewState = null;
      S.resultShown = false;
      S.rematchOffered = false;
      S.rematchPrompted = false;
      S.startedAt = Date.now();
      S.turnStarted = Date.now();
      S.pendingDead = null;
      S.clock = { 1: (S.room.minutes || 0) * 60000, 2: (S.room.minutes || 0) * 60000 };
      S.clockStart = 0;
      S.clockRunning = 0;
      CHAT.items = [];
      CHAT.lastId = 0;
      CHAT.inited = false;
      CHAT.sig = null;
      show('bd-result', false);
      renderAll();
      initChat();
      toast('再来一局！执子已经交换');
      syncNow();
    }).catch(function (err) {
      toast((err && err.message) || '重开没成功');
    });
  }

  function leaveGame() {
    if (!S) { backToLobby(); return; }
    if (S.mode === 'online' && !isLocalRoom() && S.isHost && S.room && S.room.status === 'wait') {
      var code = S.code;
      B8.sb.rpc('b8_board_cancel', { p_token: token(), p_code: code })
        .then(function () {
          clearLast();
          toast('房间已解散');
          backToLobby();
        })
        .catch(function (err) {
          toast((err && err.message) || '解散没成功，房间还留着');
          backToLobby();
        });
      return;
    }
    backToLobby();
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
      forbid: !!(S.state && S.state.forbid),
      minutes: S.minutes,
      names: S.playerNames,
      moves: S.moves.map(function (m) { return m.move; }),
      moveMeta: S.moves.map(function (m) { return { at: m.at, spent: m.spent }; }),
      startedAt: S.startedAt,
      clock: S.timed ? [Math.round(S.clock[1]), Math.round(S.clock[2])] : null,
      savedAt: Date.now(),
      status: S.state.status
    });
  }

  function startOfflineLocal(name1, name2, settings) {
    var g = settings ? settings.game : LOBBY.game;
    var size = settings ? settings.size : LOBBY.size;
    var minutes = settings ? settings.minutes : LOBBY.minutes;
    var st = E.init(g, { size: size, forbid: !!(settings && settings.forbid) });
    S = {
      mode: 'local', game: g, size: st.size,
      minutes: minutes, timed: minutes > 0,
      state: st, moves: [], texts: [], stack: [],
      clock: { 1: minutes * 60000, 2: minutes * 60000 },
      clockStart: 0, clockRunning: 0,
      sel: null, targets: [], drPath: null, drMoves: null,
      score: null, scoreBusy: false, pendingDead: null, flip: false, resultShown: false, moveBusy: false, anim: null,
      reviewing: false, reviewClosed: false, reviewIndex: 0, reviewStates: null, reviewState: null,
      room: null, code: '', playerNames: [name1 || '玩家一', name2 || '玩家二'],
      startedAt: Date.now(), turnStarted: Date.now(),
      practice: false, practicePrefix: null, practiceBase: null, practiceState: null, practiceStack: [], practiceLast: null,
      rematchOffered: false, rematchPrompted: false
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
    var st = E.init(g, { size: size, forbid: !!(settings && settings.forbid) });
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
    var input = $('bd-p' + p + 'name');
    if (!input) return;
    input.value = '';
    applySetupInput(p, mode);
    if (mode === 'no' && !logged()) setSetupHint(p, '查学号要登录；也可以切到「昵称」', true);
    else setSetupHint(p, '', false);
  }

  function digitsOnly(v) {
    var s = String(v == null ? '' : v);
    s = s.replace(/[０-９]/g, function (ch) {
      return String.fromCharCode(ch.charCodeAt(0) - 65248);
    });
    return s.replace(/[^0-9]/g, '').slice(0, 8);
  }

  function classStudentNo(v) {
    var raw = digitsOnly(v);
    if (/^[0-9]{8}$/.test(raw)) return raw;
    if (/^[0-9]{1,2}$/.test(raw)) {
      var n = parseInt(raw, 10);
      if (n >= 1 && n <= 99) return String(20282306 + n);
    }
    // 也允许直接输后四位，如 2307 → 20282307
    if (/^[0-9]{4}$/.test(raw) && raw.slice(0, 2) === '23') return '2028' + raw;
    return '';
  }

  function setSetupHint(p, text, bad) {
    var hint = $('bd-hint' + p);
    if (!hint) return;
    hint.textContent = text || '';
    hint.className = 'bd-setup-hint' + (bad ? ' is-bad' : (text ? ' is-good' : ''));
  }

  function applySetupInput(p, mode) {
    var input = $('bd-p' + p + 'name');
    if (!input) return;
    if (mode === 'no') {
      input.setAttribute('inputmode', 'numeric');
      input.setAttribute('maxlength', '8');
      input.setAttribute('placeholder', p === 1 ? '班学号 1-2 位 / 2307 / 8 位学号' : '班学号 1-2 位 / 2307 / 8 位学号');
    } else {
      input.removeAttribute('inputmode');
      input.setAttribute('maxlength', '12');
      input.setAttribute('placeholder', p === 1 ? '给自己起个昵称（12 字以内）' : '给对手起个昵称（12 字以内）');
    }
  }

  function lookupPlayer(p) {
    var input = $('bd-p' + p + 'name');
    if (!input) return;
    var mode = p === 1 ? LS.mode1 : LS.mode2;
    var raw = digitsOnly(input.value);
    if (input.value !== raw) input.value = raw;
    if (p === 1) LS.resolved1 = ''; else LS.resolved2 = '';
    if (mode !== 'no') return;
    var no = classStudentNo(raw);
    if (!no) {
      setSetupHint(p, raw ? '填班学号（1-2 位）、后四位（2307）或 8 位学号' : '', !!raw);
      return;
    }
    if (!logged()) {
      setSetupHint(p, '查学号要登录；也可以切到「昵称」', true);
      return;
    }
    setSetupHint(p, '查花名册中…', false);
    B8.sb.rpc('b8_member_lookup', { p_token: token(), p_no: no })
      .then(function (res) {
        if ((p === 1 ? LS.mode1 : LS.mode2) !== 'no') return;
        if (classStudentNo(input.value) !== no) return;
        if (res && res.ok && res.name) {
          if (p === 1) LS.resolved1 = res.name; else LS.resolved2 = res.name;
          setSetupHint(p, '✓ ' + res.name + (raw.length < 8 ? '（' + raw + ' 号 → ' + no + '）' : ''), false);
        } else {
          setSetupHint(p, '花名册里没有这个学号，可以切到「昵称」', true);
        }
      })
      .catch(function (err) {
        var msg = (err && err.message) || '';
        setSetupHint(p, /登录|token|jwt|授权/i.test(msg)
          ? '查学号要登录；也可以切到「昵称」'
          : '查学号失败（数据库没连上？），可以切到「昵称」', true);
      });
  }

  function openLocalSetup() {
    var no = (B8.auth && B8.auth.no && B8.auth.no()) || '';
    var nick = (B8.auth && B8.auth.nick && B8.auth.nick()) || '';
    var noRaw = digitsOnly(no);
    var hasNo = logged() && noRaw.length === 8;
    LS.busy = false;
    LS.mode1 = hasNo ? 'no' : 'nick';
    LS.mode2 = hasNo ? 'no' : 'nick';
    LS.resolved1 = '';
    LS.resolved2 = '';
    clearTimeout(LS.timer1);
    clearTimeout(LS.timer2);
    var i1 = $('bd-p1name'), i2 = $('bd-p2name');
    i1.value = hasNo ? noRaw : (nick || '');
    i2.value = '';
    setSetupHint(1, '', false);
    setSetupHint(2, '', false);
    var modes1 = document.querySelectorAll('.bd-setup-modes .chip[data-p="1"]');
    for (var i = 0; i < modes1.length; i++) {
      modes1[i].setAttribute('aria-pressed', modes1[i].getAttribute('data-mode') === LS.mode1 ? 'true' : 'false');
    }
    var modes2 = document.querySelectorAll('.bd-setup-modes .chip[data-p="2"]');
    for (var j = 0; j < modes2.length; j++) {
      modes2[j].setAttribute('aria-pressed', modes2[j].getAttribute('data-mode') === LS.mode2 ? 'true' : 'false');
    }
    applySetupInput(1, LS.mode1);
    applySetupInput(2, LS.mode2);
    txt('bd-setup-sub', hasNo
      ? '这盘也一样公开、可被观战、会进历史。填 8 位学号、班学号（1 号 = 20282307）或后四位（2307）会自动查姓名，也可以直接用昵称。'
      : '没登录（或账号学号不是 8 位）：学号查姓名要先登录；现在可以直接用昵称。');
    var start = $('bd-setup-start');
    if (start) { start.disabled = false; start.textContent = '开始对局'; }
    show('bd-local-setup', true);
    if (hasNo) lookupPlayer(1);
    setTimeout(function () { (hasNo ? i2 : i1).focus(); }, 80);
  }

  function closeLocalSetup() {
    show('bd-local-setup', false);
  }

  function finishLocalSetup() {
    if ($('bd-local-setup').hidden) return false;
    var names = [];
    for (var p = 1; p <= 2; p++) {
      var mode = p === 1 ? LS.mode1 : LS.mode2;
      var input = $('bd-p' + p + 'name');
      var raw = (input.value || '').trim();
      if (mode === 'no') {
        raw = digitsOnly(raw);
        if (input.value !== raw) input.value = raw;
        var no = classStudentNo(raw);
        var resolved = p === 1 ? LS.resolved1 : LS.resolved2;
        if (!resolved) {
          if (!no) setSetupHint(p, '填班学号（1-2 位）、2307 或 8 位学号', true);
          else setSetupHint(p, '这个学号没查到姓名，可以切到「昵称」', true);
          input.focus();
          return false;
        }
        names.push(resolved);
      } else {
        if (!raw || raw.length > 12) {
          setSetupHint(p, raw ? '昵称最多 12 个字' : '请填一个昵称', true);
          input.focus();
          return false;
        }
        names.push(raw);
      }
    }
    closeLocalSetup();
    createLocalRoom(names[0], names[1], {
      game: LOBBY.game, size: LOBBY.size, minutes: LOBBY.minutes, forbid: LOBBY.forbid
    });
    return true;
  }

  function submitLocalSetup() {
    if (LS.busy) return;
    clearTimeout(LS.timer1);
    clearTimeout(LS.timer2);
    var pending = [];
    for (var p = 1; p <= 2; p++) {
      var mode = p === 1 ? LS.mode1 : LS.mode2;
      var input = $('bd-p' + p + 'name');
      var raw = (input.value || '').trim();
      if (mode === 'no') {
        raw = digitsOnly(raw);
        if (input.value !== raw) input.value = raw;
        if (!classStudentNo(raw)) {
          setSetupHint(p, '填班学号（1-2 位）、2307 或 8 位学号', true);
          input.focus();
          return;
        }
        if (!(p === 1 ? LS.resolved1 : LS.resolved2)) pending.push(p);
      } else if (!raw || raw.length > 12) {
        setSetupHint(p, raw ? '昵称最多 12 个字' : '请填一个昵称', true);
        input.focus();
        return;
      }
    }
    if (!pending.length) { finishLocalSetup(); return; }
    if (!logged()) {
      setSetupHint(pending[0], '查学号要登录；也可以切到「昵称」', true);
      $('bd-p' + pending[0] + 'name').focus();
      return;
    }

    LS.busy = true;
    var start = $('bd-setup-start');
    var oldText = start ? start.textContent : '';
    if (start) { start.disabled = true; start.textContent = '查花名册…'; }
    var left = pending.length;
    var bad = false;

    pending.forEach(function (p) {
      var input = $('bd-p' + p + 'name');
      var raw = digitsOnly(input.value);
      var no = classStudentNo(raw);
      setSetupHint(p, '查花名册中…', false);
      B8.sb.rpc('b8_member_lookup', { p_token: token(), p_no: no })
        .then(function (res) {
          if (res && res.ok && res.name) {
            if (p === 1) LS.resolved1 = res.name; else LS.resolved2 = res.name;
            setSetupHint(p, '✓ ' + res.name + (raw.length < 8 ? '（' + raw + ' 号 → ' + no + '）' : ''), false);
          } else {
            bad = true;
            setSetupHint(p, '花名册里没有这个学号，可以切到「昵称」', true);
          }
        })
        .catch(function (err) {
          bad = true;
          var msg = (err && err.message) || '';
          setSetupHint(p, /登录|token|jwt|授权/i.test(msg)
            ? '查学号要登录；也可以切到「昵称」'
            : '查学号失败（数据库没连上？），可以切到「昵称」', true);
        })
        .then(function () {
          if (--left !== 0) return;
          LS.busy = false;
          if (start) { start.disabled = false; start.textContent = oldText || '开始对局'; }
          if (!bad) finishLocalSetup();
        });
    });
  }

  function resumeLocal(saved) {
    var moves = saved.moves || [];
    var st;
    try {
      st = E.replay(saved.game, { size: saved.size, forbid: saved.forbid }, moves);
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
      reviewing: false, reviewClosed: false, reviewIndex: 0, reviewStates: null, reviewState: null,
      room: null, code: '',
      playerNames: saved.names || ['玩家一', '玩家二'],
      startedAt: saved.startedAt || Date.now(), turnStarted: Date.now(),
      practice: false, practicePrefix: null, practiceBase: null, practiceState: null, practiceStack: [], practiceLast: null,
      rematchOffered: false, rematchPrompted: false
    };
    var tmp = E.init(saved.game, { size: saved.size });
    for (var i = 0; i < moves.length; i++) {
      S.texts.push({ seq: tmp.seq + 1, color: tmp.turn, text: E.text(tmp, moves[i]) });
      tmp = E.apply(tmp, moves[i]);
      var meta = saved.moveMeta && saved.moveMeta[i] ? saved.moveMeta[i] : {};
      S.moves.push({ seq: tmp.seq, color: 3 - tmp.turn, move: moves[i], at: meta.at || 0, spent: meta.spent || 0 });
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
    SPECT.last = 0;
    SPECT.inflight = false;
    stopChat();
    clearTimeout(NET.timer);
    CHAT.items = [];
    CHAT.lastId = 0;
    CHAT.hidden = false;
    CHAT.inited = false;
    CHAT.sig = null;
    NET.inflight = false;
    NET.again = false;
    NET.fails = 0;
    NET.lastOk = 0;
    NET.paused = false;
    ANALYSIS.hover = -1;
    ANALYSIS.liveKey = '';
    ANALYSIS.liveStates = null;
    ANALYSIS.practiceKey = '';
    ANALYSIS.practiceStates = null;
    S = {
      mode: 'online', code: code, room: room || null, state: state || null,
      game: room ? room.game : '', size: room ? room.size : 0,
      timed: room ? !!room.timed : false, minutes: room ? room.minutes : 0,
      seat: seat || 0, me: null, watchers: 0, presence: null, offer: null, undo: null, undoPrompted: null, undoBusy: false, anim: null,
      scoreBusy: false, pendingDead: null,
      spectators: [], spectatorError: '',
      reviewing: false, reviewClosed: false, reviewIndex: 0, reviewStates: null, reviewState: null,
      commentsHidden: false, moves: [], texts: [], moveBusy: false,
      sel: null, targets: [], drPath: null, drMoves: null,
      score: null, flip: seat === 2, resultShown: false, watch: !!opts.watch, reviewOnOpen: !!opts.review,
      isHost: false,
      startedAt: room && room.created_at ? Date.parse(room.created_at) || Date.now() : Date.now(),
      turnStarted: room && room.turn_started ? room.turn_started : Date.now(),
      practice: false, practicePrefix: null, practiceBase: null, practiceState: null, practiceStack: [], practiceLast: null,
      rematchOffered: false, rematchPrompted: false
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
    SPECT.last = 0;
    SPECT.inflight = false;
    show('bd-spectators', false);
    stopChat();
    clearTimeout(NET.timer);
    NET.paused = false;
    ANALYSIS.hover = -1;
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

  // 回看 / 演练时不再轮询：把红点收掉，明确显示「已暂停同步」
  function netPause(label) {
    if (!S || S.mode !== 'online') return;
    NET.paused = true;
    clearTimeout(NET.timer);
    setNet('pause', label || '已暂停同步');
  }

  function netResume() {
    if (!S || S.mode !== 'online') return;
    var was = NET.paused;
    NET.paused = false;
    if (was) setNet('', '已同步');
    syncNow();
  }

  function syncNow() {
    if (!S || S.mode !== 'online') return;
    if (NET.paused || S.reviewing || S.practice) { clearTimeout(NET.timer); return; }
    NET.paused = false;
    if (NET.inflight) { NET.again = true; return; }
    if (navigator.onLine === false) {
      setNet('bad', '离线');
      schedulePoll(4000);
      return;
    }
    NET.inflight = true;
    NET.started = Date.now();
    var myCode = S.code;
    // 已经同步过就一直显示「已同步」，不要每 1 秒闪一次「同步中」
    setNet('', S.room && S.room.status === 'wait' ? '等人中' : (NET.lastOk ? '已同步' : '同步中'));
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
      if (/房间不存在|已解散|自动关闭|等人超过/.test(err.message || '')) {
        toast((err && err.message) || '这个房间不存在或已经关闭');
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
    var prevState = S.state;
    S.room = res.room;
    S.me = res.me;
    S.game = res.room.game;
    S.size = res.room.size;
    S.timed = !!res.room.timed;
    S.minutes = res.room.minutes || 0;
    S.isHost = !!(res.me && res.me.host);
    S.watchers = res.watchers || 0;
    S.presence = res.presence || null;
    S.offer = res.offer || null;
    S.undo = res.undo || null;
    S.undoBusy = false;
    if (!S.undo) S.undoPrompted = null;
    if (res.me) { S.seat = res.me.seat || 0; S.flip = S.seat === 2; }
    S.commentsHidden = !!res.comments_hidden;

    var undoBack = !!(res.room && res.room.seq < prevSeq);
    var rematchReset = !!(res.room && res.room.status === 'play' && res.room.seq === 0 && prevSeq > 0);
    if (rematchReset) {
      S.moves = [];
      S.texts = [];
      S.stack = [];
      S.score = null;
      S.scoreBusy = false;
      S.undo = null;
      S.offer = null;
      S.reviewing = false;
      S.reviewIndex = 0;
      S.reviewStates = null;
      S.reviewState = null;
      S.resultShown = false;
      S.rematchOffered = false;
      S.rematchPrompted = false;
      S.startedAt = Date.now();
      S.pendingDead = null;
      S.clock = { 1: (S.room.minutes || 0) * 60000, 2: (S.room.minutes || 0) * 60000 };
      S.clockStart = 0;
      S.clockRunning = 0;
      show('bd-result', false);
    }
    if (res.state && (!S.state || res.state.seq >= S.state.seq || undoBack || res.room.status === 'over')) {
      S.state = res.state;
    }
    if (undoBack) {
      trimMovesTo(res.room.seq);
      S.anim = null;
    }

    var changed = false;
    var added = [];
    var prevAt = S.moves.length ? S.moves[S.moves.length - 1].at : (S.startedAt || 0);
    (res.moves || []).forEach(function (m) {
      var exists = false;
      for (var i = S.moves.length - 1; i >= 0 && i >= S.moves.length - 8; i--) {
        if (S.moves[i].seq === m.seq) { exists = true; break; }
      }
      if (!exists) {
        if (!m.spent && m.at && prevAt) m.spent = Math.max(0, m.at - prevAt);
        prevAt = m.at || prevAt;
        S.moves.push(m);
        added.push(m);
        changed = true;
      }
    });
    if (changed) {
      S.moves.sort(function (a, b) { return a.seq - b.seq; });
      rebuildTexts();
    }
    if (res.room && res.room.turn_started) S.turnStarted = res.room.turn_started;
    if (res.room && !S.startedAt && res.room.created_at) S.startedAt = Date.parse(res.room.created_at) || Date.now();
    if (changed || undoBack) {
      reviewReset();
      S.score = null;
      S.scoreBusy = false;
    }
    if (!undoBack && !document.hidden && added.length === 1 && prevState &&
        S.state && S.state.seq === prevState.seq + 1 &&
        S.state.status === 'play' && !added[0].move.pass) {
      S.anim = buildAnim(prevState, added[0].move, S.state);
    }

    if (res.rematch) {
      if (res.rematch.mine) {
        S.rematchOffered = true;
      } else if (!S.rematchPrompted) {
        S.rematchPrompted = true;
        B8.confirm((res.rematch.name || '对方') + ' 邀请你再来一局，同意吗？', {
          title: '再来一局', okText: '同意'
        }).then(function (ok) {
          if (ok) acceptRematch();
        });
      }
    } else {
      S.rematchOffered = false;
      S.rematchPrompted = false;
    }

    if (S.room.status === 'over' || S.state.status === 'over') {
      clearTimeout(NET.timer);
      if (!S.reviewing && !S.resultShown) {
        S.resultShown = true;
        setTimeout(showResult, 160);
      }
      // 只在「刚结束」这一刻打开评论；之后每 3 秒的同步不要再清空重载
      if (!prevState || prevState.status !== 'over') initChat();
    } else if (S.room.status === 'wait') {
      setNet('wait', '等人中');
    }

    renderAll();
    if (S.reviewing) setNet('pause', '回看中 · 已暂停同步');
    else if (S.practice) setNet('pause', '演练中 · 不上传');
    promptUndoRequest();
    if (S.reviewOnOpen && S.state && S.state.status === 'over' && S.moves.length) {
      S.reviewOnOpen = false;
      reviewGoto(0);
    }

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
    var st = E.init(S.game || (S.room && S.room.game), { size: S.size || (S.room && S.room.size), forbid: !!(S.state && S.state.forbid) });
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
    if (NET.paused || S.reviewing || S.practice) return;
    if (S.room && S.room.status === 'over') {
      NET.timer = setTimeout(syncNow, 3000);
      return;
    }
    if (typeof delay === 'number') {
      NET.timer = setTimeout(syncNow, delay);
      return;
    }
    if (document.hidden) {
      NET.timer = setTimeout(syncNow, 20000);
      return;
    }
    var d;
    if (!S.room || S.room.status === 'wait') d = 2200;
    else if (S.state && S.state.turn === S.seat) d = 2600;
    else d = 1100;
    NET.timer = setTimeout(syncNow, d);
  }

  document.addEventListener('visibilitychange', function () {
    if (!S || S.mode !== 'online' || S.reviewing || S.practice) return;
    if (!document.hidden) syncNow();
  });
  window.addEventListener('focus', function () {
    if (S && S.mode === 'online' && !S.reviewing && !S.practice && !document.hidden) syncNow();
  });
  window.addEventListener('online', function () {
    if (S && S.mode === 'online' && !S.reviewing && !S.practice) { NET.fails = 0; syncNow(); }
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
    if (S && S.scoreBusy) { toast('正在点目，稍等一下'); return; }
    if (!myTurn()) {
      if (S.mode === 'online' && S.seat === 0) toast('观战中，不能走子');
      else if (S.mode === 'online' && S.room && S.room.status === 'wait') toast('还在等对手进来');
      else if (S.mode === 'online') toast('还没轮到你');
      return;
    }
    if (S && S.state && S.state.game === 'chess' && mv && mv.f != null && mv.t != null) {
      var chMoves = E.moves(S.state);
      for (var cm = 0; cm < chMoves.length; cm++) {
        if (chMoves[cm].f === mv.f && chMoves[cm].t === mv.t) {
          if (chMoves[cm].castle) mv.castle = chMoves[cm].castle;
          if (chMoves[cm].promo) mv.promo = chMoves[cm].promo;
          break;
        }
      }
    }
    if (S && S.state && S.state.game === 'go' && mv.pass && (S.state.passes || 0) === 1) {
      // 第二手停一手：终局前自动标死子；如果刚点过目，就用用户改过的标记
      if (S.score && S.score.seq === S.state.seq && S.score.dead) {
        S.pendingDead = S.score.dead.slice();
        commitNow(mv);
        return;
      }
      var seq = S.state.seq;
      S.scoreBusy = true;
      S.score = null;
      renderScorePanel();
      renderActions();
      draw();
      estimateDead(S.state).then(function (dead) {
        if (!S || !S.state || S.state.status !== 'play' || S.state.seq !== seq) {
          if (S) S.scoreBusy = false;
          return;
        }
        S.scoreBusy = false;
        confirmAutoScore(mv, dead, false);
      }).catch(function () {
        if (!S || !S.state || S.state.status !== 'play' || S.state.seq !== seq) {
          if (S) S.scoreBusy = false;
          return;
        }
        S.scoreBusy = false;
        confirmAutoScore(mv, [], true);
      });
      return;
    }
    commitNow(mv);
  }

  function confirmAutoScore(mv, dead, failed) {
    if (!S || S.state.status !== 'play') return;
    S.pendingDead = dead;
    applyGoScore(dead, true);
    if (failed) {
      S.score.autoFailed = true;
      renderScorePanel();
    }
    var sc = S.score;
    B8.confirm(
      (failed ? '自动判断死子不可用，先按没有死子算。\n\n' : '自动标出死子 ' + dead.length + ' 颗。\n\n') +
      '黑 ' + fmtNum(sc.black) + ' : 白 ' + fmtNum(sc.white) + '\n\n' +
      '确认终局？取消可以先点棋盘上的棋子改死子，再点「停一手」。',
      { title: '自动点目', okText: '确认终局', cancelText: '先改死子' }
    ).then(function (ok) {
      if (!S || S.state.status !== 'play') return;
      if (ok) {
        S.pendingDead = (S.score && S.score.dead) ? S.score.dead.slice() : dead.slice();
        commitNow(mv);
      } else {
        S.pendingDead = null;
        toast('点棋子改死子；改完再点「停一手」终局');
      }
    });
  }

  function commitNow(mv) {
    if (isOfflineLocal()) commitLocal(mv);
    else commitOnline(mv);
  }

  function applyPendingDead(ns) {
    if (S && S.pendingDead && ns && ns.status === 'over' && ns.reason === 'score') {
      ns.score = E.scoreGo(ns, S.pendingDead);
      ns.score.dead = S.pendingDead.slice();
      ns.score.auto = true;
      ns.winner = ns.score.winner;
    }
    if (S) S.pendingDead = null;
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
    applyPendingDead(ns);
    var keepScore = !!(mv.pass && ns.status === 'play' && S.score && S.score.seq === prev.seq);
    var now = Date.now();
    var spent = S.turnStarted ? Math.max(0, now - S.turnStarted) : 0;
    S.moves.push({ seq: ns.seq, color: prev.turn, move: mv, at: now, spent: spent });
    S.turnStarted = now;
    S.texts.push({ seq: ns.seq, color: prev.turn, text: text });
    S.state = ns;
    reviewReset();
    animateMove(prev, mv, ns);
    S.sel = null; S.targets = []; S.drPath = null; S.drMoves = null;
    if (keepScore) S.score.seq = ns.seq;
    else { S.score = null; S.scoreBusy = false; }
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
    applyPendingDead(ns);
    var keepScore = !!(mv.pass && ns.status === 'play' && S.score && S.score.seq === prev.seq);
    var now = Date.now();
    var spent = S.turnStarted ? Math.max(0, now - S.turnStarted) : 0;
    S.moves.push({ seq: ns.seq, color: prev.turn, move: mv, at: now, spent: spent });
    S.turnStarted = now;
    S.texts.push({ seq: ns.seq, color: prev.turn, text: text });
    S.state = ns;
    reviewReset();
    animateMove(prev, mv, ns);
    S.sel = null; S.targets = []; S.drPath = null; S.drMoves = null;
    if (keepScore) S.score.seq = ns.seq;
    else { S.score = null; S.scoreBusy = false; }
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
        S.moveBusy = false;
        S.anim = null;
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
      S.anim = null;
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
  function practiceReset() {
    if (!S || !S.practice || !S.practiceBase) return;
    S.practiceState = E.clone(S.practiceBase);
    S.practiceStack = [];
    S.practiceLast = null;
    S.sel = null;
    S.targets = [];
    renderAll();
  }

  function exitPractice() {
    if (!S) return;
    var wasReview = S.reviewing;
    S.practice = false;
    S.practicePrefix = null;
    S.practiceBase = null;
    S.practiceState = null;
    S.practiceStack = [];
    S.practiceLast = null;
    S.sel = null;
    S.targets = [];
    renderAll();
    if (wasReview) netPause('回看中 · 已暂停同步');
    else netResume();
    toast(wasReview ? '已退出演练，回到棋谱回看' : '已退出演练');
  }

  function togglePractice() {
    if (!S || !S.state) return;
    if (S.practice) { exitPractice(); return; }
    var base = (S.reviewing && S.reviewState) ? S.reviewState : S.state;
    if (!base) return;
    var fullStates = analysisStates();
    var prefix = S.reviewing
      ? fullStates.slice(0, Math.min(fullStates.length, (S.reviewIndex || 0) + 1))
      : fullStates.slice();
    clearTimeout(NET.timer);
    S.practice = true;
    S.practicePrefix = prefix;
    S.practiceBase = E.clone(base);
    S.practiceState = E.clone(base);
    S.practiceStack = [];
    S.practiceLast = null;
    S.sel = null;
    S.targets = [];
    S.score = null;
    S.scoreBusy = false;
    show('bd-result', false);
    // 演练是纯本地的分支，不轮询、不上传；顺带把胜率图打开
    netPause('演练中 · 不上传');
    ANALYSIS.on = true;
    renderAll();
    toast('演练模式：随便走，不会上传；「重置演练」回到起点，胜率图会按这条分支重画');
  }

  function practiceApply(mv) {
    if (!S || !S.practice || !S.practiceState) return;
    var prev = S.practiceState;
    S.practiceStack.push(prev);
    S.practiceState = E.apply(E.clone(prev), mv);
    S.practiceLast = mv;
    S.sel = null;
    S.targets = [];
    renderAll();
    if (S.practiceState.status === 'over') {
      toast('演练结束；可以重置或退出演练');
    }
  }

  function practiceClick(idx) {
    if (!S || !S.practiceState) return;
    var st = S.practiceState;
    var legal = E.moves(st);
    var info = E.games[st.game] || E.games[S.game] || {};
    if (info.kind === 'stone') {
      var stone = null;
      for (var i = 0; i < legal.length; i++) if (legal[i].t === idx) { stone = legal[i]; break; }
      if (stone) practiceApply(stone);
      return;
    }
    if (st.board[idx] && (st.board[idx] < 8 ? 1 : 2) === st.turn) {
      S.sel = idx;
      S.targets = [];
      for (var j = 0; j < legal.length; j++) {
        var sf = legal[j].f != null ? legal[j].f : (legal[j].p && legal[j].p[0]);
        var stt = legal[j].t != null ? legal[j].t : (legal[j].p && legal[j].p[legal[j].p.length - 1]);
        if (sf === idx && stt != null) S.targets.push(st.game === 'draughts' ? stt : legal[j]);
      }
      renderAll();
      return;
    }
    if (S.sel != null) {
      var found = null;
      for (var k = 0; k < legal.length; k++) {
        var kf = legal[k].f != null ? legal[k].f : (legal[k].p && legal[k].p[0]);
        var kt = legal[k].t != null ? legal[k].t : (legal[k].p && legal[k].p[legal[k].p.length - 1]);
        if (kf === S.sel && kt === idx) { found = legal[k]; break; }
      }
      if (found) { practiceApply(found); return; }
    }
    S.sel = null;
    S.targets = [];
    renderAll();
  }

  function onBoardClick(ev) {
    if (!S || !renderer || !renderer.g) return;
    if (S.moveBusy) { toast('这一步还在上传，上传完成后才能继续落子'); return; }
    var rect = renderer.cv.getBoundingClientRect();
    var px = (ev.clientX - rect.left) * (renderer.w / rect.width);
    var py = (ev.clientY - rect.top) * (renderer.h / rect.height);
    var idx = renderer.g.hit(px, py);
    if (idx < 0) return;
    if (S.practice) { practiceClick(idx); return; }
    if (S.scoreBusy) { toast('正在点目，稍等一下'); return; }
    if (S.score && S.state.game === 'go' && (S.state.status === 'play' || S.reviewing)) {
      var scoreBoard = scoreState().board;
      if (scoreBoard[idx]) toggleDeadChain(idx);
      else toast('点棋子可以标死子；再点「退出点目」回到对局');
      return;
    }
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
    renderSpectators();
    renderActions();
    renderUploadMask();
    renderOffer();
    renderUndoBox();
    renderMoves();
    renderAnalysis();
    renderChat();
    renderStatus();
    renderOverlays();
    renderReview();
    if (S.state.game === 'go') renderScorePanel();
    else { var sp = $('bd-scorepanel'); if (sp) sp.hidden = true; }
    draw();
    if (S.anim) ensureAnimLoop();
  }

  function isAdminUser() {
    return !!(B8.auth && B8.auth.isAdmin && B8.auth.isAdmin());
  }

  function adminToken() {
    return (B8.auth && B8.auth.token && B8.auth.token()) || token();
  }

  function loadSpectators(force) {
    if (!S || S.mode !== 'online' || !isAdminUser()) return;
    if (SPECT.inflight) return;
    if (!force && Date.now() - SPECT.last < 8000) return;
    SPECT.inflight = true;
    var myCode = S.code;
    B8.sb.rpc('b8_board_watchers_list', { p_token: adminToken(), p_code: myCode })
      .then(function (res) {
        if (!S || S.code !== myCode) return;
        S.spectators = (res && res.watchers) || [];
        S.spectatorError = '';
        SPECT.last = Date.now();
        renderSpectators();
      })
      .catch(function (err) {
        if (!S || S.code !== myCode) return;
        S.spectatorError = (err && err.message) || '读取观战名单失败';
        SPECT.last = Date.now();
        renderSpectators();
      })
      .then(function () { SPECT.inflight = false; });
  }

  function renderSpectators() {
    var on = !!(S && S.mode === 'online' && isAdminUser());
    show('bd-spectators', on);
    if (!on) return;
    var list = S.spectators || [];
    txt('bd-spectator-count', String(list.length));
    var box = $('bd-spectator-list');
    if (!box) return;
    box.innerHTML = '';
    if (!list.length) {
      var li = document.createElement('li');
      li.className = 'bd-sp-empty';
      li.textContent = '现在没有观战';
      box.appendChild(li);
    } else {
      for (var i = 0; i < list.length; i++) {
        var w = list[i];
        var row = document.createElement('li');
        var name = document.createElement('b');
        name.textContent = w.name || w.nick || w.no || '同学';
        var when = document.createElement('span');
        when.textContent = w.last_seen ? fmtAgo(new Date(w.last_seen).toISOString()) : '';
        row.appendChild(name);
        row.appendChild(when);
        box.appendChild(row);
      }
    }
    var note = $('bd-spectator-note');
    if (note) note.textContent = S.spectatorError || '仅管理员可见';
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
    if (S.practice) bits.push('演练模式 · 不上传');
    txt('bd-gmeta', bits.join(' · '));
    show('bd-net', S.mode === 'online');
    show('bd-invite', S.mode === 'online' && S.room && S.seat > 0 &&
      (S.room.status === 'wait' || isLocalRoom()));
    show('bd-admin-close', !!(B8.auth && B8.auth.isSuper && B8.auth.isSuper() &&
      S.mode === 'online' && S.room && (S.room.status === 'play' || S.room.status === 'wait')));
  }

  function presenceOf(c) {
    if (isOfflineLocal()) return { t: '同桌', cls: 'is-same', title: '两个人同一台设备' };
    var p = S.presence;
    if (isLocalRoom()) {
      if (!p) {
        return c === 1
          ? { t: '本机', cls: 'is-same', title: '本机对局' }
          : { t: '同桌', cls: 'is-same', title: '和房主同一台设备' };
      }
      var on = !!p.host;
      if (c === 1) return { t: on ? '在线' : '离线', cls: on ? 'is-on' : 'is-off', title: '本机对局房主' };
      return { t: on ? '同桌' : '离线', cls: on ? 'is-same' : 'is-off', title: '和房主同一台设备' };
    }
    if (c === 2 && S.room && !S.room.guest_name) return { t: '', cls: '', title: '' };
    if (!p) return { t: '', cls: '', title: '' };
    var online = c === 1 ? p.host : p.guest;
    return { t: online ? '在线' : '离线', cls: online ? 'is-on' : 'is-off', title: '90 秒内有同步心跳' };
  }

  function paintPresence(id, c) {
    var el = $(id);
    if (!el) return;
    var p = presenceOf(c);
    el.textContent = p.t;
    el.className = 'bd-presence' + (p.cls ? ' ' + p.cls : '');
    el.title = p.title || '';
    el.hidden = !p.t;
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
    paintPresence('bd-on1', c1);
    paintPresence('bd-on2', c2);

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
    if (S.reviewing) return '回看 ' + S.reviewIndex + '/' + S.moves.length;
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
    if (S.reviewing) {
      n.textContent = S.reviewIndex === 0
        ? '开局 · 共 ' + S.moves.length + ' 手（← → 切换）'
        : '回看第 ' + S.reviewIndex + ' / ' + S.moves.length + ' 手（← → 切换）';
      return;
    }
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

  function renderUploadMask() {
    var busy = !!(S && S.mode === 'online' && S.moveBusy);
    show('bd-uploading', busy);
    var wrap = $('bd-boardwrap');
    if (wrap) {
      if (busy) wrap.classList.add('is-uploading');
      else wrap.classList.remove('is-uploading');
    }
  }

  function renderActions() {
    show('bd-analysis', !!S.state);
    show('bd-practice', !!S.state && !(S.room && S.room.status === 'wait'));
    var practiceBtn = $('bd-practice');
    if (practiceBtn) practiceBtn.textContent = S.practice ? '退出演练' : '演练';
    show('bd-practice-reset', !!S.practice);
    if (S.practice) {
      var hideInPractice = ['bd-resign','bd-draw','bd-pass','bd-undo','bd-end','bd-restart','bd-score','bd-invite','bd-cancel-room','bd-admin-close'];
      for (var hp = 0; hp < hideInPractice.length; hp++) show(hideInPractice[hp], false);
      return;
    }
    var st = S.state;
    var online = S.mode === 'online';
    var localRoom = isLocalRoom();
    var offline = isOfflineLocal();
    var playing = st.status === 'play' && (offline || (S.room && S.room.status === 'play'));
    var isPlayer = !online || S.seat > 0;
    var canOperate = offline || (isLocalRoom() && S.seat > 0) || (isVsRoom() && S.seat > 0);
    show('bd-resign', playing && ((isVsRoom() && S.seat > 0) || (isLocalRoom() && S.seat > 0) || isOfflineLocal()));
    show('bd-draw', playing && online && !localRoom && isPlayer);
    show('bd-pass', playing && st.game === 'go' && canOperate);
    show('bd-undo', playing && canOperate);
    show('bd-end', playing && localRoom && S.seat > 0);
    show('bd-restart', playing && (offline || (localRoom && S.seat > 0)));
    show('bd-score', st.game === 'go' && (st.status === 'play' || S.reviewing));
    show('bd-chat', online);
    show('bd-cancel-room', !!(S.isHost && S.room && S.room.status === 'wait'));
    var passBtn = $('bd-pass');
    if (passBtn) passBtn.disabled = !myTurn() || !!S.moveBusy;
    var resignBtn = $('bd-resign'); if (resignBtn) resignBtn.disabled = !!S.moveBusy;
    var endBtn = $('bd-end'); if (endBtn) endBtn.disabled = !!S.moveBusy;
    var restartBtn = $('bd-restart'); if (restartBtn) restartBtn.disabled = !!S.moveBusy;
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
      return E.replay(S.game, { size: S.size, forbid: !!(S.state && S.state.forbid) }, S.moves.slice(0, -1).map(function (m) { return m.move; }));
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
      S.anim = null;
      S.score = null;
      S.scoreBusy = false;
      reviewReset();
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

  function reviewReset() {
    if (!S) return;
    S.reviewing = false;
    S.reviewIndex = 0;
    S.reviewStates = null;
    S.reviewState = null;
  }

  function reviewBuild() {
    if (!S || !S.moves) return [];
    if (S.reviewStates) return S.reviewStates;
    var arr = [E.init(S.game, { size: S.size, forbid: !!(S.state && S.state.forbid) })];
    var st = arr[0];
    for (var i = 0; i < S.moves.length; i++) {
      if (st.status !== 'play') break;
      try { st = E.apply(st, S.moves[i].move); } catch (e) { break; }
      arr.push(st);
    }
    S.reviewStates = arr;
    return arr;
  }

  function reviewGoto(i) {
    if (!S || !S.state || S.state.status !== 'over' || !S.moves.length) return;
    var arr = reviewBuild();
    if (!arr.length) return;
    var was = S.reviewing;
    i = Math.max(0, Math.min(arr.length - 1, i));
    S.reviewing = true;
    S.reviewClosed = false;
    S.reviewIndex = i;
    S.reviewState = arr[i];
    S.anim = null;
    S.resultShown = false;
    S.score = null;
    S.scoreBusy = false;
    show('bd-result', false);
    if (!was) {
      // 回看时停掉轮询：红点收掉，胜率图自动打开
      netPause('回看中 · 已暂停同步');
      ANALYSIS.on = true;
    }
    renderAll();
  }

  function exitReview() {
    if (!S) return;
    reviewReset();
    S.reviewClosed = true;
    S.anim = null;
    S.resultShown = false;
    renderAll();
    showResult();
    netResume();
  }

  function reviewStep(d) {
    if (!S) return;
    var total = S.moves.length;
    var i = S.reviewing ? S.reviewIndex : total;
    reviewGoto(i + d);
  }

  function renderReview() {
    if (!S) return;
    var on = !!(S.state && S.state.status === 'over' && S.moves && S.moves.length &&
      !S.practice && !S.reviewClosed);
    show('bd-review', on);
    if (!on) return;
    var total = S.moves.length;
    var i = S.reviewing ? S.reviewIndex : total;
    txt('bd-review-label', i === 0
      ? '开局 · 共 ' + total + ' 手'
      : (i >= total ? '终局 · 共 ' + total + ' 手' : '第 ' + i + ' / ' + total + ' 手'));
    $('bd-review-start').disabled = i <= 0;
    $('bd-review-prev').disabled = i <= 0;
    $('bd-review-next').disabled = i >= total;
    $('bd-review-end').disabled = i >= total;
  }

  function fmtSpent(ms) {
    var sec = Math.max(0, Math.round((ms || 0) / 1000));
    if (sec < 60) return sec + 's';
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  var MATE_SCORE = 100000;
  var INF_SCORE = 1000000;

  function positionBonus(st, i, color, type) {
    if (st.game === 'chess') {
      var x = i % 8, y = Math.floor(i / 8);
      if (color === 2) y = 7 - y;
      var cx = Math.abs(x - 3.5), cy = Math.abs(y - 3.5);
      if (type === 1) return (6 - y) * 10 + Math.round((3.5 - cx) * 4) + (y <= 3 ? 12 : 0);
      if (type === 2 || type === 3) return Math.round((7 - (cx + cy)) * 6);
      if (type === 4) return (y === 1 ? 22 : 0) + Math.round((3.5 - cx) * 3);
      if (type === 5) return Math.round((7 - (cx + cy)) * 3);
      if (type === 6) return (y === 0 && (x === 6 || x === 2) ? 30 : 0) - Math.round(cx * 4);
      return 0;
    }
    if (st.game === 'xiangqi') {
      var xx = i % 9, yy = Math.floor(i / 9);
      if (color === 2) yy = 9 - yy;
      var adv = 9 - yy;
      if (type === 7) return adv * 8 + Math.round((4 - Math.abs(xx - 4)) * 3) + (yy <= 4 ? 15 : 0);
      if (type === 4) return Math.round((4 - Math.abs(xx - 4)) * 3) + Math.round((4 - Math.abs(yy - 4)) * 2);
      if (type === 5) return Math.round((4 - Math.abs(xx - 4)) * 2);
      if (type === 2) return yy >= 7 ? 10 : 0;
      if (type === 3) return yy >= 7 ? 8 : 0;
      if (type === 1) return yy >= 8 ? 15 : 0;
      return 0;
    }
    // draughts
    var dx = i % 10, dy = Math.floor(i / 10);
    if (color === 2) { dx = 9 - dx; dy = 9 - dy; }
    if (type === 1) return (9 - dy) * 6 + Math.round((4.5 - Math.abs(dx - 4.5)) * 2);
    return 12 + Math.round((4.5 - Math.abs(dx - 4.5)) * 2);
  }

  function evalMaterial(st) {
    var b = st.board, i, v, diff = 0;
    var vals = {
      chess: [0, 100, 320, 330, 500, 900, 0],
      xiangqi: [0, 900, 200, 200, 450, 900, 450, 100],
      draughts: [0, 100, 175]
    }[st.game] || [0];
    for (i = 0; i < b.length; i++) {
      v = b[i];
      if (!v) continue;
      var color = v < 8 ? 1 : 2;
      var type = v < 8 ? v : v - 8;
      var val = (vals[type] || 0) + positionBonus(st, i, color, type);
      diff += color === 1 ? val : -val;
    }
    return diff;
  }

  function sideScore(st) {
    var d = evalMaterial(st);
    return st.turn === 1 ? d : -d;
  }

  function captureValue(st, mv) {
    if (!mv) return 0;
    if (st.game === 'draughts') return (mv.c ? mv.c.length : 0) * 100;
    var pc = mv.t != null ? st.board[mv.t] : 0;
    if (!pc) return 0;
    return (pc < 8 ? pc : pc - 8) * 10 + (mv.promo ? 50 : 0);
  }

  // 只收「吃子」的静态搜索：让 1 层搜索也能看见对方马上回吃，
  // 否则象棋开局会以为「炮打马」白赚一子（实际下一手就被车吃回去）。
  function quiesce(st, alpha, beta, depth) {
    if (st.status === 'over') {
      if (!st.winner || st.winner === 3) return 0;
      return st.winner === st.turn ? MATE_SCORE : -MATE_SCORE;
    }
    var stand = sideScore(st);
    if (stand >= beta) return beta;
    if (stand > alpha) alpha = stand;
    if (depth <= 0) return alpha;

    var all = E.moves(st);
    var caps = [];
    for (var i = 0; i < all.length; i++) {
      if (captureValue(st, all[i]) > 0) caps.push(all[i]);
    }
    if (!caps.length) return alpha;
    caps.sort(function (a, b) { return captureValue(st, b) - captureValue(st, a); });
    for (var j = 0; j < caps.length; j++) {
      var ns = E.apply(st, caps[j]);
      var v = -quiesce(ns, -beta, -alpha, depth - 1);
      if (v >= beta) return beta;
      if (v > alpha) alpha = v;
    }
    return alpha;
  }

  function negamax(st, depth, alpha, beta) {
    if (st.status === 'over') {
      if (!st.winner || st.winner === 3) return 0;
      return st.winner === st.turn ? MATE_SCORE : -MATE_SCORE;
    }
    if (depth <= 0) return quiesce(st, alpha, beta, 3);
    var moves = E.moves(st);
    if (!moves.length) return -MATE_SCORE;
    moves.sort(function (a, b) { return captureValue(st, b) - captureValue(st, a); });
    var best = -INF_SCORE;
    for (var i = 0; i < moves.length; i++) {
      var ns = E.apply(st, moves[i]);
      var v = -negamax(ns, depth - 1, -beta, -alpha);
      if (v > best) best = v;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    return best;
  }

  // 1 层（国跳 2 层）alpha-beta：至少能看见「这步会丢子 / 能把子吃回来」，
  // 比纯子力静态分稳得多，又不会把手机卡死。
  function searchScore(st) {
    var depth = st.game === 'draughts' ? 2 : 1;
    var v = negamax(st, depth, -INF_SCORE, INF_SCORE);
    return st.turn === 1 ? v : -v;
  }

  function gomokuFiveAt(b, idx, color) {
    var x = idx % 15, y = Math.floor(idx / 15);
    if (b[idx] !== 0) return false;
    b[idx] = color;
    var dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
    for (var d = 0; d < 4; d++) {
      var dx = dirs[d][0], dy = dirs[d][1], n = 1;
      for (var s = -1; s <= 1; s += 2) {
        var ax = x + dx * s, ay = y + dy * s;
        while (ax >= 0 && ax < 15 && ay >= 0 && ay < 15 && b[ay * 15 + ax] === color) {
          n++; ax += dx * s; ay += dy * s;
        }
      }
      if (n >= 5) { b[idx] = 0; return true; }
    }
    b[idx] = 0;
    return false;
  }

  function gomokuImmediate(st) {
    var b = st.board, me = st.turn, opp = 3 - me;
    for (var i = 0; i < 225; i++) {
      if (b[i]) continue;
      if (gomokuFiveAt(b, i, me)) return 1;
    }
    for (var j = 0; j < 225; j++) {
      if (b[j]) continue;
      if (gomokuFiveAt(b, j, opp)) return -1;
    }
    return 0;
  }

  function goInfluence(st) {
    var n = st.size, N = n * n, b = st.board;
    var inf = new Float64Array(N);
    var i, x, y;
    for (i = 0; i < N; i++) inf[i] = b[i] === 1 ? 1 : (b[i] === 2 ? -1 : 0);
    for (var it = 0; it < 5; it++) {
      var next = new Float64Array(N);
      for (i = 0; i < N; i++) {
        if (b[i]) { next[i] = inf[i]; continue; }
        x = i % n; y = (i - x) / n;
        var sum = 0, cnt = 0;
        for (var dx = -1; dx <= 1; dx++) {
          for (var dy = -1; dy <= 1; dy++) {
            if (!dx && !dy) continue;
            var nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
            sum += inf[ny * n + nx]; cnt++;
          }
        }
        next[i] = cnt ? Math.max(-1, Math.min(1, sum / cnt)) : 0;
      }
      inf = next;
    }
    var diff = 0;
    for (i = 0; i < N; i++) if (!b[i]) diff += inf[i];
    return diff;
  }

  function evalGomoku(st) {
    function side(color) {
      var b = st.board, dirs = [[1, 0], [0, 1], [1, 1], [1, -1]], total = 0;
      for (var i = 0; i < 225; i++) {
        if (b[i] !== color) continue;
        var x = i % 15, y = Math.floor(i / 15);
        for (var d = 0; d < 4; d++) {
          var dx = dirs[d][0], dy = dirs[d][1];
          var px = x - dx, py = y - dy;
          if (px >= 0 && px < 15 && py >= 0 && py < 15 && b[py * 15 + px] === color) continue;
          var n = 0, ax = x, ay = y;
          while (ax >= 0 && ax < 15 && ay >= 0 && ay < 15 && b[ay * 15 + ax] === color) {
            n++; ax += dx; ay += dy;
          }
          var open = 0;
          if (ax >= 0 && ax < 15 && ay >= 0 && ay < 15 && b[ay * 15 + ax] === 0) open++;
          var bx = x - dx, by = y - dy;
          if (bx >= 0 && bx < 15 && by >= 0 && by < 15 && b[by * 15 + bx] === 0) open++;
          total += Math.pow(2.2, n) * (open === 2 ? 1.5 : (open === 1 ? 1 : 0.35));
        }
      }
      return total;
    }
    return side(1) - side(2);
  }

  function evalState(st) {
    if (!st) return 0.5;
    if (st.status === 'over') {
      if (st.winner === 1) return 1;
      if (st.winner === 2) return 0;
      return 0.5;
    }
    var raw = 0, scale = 1, tempo = 0;
    try {
      if (st.game === 'go') {
        var sc = E.scoreGo(st, []);
        var inf = goInfluence(st);
        raw = sc.diff * 0.6 + inf * 0.8;
        scale = 16;
      } else if (st.game === 'gomoku') {
        var im = gomokuImmediate(st);
        if (im > 0) return 0.99;
        if (im < 0) return 0.01;
        raw = evalGomoku(st);
        scale = 9;
        tempo = 2;
      } else {
        raw = searchScore(st);
        scale = st.game === 'chess' ? 300 : (st.game === 'xiangqi' ? 360 : 220);
        tempo = 15;
      }
    } catch (e) {
      raw = 0;
      scale = 1;
    }
    raw += st.turn === 1 ? tempo : -tempo;
    var p = 1 / (1 + Math.exp(-raw / scale));
    return Math.max(0.02, Math.min(0.98, p));
  }

  function stateSig(st) {
    if (!st) return '';
    return (st.game || '') + '|' + (st.size || 0) + '|' + (st.seq || 0) + '|' +
      (st.turn || 0) + '|' + (st.status || '') + '|' + (st.winner || 0);
  }

  // 回看 / 演练 / 实战都在这里取「整盘的局面序列」。
  // 实战是增量长的，缓存住上一份，只 apply 新走的几步。
  function analysisStates() {
    if (!S) return [];
    if (S.practice && S.practiceState) {
      var prefix = (S.practicePrefix && S.practicePrefix.length) ? S.practicePrefix.slice() : [S.practiceBase || S.practiceState];
      // practiceStack 的第一项就是起点；prefix 已经以起点结尾，跳过它
      for (var pi = 1; pi < (S.practiceStack || []).length; pi++) prefix.push(S.practiceStack[pi]);
      var tail = prefix[prefix.length - 1];
      if (!tail || tail.seq !== S.practiceState.seq) prefix.push(S.practiceState);
      var pk = 'p|' + (S.code || 'local') + '|' + stateSig(prefix[0]) + '|' + prefix.length + '|' + stateSig(prefix[prefix.length - 1]);
      if (ANALYSIS.practiceKey === pk && ANALYSIS.practiceStates) return ANALYSIS.practiceStates;
      ANALYSIS.practiceKey = pk;
      ANALYSIS.practiceStates = prefix;
      return prefix;
    }
    if (S.reviewStates && S.reviewStates.length) return S.reviewStates;

    var game = S.game || (S.room && S.room.game);
    var size = S.size || (S.room && S.room.size);
    var mlen = (S.moves && S.moves.length) || 0;
    var lk = 'l|' + (S.code || 'local') + '|' + game + '|' + size + '|' + mlen + '|' + (S.state ? S.state.seq : -1);
    if (ANALYSIS.liveKey === lk && ANALYSIS.liveStates) return ANALYSIS.liveStates;

    var prev = ANALYSIS.liveStates;
    var arr = null;
    if (prev && prev.length && ANALYSIS.liveCode === (S.code || 'local') &&
        prev[0].game === game && prev[0].size === size &&
        prev.length - 1 <= mlen &&
        (S.state ? (S.state.seq || 0) : 0) + 1 >= (prev[prev.length - 1].seq || 0)) {
      arr = prev.slice();
      var st = arr[arr.length - 1];
      var from = arr.length - 1;
      for (var j = from; j < mlen && st.status === 'play'; j++) {
        try { st = E.apply(st, S.moves[j].move); } catch (e) { arr = null; break; }
        arr.push(st);
      }
    }
    if (!arr) {
      var init = E.init(game, { size: size, forbid: !!(S.state && S.state.forbid) });
      arr = [init];
      var cur = init;
      for (var i = 0; i < mlen; i++) {
        if (cur.status !== 'play') break;
        try { cur = E.apply(cur, S.moves[i].move); } catch (e) { break; }
        arr.push(cur);
      }
    }
    ANALYSIS.liveKey = lk;
    ANALYSIS.liveCode = S.code || 'local';
    ANALYSIS.liveStates = arr;
    return arr;
  }

  // 评估只做新增的那一段；回看切手、评论同步都不会把整盘重算一遍。
  function ensureAnalysisData(states) {
    if (!states || !states.length) {
      ANALYSIS.data = [];
      ANALYSIS.baseSig = '';
      ANALYSIS.lastSig = '';
      return;
    }
    var base = stateSig(states[0]);
    var last = stateSig(states[states.length - 1]);
    if (ANALYSIS.data.length === states.length && ANALYSIS.baseSig === base && ANALYSIS.lastSig === last) return;
    var reuse = 0;
    if (ANALYSIS.data.length && ANALYSIS.data.length <= states.length &&
        ANALYSIS.baseSig === base &&
        ANALYSIS.lastSig === stateSig(states[ANALYSIS.data.length - 1])) {
      reuse = ANALYSIS.data.length;
    }
    var data = reuse ? ANALYSIS.data.slice(0, reuse) : [];
    for (var i = reuse; i < states.length; i++) data.push(evalState(states[i]));
    ANALYSIS.data = data;
    ANALYSIS.baseSig = base;
    ANALYSIS.lastSig = last;
  }

  function shortName(c) {
    var n = nameForColor(c) || ((E.games[S.game] && E.games[S.game].colors) ? E.games[S.game].colors[c - 1] : (c === 1 ? '先手' : '后手'));
    n = String(n || '').trim();
    if (n.length > 8) n = n.slice(0, 8) + '…';
    return n;
  }

  function chartPalette() {
    if (isNight()) {
      return {
        grid: 'rgba(255,255,255,.10)', axis: 'rgba(255,255,255,.18)',
        text: 'rgba(233,227,215,.72)', first: '#e0795a', second: '#8fa6c4',
        firstFill: 'rgba(224,121,90,.16)', secondFill: 'rgba(143,166,196,.14)',
        line: 'rgba(240,235,224,.9)', tipBg: 'rgba(18,20,25,.96)', tipText: '#f3eee2',
        tipEdge: 'rgba(255,255,255,.16)'
      };
    }
    return {
      grid: 'rgba(35,33,28,.09)', axis: 'rgba(35,33,28,.2)',
      text: 'rgba(91,87,77,.88)', first: '#c1522f', second: '#44536a',
      firstFill: 'rgba(193,82,47,.14)', secondFill: 'rgba(68,83,106,.11)',
      line: 'rgba(35,33,28,.82)', tipBg: 'rgba(35,33,28,.94)', tipText: '#f8f4e9',
      tipEdge: 'rgba(255,255,255,.14)'
    };
  }

  function chartGeom(w, h, n) {
    var padL = 32, padR = 10, padT = 12, padB = 21;
    var iw = Math.max(12, w - padL - padR), ih = Math.max(12, h - padT - padB);
    return {
      padL: padL, padR: padR, padT: padT, padB: padB, iw: iw, ih: ih,
      x: function (i) { return padL + (n <= 1 ? iw / 2 : iw * i / (n - 1)); },
      y: function (p) { return padT + ih * (1 - p); }
    };
  }

  function drawWinChart() {
    var cv = $('bd-win-chart');
    if (!cv) return;
    var data = ANALYSIS.data || [];
    var w = Math.max(200, Math.floor(cv.clientWidth || cv.parentNode.clientWidth || 280));
    var h = Math.max(120, Math.floor(cv.clientHeight || 170));
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    if (cv.width !== Math.floor(w * dpr) || cv.height !== Math.floor(h * dpr)) {
      cv.width = Math.floor(w * dpr);
      cv.height = Math.floor(h * dpr);
    }
    var ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!data.length) return;

    var pal = chartPalette();
    var n = data.length;
    var g = chartGeom(w, h, n);
    var cur = Math.max(0, Math.min(ANALYSIS.cur, n - 1));
    var hover = (ANALYSIS.hover >= 0 && ANALYSIS.hover < n) ? ANALYSIS.hover : -1;

    // 上下半区：先手占优 / 后手占优
    ctx.fillStyle = pal.firstFill;
    ctx.fillRect(g.padL, g.padT, g.iw, g.ih / 2);
    ctx.fillStyle = pal.secondFill;
    ctx.fillRect(g.padL, g.padT + g.ih / 2, g.iw, g.ih / 2);

    // 横网格与刻度
    ctx.font = '9px ui-monospace, Menlo, Consolas, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    var marks = [0, 0.25, 0.5, 0.75, 1];
    for (var m = 0; m < marks.length; m++) {
      var gy = g.y(marks[m]);
      ctx.strokeStyle = marks[m] === 0.5 ? pal.axis : pal.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (marks[m] === 0.5) ctx.setLineDash([4, 4]);
      ctx.moveTo(g.padL, gy);
      ctx.lineTo(g.padL + g.iw, gy);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.fillStyle = pal.text;
    ctx.fillText('100', g.padL - 5, g.padT + 1);
    ctx.fillText('50', g.padL - 5, g.padT + g.ih / 2);
    ctx.fillText('0', g.padL - 5, g.padT + g.ih);

    // 折线：按当前领先方分段上色
    for (var i = 1; i < n; i++) {
      var x0 = g.x(i - 1), y0 = g.y(data[i - 1]);
      var x1 = g.x(i), y1 = g.y(data[i]);
      var above = (data[i - 1] + data[i]) / 2 >= 0.5;
      ctx.strokeStyle = above ? pal.first : pal.second;
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
    if (n === 1) {
      ctx.fillStyle = pal.first;
      ctx.beginPath();
      ctx.arc(g.x(0), g.y(data[0]), 3, 0, Math.PI * 2);
      ctx.fill();
    }

    function marker(idx, color, radius, dashed) {
      var mx = g.x(idx), my = g.y(data[idx]);
      ctx.strokeStyle = dashed ? pal.axis : color;
      ctx.lineWidth = 1;
      if (dashed) ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(mx, g.padT);
      ctx.lineTo(mx, g.padT + g.ih);
      ctx.stroke();
      ctx.setLineDash([]);
      if (!dashed) {
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(mx, my, radius + 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(mx, my, radius, 0, Math.PI * 2);
      ctx.fill();
      return [mx, my];
    }

    // 当前手
    var curColor = data[cur] >= 0.5 ? pal.first : pal.second;
    marker(cur, curColor, 3.2, true);

    // 悬停 / 点击查看的那一手
    if (hover >= 0 && hover !== cur) {
      var hc = isNight() ? '#d9b86a' : '#c08c2c';
      var hp = marker(hover, hc, 3.4, false);
      var pw = Math.round(data[hover] * 100);
      var lines = ['第 ' + hover + ' 手', shortName(1) + ' ' + pw + '%', shortName(2) + ' ' + (100 - pw) + '%'];
      ctx.font = '9.5px ui-monospace, Menlo, Consolas, monospace';
      var tw = 0;
      for (var t = 0; t < lines.length; t++) tw = Math.max(tw, ctx.measureText(lines[t]).width);
      var bw = Math.ceil(tw + 16), bh = 46;
      var bx = Math.min(g.padL + g.iw - bw - 2, Math.max(g.padL + 2, hp[0] - bw / 2));
      var by = g.padT + 3;
      if (hp[1] < g.padT + bh + 8) by = Math.min(g.padT + g.ih - bh - 3, hp[1] + 10);
      ctx.fillStyle = pal.tipBg;
      ctx.strokeStyle = pal.tipEdge;
      ctx.lineWidth = 1;
      if (ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(bx, by, bw, bh, 6);
        ctx.fill();
        ctx.stroke();
      } else {
        ctx.fillRect(bx, by, bw, bh);
        ctx.strokeRect(bx, by, bw, bh);
      }
      ctx.fillStyle = pal.tipText;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      for (var q = 0; q < lines.length; q++) {
        ctx.fillText(lines[q], bx + 8, by + 11 + q * 12);
      }
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
    }

    // 当前手百分比小药丸（鼠标正在看别的某一手时让位给 tooltip）
    var pct = Math.round(data[cur] * 100);
    if (hover < 0) {
      var label = pct + '%';
      ctx.font = '700 10px ui-monospace, Menlo, Consolas, monospace';
      var lw = ctx.measureText(label).width + 12;
      var lx = Math.min(g.padL + g.iw - lw, Math.max(g.padL, g.x(cur) - lw / 2));
      var ly = data[cur] > 0.6 ? g.padT + g.ih - 19 : g.padT + 2;
      ctx.fillStyle = curColor;
      if (ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(lx, ly, lw, 16, 8);
        ctx.fill();
      } else {
        ctx.fillRect(lx, ly, lw, 16);
      }
      ctx.fillStyle = '#fffdf7';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, lx + lw / 2, ly + 8.5);
    }

    // 横轴：0 与最后一手
    ctx.font = '9px ui-monospace, Menlo, Consolas, monospace';
    ctx.fillStyle = pal.text;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('0', g.padL, g.padT + g.ih + 11);
    ctx.textAlign = 'right';
    ctx.fillText(String(n - 1), g.padL + g.iw, g.padT + g.ih + 11);
    if (n > 2) {
      ctx.textAlign = 'center';
      ctx.fillText('第 ' + cur + ' 手', g.padL + g.iw / 2, g.padT + g.ih + 11);
    }

    cv.setAttribute('aria-label',
      '胜率折线图：第 ' + cur + ' 手，' + shortName(1) + ' ' + pct + '%，' + shortName(2) + ' ' + (100 - pct) + '%');
  }

  function chartIndexAt(clientX) {
    var cv = $('bd-win-chart');
    var data = ANALYSIS.data || [];
    if (!cv || !data.length) return -1;
    var rect = cv.getBoundingClientRect();
    if (!rect.width) return -1;
    var w = cv.clientWidth || rect.width;
    var g = chartGeom(w, Math.max(120, cv.clientHeight || 170), data.length);
    var x = clientX - rect.left;
    if (data.length <= 1) return 0;
    if (x < g.padL - 10 || x > g.padL + g.iw + 10) return -1;
    var i = Math.round((x - g.padL) / g.iw * (data.length - 1));
    return Math.max(0, Math.min(data.length - 1, i));
  }

  function renderWinBar(p, cur) {
    var bar = $('bd-winbar');
    if (!bar || !S || !S.state) { show('bd-winbar', false); return; }
    var pct = Math.round(p * 100);
    var n1 = shortName(1), n2 = shortName(2);
    txt('bd-winbar-p1', n1 + ' ' + pct + '%');
    txt('bd-winbar-p2', (100 - pct) + '% ' + n2);
    var fill = $('bd-winbar-fill');
    if (fill) fill.style.width = Math.max(2, Math.min(98, pct)) + '%';
    bar.title = '局面胜率（本地估算） · 第 ' + cur + ' 手 · 点开看整盘折线图';
    bar.setAttribute('aria-label',
      '局面胜率：' + n1 + ' ' + pct + '%，' + n2 + ' ' + (100 - pct) + '%。点开看折线图');
    show('bd-winbar', true);
  }

  function renderAnalysis() {
    var has = !!(S && S.state);
    show('bd-analysis', has);
    var engineBtn = $('bd-engine-run');
    if (engineBtn) engineBtn.hidden = !has || (S.state.game !== 'chess' && S.state.game !== 'xiangqi');
    var btn = $('bd-analysis');
    if (btn) {
      btn.textContent = ANALYSIS.on ? '收起胜率' : '胜率';
      btn.setAttribute('aria-pressed', ANALYSIS.on ? 'true' : 'false');
    }
    if (!has) {
      show('bd-analysis-panel', false);
      show('bd-winbar', false);
      return;
    }
    var states = analysisStates();
    ensureAnalysisData(states);
    var last = Math.max(0, (ANALYSIS.data || []).length - 1);
    ANALYSIS.cur = S.practice ? last : (S.reviewing ? Math.min(S.reviewIndex, last) : last);
    var p = (ANALYSIS.data && ANALYSIS.data.length) ? ANALYSIS.data[ANALYSIS.cur] : 0.5;
    var pct = Math.round(p * 100);

    txt('bd-an-name1', shortName(1));
    txt('bd-an-name2', shortName(2));
    txt('bd-an-p1', pct + '%');
    txt('bd-an-p2', (100 - pct) + '%');
    txt('bd-analysis-label', '第 ' + ANALYSIS.cur + ' / ' + last + ' 手');
    renderWinBar(p, ANALYSIS.cur);

    show('bd-analysis-panel', !!ANALYSIS.on);
    if (!ANALYSIS.on) return;
    drawWinChart();
  }

  var engineBusy = false;

  function engineNote(msg, isErr) {
    var el = $('bd-engine-note');
    if (!el) return;
    el.hidden = !msg;
    el.textContent = msg || '';
    el.classList.toggle('is-err', !!isErr);
  }

  function runEngine() {
    if (!S || !S.state || engineBusy) return;
    var game = S.state.game;
    if (game !== 'chess' && game !== 'xiangqi') {
      engineNote('引擎目前接了国象/象棋；五子棋、围棋、国跳还在排队。', true);
      return;
    }
    if (!window.B8Engine) {
      engineNote('引擎脚本没加载上，刷新再试。', true);
      return;
    }

    var engineName = game === 'chess' ? 'Stockfish' : 'Pikafish';
    engineBusy = true;
    var btn = $('bd-engine-run');
    if (btn) { btn.disabled = true; btn.textContent = '分析中'; }
    engineNote(engineName + ' 正在分析当前局面…');

    window.B8Engine.analyze(game, S.state, { movetime: 900 }).then(function (r) {
      var side = r.p1 >= 50 ? shortName(1) : shortName(2);
      var pct = r.p1 >= 50 ? r.p1 : (100 - r.p1);
      var best = r.bestmove ? ' · 最佳 ' + r.bestmove : '';
      var mate = r.mate != null ? ' · 杀棋 ' + Math.abs(r.mate) + ' 步' : '';
      engineNote(engineName + '：' + side + ' ' + pct.toFixed(1) + '% · 深度 ' +
        r.depth + ' · ' + (r.ms / 1000).toFixed(1) + 's' + mate + best +
        ' · GPLv3', false);
    }).catch(function (err) {
      engineNote('引擎失败：' + (err && err.message ? err.message : '未知错误'), true);
    }).then(function () {
      engineBusy = false;
      if (btn) { btn.disabled = false; btn.textContent = '引擎'; }
    });
  }

  function openAnalysis() {
    if (!S || !S.state) return;
    ANALYSIS.on = true;
    renderAnalysis();
    var panel = $('bd-analysis-panel');
    if (panel && panel.scrollIntoView && window.innerWidth < 900) {
      try { panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) {}
    }
  }

  function toggleAnalysis() {
    ANALYSIS.on = !ANALYSIS.on;
    if (!ANALYSIS.on) ANALYSIS.hover = -1;
    renderAnalysis();
    if (ANALYSIS.on) {
      var panel = $('bd-analysis-panel');
      if (panel && panel.scrollIntoView && window.innerWidth < 900) {
        try { panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) {}
      }
    }
  }

  var chartResizeTimer = 0;
  window.addEventListener('resize', function () {
    if (!ANALYSIS.on) return;
    clearTimeout(chartResizeTimer);
    chartResizeTimer = setTimeout(drawWinChart, 120);
  });

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
    var cur = S.reviewing ? S.reviewIndex : S.moves.length;
    for (var i = start; i < S.moves.length; i++) {
      var m = S.moves[i];
      var t = S.texts[i - start] || null;
      // texts 与 moves 可能因为增量对不齐，按 seq 找
      for (var k = 0; k < S.texts.length; k++) if (S.texts[k].seq === m.seq) { t = S.texts[k]; break; }
      var li2 = document.createElement('li');
      if (i === S.moves.length - 1) li2.className = 'is-new';
      if (i + 1 === cur) li2.className += ' is-review';
      if (S.state.status === 'over') {
        li2.className += ' is-clickable';
        li2.tabIndex = 0;
        li2.setAttribute('role', 'button');
        li2.title = '看这一手之后的局面';
        li2.setAttribute('data-i', String(i + 1));
        li2.addEventListener('click', (function (idx) {
          return function () { reviewGoto(idx); };
        })(i + 1));
        li2.addEventListener('keydown', (function (idx) {
          return function (ev) {
            if (ev.key === 'Enter' || ev.key === ' ') {
              ev.preventDefault();
              reviewGoto(idx);
            }
          };
        })(i + 1));
      }
      var no = document.createElement('span');
      no.className = 'bd-mv-no';
      no.textContent = (i + 1) + '.';
      var body = document.createElement('span');
      body.className = 'bd-mv-body';
      body.textContent = t ? t.text : '';
      var who = document.createElement('i');
      who.textContent = colorName(m.color);
      body.appendChild(who);
      if (m.spent) {
        var tm = document.createElement('span');
        tm.className = 'bd-mv-time';
        tm.textContent = fmtSpent(m.spent);
        tm.title = '这一步用时 ' + fmtSpent(m.spent);
        body.appendChild(tm);
      }
      li2.appendChild(no);
      li2.appendChild(body);
      box.appendChild(li2);
    }
    var active = box.querySelector('.is-review');
    if (active) box.scrollTop = Math.max(0, active.offsetTop - box.offsetTop - 30);
    else if (cur === 0) box.scrollTop = 0;
    else box.scrollTop = box.scrollHeight;
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
      var again = $('bd-again');
      if (again) {
        again.disabled = !!S.rematchOffered;
        again.textContent = S.rematchOffered ? '已邀请，等对方' : (S.mode === 'online' && !isLocalRoom() ? '邀请再来一局' : '再来一局');
      }
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
    if (S.startedAt) {
      var lastAt = S.moves.length ? (S.moves[S.moves.length - 1].at || Date.now()) : Date.now();
      var d = new Date(S.startedAt);
      var hh = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
      var total = Math.max(0, lastAt - S.startedAt);
      sub += (sub ? ' · ' : '') + '开始 ' + hh + ' · 总用时 ' + fmtSpent(total);
    }
    return { title: title, sub: sub };
  }

  function showResult() {
    if (!S || !S.state || S.state.status !== 'over' || S.reviewing) return;
    S.resultShown = true;
    renderOverlays();
    renderActions();
    initChat();
  }

  function loadDeadstones() {
    var build = encodeURIComponent(window.B8_BUILD || '');
    if (window.B8DeadStones) {
      try { window.B8DeadStones.useFetch('assets/games/deadstones_bg.wasm?v=' + build); } catch (e) {}
      return Promise.resolve(window.B8DeadStones);
    }
    if (DEADSTONES.loading) return DEADSTONES.loading;
    DEADSTONES.loading = new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        reject(new Error('auto-score timeout'));
      }, 10000);
      var sc = document.createElement('script');
      sc.src = 'assets/games/deadstones.js?v=' + build;
      sc.async = true;
      sc.onload = function () {
        if (done) return;
        if (!window.B8DeadStones) {
          done = true;
          clearTimeout(timer);
          reject(new Error('auto-score missing'));
          return;
        }
        try {
          window.B8DeadStones.useFetch('assets/games/deadstones_bg.wasm?v=' + build);
        } catch (e) {}
        done = true;
        clearTimeout(timer);
        resolve(window.B8DeadStones);
      };
      sc.onerror = function () {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(new Error('auto-score load failed'));
      };
      document.head.appendChild(sc);
    });
    return DEADSTONES.loading;
  }

  function goMatrix(st) {
    var n = st.size, rows = [];
    for (var y = 0; y < n; y++) {
      var row = [];
      for (var x = 0; x < n; x++) {
        var v = st.board[y * n + x];
        row.push(v === 1 ? 1 : (v === 2 ? -1 : 0));
      }
      rows.push(row);
    }
    return rows;
  }

  function estimateDead(st) {
    return loadDeadstones().then(function (lib) {
      return lib.guess(goMatrix(st), { finished: true, iterations: 100 });
    }).then(function (verts) {
      var n = st.size, out = [], seen = {};
      for (var i = 0; i < verts.length; i++) {
        var v = verts[i];
        var idx = v[1] * n + v[0];
        if (st.board[idx] && !seen[idx]) {
          seen[idx] = 1;
          out.push(idx);
        }
      }
      out.sort(function (a, b) { return a - b; });

      // 自动死子偶尔会把整片同色棋子都判死，点目就会整盘只剩一种颜色。
      // 这种明显不合理的估计直接丢掉，改为让用户点棋子手动标。
      var stones = [0, 0], deadByColor = [0, 0];
      for (var q = 0; q < st.board.length; q++) {
        if (st.board[q]) stones[st.board[q] - 1]++;
      }
      for (var w = 0; w < out.length; w++) deadByColor[st.board[out[w]] - 1]++;
      if (out.length > st.board.length * 0.5) return [];
      if ((stones[0] > 0 && deadByColor[0] === stones[0] && stones[1] > 0) ||
          (stones[1] > 0 && deadByColor[1] === stones[1] && stones[0] > 0)) {
        return [];
      }
      return out;
    });
  }

  function goChainAt(st, idx) {
    var color = st.board[idx];
    if (!color) return [];
    var n = st.size, seen = {}, stack = [idx], out = [];
    seen[idx] = 1;
    while (stack.length) {
      var cur = stack.pop();
      out.push(cur);
      var x = cur % n, y = (cur - x) / n;
      var nb = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]];
      for (var k = 0; k < 4; k++) {
        var nx = nb[k][0], ny = nb[k][1];
        if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
        var j = ny * n + nx;
        if (st.board[j] !== color || seen[j]) continue;
        seen[j] = 1;
        stack.push(j);
      }
    }
    return out;
  }

  function scoreState() {
    return (S && S.reviewing && S.reviewState) ? S.reviewState : (S ? S.state : null);
  }

  function applyGoScore(dead, auto) {
    var st = scoreState();
    if (!S || !st || st.game !== 'go') return;
    dead = (dead || []).slice();
    var sc = E.scoreGo(st, dead);
    sc.dead = dead;
    sc.seq = st.seq;
    sc.auto = !!auto;
    S.score = sc;
    S.scoreBusy = false;
    renderScorePanel();
    renderActions();
    draw();
  }

  function toggleGoScore() {
    if (!S || !S.state || S.state.game !== 'go') return;
    if (S.scoreBusy) { toast('正在点目，稍等一下'); return; }
    if (S.score) {
      S.score = null;
      S.scoreBusy = false;
      renderScorePanel();
      renderActions();
      draw();
      return;
    }
    var st = scoreState();
    if (!st || st.status !== 'play') { toast('这个局面不能点目'); return; }
    var seq = st.seq;
    var reviewIdx = S.reviewing ? S.reviewIndex : -1;
    S.scoreBusy = true;
    S.score = null;
    renderScorePanel();
    renderActions();
    draw();
    estimateDead(st).then(function (dead) {
      if (!S || !S.state || S.state.game !== 'go' || !S.scoreBusy) return;
      if (S.reviewing ? (S.reviewIndex !== reviewIdx) : (S.state.seq !== seq)) return;
      applyGoScore(dead, true);
      toast(dead.length
        ? '自动标出 ' + dead.length + ' 颗死子；点错的棋子可以直接点一下改正'
        : '没有找到死子；有争议的话点棋子手动标死子');
    }).catch(function () {
      if (!S || !S.state || S.state.game !== 'go' || !S.scoreBusy) return;
      if (S.reviewing ? (S.reviewIndex !== reviewIdx) : (S.state.seq !== seq)) return;
      applyGoScore([], false);
      S.score.autoFailed = true;
      renderScorePanel();
      toast('自动判断死子不可用：可以点棋子手动标死子');
    });
  }

  function toggleDeadChain(idx) {
    var st = scoreState();
    if (!S || !S.score || !st || st.game !== 'go') return;
    var chain = goChainAt(st, idx);
    if (!chain.length) return;
    var dead = (S.score.dead || []).slice();
    var has = false;
    for (var i = 0; i < chain.length; i++) {
      if (dead.indexOf(chain[i]) >= 0) { has = true; break; }
    }
    if (has) {
      dead = dead.filter(function (v) { return chain.indexOf(v) < 0; });
    } else {
      dead = dead.concat(chain);
    }
    applyGoScore(dead, false);
  }

  function renderScorePanel() {
    var n = $('bd-scorepanel');
    var btn = $('bd-score');
    if (!n) return;
    if (!S) {
      n.hidden = true;
      n.innerHTML = '';
      return;
    }
    if (S.scoreBusy) {
      n.hidden = false;
      n.innerHTML = '<p class="bd-score-note">正在自动判断死子…</p>';
      if (btn) { btn.disabled = true; btn.textContent = '点目中…'; }
      return;
    }
    if (!S.score) {
      n.hidden = true;
      n.innerHTML = '';
      if (btn) { btn.disabled = false; btn.textContent = '点目'; }
      return;
    }
    var sc = S.score;
    var deadCount = sc.dead ? sc.dead.length : 0;
    n.hidden = false;
    n.innerHTML =
      '<div class="bd-score-line">' +
        '<span><i class="bd-sq is-b"></i>黑 <b>' + fmtNum(sc.black) + '</b></span>' +
        '<span><i class="bd-sq is-w"></i>白 <b>' + fmtNum(sc.white) + '</b></span>' +
        '<span>贴目 <b>7.5</b></span>' +
        '<span>' + (sc.winner === 0 ? '和棋' : (sc.winner === 1 ? '黑胜 ' : '白胜 ') + fmtNum(Math.abs(sc.diff))) + '</span>' +
      '</div>' +
      '<p class="bd-score-note">' +
        (sc.autoFailed ? '自动判断不可用，已按无死子计分；请点棋盘上的棋子手动标死子。'
          : (sc.auto ? '自动' : '手动') + '判定死子 ' + deadCount + ' 颗；' +
            (deadCount ? '点一下标错的棋子可以改回来。' : '有死子的话，点棋盘上的棋子标上。')) +
        ' 中国规则数子：黑 ' + sc.stones[0] + ' 子 + ' + sc.terr[0] + ' 空；白 ' +
        sc.stones[1] + ' 子 + ' + sc.terr[1] + ' 空 + 贴 7.5。' +
        (sc.neutral ? ' 单官 / 未定 ' + sc.neutral + ' 点。' : '') +
      '</p>';
    if (btn) { btn.disabled = false; btn.textContent = '退出点目'; }
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

  Renderer.prototype.draw = function (fast) {
    if (!this.st) return;
    if (!fast || !this.w) this.measure();
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
    var anim = opts.anim;
    var skip = anim && anim.kind === 'drop' ? anim.to : -1;
    var deadSet = {};
    (opts.dead || []).forEach(function (di) { deadSet[di] = 1; });
    for (var j = 0; j < n * n; j++) {
      if (!st.board[j] || j === skip) continue;
      var pp = P(j);
      if (deadSet[j]) {
        ctx.globalAlpha = 0.3;
        drawStone(ctx, pp[0], pp[1], r, st.board[j], p);
        ctx.globalAlpha = 1;
        deadCross(ctx, pp[0], pp[1], r);
      } else {
        drawStone(ctx, pp[0], pp[1], r, st.board[j], p);
      }
    }
    if (anim && anim.kind === 'drop') {
      var dt = easeOut(animT(anim));
      var dp = P(anim.to);
      ctx.globalAlpha = 0.25 + dt * 0.75;
      drawStone(ctx, dp[0], dp[1], r * (0.62 + 0.38 * dt), anim.color, p);
      ctx.globalAlpha = 1;
    }

    if (!anim && st.last && st.last.t != null) {
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

  function deadCross(ctx, x, y, r) {
    ctx.strokeStyle = 'rgba(193,82,47,.95)';
    ctx.lineWidth = Math.max(1.5, r * 0.16);
    ctx.beginPath();
    ctx.moveTo(x - r * 0.5, y - r * 0.5);
    ctx.lineTo(x + r * 0.5, y + r * 0.5);
    ctx.moveTo(x + r * 0.5, y - r * 0.5);
    ctx.lineTo(x - r * 0.5, y + r * 0.5);
    ctx.stroke();
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
    var anim = opts.anim;
    var skip = anim && anim.kind === 'drop' ? anim.to : -1;
    for (var j = 0; j < n * n; j++) {
      if (!st.board[j] || j === skip) continue;
      var pp = P(j);
      drawStone(ctx, pp[0], pp[1], r, st.board[j], p);
    }
    if (anim && anim.kind === 'drop') {
      var dt = easeOut(animT(anim));
      var dp = P(anim.to);
      ctx.globalAlpha = 0.25 + dt * 0.75;
      drawStone(ctx, dp[0], dp[1], r * (0.62 + 0.38 * dt), anim.color, p);
      ctx.globalAlpha = 1;
    }
    if (!anim && st.last && st.last.t != null) {
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
    // 九宫：上下各一个。每个九宫只画一组对角线（3,0）↔（5,2）；
    // 之前把 (5,0) 也当成一个宫，等于每个九宫又往右画了一组，成了两个并排的 X。
    [[3, 0], [3, 7]].forEach(function (s) {
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
    var anim = opts.anim;
    var skip = anim && anim.kind === 'slide' ? anim.to : -1;
    for (var i = 0; i < 90; i++) {
      var pc = st.board[i];
      if (!pc || i === skip) continue;
      var pp = P(i);
      drawXqPiece(ctx, pp[0], pp[1], r, pc, p, opts.sel === i);
    }
    if (anim && anim.kind === 'slide') {
      var t = easeOut(animT(anim));
      if (anim.cap && anim.capIdx >= 0) {
        var cp = P(anim.capIdx);
        ctx.globalAlpha = Math.max(0, 1 - t);
        drawXqPiece(ctx, cp[0], cp[1], r, anim.cap, p, false);
        ctx.globalAlpha = 1;
      }
      var a = P(anim.from), b = P(anim.to);
      drawXqPiece(ctx, a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, r, anim.piece, p, false);
    }
    if (!anim && st.last) {
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
      else dot(ctx, p2[0], p2[1], Math.max(2.4, cell * 0.09), 'rgba(47,111,94,.72)');
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
    if (!opts.anim && st.last) {
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
    var anim = opts.anim;
    var skip = anim && anim.kind === 'slide' ? anim.to : -1;
    for (var j = 0; j < 64; j++) {
      var pc = st.board[j];
      if (!pc || j === skip) continue;
      var rr = sqRect(j);
      drawChessPiece(ctx, pc, rr[0] + cell / 2, rr[1] + cell / 2, cell, p, glyph);
    }
    if (anim && anim.kind === 'slide') {
      var t = easeOut(animT(anim));
      if (anim.cap && anim.capIdx >= 0) {
        var cp = sqRect(anim.capIdx);
        ctx.globalAlpha = Math.max(0, 1 - t);
        drawChessPiece(ctx, anim.cap, cp[0] + cell / 2, cp[1] + cell / 2, cell, p, glyph);
        ctx.globalAlpha = 1;
      }
      var a = sqRect(anim.from), b = sqRect(anim.to);
      drawChessPiece(ctx, anim.piece,
        a[0] + (b[0] - a[0]) * t + cell / 2,
        a[1] + (b[1] - a[1]) * t + cell / 2, cell, p, glyph);
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

  function drawChessPiece(ctx, pc, cx, cy, cell, p, glyph) {
    var white = pc < 8;
    ctx.lineWidth = Math.max(1, cell * 0.02);
    ctx.fillStyle = white ? '#fffdf7' : (p.night ? '#111116' : '#1d1b18');
    ctx.strokeStyle = white ? (p.night ? '#cfc9ba' : '#2a2620') : (p.night ? '#b9b3a5' : '#000000');
    var g = glyph[pc] || '?';
    ctx.fillText(g, cx, cy + cell * 0.02);
    ctx.strokeText(g, cx, cy + cell * 0.02);
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
    if (!opts.anim && st.last && st.last.pts) {
      st.last.pts.forEach(function (sq) {
        var r = cRect(sq);
        ctx.fillStyle = 'rgba(192,140,44,.3)';
        ctx.fillRect(r[0], r[1], cell, cell);
      });
    }
    var anim = opts.anim;
    var skip = anim && anim.kind === 'path' ? anim.path[anim.path.length - 1] : -1;
    for (var j = 0; j < 100; j++) {
      var pc = st.board[j];
      if (!pc || j === skip) continue;
      var rr = cRect(j);
      drawMan(ctx, rr[0] + cell / 2, rr[1] + cell / 2, cell * 0.36, pc, p, opts.sel === j);
    }
    if (anim && anim.kind === 'path') {
      var t = animT(anim);
      for (var c = 0; c < anim.caps.length; c++) {
        var cpc = anim.prevBoard[anim.caps[c]];
        if (!cpc) continue;
        var cr = cRect(anim.caps[c]);
        ctx.globalAlpha = Math.max(0, 1 - t);
        drawMan(ctx, cr[0] + cell / 2, cr[1] + cell / 2, cell * 0.36, cpc, p, false);
        ctx.globalAlpha = 1;
      }
      var segs = Math.max(1, anim.path.length - 1);
      var pos = t * segs;
      var si = Math.min(segs - 1, Math.floor(pos));
      var frac = pos - si;
      var pa = cRect(anim.path[si]), pb = cRect(anim.path[si + 1]);
      var ax = pa[0] + cell / 2, ay = pa[1] + cell / 2;
      var bx = pb[0] + cell / 2, by = pb[1] + cell / 2;
      drawMan(ctx, ax + (bx - ax) * frac, ay + (by - ay) * frac, cell * 0.36, anim.piece, p, false);
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

  function buildAnim(prev, mv, ns) {
    if (!prev || !mv || !ns || mv.pass) return null;
    var game = prev.game || (S && S.game);
    if (game === 'go' || game === 'gomoku') {
      return { kind: 'drop', to: mv.t, color: prev.turn, started: Date.now(), dur: 180 };
    }
    if (game === 'draughts') {
      return {
        kind: 'path', path: (mv.p || []).slice(), caps: (mv.c || []).slice(),
        piece: ns.board[mv.p[mv.p.length - 1]], prevBoard: prev.board.slice(),
        started: Date.now(), dur: Math.max(180, 130 * Math.max(1, (mv.p || []).length - 1))
      };
    }
    var capIdx = mv.t;
    if (mv.ep) capIdx = mv.t + (prev.turn === 1 ? 8 : -8);
    return {
      kind: 'slide', from: mv.f, to: mv.t, capIdx: capIdx,
      cap: prev.board[capIdx] || 0, piece: ns.board[mv.t],
      started: Date.now(), dur: 220
    };
  }

  function animateMove(prev, mv, ns) {
    if (!S || document.hidden) { if (S) S.anim = null; return; }
    S.anim = buildAnim(prev, mv, ns);
  }

  function animT(a) {
    var t = (Date.now() - a.started) / a.dur;
    return t < 0 ? 0 : (t > 1 ? 1 : t);
  }

  function easeOut(t) { return 1 - Math.pow(1 - t, 3); }

  function ensureAnimLoop() {
    if (animRAF) return;
    var raf = window.requestAnimationFrame || function (fn) { return setTimeout(fn, 16); };
    function step() {
      animRAF = 0;
      if (!S || !S.anim) { draw(); return; }
      if (animT(S.anim) >= 1) { S.anim = null; draw(); return; }
      draw();
      animRAF = raf(step);
    }
    animRAF = raf(step);
  }

  function draw() {
    if (!S || !S.state || !renderer) return;
    var st = S.practice && S.practiceState ? S.practiceState :
      ((S.reviewing && S.reviewState) ? S.reviewState : S.state);
    if (!st || !st.board) return;
    var practicing = !!S.practice;
    renderer.set(st, {
      sel: (S.reviewing && !practicing) ? null : S.sel,
      targets: (S.reviewing && !practicing) ? [] : S.targets,
      flip: S.flip,
      score: practicing ? null : (S.score || null),
      dead: (!practicing && S.score && S.score.dead) ? S.score.dead : [],
      anim: (S.reviewing || practicing) ? null : S.anim
    });
    renderer.draw(!!S.anim && !S.reviewing && !practicing);
  }

  /* ============================================================
     十、计时
     ============================================================ */
  function renderFirstBanner() {
    if (!S || S.mode !== 'online' || !S.room || isLocalRoom() ||
        !S.timed || S.room.status !== 'play' || !S.state || S.state.status !== 'play' ||
        S.state.seq !== 0 || !S.room.turn_started) {
      show('bd-first-banner', false);
      return;
    }
    var elapsed = (Date.now() + (NET.offset || 0)) - S.room.turn_started;
    if (elapsed < 10000) {
      show('bd-first-banner', false);
      return;
    }
    var left = Math.ceil((30000 - elapsed) / 1000);
    var text;
    if (left <= 0) {
      text = '第一手已超时，正在结算…';
      if (!NET.timeoutAt || Date.now() - NET.timeoutAt > 2500) {
        NET.timeoutAt = Date.now();
        syncNow();
      }
    } else {
      var who = S.seat === 0 ? '' : (S.state.turn === S.seat ? '你的' : '对方的');
      text = who + '第一手倒计时 <b>' + left + '</b> 秒 · 超时判负';
    }
    var el = $('bd-first-banner');
    if (el) el.innerHTML = text;
    show('bd-first-banner', true);
  }

  function tick() {
    if (!S) return;
    if (S.practice || S.reviewing) { renderFirstBanner(); return; }
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
    renderFirstBanner();
    loadSpectators(false);
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
      CHAT.inited = false;
      CHAT.sig = null;
      stopChat();
      return;
    }
    if (!CHAT.inited) {
      refreshChat(true);
    } else {
      scheduleChat();
    }
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
      CHAT.inited = true;
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

  function renderChatList(force) {
    var box = $('bd-chat-list');
    if (!box) return;
    // 同步每 1 秒跑一次，评论没变就别重建 DOM——否则正在看旧评论会被顶回顶部
    var sig = CHAT.items.map(function (c) { return c.id; }).join(',');
    if (!force && sig === CHAT.sig) {
      txt('bd-chat-count', String(CHAT.items.length));
      return;
    }
    CHAT.sig = sig;
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
    $('bd-exit').addEventListener('click', leaveGame);
    $('bd-practice').addEventListener('click', togglePractice);
    $('bd-analysis').addEventListener('click', toggleAnalysis);
    var engineRun = $('bd-engine-run');
    if (engineRun) engineRun.addEventListener('click', runEngine);
    $('bd-practice-reset').addEventListener('click', practiceReset);
    $('bd-review-exit').addEventListener('click', exitReview);
    $('bd-winbar').addEventListener('click', openAnalysis);
    $('bd-winbar').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openAnalysis(); }
    });

    // 胜率折线图：鼠标悬停看每一手，点击直接跳到那一手（回看 / 演练）
    var chartCv = $('bd-win-chart');
    if (chartCv) {
      chartCv.addEventListener('pointermove', function (e) {
        if (e.pointerType && e.pointerType !== 'mouse' && e.pointerType !== 'pen') return;
        var i = chartIndexAt(e.clientX);
        if (i === ANALYSIS.hover) return;
        ANALYSIS.hover = i;
        drawWinChart();
      });
      chartCv.addEventListener('pointerleave', function () {
        if (ANALYSIS.hover < 0) return;
        ANALYSIS.hover = -1;
        drawWinChart();
      });
      chartCv.addEventListener('click', function (e) {
        var i = chartIndexAt(e.clientX);
        if (i < 0) return;
        ANALYSIS.hover = i;
        if (S && S.state && S.state.status === 'over' && S.moves && S.moves.length) {
          reviewGoto(i);
        } else {
          drawWinChart();
        }
      });
    }
    $('bd-refresh').addEventListener('click', function () { loadLists(true); toast('已刷新'); });
    $('bd-history-filter').addEventListener('click', function (e) {
      var btn = e.target;
      while (btn && btn !== this && !(btn.getAttribute && btn.getAttribute('data-hg') !== null)) btn = btn.parentNode;
      if (!btn || btn === this) return;
      LOBBY.historyFilter = btn.getAttribute('data-hg') || '';
      LOBBY.historyLimit = 100;
      renderHistory();
    });
    $('bd-history-sort').addEventListener('click', function (e) {
      var btn = e.target;
      while (btn && btn !== this && !(btn.getAttribute && btn.getAttribute('data-hs') !== null)) btn = btn.parentNode;
      if (!btn || btn === this) return;
      LOBBY.historySort = btn.getAttribute('data-hs') || 'time';
      LOBBY.historyLimit = 100;
      renderHistory();
    });
    $('bd-history-more').addEventListener('click', function () {
      LOBBY.historyLimit = (LOBBY.historyLimit || 100) + 100;
      renderHistory();
    });
    $('bd-rank-game').addEventListener('change', function () {
      LOBBY.rankGame = this.value || 'xiangqi';
      loadBoardRank();
    });
    $('bd-rank-sort').addEventListener('change', function () {
      LOBBY.rankSort = this.value || 'wins';
      loadBoardRank();
    });
    $('bd-local').addEventListener('click', function () {
      if (LOBBY.rematch) {
        var rm = LOBBY.rematch;
        LOBBY.rematch = null;
        createLocalRoom(rm[0], rm[1], {
          game: LOBBY.game, size: LOBBY.size, minutes: LOBBY.minutes, forbid: LOBBY.forbid
        });
        return;
      }
      openLocalSetup();
    });
    $('bd-forbid').addEventListener('click', function () {
      LOBBY.forbid = !LOBBY.forbid;
      renderOptions();
    });
    $('bd-create').addEventListener('click', function () {
      createRoom({ game: LOBBY.game, size: LOBBY.size, minutes: LOBBY.minutes, color: LOBBY.color, forbid: LOBBY.forbid });
    });
    $('bd-join-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var v = ($('bd-code').value || '').replace(/[^0-9]/g, '');
      $('bd-code').value = v;
      if (v.length !== 3) { txt('bd-join-note', '邀请码是 3 位数字'); return; }
      txt('bd-join-note', '');
      openRoom(v, { watch: false });
    });
    $('bd-code').addEventListener('input', function () {
      this.value = this.value.replace(/[^0-9]/g, '').slice(0, 3);
    });

    $('bd-canvas').addEventListener('click', onBoardClick);

    var modeChips = document.querySelectorAll('.bd-setup-modes .chip');
    for (var mc = 0; mc < modeChips.length; mc++) {
      modeChips[mc].addEventListener('click', function () {
        setSetupMode(Number(this.getAttribute('data-p')), this.getAttribute('data-mode'));
      });
    }
    [1, 2].forEach(function (p) {
      var input = $('bd-p' + p + 'name');
      if (!input) return;
      input.addEventListener('input', function () {
        var mode = p === 1 ? LS.mode1 : LS.mode2;
        if (mode === 'no') {
          var v = digitsOnly(this.value);
          if (this.value !== v) this.value = v;
        }
        if (p === 1) LS.resolved1 = ''; else LS.resolved2 = '';
        var hint = $('bd-hint' + p);
        if (hint) { hint.textContent = ''; hint.className = 'bd-setup-hint'; }
        clearTimeout(p === 1 ? LS.timer1 : LS.timer2);
        var t = setTimeout(function () { lookupPlayer(p); }, 260);
        if (p === 1) LS.timer1 = t; else LS.timer2 = t;
      });
      input.addEventListener('focus', function () {
        var mode = p === 1 ? LS.mode1 : LS.mode2;
        if (mode === 'no' && this.value.length >= 8) this.select();
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
      if (S.moves && S.moves.length) reviewGoto(0);
      else draw();
      renderActions();
    });

    $('bd-review-start').addEventListener('click', function () { reviewGoto(0); });
    $('bd-review-prev').addEventListener('click', function () { reviewStep(-1); });
    $('bd-review-next').addEventListener('click', function () { reviewStep(1); });
    $('bd-review-end').addEventListener('click', function () {
      if (S) reviewGoto(S.moves.length);
    });
    $('bd-spectator-refresh').addEventListener('click', function () {
      loadSpectators(true);
    });

    $('bd-flip').addEventListener('click', function () {
      if (!S) return;
      S.flip = !S.flip;
      draw();
    });

    $('bd-score').addEventListener('click', function () {
      toggleGoScore();
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
        var localGame = isOfflineLocal() || isLocalRoom();
      var loser = S.state.turn;
      var msg = localGame
        ? '现在轮到 ' + nameForColor(loser) + ' 走。确定让 ' + nameForColor(loser) + ' 认输？'
        : '确定认输？这盘就结束了。';
      B8.confirm(msg, { title: '认输', danger: true, okText: '认输' })
        .then(function (ok) {
          if (!ok) return;
          if (isOfflineLocal()) {
            S.state = E.clone(S.state);
            S.state.status = 'over';
            S.state.winner = 3 - S.state.turn;
            S.state.reason = 'resign';
            S.clockRunning = 0;
            S.score = null;
            S.scoreBusy = false;
            saveLocal();
            renderAll();
            showResult();
            return;
          }
          B8.sb.rpc('b8_board_resign', { p_token: token(), p_code: S.code })
            .then(function (res) {
              S.room = res.room; S.state = res.state;
              S.resultShown = true;
              S.score = null;
              S.scoreBusy = false;
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
    $('bd-admin-close').addEventListener('click', function () {
      if (!S || !S.room) return;
      function closeAs(winner) {
        B8.sb.rpc('b8_board_admin_close', {
          p_token: (B8.auth && B8.auth.token && B8.auth.token()) || '',
          p_code: S.code,
          p_winner: winner
        }).then(function (res) {
          if (!res || !res.ok) throw new Error('关闭没成功');
          if (res.closed === 'wait') {
            toast('等人的房间已关闭');
            backToLobby();
            return;
          }
          S.room = res.room;
          S.state = res.state;
          S.resultShown = true;
          S.score = null;
          S.scoreBusy = false;
          renderAll();
          showResult();
          toast(winner === 3 ? '已强制关闭，记和棋' : '已强制关闭，判 ' + nameForColor(winner) + ' 胜');
        }).catch(function (err) {
          toast((err && err.message) || '关闭没成功');
        });
      }
      if (S.room.status === 'wait') {
        B8.confirm('关闭这个还没人进来的房间？', { title: '强制关闭', danger: true, okText: '关闭' })
          .then(function (ok) { if (ok) closeAs(3); });
        return;
      }
      B8.confirm('强制结束这盘？下一步选择谁胜 / 和棋，不能恢复。', {
        title: '强制关闭', danger: true, okText: '继续'
      }).then(function (ok) {
        if (!ok) return;
        B8.confirm('判 ' + nameForColor(1) + '（先手）胜？\n\n点「取消」可以继续选后手胜或和棋。', {
          title: '选择胜方', okText: nameForColor(1) + ' 胜'
        }).then(function (ok1) {
          if (ok1) { closeAs(1); return; }
          B8.confirm('判 ' + nameForColor(2) + '（后手）胜？\n\n点「取消」可以记和棋。', {
            title: '选择胜方', okText: nameForColor(2) + ' 胜'
          }).then(function (ok2) {
            if (ok2) { closeAs(2); return; }
            B8.confirm('记和棋并结束？', { title: '选择结果', danger: true, okText: '和棋' })
              .then(function (ok3) { if (ok3) closeAs(3); });
          });
        });
      });
    });
    $('bd-cancel-room').addEventListener('click', function () {
      if (!S || S.mode !== 'online') return;
      B8.confirm('解散房间？邀请的同学就进不来了。', { title: '解散房间', danger: true, okText: '解散' })
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
        LOBBY.rematch = (S.playerNames || ['玩家一', '玩家二']).slice();
        backToLobby();
        toast('选一种棋，点「本机对局」直接用原来的两位棋手开局');
        return;
      }
      var settings = {
        game: S.room.game,
        size: S.room.size,
        minutes: S.room.timed ? S.room.minutes : 0,
        color: S.seat || 1,
        forbid: !!(S.state && S.state.forbid)
      };
      if (isLocalRoom()) {
        LOBBY.rematch = [S.room.host_name, S.room.guest_name];
        backToLobby();
        toast('选一种棋，点「本机对局」直接用原来的两位棋手开局');
        return;
      }
      inviteRematch();
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
      if (S) S.anim = null;
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
    setTimeout(loadBoardRank, 1200);
    document.addEventListener('keydown', function (e) {
      if (!S || !S.reviewing) return;
      var tag = (e.target && e.target.tagName) || '';
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        reviewStep(-1);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        reviewStep(1);
      } else if (e.key === 'Home') {
        e.preventDefault();
        reviewGoto(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        if (S) reviewGoto(S.moves.length);
      }
    });
    updateWho();

    B8.auth.ready(function () {
      updateWho();
      loadLists(true);
    });

    // 邀请码：登录后自动进房
    var code = query('code');
    if (code) {
      var upCode = code.toUpperCase();
      var legacyCode = !isShortCode(upCode);
      pendingOpen = { code: upCode, watch: query('watch') === '1' || legacyCode };
      B8.auth.ready(function () {
        var o = pendingOpen;
        if (!o) return;
        if (legacyCode) {
          // 旧链接 / 刷新后的 6 位房间：直接只读回看，不弹登录、不报 3 位错误
          pendingOpen = null;
          openRoom(o.code, { watch: true, review: true, legacy: true });
          return;
        }
        if (o.watch) {
          pendingOpen = null;
          openRoom(o.code, { watch: true, review: query('review') === '1' });
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
      eval: function (st) { return evalState(st); },
      material: function (st) { return evalMaterial(st); },
      search: function (st) { return searchScore(st); },
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
