/* ============================================================
   B8 · 首页「正在对弈」（膜宙金按钮下方）
   ------------------------------------------------------------
   读 b8_board_list（不需要登录），把还在进行 / 等人的棋局放在首屏。
   点「观战」进 board.html?code=…&watch=1；等人的局点「加入」直接坐下。
   数据库没初始化（函数 404）就整块隐藏，不影响首页其它内容。
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
  var missing = false;
  var lastLoad = 0;

  var GAMES = {
    xiangqi: { name: '中国象棋', icon: '帅', colors: ['红', '黑'] },
    chess: { name: '国际象棋', icon: '♞', colors: ['白', '黑'] },
    go: { name: '围棋', icon: '碁', colors: ['黑', '白'] },
    gomoku: { name: '五子棋', icon: '五', colors: ['黑', '白'] },
    draughts: { name: '国际跳棋', icon: '◉', colors: ['白', '黑'] }
  };

  function esc(s) { return B8.esc(s == null ? '' : s); }

  function row(r) {
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

  function render(rooms) {
    if (!listEl) return;
    listEl.innerHTML = '';
    if (!rooms.length) {
      mount.hidden = true;
      return;
    }
    mount.hidden = false;
    rooms.slice(0, 3).forEach(function (r) { listEl.appendChild(row(r)); });
    if (countEl) countEl.textContent = rooms.length + ' 盘在桌上';
  }

  function schedule() {
    clearTimeout(timer);
    if (missing) return;
    timer = setTimeout(load, 20000);
  }

  function load() {
    if (missing || loading) return;
    if (document.hidden) { schedule(); return; }
    if (!B8.sb || !B8.sb.ready) return;
    loading = true;
    lastLoad = Date.now();
    B8.sb.rpc('b8_board_list', { p_token: null })
      .then(function (res) {
        var rooms = ((res && res.rooms) || []).filter(function (r) { return !r.dormant; });
        rooms.sort(function (a, b) {
          if (a.status !== b.status) return a.status === 'play' ? -1 : 1;
          return new Date(b.updated_at) - new Date(a.updated_at);
        });
        render(rooms);
      })
      .catch(function (err) {
        if (err && (err.status === 404 || /does not exist|schema cache|Could not find the function/i.test(err.message || ''))) {
          missing = true;
          mount.hidden = true;
          return;
        }
        if (window.console) console.warn('[board-live] 读取失败', err);
      })
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
