/* ============================================================
   B8 · 首页「正在对局」（膜宙金按钮下方）
   ------------------------------------------------------------
   同时读 b8_board_list（棋类）和 b8_arcade_list（多人游戏），
   把还在进行 / 等人的对局放在首屏。
   · 棋类：点「观战」进 board.html?code=…&watch=1；等人的局点「加入」。
   · 多人：点「观战」进 arcade.html?room=…；等人的局点「加入」。
   数据库没初始化（某个函数 404）就只跳过那一类，不影响另一类。
   ============================================================ */
(function () {
  'use strict';

  var B8 = window.B8;
  var mount = document.getElementById('hero-live');
  if (!B8 || !mount) return;

  var listEl = document.getElementById('hero-live-list');
  var countEl = document.getElementById('hero-live-count');
  var timer = 0;
  var loading = false;
  var boardMissing = false;
  var arcadeMissing = false;
  var lastLoad = 0;

  var GAMES = {
    xiangqi: { name: '中国象棋', icon: '帅', colors: ['红', '黑'] },
    chess: { name: '国际象棋', icon: '♞', colors: ['白', '黑'] },
    go: { name: '围棋', icon: '碁', colors: ['黑', '白'] },
    gomoku: { name: '五子棋', icon: '五', colors: ['黑', '白'] },
    draughts: { name: '国际跳棋', icon: '◉', colors: ['白', '黑'] }
  };
  var ARCADES = {
    quoridor: { name: '步步为营', icon: '墙' },
    graphwar: { name: '函数大战', icon: 'ƒ' }
  };

  function esc(s) { return B8.esc(s == null ? '' : s); }

  function boardRow(r) {
    var g = GAMES[r.game] || { name: r.game, icon: '棋', colors: ['先', '后'] };
    var waiting = r.status === 'wait';
    var a = document.createElement('a');
    a.className = 'hero-live-row' + (waiting ? ' is-wait' : '');
    a.href = 'board.html?code=' + encodeURIComponent(r.code) + (waiting ? '' : '&watch=1');

    var icon = document.createElement('span');
    icon.className = 'hlr-icon';
    icon.textContent = g.icon;

    var main = document.createElement('span');
    main.className = 'hlr-main';
    var line = document.createElement('b');
    line.textContent = g.name + (r.mode === 'local' ? ' · 本机' : '');
    var who = document.createElement('span');
    who.className = 'hlr-who';
    who.innerHTML =
      esc(r.host_name || '房主') + ' <i>' + g.colors[r.host_color - 1] + '</i>' +
      ' <em>vs</em> ' +
      (r.guest_name ? esc(r.guest_name) + ' <i>' + g.colors[r.guest_color - 1] + '</i>' : '<u>空位</u>');
    main.appendChild(line);
    main.appendChild(who);

    var meta = document.createElement('span');
    meta.className = 'hlr-meta';
    meta.textContent = (waiting ? '等人' : (r.seq || 0) + ' 手') +
      (r.watchers ? ' · ' + r.watchers + ' 人看' : '');

    var go = document.createElement('span');
    go.className = 'hlr-go';
    go.textContent = waiting ? '加入 →' : '观战 →';

    a.appendChild(icon);
    a.appendChild(main);
    a.appendChild(meta);
    a.appendChild(go);
    return a;
  }

  function arcadeRow(r) {
    var g = ARCADES[r.game] || { name: r.game, icon: '玩' };
    var waiting = r.status === 'wait';
    var a = document.createElement('a');
    a.className = 'hero-live-row' + (waiting ? ' is-wait' : '');
    a.href = 'arcade.html?room=' + encodeURIComponent(r.code) + (waiting ? '' : '&watch=1');

    var icon = document.createElement('span');
    icon.className = 'hlr-icon';
    icon.textContent = g.icon;

    var main = document.createElement('span');
    main.className = 'hlr-main';
    var line = document.createElement('b');
    line.textContent = g.name + (r.team_mode === 'team' ? ' · 组队' : '');
    var who = document.createElement('span');
    who.className = 'hlr-who';
    var names = (r.seats || []).map(function (s) { return s.name || s.no || '同学'; });
    who.innerHTML = names.length
      ? names.map(esc).join(' <em>vs</em> ')
      : '<u>空位</u>';
    main.appendChild(line);
    main.appendChild(who);

    var meta = document.createElement('span');
    meta.className = 'hlr-meta';
    meta.textContent = (waiting ? '等人' : ((r.seats || []).length + ' 人')) +
      (!waiting && r.turn ? ' · ' + r.turn + ' 号行动' : '');

    var go = document.createElement('span');
    go.className = 'hlr-go';
    go.textContent = waiting ? '加入 →' : '观战 →';

    a.appendChild(icon);
    a.appendChild(main);
    a.appendChild(meta);
    a.appendChild(go);
    return a;
  }

  function render(rooms, arcadeRooms) {
    if (!listEl) return;
    listEl.innerHTML = '';
    var all = [];
    rooms.forEach(function (r) { all.push({ kind: 'board', r: r }); });
    (arcadeRooms || []).forEach(function (r) { all.push({ kind: 'arcade', r: r }); });
    if (!all.length) {
      mount.hidden = true;
      return;
    }
    all.sort(function (a, b) {
      var sa = a.r.status === 'play' ? 0 : 1;
      var sb = b.r.status === 'play' ? 0 : 1;
      if (sa !== sb) return sa - sb;
      return new Date(b.r.updated_at || 0) - new Date(a.r.updated_at || 0);
    });
    mount.hidden = false;
    all.slice(0, 3).forEach(function (x) {
      listEl.appendChild(x.kind === 'board' ? boardRow(x.r) : arcadeRow(x.r));
    });
    if (countEl) countEl.textContent = all.length + ' 盘在桌上';
  }

  function schedule() {
    clearTimeout(timer);
    if (boardMissing && arcadeMissing) return;
    timer = setTimeout(load, 20000);
  }

  function fetchBoard() {
    if (boardMissing) return Promise.resolve([]);
    return B8.sb.rpc('b8_board_list', { p_token: null }).then(function (res) {
      return ((res && res.rooms) || []).filter(function (r) { return !r.dormant; });
    }, function (err) {
      if (err && (err.status === 404 || /does not exist|schema cache|Could not find the function/i.test(err.message || ''))) {
        boardMissing = true;
        return [];
      }
      if (window.console) console.warn('[board-live] 读取失败', err);
      return [];
    });
  }

  function fetchArcade() {
    if (arcadeMissing) return Promise.resolve([]);
    return B8.sb.rpc('b8_arcade_list', { p_token: null }).then(function (res) {
      return ((res && res.rooms) || []).filter(function (r) {
        return !r.is_private && (r.status === 'play' || r.status === 'wait');
      });
    }, function (err) {
      if (err && (err.status === 404 || /does not exist|schema cache|Could not find the function/i.test(err.message || ''))) {
        arcadeMissing = true;
        return [];
      }
      if (window.console) console.warn('[arcade-live] 读取失败', err);
      return [];
    });
  }

  function load() {
    if (loading) return;
    if (document.hidden) { schedule(); return; }
    if (!B8.sb || !B8.sb.ready) return;
    loading = true;
    lastLoad = Date.now();
    Promise.all([fetchBoard(), fetchArcade()])
      .then(function (rows) { render(rows[0], rows[1]); })
      .then(function () {
        loading = false;
        schedule();
      });
  }

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && Date.now() - lastLoad > 5000) load();
  });

  setTimeout(load, 700);
})();
