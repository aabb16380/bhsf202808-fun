/* ============================================================
   B8 · 首页「正在对弈」
   ------------------------------------------------------------
   读 b8_board_list（不需要登录），把还在进行 / 等人的棋局放在首页。
   点「观战」进 board.html?code=…&watch=1；等人的局点「加入」直接坐下。
   数据库没初始化（函数 404）就整块隐藏，不影响首页其它内容。
   ============================================================ */
(function () {
  'use strict';

  var B8 = window.B8;
  var section = document.getElementById('board-live');
  if (!B8 || !section) return;

  var listEl = document.getElementById('board-live-list');
  var noteEl = document.getElementById('board-live-note');
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

  function timeText(r) {
    return r.timed ? r.minutes + ' 分钟' : '不限时';
  }

  function card(r) {
    var g = GAMES[r.game] || { name: r.game, icon: '棋', colors: ['先', '后'] };
    var a = document.createElement('a');
    var waiting = r.status === 'wait';
    a.className = 'board-live-card' + (waiting ? ' is-wait' : '');
    a.href = 'board.html?code=' + encodeURIComponent(r.code) + (waiting ? '' : '&watch=1');

    var glyph = document.createElement('span');
    glyph.className = 'blc-glyph';
    glyph.textContent = g.icon;

    var main = document.createElement('span');
    main.className = 'blc-main';
    var title = document.createElement('b');
    title.textContent = g.name;
    var players = document.createElement('span');
    players.className = 'blc-players';
    players.innerHTML =
      esc(r.host_name || '房主') + ' <i>' + g.colors[r.host_color - 1] + '</i>' +
      ' <em>vs</em> ' +
      (r.guest_name ? esc(r.guest_name) + ' <i>' + g.colors[r.guest_color - 1] + '</i>' : '<u>空位</u>');
    var meta = document.createElement('span');
    meta.className = 'blc-meta';
    meta.textContent = (waiting ? '等人' : (r.seq || 0) + ' 手') + ' · ' + timeText(r) +
      (r.watchers ? ' · ' + r.watchers + ' 人观战' : '');
    main.appendChild(title);
    main.appendChild(players);
    main.appendChild(meta);

    var go = document.createElement('span');
    go.className = 'blc-go';
    go.textContent = waiting ? '加入 →' : '观战 →';

    a.appendChild(glyph);
    a.appendChild(main);
    a.appendChild(go);
    return a;
  }

  function render(rooms) {
    if (!listEl) return;
    listEl.innerHTML = '';
    if (!rooms.length) {
      section.hidden = true;
      return;
    }
    section.hidden = false;
    rooms.slice(0, 6).forEach(function (r) {
      listEl.appendChild(card(r));
    });
    if (noteEl) {
      noteEl.textContent = '共 ' + rooms.length + ' 盘在桌上 · 每 20 秒刷新';
    }
  }

  function schedule() {
    clearTimeout(timer);
    if (missing) return;
    timer = setTimeout(load, 20000);
  }

  function load() {
    if (missing || loading) return;
    if (document.hidden) {
      schedule();
      return;
    }
    if (!B8.sb || !B8.sb.ready) return;
    loading = true;
    lastLoad = Date.now();
    B8.sb.rpc('b8_board_list', { p_token: null })
      .then(function (res) {
        var rooms = (res && res.rooms) || [];
        rooms.sort(function (a, b) {
          if (a.status !== b.status) return a.status === 'play' ? -1 : 1;
          return new Date(b.updated_at) - new Date(a.updated_at);
        });
        render(rooms);
      })
      .catch(function (err) {
        // 函数还没建（SQL 没跑）就把这一块收起来，别在首页留个报错
        if (err && (err.status === 404 || /does not exist|schema cache|Could not find the function/i.test(err.message || ''))) {
          missing = true;
          section.hidden = true;
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

  // 首页先把其它内容画完，再补这一块
  setTimeout(load, 700);
})();
