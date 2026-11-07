/* ============================================================
   B8 多人大厅（arcade.html）
   ------------------------------------------------------------
   三个游戏一个壳：
     · quoridor 步步为营（2-4 人）
     · graphwar 函数大战（2-8 人）
     · mines    无猜扫雷（单人，直接挂在大厅）
   游戏规则全在各个 arcade-*.js 模块里；这里负责大厅、房间、座位、
   同步（Supabase 权威 + 引擎 API 的 /ws/room 广播「变了」）、聊天、排行榜，
   以及 v2.152 的「每一局对局记录 + 回看」（记录存进 b8_arcade_games）。

   模块契约见 arcade-*.js 顶部注释；壳这边只保证：
     A.games[key] = { key, title, icon, sub, mode, seats, mount(root, ctx), destroy() }
   回看时 ctx 多一个 replay = { on, index, total }，seat = 0、只读；
   模块可以用 _test.applyAction(state, seat, act) 把记录里的动作重演出来。
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
    syncQueued: false,
    joined: false,
    result: '',
    dbMissing: false,
    lastList: 0,
    round: 0,
    overShown: false,
    rematchPrompted: false,
    // v2.152：对局记录 / 回看 / 本机对局流水
    records: { mine: [], recent: [] },
    recTab: 'mine',
    recordsAt: 0,
    recordsError: '',
    localActs: [],
    localInit: null,
    localStartedAt: 0,
    localSaved: false,
    replay: null
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
     〇、对局记录的小工具（v2.152）
     ============================================================ */

  var REC_KEY = 'b8arcade.local.records.v1';
  var REC_MAX = 8;

  function pad2(n) { n = Number(n) || 0; return (n < 10 ? '0' : '') + n; }

  function fmtWhen(iso) {
    var d = iso ? new Date(iso) : null;
    if (!d || isNaN(d.getTime())) return '';
    return (d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
      pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function fmtDuration(ms) {
    ms = Math.max(0, Number(ms) || 0);
    var sec = Math.round(ms / 1000);
    if (sec < 60) return sec + ' 秒';
    var min = Math.floor(sec / 60);
    var rest = sec % 60;
    if (min < 60) return min + ' 分 ' + pad2(rest) + ' 秒';
    return Math.floor(min / 60) + ' 小时 ' + pad2(min % 60) + ' 分';
  }

  function recSeatName(rec, seat) {
    var list = (rec && rec.players) || [];
    for (var i = 0; i < list.length; i++) {
      if (Number(list[i].seat) === Number(seat)) return String(list[i].name || ('玩家 ' + seat));
    }
    return seat ? (seat + ' 号') : '';
  }

  function recPlayersText(rec) {
    var list = ((rec && rec.players) || []).slice().sort(function (a, b) {
      return Number(a.seat) - Number(b.seat);
    });
    if (!list.length) return (rec && rec.n ? rec.n + ' 人' : '—');
    return list.map(function (p) { return p.name || ('玩家 ' + p.seat); }).join(' · ');
  }

  function recWinnerName(rec) {
    if (!rec) return '';
    if (rec.winner_name) return String(rec.winner_name);
    return Number(rec.winner) > 0 ? recSeatName(rec, rec.winner) : '';
  }

  function recResultText(rec) {
    if (!rec) return '';
    if (rec.reason === 'leave') return '有人离开，对局结束';
    if (rec.reason === 'closed') return '房间已解散';
    var who = recWinnerName(rec);
    return who ? who + ' 获胜' : '对局结束';
  }

  function recSourceText(rec) {
    if (rec && rec.source === 'local') {
      var who = rec.owner_name || '';
      var no = rec.owner_no || '';
      return '本机' + (who ? ' · ' + who : '') + (no ? '（' + no + '）' : '');
    }
    return rec && rec.room_code ? '房号 ' + rec.room_code : '联机';
  }

  function readLocalRecords() {
    try {
      var raw = window.localStorage ? window.localStorage.getItem(REC_KEY) : '';
      var list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch (e) {
      return [];
    }
  }

  function writeLocalRecords(list) {
    try {
      if (!window.localStorage) return;
      window.localStorage.setItem(REC_KEY, JSON.stringify((list || []).slice(0, REC_MAX)));
    } catch (e) {}
  }

  function removeLocalRecord(rec) {
    if (!rec || !rec.localId) return;
    writeLocalRecords(readLocalRecords().filter(function (r) {
      return r && r.localId !== rec.localId;
    }));
  }

  function saveLocalRecord(rec) {
    if (!rec || !rec.localId) return;
    var list = readLocalRecords();
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].localId === rec.localId) {
        list[i] = rec;
        writeLocalRecords(list);
        return;
      }
    }
    list.unshift(rec);
    writeLocalRecords(list);
  }

  function patchLocalRecord(localId, patch) {
    if (!localId || !patch) return;
    var list = readLocalRecords();
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].localId === localId) {
        for (var k in patch) {
          if (Object.prototype.hasOwnProperty.call(patch, k)) list[i][k] = patch[k];
        }
        writeLocalRecords(list);
        return;
      }
    }
  }

  function newLocalId() {
    return 'L' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  /* ============================================================
     一、大厅
     ============================================================ */

  function renderGames() {
    var box = $('ag-games');
    if (!box) return;
    box.innerHTML = '';
    ['graphwar', 'quoridor'].forEach(function (key) {
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
    if (m.seats.indexOf(S.seats) < 0) {
      S.seats = m.seats[0];
    }
    renderGames();
    renderOptions();
  }

  function renderOptions() {
    var m = meta(S.game);
    var multi = m.mode === 'multi';
    txt('ag-start-title', '开一局' + m.title);
    txt('ag-start-note', '选好人数：开房间会生成 4 位房号，发同学就能进来；本地游玩是一台设备上几个人轮流。');

    show('ag-seat-row', multi);
    show('ag-mode-row', multi && S.game === 'graphwar');
    show('ag-private-row', multi);
    show('ag-name-row', multi);
    show('ag-create', multi);
    show('ag-local', multi);
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
        var msg = errText(err);
        if (/ambiguous|column reference|r\.id/i.test(msg)) {
          msg = '大厅 SQL 还是旧版（b8_arcade_list 有 r.id 歧义），请重跑最新 install-all.sql。';
        }
        if (n) {
          n.hidden = false;
          n.textContent = /数据库还没更新/.test(msg)
            ? '多人大厅的数据库还没初始化：请管理员在 Supabase SQL Editor 跑一遍最新 install-all.sql。'
            : '多人大厅读取失败：' + msg;
        }
        renderRooms([], []);
        if (window.console) console.warn('[arcade] 列表失败', err);
      });
  }

  function roomLine(r) {
    var m = meta(r.game);
    var seats = r.seats || [];
    var away = 0;
    var names = seats.map(function (x) {
      if (x.left) away++;
      return (x.name || x.no) + (x.left ? '（离开）' : '');
    }).join(' vs ');
    return {
      title: m.title + (r.is_private ? ' · 私密' : '') +
        (r.status === 'wait' ? ' · 等人' : (r.status === 'play' ? ' · 对局中' : ' · 已结束')),
      sub: (r.name ? esc(r.name) + ' · ' : '') + '房号 ' + esc(r.code) + ' · ' +
        seats.length + '/' + r.max_seats + ' 人' +
        (away ? '（' + away + ' 人离开）' : '') +
        (names ? ' · ' + esc(names) : '')
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
    if (box) {
      box.innerHTML = '';
      var open = rooms.filter(function (r) { return r.status === 'wait' && !r.is_private; });
      if (!open.length) {
        var q = document.createElement('p');
        q.className = 'ag-empty';
        q.textContent = S.dbMissing ? '大厅读取失败，刷新试试。' : '现在没有公开房间。自己开一个，等人来。';
        box.appendChild(q);
      } else {
        open.forEach(function (r) { box.appendChild(roomRow(r, false)); });
      }
    }

    var liveBox = $('ag-live-rooms');
    if (liveBox) {
      liveBox.innerHTML = '';
      var live = rooms.filter(function (r) { return r.status === 'play' && !r.is_private; });
      if (!live.length) {
        var lp = document.createElement('p');
        lp.className = 'ag-empty';
        lp.textContent = S.dbMissing ? '大厅读取失败，刷新试试。' : '现在没有正在进行的对局。';
        liveBox.appendChild(lp);
      } else {
        live.forEach(function (r) { liveBox.appendChild(roomRow(r, false)); });
      }
    }
  }

  /* ============================================================
     一·二、对局记录（大厅里的「我的对局 / 最近对局」）
     ============================================================ */

  function loadRecords(force) {
    if (!B8.sb || !B8.sb.ready) { renderRecords(); return; }
    if (!force && Date.now() - (S.recordsAt || 0) < 8000) return;
    S.recordsAt = Date.now();
    rpc('b8_arcade_games_list', {
      p_token: logged() ? token() : null,
      p_limit: 24
    }).then(function (res) {
      S.records = {
        mine: (res && res.mine) || [],
        recent: (res && res.recent) || []
      };
      S.recordsError = '';
      renderRecords();
    }).catch(function (err) {
      S.recordsError = errText(err);
      renderRecords();
      if (window.console) console.warn('[arcade] 对局记录读取失败', err);
    });
  }

  function visibleRecords() {
    var mine = (S.records && S.records.mine) || [];
    if (S.recTab === 'recent') return (S.records && S.records.recent) || [];
    var seen = {};
    mine.forEach(function (r) { if (r) seen[String(r.id)] = true; });
    var local = readLocalRecords().filter(function (r) {
      if (!r) return false;
      if (!r.server_id) return true;
      // 已经进库：服务端列表里有时就不重复显示
      return !seen[String(r.server_id)];
    });
    var out = mine.concat(local);
    out.sort(function (a, b) {
      var ta = new Date((a && a.ended_at) || 0).getTime() || 0;
      var tb = new Date((b && b.ended_at) || 0).getTime() || 0;
      return tb - ta;
    });
    return out;
  }

  function deleteRecord(rec) {
    if (!rec) return;
    var serverId = Number(rec.server_id || (rec.source !== 'local' ? rec.id : 0)) || 0;
    var localId = rec.localId || 0;
    if (!serverId && !localId) { B8.toast('这条记录不能删'); return; }
    var m = meta(rec.game);
    var label = (m ? m.title : '对局') + ' · ' + recPlayersText(rec) + ' · ' + recResultText(rec);
    B8.confirm('删除对局记录「' + label + '」？删掉后回放链接会失效。', {
      title: '删除对局记录', okText: '删除', danger: true
    }).then(function (ok) {
      if (!ok) return;
      var done = function () {
        if (localId) removeLocalRecord(rec);
        B8.toast('对局记录已删除');
        loadRecords(true);
        renderRecords();
      };
      if (serverId) {
        rpc('b8_arcade_record_delete', { p_token: token(), p_id: serverId })
          .then(done).catch(function (err) { B8.toast(errText(err)); });
      } else {
        done();
      }
    });
  }

  function recordRow(rec) {
    var wrap = document.createElement('div');
    wrap.className = 'ag-rec';
    var m = meta(rec.game);
    var icon = document.createElement('span');
    icon.className = 'ag-rec-icon';
    icon.textContent = m.icon;
    icon.setAttribute('aria-hidden', 'true');
    wrap.appendChild(icon);

    var main = document.createElement('div');
    main.className = 'ag-rec-main';
    var title = document.createElement('b');
    title.textContent = m.title + ' · ' + recPlayersText(rec) + ' · ' + recResultText(rec);
    var sub = document.createElement('span');
    var bits = [fmtWhen(rec.ended_at), fmtDuration(rec.duration_ms)];
    if (rec.moves != null) bits.push(rec.moves + ' 步');
    if (rec.game === 'graphwar' && rec.shots != null) bits.push(rec.shots + ' 炮');
    bits.push(recSourceText(rec));
    if (rec.id && rec.source !== 'local') bits.push('#' + rec.id);
    else if (rec.server_id) bits.push('#' + rec.server_id);
    sub.textContent = bits.join(' · ');
    main.appendChild(title);
    main.appendChild(sub);
    wrap.appendChild(main);

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ag-room-btn';
    btn.textContent = '看回放';
    btn.addEventListener('click', function () { openRecord(rec); });
    wrap.appendChild(btn);

    if (B8.auth && B8.auth.isSuper && B8.auth.isSuper()) {
      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'ag-room-btn ag-rec-del';
      del.textContent = '删除';
      del.title = '超管删除这条对局记录';
      del.addEventListener('click', function (e) {
        e.stopPropagation();
        deleteRecord(rec);
      });
      wrap.appendChild(del);
    }
    return wrap;
  }

  function renderRecords() {
    var box = $('ag-records');
    if (!box) return;
    box.innerHTML = '';
    var list = visibleRecords();
    if (!list.length) {
      var p = document.createElement('p');
      p.className = 'ag-empty';
      if (S.recordsError) {
        p.textContent = '对局记录还没同步下来；本机游玩的会先存在这台设备上。';
      } else if (S.recTab === 'recent') {
        p.textContent = '还没有人打完一局。开一局，打完自动留记录。';
      } else if (!logged()) {
        p.textContent = '登录后这里显示你打过的每一局；本机游玩也会留一份。';
      } else {
        p.textContent = '你还没打过。开一局，打完自动留记录。';
      }
      box.appendChild(p);
    } else {
      list.forEach(function (rec) { if (rec) box.appendChild(recordRow(rec)); });
    }

    var mineBtn = $('ag-rec-mine');
    var recBtn = $('ag-rec-recent');
    if (mineBtn) {
      mineBtn.className = 'chip' + (S.recTab === 'mine' ? ' is-on' : '');
      mineBtn.setAttribute('aria-pressed', S.recTab === 'mine' ? 'true' : 'false');
    }
    if (recBtn) {
      recBtn.className = 'chip' + (S.recTab === 'recent' ? ' is-on' : '');
      recBtn.setAttribute('aria-pressed', S.recTab === 'recent' ? 'true' : 'false');
    }

    var note = $('ag-rec-note');
    if (note) {
      if (S.recordsError) {
        note.textContent = '对局记录读不出来：' + S.recordsError;
        note.className = 'ag-hint is-warn';
      } else if (!logged() && S.recTab === 'mine') {
        note.textContent = '本机记录只存在这台设备；登录后每一局都会存到服务器，换设备也能看。';
        note.className = 'ag-hint';
      } else {
        note.textContent = '每一局打完自动保存；点「看回放」能一步步重看，链接也能发给同学。';
        note.className = 'ag-hint';
      }
    }
  }

  /* ============================================================
     一·三、对局回看（和棋谱回看一个意思）
     ------------------------------------------------------------
     记录里存了「开局局面 + 每一步动作」，这里按模块的纯规则一步步重演。
     回看是只读的：ctx.seat = 0，ctx.replay 标记，模块不画结算层。
     ============================================================ */

  function openRecord(recOrId) {
    if (!recOrId) return;
    if (typeof recOrId === 'object') {
      if (recOrId.acts && recOrId.state) { startReplay(recOrId); return; }
      if (recOrId.server_id) { openRecord(Number(recOrId.server_id)); return; }
      if (recOrId.id && !recOrId.localId) { openRecord(Number(recOrId.id)); return; }
      if (recOrId.localId) { startReplay(recOrId); return; }
      B8.toast('这条记录不完整');
      return;
    }
    var id = Number(recOrId);
    if (!id) return;
    rpc('b8_arcade_game', { p_id: id }).then(function (rec) {
      if (!rec) { B8.toast('这条对局记录不存在了'); return; }
      startReplay(rec);
    }).catch(function (err) {
      B8.toast('记录打不开：' + errText(err));
    });
  }

  function startReplay(rec) {
    if (!rec || !rec.game) { B8.toast('这条记录不完整'); return; }
    if (S.view === 'replay') closeReplay(true);
    var back = S.room ? { room: S.room, seat: S.seat, round: S.round, local: !!S.local } : null;
    wsClose();
    clearTimeout(S.pollTimer);
    destroyModule();
    S.local = false;
    S.seat = 0;

    var acts = Array.isArray(rec.acts) ? rec.acts.slice() : [];
    var init = null;
    var broken = false;
    if (acts.length && acts[0] && acts[0].act && acts[0].act.state) {
      init = acts[0].act.state;
      acts = acts.slice(1);
    } else if (rec.state) {
      init = rec.state;
      acts = [];
      broken = true;
    } else {
      B8.toast('这条记录没有局面数据');
      return;
    }

    // v2.173：记录尾部可能带 type=chat 的公屏消息；回放步数里过滤掉，单独展示。
    var chatMsgs = [];
    acts = acts.filter(function (a) {
      var act = (a && a.act) || {};
      if (String(act.type || '') === 'chat') {
        chatMsgs.push({
          seat: Number(a.seat) || 0,
          nick: act.nick || '',
          body: act.body || '',
          at: act.at || a.at || ''
        });
        return false;
      }
      if (String(act.type || '') === 'surrender') return false;
      return true;
    });
    if (!Array.isArray(rec.chat)) rec.chat = chatMsgs;

    S.replay = {
      rec: rec,
      back: back,
      acts: acts,
      frames: [init],
      index: 0,
      total: acts.length,
      broken: broken,
      timer: 0
    };
    var seats = ((rec.players || []).slice()).sort(function (a, b) {
      return Number(a.seat) - Number(b.seat);
    }).map(function (p) {
      return { seat: Number(p.seat), no: '', name: p.name || ('玩家 ' + p.seat) };
    });
    S.room = {
      id: 0,
      code: rec.id ? 'REC' + rec.id : 'LOCALREC',
      game: rec.game,
      name: '对局回看',
      status: 'over',
      is_private: true,
      max_seats: Number(rec.n) || seats.length || 2,
      team_mode: rec.team_mode || 'ffa',
      host_seat: 1,
      seats: seats,
      state: init,
      seq: 1,
      turn: Number(init && init.turn) || 0,
      winner: Number(rec.winner) || 0,
      record_id: rec.id || null
    };
    S.view = 'replay';
    S.round = 0;
    show('ag-lobby', false);
    show('ag-room', false);
    show('ag-replay', true);
    showGame('ag-over', false);
    renderReplayHead();
    renderReplayChat();
    mountReplayModule();
    replayTo(0);
    if (rec.id && !rec.localId) {
      try { history.replaceState(null, '', 'arcade.html?rec=' + encodeURIComponent(rec.id)); } catch (e) {}
    }
  }

  function mountReplayModule() {
    var rp = S.replay;
    var stage = $('ag-replay-stage');
    if (!rp || !stage) return;
    var m = mod(rp.rec.game);
    if (!m || typeof m.mount !== 'function') {
      stage.innerHTML = '<p class="ag-empty">这个游戏的模块没加载好，回放画不出来。</p>';
      return;
    }
    destroyModule();
    S.mod = m;
    S.modKey = 'replay:' + (rp.rec.id || rp.rec.localId || 'x');
    try {
      m.mount(stage, makeCtx());
    } catch (e) {
      if (window.console) console.warn('[arcade] 回放挂载失败', e);
      stage.innerHTML = '<p class="ag-empty">回放画面出错：' + esc(e && e.message) + '</p>';
      S.mod = null;
    }
  }

  function applyReplayAct(state, seat, act) {
    var rp = S.replay;
    if (!rp || !act) return null;
    var m = mod(rp.rec.game);
    if (!m) return null;
    try {
      if (m._test && typeof m._test.applyAction === 'function') {
        return m._test.applyAction(state, seat, act);
      }
      if (typeof m.applyAction === 'function') {
        return m.applyAction(state, seat, act);
      }
    } catch (e) {
      if (window.console) console.warn('[arcade] 回放这一手算不出来', e);
    }
    return null;
  }

  function replayFrameAt(i) {
    var rp = S.replay;
    if (!rp) return null;
    if (i <= 0) return rp.frames[0];
    while (rp.frames.length <= i) {
      var k = rp.frames.length - 1;
      var a = rp.acts[k];
      if (!a) break;
      var next = applyReplayAct(rp.frames[k], a.seat, a.act);
      if (!next) {
        // 旧记录 / 新规则对不上：这一手跳过；走到最后一步至少把终局亮出来
        rp.broken = true;
        next = (k + 1 >= rp.total && rp.rec.state) ? rp.rec.state : rp.frames[k];
      }
      rp.frames.push(next);
    }
    if (i >= rp.total && rp.broken && rp.rec.state) return rp.rec.state;
    return rp.frames[Math.min(i, rp.frames.length - 1)];
  }

  function replayTo(i) {
    var rp = S.replay;
    if (!rp || !S.room) return;
    i = Math.max(0, Math.min(rp.total, Number(i) || 0));
    rp.index = i;
    var st = replayFrameAt(i);
    S.room.state = st;
    S.room.turn = Number(st && st.turn) || 0;
    S.room.seq = i + 1;
    S.room.winner = i >= rp.total ? (Number(rp.rec.winner) || 0) : 0;
    notify();
    renderReplayBar();
    drawQuoridorAnalysis();
  }

  function sameOriginReferrer() {
    var ref = document.referrer || '';
    if (!ref) return false;
    try {
      var u = new URL(ref);
      return u.origin === location.origin && u.pathname !== location.pathname;
    } catch (e) {
      return false;
    }
  }

  // 手机 WebView / 直接打开链接时 history.back() 可能没有上一页，
  // 只 preventDefault 会变成“点了没反应”。这里带一个 350ms 的兜底跳转。
  function safeHistoryBack(fallback) {
    var done = false;
    function finish() {
      if (done) return;
      done = true;
      try { fallback(); } catch (e) {}
    }
    try {
      if (window.history.length <= 1) { finish(); return; }
      window.addEventListener('pagehide', function () { done = true; }, { once: true });
      window.history.back();
      setTimeout(finish, 350);
    } catch (e) {
      finish();
    }
  }

  function backFromReplay() {
    var rp = S.replay;
    if (rp && rp.back && rp.back.room) { closeReplay(false); return; }
    if (sameOriginReferrer()) {
      safeHistoryBack(function () { closeReplay(false); });
      return;
    }
    closeReplay(false);
  }

  function stopReplayTimer() {
    if (S.replay && S.replay.timer) {
      clearInterval(S.replay.timer);
      S.replay.timer = 0;
    }
  }

  /* ---------- 步步为营全局分析：每人到终点的最短路线长 ---------- */

  var QC_LINE_COLORS = ['#c1522f', '#2f6f5e', '#ac7c25', '#52618c'];

  function quoridorAnalysis() {
    var rp = S.replay;
    if (!rp || rp.rec.game !== 'quoridor') return null;
    var m = mod('quoridor');
    var T = m && m._test;
    if (!T || typeof T.pathLen !== 'function') return null;
    var players = (rp.rec.players || []).slice().sort(function (a, b) {
      return Number(a.seat) - Number(b.seat);
    });
    if (!players.length) return null;
    var series = players.map(function (p) {
      return {
        seat: Number(p.seat),
        name: p.name || p.no || ('座位 ' + p.seat),
        color: QC_LINE_COLORS[(Number(p.seat) - 1) % QC_LINE_COLORS.length],
        values: []
      };
    });
    var total = rp.total;
    for (var i = 0; i <= total; i++) {
      var st = replayFrameAt(i) || {};
      for (var s = 0; s < series.length; s++) {
        var seat = series[s].seat;
        var v = null;
        if ((st.rank || []).indexOf(seat) >= 0) {
          v = 0;
        } else {
          var pv = T.pathLen(st, seat);
          if (isFinite(pv) && pv >= 0) v = Number(pv);
        }
        series[s].values.push(v);
      }
    }
    return { series: series, total: total, index: rp.index };
  }

  function analysisPad() { return { left: 26, right: 8 }; }

  function drawQuoridorAnalysis() {
    var box = $('ag-quoridor-analysis');
    var cv = $('ag-analysis-canvas');
    if (!box || !cv) return;
    var data = quoridorAnalysis();
    if (!data) { box.hidden = true; return; }
    box.hidden = false;

    var w = Math.max(150, box.clientWidth - 18);
    var h = 132;
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var pw = Math.round(w * dpr), ph = Math.round(h * dpr);
    if (cv.width !== pw || cv.height !== ph) {
      cv.width = pw;
      cv.height = ph;
    }
    cv.style.width = '100%';
    cv.style.height = h + 'px';
    var g = cv.getContext && cv.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    var pad = analysisPad();
    var left = pad.left, right = pad.right, top = 24, bottom = 18;
    var plotW = Math.max(10, w - left - right);
    var plotH = Math.max(10, h - top - bottom);
    var maxV = 1;
    data.series.forEach(function (s) {
      s.values.forEach(function (v) { if (v != null && v > maxV) maxV = v; });
    });
    var yMax = Math.max(1, Math.ceil(maxV));
    function xAt(i) { return left + (data.total ? (i / data.total) * plotW : 0); }
    function yAt(v) { return top + plotH - (v / yMax) * plotH; }

    // 横向网格 + 纵轴刻度
    g.font = '8px Menlo, Consolas, monospace';
    g.textBaseline = 'middle';
    g.textAlign = 'right';
    for (var t = 0; t <= 4; t++) {
      var val = Math.round(yMax * t / 4);
      var y = yAt(val);
      g.strokeStyle = t === 0 ? 'rgba(86,69,45,.35)' : 'rgba(86,69,45,.12)';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(left, y);
      g.lineTo(left + plotW, y);
      g.stroke();
      g.fillStyle = '#8a8375';
      g.fillText(String(val), left - 5, y);
    }

    // 横轴刻度
    g.textAlign = 'center';
    g.textBaseline = 'top';
    var ticks = data.total <= 2 ? data.total : 2;
    for (var k = 0; k <= ticks; k++) {
      var step = ticks ? Math.round(data.total * k / ticks) : 0;
      var x = xAt(step);
      g.fillStyle = '#8a8375';
      g.fillText(String(step), x, top + plotH + 5);
    }
    g.textAlign = 'right';
    g.fillStyle = '#8a8375';
    g.fillText('步数', left + plotW, h - 4);
    g.save();
    g.translate(10, top + 2);
    g.rotate(-Math.PI / 2);
    g.textAlign = 'right';
    g.fillText('最短路线长', 0, 0);
    g.restore();

    // 当前步竖线
    if (data.total > 0) {
      var cx = xAt(data.index);
      g.strokeStyle = 'rgba(193,82,47,.35)';
      g.setLineDash([3, 3]);
      g.beginPath();
      g.moveTo(cx, top);
      g.lineTo(cx, top + plotH);
      g.stroke();
      g.setLineDash([]);
    }

    // 每个玩家一条线
    data.series.forEach(function (s) {
      g.strokeStyle = s.color;
      g.fillStyle = s.color;
      g.lineWidth = 1.8;
      g.lineJoin = 'round';
      g.beginPath();
      var started = false;
      for (var i = 0; i < s.values.length; i++) {
        var v = s.values[i];
        if (v == null) { started = false; continue; }
        var x = xAt(i), y = yAt(v);
        if (!started) { g.moveTo(x, y); started = true; }
        else g.lineTo(x, y);
      }
      g.stroke();
      // 当前点
      if (data.index < s.values.length && s.values[data.index] != null) {
        g.beginPath();
        g.arc(xAt(data.index), yAt(s.values[data.index]), 3, 0, Math.PI * 2);
        g.fill();
      }
    });

    // 图例
    var lx = left;
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.font = '9px sans-serif';
    data.series.forEach(function (s) {
      g.fillStyle = s.color;
      g.beginPath();
      g.arc(lx + 4, 12, 3.2, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#4b463c';
      g.fillText(s.name, lx + 11, 12);
      lx += 11 + g.measureText(s.name).width + 12;
    });
  }

  function replayActText(rec, a, i) {
    var act = (a && a.act) || {};
    var who = recSeatName(rec, a && a.seat) || ((a && a.seat) + ' 号');
    var t = String(act.type || '');
    if (rec.game === 'quoridor') {
      if (t === 'move') return who + ' 走到 (' + act.x + ', ' + act.y + ')';
      if (t === 'wall') {
        var w = act.wall || {};
        return who + ' 放' + (String(w.dir) === 'v' ? '竖墙' : '横墙') +
          ' (' + Number(w.x) + ', ' + Number(w.y) + ')';
      }
      if (t === 'timeout') return who + ' 超时，跳过';
    } else {
      if (t === 'shot') {
        var mode = act.mode === 'y2' ? "y'' =" : 'y =';
        return who + ' 发射 ' + mode + ' ' + String(act.expr == null ? '?' : act.expr);
      }
      if (t === 'timeout') return who + ' 超时，跳过';
    }
    return who + ' · ' + (t || '动作');
  }

  function replayShotMark(idx, a) {
    var rp = S.replay;
    if (!rp || rp.rec.game !== 'graphwar') return '';
    var act = (a && a.act) || {};
    if (String(act.type || '') !== 'shot') return '';
    var st;
    try { st = replayFrameAt(idx + 1); } catch (e) { return ''; }
    var shots = (st && st.shots) || [];
    var rec = shots[shots.length - 1];
    if (!rec) return '';
    if (rec.hits && rec.hits.length) return '命中';
    if (rec.hitObstacle) return '炸洞';
    return '';
  }

  function renderReplayChat() {
    var rp = S.replay;
    var box = $('ag-replay-chat-list');
    var count = $('ag-replay-chat-count');
    if (!box) return;
    var list = (rp && rp.rec && Array.isArray(rp.rec.chat)) ? rp.rec.chat : [];
    if (count) count.textContent = String(list.length);
    box.innerHTML = '';
    if (!list.length) {
      var empty = document.createElement('p');
      empty.className = 'ag-empty';
      empty.textContent = '本局没有公屏聊天';
      box.appendChild(empty);
      return;
    }
    for (var i = 0; i < list.length; i++) {
      var msg = list[i] || {};
      var row = document.createElement('div');
      row.className = 'ag-replay-chat-row';
      var name = document.createElement('b');
      var seat = Number(msg.seat) || 0;
      name.textContent = (seat > 0 ? recSeatName(rp.rec, seat) : '') ||
        msg.nick || msg.no || '同学';
      var body = document.createElement('span');
      body.textContent = String(msg.body == null ? '' : msg.body);
      var time = document.createElement('em');
      try {
        time.textContent = new Date(msg.at).toLocaleTimeString('zh-CN', {
          hour: '2-digit', minute: '2-digit'
        });
      } catch (e) { time.textContent = ''; }
      row.appendChild(name);
      row.appendChild(body);
      if (time.textContent) row.appendChild(time);
      box.appendChild(row);
    }
  }

  function renderReplayHead() {
    var rp = S.replay;
    if (!rp) return;
    var rec = rp.rec;
    var m = meta(rec.game);
    txt('ag-replay-title', m.title + ' · 对局回看' + (rec.id ? ' #' + rec.id : ''));
    txt('ag-replay-meta', [
      fmtWhen(rec.ended_at),
      fmtDuration(rec.duration_ms),
      recResultText(rec),
      recSourceText(rec)
    ].filter(Boolean).join(' · '));

    var box = $('ag-replay-players');
    if (box) {
      box.innerHTML = '';
      var players = ((rec.players || []).slice()).sort(function (a, b) {
        return Number(a.seat) - Number(b.seat);
      });
      players.forEach(function (p) {
        var el = document.createElement('span');
        var win = Number(p.seat) === Number(rec.winner) && Number(rec.winner) > 0;
        el.className = 'ag-player' + (win ? ' is-turn' : '');
        var i = document.createElement('i');
        i.textContent = String(p.seat);
        var b = document.createElement('span');
        b.textContent = (p.name || ('玩家 ' + p.seat)) + (win ? ' · 赢' : '');
        el.appendChild(i);
        el.appendChild(b);
        box.appendChild(el);
      });
    }

    var info = $('ag-replay-info');
    if (info) info.textContent = (rec.moves != null ? rec.moves + ' 步' : '') +
      (rec.game === 'graphwar' && rec.shots != null ? ' · ' + rec.shots + ' 炮' : '');

    var log = $('ag-replay-log');
    if (log) {
      log.innerHTML = '';
      if (!rp.acts.length) {
        var p = document.createElement('p');
        p.className = 'ag-empty';
        p.textContent = rp.broken ? '这条记录只有终局，没有逐步流水。' : '这局没有可回看的动作。';
        log.appendChild(p);
      } else {
        rp.acts.forEach(function (a, idx) {
          var row = document.createElement('button');
          row.type = 'button';
          row.className = 'ag-replay-row';
          row.setAttribute('data-step', String(idx + 1));
          var no = document.createElement('em');
          no.textContent = String(idx + 1);
          var tx = document.createElement('span');
          tx.textContent = replayActText(rec, a, idx);
          row.appendChild(no);
          row.appendChild(tx);
          var mark = replayShotMark(idx, a);
          if (mark) {
            row.className += ' is-hit';
            row.setAttribute('data-hit', '1');
            var tag = document.createElement('b');
            tag.className = 'ag-replay-hit';
            tag.textContent = mark;
            row.appendChild(tag);
          }
          row.addEventListener('click', function () { replayTo(idx + 1); });
          log.appendChild(row);
        });
      }
    }
    renderReplayBar();
  }

  function renderReplayBar() {
    var rp = S.replay;
    if (!rp) return;
    txt('ag-replay-step', rp.total
      ? '第 ' + rp.index + ' / ' + rp.total + ' 步'
      : (rp.broken ? '只有终局' : '没有动作'));
    var first = $('ag-replay-first');
    var prev = $('ag-replay-prev');
    var next = $('ag-replay-next');
    var last = $('ag-replay-last');
    var play = $('ag-replay-play');
    if (first) first.disabled = rp.index <= 0;
    if (prev) prev.disabled = rp.index <= 0;
    if (next) next.disabled = rp.index >= rp.total;
    if (last) last.disabled = rp.index >= rp.total;
    if (play) {
      play.textContent = rp.timer ? '⏸ 暂停' : '▶ 自动';
      play.disabled = rp.total <= 0;
      play.classList[rp.timer ? 'add' : 'remove']('is-on');
    }
    var log = $('ag-replay-log');
    if (log) {
      var rows = log.querySelectorAll('.ag-replay-row');
      for (var i = 0; i < rows.length; i++) {
        var step = Number(rows[i].getAttribute('data-step'));
        rows[i].className = 'ag-replay-row' +
          (step === rp.index ? ' is-on' : '') +
          (rows[i].getAttribute('data-hit') === '1' ? ' is-hit' : '');
      }
    }
  }

  function toggleReplayAuto() {
    var rp = S.replay;
    if (!rp) return;
    if (rp.timer) {
      stopReplayTimer();
      renderReplayBar();
      return;
    }
    if (rp.index >= rp.total) replayTo(0);
    rp.timer = setInterval(function () {
      if (!S.replay || S.view !== 'replay') { stopReplayTimer(); return; }
      if (S.replay.index >= S.replay.total) {
        stopReplayTimer();
        renderReplayBar();
        return;
      }
      replayTo(S.replay.index + 1);
    }, 1300);
    renderReplayBar();
  }

  function closeReplay(silent) {
    var rp = S.replay;
    if (!rp) return;
    stopReplayTimer();
    destroyModule();
    var back = rp.back;
    S.replay = null;
    S.local = false;
    if (back && back.room) {
      S.room = back.room;
      S.seat = back.seat || 0;
      S.round = back.round || 0;
      S.local = !!back.local;
      S.view = 'room';
      show('ag-replay', false);
      show('ag-room', true);
      S.modKey = '';
      renderRoom();
      ensureModule();
      if (!S.local && S.room.code) {
        wsConnect(S.room.code);
        schedulePoll();
        try {
          history.replaceState(null, '', 'arcade.html?room=' + encodeURIComponent(S.room.code));
        } catch (e) {}
      }
      return;
    }
    S.room = null;
    S.seat = 0;
    S.view = 'lobby';
    show('ag-replay', false);
    show('ag-room', false);
    show('ag-lobby', true);
    if (!silent) {
      try { history.replaceState(null, '', 'arcade.html'); } catch (e) {}
    }
    loadLists(true);
    loadRecords(true);
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

  function createRoom() {
    if (!requireLogin('开房间要登录（要记座位和分数）')) return;
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
    var btn = $('ag-create');
    if (btn) btn.disabled = true;
    rpc('b8_arcade_create', args).then(function (res) {
      if (btn) btn.disabled = false;
      enterRoom(res.room, res.seat || 0, true);
    }).catch(function (err) {
      if (btn) btn.disabled = false;
      B8.toast(errText(err));
    });
  }

  /* ---------- 本地游玩：一台设备，几个人轮流 ---------- */

  function buildState(seats, teamMode) {
    var m = mod(S.game);
    if (!m) return null;
    try {
      if (typeof m.newState === 'function') {
        return m.newState({ players: seats.length, seats: seats, teamMode: teamMode });
      }
      if (m._test) {
        if (S.game === 'quoridor' && typeof m._test.init === 'function') return m._test.init(seats.length);
        if (S.game === 'graphwar' && typeof m._test.newState === 'function') {
          return m._test.newState(seats.length, teamMode);
        }
      }
    } catch (e) {
      if (window.console) console.warn('[arcade] buildState', e);
    }
    return null;
  }

  var LS = { mode: {}, resolved: {}, timers: {}, busy: false };

  function defaultSeatName(i) {
    var cn = i === 1 ? '一' : i === 2 ? '二' : i === 3 ? '三' : i === 4 ? '四' :
      i === 5 ? '五' : i === 6 ? '六' : i === 7 ? '七' : '八';
    return '玩家' + cn;
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
    if (/^[0-9]{4}$/.test(raw) && raw.slice(0, 2) === '23') return '2028' + raw;
    return '';
  }

  function setLocalHint(i, text, bad) {
    var hint = $('ag-local-hint-' + i);
    if (!hint) return;
    hint.textContent = text || '';
    hint.className = 'ag-local-hint' + (bad ? ' is-bad' : (text ? ' is-good' : ''));
  }

  function applyLocalMode(i) {
    var input = $('ag-local-p' + i);
    if (!input) return;
    if (LS.mode[i] === 'no') {
      input.setAttribute('inputmode', 'numeric');
      input.setAttribute('maxlength', '8');
      input.setAttribute('placeholder', '班学号 1-2 位 / 2307 / 8 位学号');
    } else {
      input.removeAttribute('inputmode');
      input.setAttribute('maxlength', '12');
      input.setAttribute('placeholder', '昵称（12 字以内）');
    }
  }

  function setLocalMode(i, mode) {
    LS.mode[i] = mode;
    LS.resolved[i] = '';
    var chips = document.querySelectorAll('.ag-local-modes .chip[data-seat="' + i + '"]');
    for (var k = 0; k < chips.length; k++) {
      var on = chips[k].getAttribute('data-mode') === mode;
      chips[k].setAttribute('aria-pressed', on ? 'true' : 'false');
      chips[k].className = 'chip' + (on ? ' is-on' : '');
    }
    var input = $('ag-local-p' + i);
    if (input) {
      input.value = '';
      applyLocalMode(i);
    }
    if (mode === 'no' && !logged()) setLocalHint(i, '查学号要登录；也可以切到「昵称」', true);
    else setLocalHint(i, '', false);
    if (input) setTimeout(function () { try { input.focus(); } catch (e) {} }, 20);
  }

  function lookupLocalSeat(i) {
    var input = $('ag-local-p' + i);
    if (!input || LS.mode[i] !== 'no') return;
    var raw = digitsOnly(input.value);
    if (input.value !== raw) input.value = raw;
    LS.resolved[i] = '';
    var no = classStudentNo(raw);
    if (!no) {
      setLocalHint(i, raw ? '填班学号（1-2 位）、后四位（2307）或 8 位学号' : '', !!raw);
      return;
    }
    if (!logged()) {
      setLocalHint(i, '查学号要登录；也可以切到「昵称」', true);
      return;
    }
    setLocalHint(i, '查花名册中…', false);
    rpc('b8_member_lookup', { p_token: token(), p_no: no }).then(function (res) {
      if (LS.mode[i] !== 'no' || classStudentNo(input.value) !== no) return;
      if (res && res.ok && res.name) {
        LS.resolved[i] = res.name;
        setLocalHint(i, '✓ ' + res.name + (raw.length < 8 ? '（' + raw + ' 号 → ' + no + '）' : ''), false);
      } else {
        setLocalHint(i, '花名册里没有这个学号，可以切到「昵称」', true);
      }
    }).catch(function (err) {
      var msg = (err && err.message) || '';
      setLocalHint(i, /登录|token|jwt|授权/i.test(msg)
        ? '查学号要登录；也可以切到「昵称」'
        : '查学号失败（数据库没连上？），可以切到「昵称」', true);
    });
  }

  function openLocalSetup() {
    var m = meta(S.game);
    if (m.mode !== 'multi') { B8.toast('先选一个多人游戏'); return; }
    var rows = $('ag-local-rows');
    if (!rows) return;
    LS.busy = false;
    var myNo = digitsOnly(B8.auth && B8.auth.no ? B8.auth.no() : '');
    var myNick = (B8.auth && B8.auth.nick && B8.auth.nick()) || '';
    var hasNo = logged() && myNo.length === 8;
    rows.innerHTML = '';
    for (var i = 1; i <= S.seats; i++) {
      (function (seat) {
      LS.mode[seat] = hasNo ? 'no' : 'nick';
      LS.resolved[seat] = '';
      var row = document.createElement('div');
      row.className = 'ag-local-row';
      var head = document.createElement('div');
      head.className = 'ag-local-head';
      var b = document.createElement('b');
      b.textContent = defaultSeatName(seat) + (seat === 1 ? ' · 先手' : '');
      var modes = document.createElement('div');
      modes.className = 'ag-local-modes';
      ['no', 'nick'].forEach(function (mode) {
        var chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'chip' + (LS.mode[seat] === mode ? ' is-on' : '');
        chip.setAttribute('data-seat', String(seat));
        chip.setAttribute('data-mode', mode);
        chip.setAttribute('aria-pressed', LS.mode[seat] === mode ? 'true' : 'false');
        chip.textContent = mode === 'no' ? '学号' : '昵称';
        chip.addEventListener('click', function () { setLocalMode(seat, mode); });
        modes.appendChild(chip);
      });
      head.appendChild(b);
      head.appendChild(modes);
      var input = document.createElement('input');
      input.id = 'ag-local-p' + seat;
      input.type = 'text';
      input.autocomplete = 'off';
      input.value = seat === 1 ? (hasNo ? myNo : myNick) : '';
      input.addEventListener('input', function () {
        if (LS.mode[seat] === 'no') {
          var raw = digitsOnly(input.value);
          if (input.value !== raw) input.value = raw;
        }
        setLocalHint(seat, '', false);
        clearTimeout(LS.timers[seat]);
        LS.timers[seat] = setTimeout(function () { lookupLocalSeat(seat); }, 260);
      });
      input.addEventListener('focus', function () {
        if (LS.mode[seat] === 'no' && input.value.length >= 8) input.select();
      });
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); submitLocalSetup(); }
      });
      var hint = document.createElement('p');
      hint.className = 'ag-local-hint';
      hint.id = 'ag-local-hint-' + seat;
      row.appendChild(head);
      row.appendChild(input);
      row.appendChild(hint);
      rows.appendChild(row);
      applyLocalMode(seat);
      })(i);
    }
    txt('ag-local-sub', hasNo
      ? '填 8 位学号、班学号（1 号 = 20282307）或后四位（2307）会自动查姓名，也可以直接用昵称。'
      : '没登录（或账号学号不是 8 位）：学号查姓名要先登录；现在可以直接用昵称。');
    show('ag-local-setup', true);
    if (hasNo) lookupLocalSeat(1);
    setTimeout(function () {
      var target = $('ag-local-p' + (hasNo ? 2 : 1));
      if (target) { try { target.focus(); } catch (e) {} }
    }, 60);
  }

  function closeLocalSetup() {
    show('ag-local-setup', false);
  }

  function finishLocalSetup(names, nos) {
    closeLocalSetup();
    startLocal(names, nos);
  }

  function submitLocalSetup() {
    if (LS.busy) return;
    for (var t = 1; t <= S.seats; t++) clearTimeout(LS.timers[t]);
    var pending = [];
    for (var i = 1; i <= S.seats; i++) {
      var input = $('ag-local-p' + i);
      var raw = (input && input.value || '').trim();
      if (LS.mode[i] === 'no') {
        raw = digitsOnly(raw);
        if (input) input.value = raw;
        if (!classStudentNo(raw)) {
          setLocalHint(i, '填班学号（1-2 位）、后四位（2307）或 8 位学号', true);
          if (input) input.focus();
          return;
        }
        if (!LS.resolved[i]) pending.push(i);
      } else if (!raw || raw.length > 12) {
        setLocalHint(i, raw ? '昵称最多 12 个字' : '请填一个昵称', true);
        if (input) input.focus();
        return;
      }
    }
    if (!pending.length) {
      var names = [], nos = [];
      for (var j = 1; j <= S.seats; j++) {
        var inp = $('ag-local-p' + j);
        if (LS.mode[j] === 'no') {
          names.push(LS.resolved[j]);
          nos.push(classStudentNo(inp.value));
        } else {
          names.push((inp.value || '').trim());
          nos.push('');
        }
      }
      finishLocalSetup(names, nos);
      return;
    }
    if (!logged()) {
      setLocalHint(pending[0], '查学号要登录；也可以切到「昵称」', true);
      var pInput = $('ag-local-p' + pending[0]);
      if (pInput) pInput.focus();
      return;
    }
    LS.busy = true;
    var start = $('ag-local-start');
    if (start) { start.disabled = true; start.textContent = '查花名册…'; }
    var left = pending.length, bad = false;
    pending.forEach(function (p) {
      var inp = $('ag-local-p' + p);
      var no = classStudentNo(inp.value);
      setLocalHint(p, '查花名册中…', false);
      rpc('b8_member_lookup', { p_token: token(), p_no: no }).then(function (res) {
        if (res && res.ok && res.name) {
          LS.resolved[p] = res.name;
          setLocalHint(p, '✓ ' + res.name, false);
        } else {
          bad = true;
          setLocalHint(p, '花名册里没有这个学号，可以切到「昵称」', true);
        }
      }).catch(function (err) {
        bad = true;
        var msg = (err && err.message) || '';
        setLocalHint(p, /登录|token|jwt|授权/i.test(msg)
          ? '查学号要登录；也可以切到「昵称」'
          : '查学号失败（数据库没连上？），可以切到「昵称」', true);
      }).then(function () {
        if (--left !== 0) return;
        LS.busy = false;
        if (start) { start.disabled = false; start.textContent = '开始对局'; }
        if (!bad) {
          var ns = [], cs = [];
          for (var k = 1; k <= S.seats; k++) {
            var box = $('ag-local-p' + k);
            if (LS.mode[k] === 'no') {
              ns.push(LS.resolved[k]);
              cs.push(classStudentNo(box.value));
            } else {
              ns.push((box.value || '').trim());
              cs.push('');
            }
          }
          finishLocalSetup(ns, cs);
        }
      });
    });
  }

  function startLocal(names, nos) {
    var m = meta(S.game);
    if (m.mode !== 'multi') { B8.toast('先选一个多人游戏'); return; }
    var chosen = Array.isArray(names) ? names.slice() : (S.localNames || []).slice();
    var chosenNos = Array.isArray(nos) ? nos.slice() :
      (Array.isArray(names) ? [] : (S.localNos || []).slice());
    if (Array.isArray(names)) {
      S.localNames = chosen.slice();
      S.localNos = chosenNos.slice();
    }
    var seats = [];
    for (var i = 1; i <= S.seats; i++) {
      seats.push({
        seat: i,
        no: String(chosenNos[i - 1] || '').slice(0, 8),
        name: String(chosen[i - 1] || '').trim().slice(0, 20) || defaultSeatName(i)
      });
    }
    closeLocalSetup();
    var init = buildState(seats, S.teamMode);
    if (!init) { B8.toast('这个游戏还没加载好'); return; }
    S.local = true;
    S.seat = 1;
    S.chat = [];
    S.round = (S.round || 0) + 1;
    S.overShown = false;
    S.subs = [];
    // v2.152：本机对局也留流水，打完存一份记录
    S.localActs = [];
    S.localInit = JSON.parse(JSON.stringify(init));
    S.localStartedAt = Date.now();
    S.localSaved = false;
    S.localRecord = null;
    if (S.mod && S.mod.destroy) { try { S.mod.destroy(); } catch (e) {} }
    S.mod = null;
    S.modKey = '';
    S.room = {
      id: 0, code: 'LOCAL', game: S.game, name: '本地对局', status: 'play',
      is_private: true, max_seats: S.seats, team_mode: S.teamMode, host_seat: 1,
      seats: seats, state: init, seq: 1, turn: 1, winner: null
    };
    wsClose();
    clearTimeout(S.pollTimer);
    show('ag-lobby', false);
    show('ag-room', true);
    showGame('ag-over', false);
    S.view = 'room';
    try { history.replaceState(null, '', 'arcade.html'); } catch (e) {}
    renderRoom();
    ensureModule();
    txt('ag-status', '本地对局 · ' + seats.length + ' 人 · 轮流操作，不用联网');
  }

  function localSend(action, nextState, opts) {
    var r = S.room;
    if (!r || !S.local) return Promise.reject(new Error('本地对局没开始'));
    opts = opts || {};
    // 本地局没有服务器，动作流水先攒在这里；打完再一起存成记录
    var actor = Number(r.turn) || 1;
    if (action && typeof action === 'object') {
      S.localActs.push({
        seat: Number(action.seat) || actor,
        act: action,
        at: new Date().toISOString()
      });
    }
    if (nextState) r.state = nextState;
    if (opts.turn != null) r.turn = opts.turn;
    if (opts.status === 'over') {
      r.status = 'over';
      r.winner = opts.winner == null ? null : opts.winner;
    }
    r.seq = (r.seq || 0) + 1;
    if (r.status === 'over') saveLocalMatch();
    renderRoom();
    notify();
    return Promise.resolve({ ok: true, room: r });
  }

  /* ---------- 本机对局：存一份记录（本机一定有，登录了再传服务器） ---------- */

  function saveLocalMatch() {
    var r = S.room;
    if (!r || !S.local || S.localSaved || !r.state || !S.localInit) return;
    S.localSaved = true;
    var seats = r.seats || [];
    var players = seats.map(function (x) { return { seat: Number(x.seat), name: x.name, no: x.no || '' }; });
    var acts = [{
      seat: 1,
      act: { type: 'start', n: seats.length, state: S.localInit },
      at: new Date(S.localStartedAt || Date.now()).toISOString()
    }];
    (S.localActs || []).forEach(function (x) {
      if (x && x.act) acts.push({ seat: x.seat, act: x.act, at: x.at });
    });
    var rec = {
      localId: newLocalId(),
      source: 'local',
      owner_no: (B8.auth && B8.auth.no) ? B8.auth.no() : '',
      owner_name: (B8.auth && B8.auth.nick) ? B8.auth.nick() : '',
      game: r.game,
      team_mode: r.team_mode || 'ffa',
      n: seats.length,
      players: players,
      state: r.state,
      acts: acts,
      winner: Number(r.winner) || 0,
      winner_name: '',
      reason: 'normal',
      moves: Math.max(0, acts.length - 1),
      shots: acts.filter(function (x) { return x.act && x.act.type === 'shot'; }).length,
      duration_ms: Math.max(0, Date.now() - (S.localStartedAt || Date.now())),
      ended_at: new Date().toISOString()
    };
    for (var i = 0; i < players.length; i++) {
      if (players[i].seat === rec.winner) rec.winner_name = players[i].name;
    }
    S.localRecord = rec;
    saveLocalRecord(rec);
    renderRecords();

    if (!logged()) return;
    rpc('b8_arcade_save_local', {
      p_token: token(),
      p_game: rec.game,
      p_team_mode: rec.team_mode,
      p_players: players,
      p_state: rec.state,
      p_acts: rec.acts,
      p_winner: rec.winner,
      p_duration_ms: rec.duration_ms
    }).then(function (res) {
      if (res && res.id) {
        patchLocalRecord(rec.localId, { server_id: res.id });
        loadRecords(true);
      }
    }).catch(function (err) {
      // 数据库没更新时也别弹窗打断：本机记录已经存好了，列表里标「本机」
      if (window.console) console.warn('[arcade] 本机对局上传失败', err);
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
    S.local = false;
    S.localRecord = null;
    S.room = room;
    S.seat = seat || 0;
    S.chat = [];
    S.view = 'room';
    S.result = '';
    S.round = 0;
    S.overShown = false;
    S.rematchPrompted = false;
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
    // 直接进一个已经开局的房间（观战/重进）时，sync 会因为「房间没变」提前 return，
    // 得在这里先把游戏模块挂上，不然舞台会一直是空的。
    if (room.status === 'play' || room.status === 'over') ensureModule();
    syncRoom(true);
    wsConnect(room.code);
    schedulePoll();
  }

  function leaveRoom(silent) {
    // 跟棋类一样：离开只是回大厅，不删座位、不结束对局、也不调 b8_arcade_leave。
    // 房间和座位都留在服务器上，重新输房号回来还是原位；真要撤房走「关房」。
    if (!silent) wsSend({ type: 'changed' });
    wsClose();
    clearTimeout(S.pollTimer);
    if (S.mod && S.mod.destroy) { try { S.mod.destroy(); } catch (e) {} }
    S.mod = null;
    S.modKey = '';
    S.subs = [];
    S.room = null;
    S.seat = 0;
    S.local = false;
    S.view = 'lobby';
    try { history.replaceState(null, '', 'arcade.html'); } catch (e) {}
    show('ag-room', false);
    show('ag-lobby', true);
    showGame('ag-over', false);
    loadLists(true);
    loadRecords(true);
  }

  // 房主在等人阶段把某个座位清掉（请出/清掉离开的空座），让别的同学能坐。
  function kickSeat(seat) {
    if (!S.room || S.local || S.seat !== 1 || S.room.status !== 'wait') return;
    var p = null;
    var list = S.room.seats || [];
    for (var i = 0; i < list.length; i++) {
      if (Number(list[i].seat) === Number(seat)) p = list[i];
    }
    if (!p) return;
    var name = p.name || p.no || ('座位 ' + seat);
    B8.confirm('把「' + name + '」请出房间？空出的座位可以让别的同学坐。', {
      title: '请出座位', okText: '请出', danger: true
    }).then(function (ok) {
      if (!ok || !S.room) return;
      rpc('b8_arcade_kick', {
        p_token: token(), p_code: S.room.code, p_seat: seat
      }).then(function (res) {
        if (res && res.room) S.room = res.room;
        wsSend({ type: 'changed' });
        renderRoom();
        B8.toast('已请出 ' + name);
      }).catch(function (err) {
        B8.toast('没请出去：' + errText(err));
      });
    });
  }

  // 真正解散房间：房主/超管用。跟「离开」不一样 —— 离开只是回大厅，房间保留。
  function closeRoomNow() {
    if (!S.room) return;
    B8.confirm('解散这个房间？里面的人都会被请出去，房间号立刻失效。', {
      title: '解散房间', okText: '解散', danger: true
    }).then(function (ok) {
      if (!ok) return;
      rpc('b8_arcade_close', { p_token: token(), p_code: S.room.code })
        .then(function () {
          wsSend({ type: 'changed' });   // 屋里的人立刻收到「房间没了」，不用等轮询
          leaveRoom(true);
        })
        .catch(function (err) { B8.toast(errText(err)); });
    });
  }

  /* ============================================================
     三、同步 / WebSocket
     ============================================================ */

  function applyRoom(room, seat) {
    if (!room) return;
    // 回看时不要被房间的心跳覆盖（点记录时可能还有一个 sync 在路上）
    if (S.view === 'replay') return;
    var prev = S.room || {};
    // 本地先乐观走一步后，可能有一个更早发出的 sync 才回来；
    // 它的 seq 更小，直接丢掉，否则会把棋子画回上一步再跳回来（手机/慢网最明显）。
    if (prev.code && prev.code === room.code &&
        Number(room.seq) < Number(prev.seq) &&
        !(prev.status === 'over' && room.status === 'play')) {
      return;
    }
    // 再来一局：别人开的新一局也要重挂载，否则停在上一局的结算画面
    if (prev.status === 'over' && room.status === 'play') S.round = (S.round || 0) + 1;
    var same = !!prev.code && prev.code === room.code &&
      prev.seq === room.seq && prev.status === room.status &&
      prev.turn === room.turn && prev.winner === room.winner &&
      prev.rematch_by === room.rematch_by && prev.rematch_at === room.rematch_at &&
      JSON.stringify(prev.seats || []) === JSON.stringify(room.seats || []) &&
      JSON.stringify(prev.watchers || []) === JSON.stringify(room.watchers || []);
    S.room = room;
    if (typeof seat === 'number' && seat >= 0) S.seat = seat;
    if (room.status === 'play') S.rematchPrompted = false;
    var myno = myNo();
    var by = room.rematch_by || '';
    if (room.status === 'over' && by && by !== myno && !S.rematchPrompted) {
      S.rematchPrompted = true;
      acceptRematch(true);
    } else if (!by || by === myno) {
      S.rematchPrompted = false;
    }
    if (same) return;                       // 只是心跳，别重画（会打断动画）
    renderRoom();
    if (room.status === 'play' || room.status === 'over') ensureModule();
    else destroyModule();
    // 这一局刚打完：记录是服务器在最后一步里自动存的，这里补一下列表
    if (room.status === 'over' && prev.status !== 'over') loadRecords(true);
  }

  function flushQueuedSync() {
    if (!S.syncQueued) return;
    S.syncQueued = false;
    setTimeout(function () {
      if (S.room && S.view !== 'replay') syncRoom(true);
    }, 0);
  }

  function syncRoom(force) {
    if (!S.room || S.view === 'replay') return;
    if (S.syncBusy) { S.syncQueued = true; return; }
    var now = Date.now();
    // 900ms 冷却 + 合流：onChange 里再调 refresh 也只会排在后面跑一次
    if (!force && now - (S.lastSync || 0) < 900) {
      clearTimeout(S.syncLater);
      S.syncLater = setTimeout(function () { syncRoom(false); }, 950);
      return;
    }
    S.syncBusy = true;
    S.lastSync = Date.now();
    rpc('b8_arcade_sync', {
      p_token: logged() ? token() : null,
      p_code: S.room.code
    }).then(function (res) {
      S.syncBusy = false;
      flushQueuedSync();
      if (!res || !res.room) return;
      S.chat = res.chat || [];
      if (Array.isArray(res.watchers)) res.room.watchers = res.watchers;
      var wasSeat = Number(S.seat) || 0;
      var seatNow = typeof res.seat === 'number' ? res.seat : S.seat;
      applyRoom(res.room, seatNow);
      // 自己的座位被房主清掉了：回大厅（不是「离开」，是「被请出」）
      if (wasSeat > 0 && seatNow === 0 && res.room.status !== 'over') {
        B8.toast('你被房主请出了房间');
        leaveRoom(true);
        return;
      }
      renderChat();
      notify();
    }).catch(function (err) {
      S.syncBusy = false;
      flushQueuedSync();
      if (S.dbMissing) return;
      if (/房间不存在/.test((err && err.message) || '')) {
        B8.toast('房间已解散');
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
    }, S.ws ? 4000 : 3000);
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
        clearTimeout(S.reconnectTimer);
        S.reconnectTimer = setTimeout(function () {
          if (S.view === 'room' && S.room && !S.ws) wsConnect(S.room.code);
        }, 1500 * S.wsRetry);
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
    if (obj && obj.type === 'changed') {
      var now = Date.now();
      if (now - (S.changedAt || 0) < 450) {
        clearTimeout(S.changedTimer);
        S.changedTimer = setTimeout(function () { wsSend(obj); }, 460);
        return;
      }
      S.changedAt = now;
    }
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
    txt('ag-room-meta', (S.local ? '本地对局' : '房号 ' + r.code) + ' · ' +
      seats.length + (S.local ? ' 人' : '/' + r.max_seats + ' 人') + ' · ' +
      (r.status === 'wait' ? '等人' : (r.status === 'play' ? '对局中' : '已结束')) +
      (r.team_mode === 'team' ? ' · 组队' : '') +
      (S.local
        ? ' · 轮到 ' + ((seats[(r.turn || 1) - 1] || {}).name || (r.turn + ' 号'))
        : (S.seat > 0 ? ' · 你坐 ' + S.seat + ' 号' : ' · 观战')));

    var box = $('ag-players');
    if (box) {
      box.innerHTML = '';
      seats.forEach(function (p) {
        var el = document.createElement('span');
        var away = !!p.left;
        el.className = 'ag-player' +
          (r.turn === p.seat && r.status === 'play' ? ' is-turn' : '') +
          (p.seat === S.seat ? ' is-me' : '') +
          (away ? ' is-away' : '');
        var i = document.createElement('i');
        i.textContent = String(p.seat);
        var b = document.createElement('span');
        b.textContent = (p.name || p.no || '同学') + (p.seat === S.seat ? '（你）' : '') +
          (away ? ' · 离开' : '');
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
    var waiting = r.status === 'wait';
    show('ag-close-room', !S.local && (isHost || (B8.auth && B8.auth.isSuper && B8.auth.isSuper())));
    show('ag-surrender', !S.local && S.seat > 0 && r.status === 'play');
    show('ag-copy-link', !S.local);
    show('ag-again', !S.local && S.seat > 0 && r.status === 'over');
    txt('ag-chat-count', String((S.chat || []).length));
    renderWatchers(r);
    // 等人：直接在房间页里显示「房号 + 座位 + 开始」，不再用全屏弹层挡住宿位和人数。
    show('ag-waitbox', waiting);
    show('ag-stage', !waiting);
    if (waiting) renderWaitBox(r, seats, isHost);
    if (r.status === 'over') {
      S.overShown = true;
      renderOver();
    } else {
      S.overShown = false;
      showGame('ag-over', false);
    }
  }

  function renderWatchers(r) {
    var box = $('ag-watch-list');
    var count = $('ag-watch-count');
    if (!box) return;
    var list = (r && Array.isArray(r.watchers)) ? r.watchers : [];
    if (count) count.textContent = list.length + ' 人';
    box.innerHTML = '';
    if (!list.length) {
      var empty = document.createElement('p');
      empty.className = 'ag-empty';
      empty.textContent = '暂时没人观战';
      box.appendChild(empty);
      return;
    }
    var mine = (B8.auth && B8.auth.no) ? B8.auth.no() : '';
    for (var i = 0; i < list.length; i++) {
      var w = list[i] || {};
      var name = document.createElement('span');
      name.className = 'ag-watch-name' + (mine && w.no === mine ? ' is-me' : '');
      name.textContent = (w.nick || w.no || '同学') + (mine && w.no === mine ? '（你）' : '');
      box.appendChild(name);
    }
  }

  // 等人面板：房号、座位（谁在、谁离开、谁空着）、房主请人、开始游戏
  function renderWaitBox(r, seats, isHost) {
    txt('ag-wait-code', r.code || '----');
    txt('ag-wait-count', seats.length + ' / ' + r.max_seats + ' 人');
    txt('ag-wait-note', '把房号发给同学，他在大厅输进来就坐下。人齐了房主点「开始游戏」。');

    var start = $('ag-start-now');
    if (start) {
      start.hidden = !isHost || S.local;
      var canStart = seats.length >= 2;
      start.disabled = !canStart;
      start.textContent = canStart ? '开始游戏' : '等人齐（' + seats.length + '/' + r.max_seats + '）';
    }
    show('ag-wait-close', !S.local && isHost);
    var hint = $('ag-wait-hint');
    if (hint) {
      hint.textContent = isHost
        ? '人齐了点「开始游戏」。座位右边可以把人请出/清掉离开的座位；离开不会解散房间。'
        : (S.local ? '' : '等房主点开始。离开不会解散房间，回来还能坐原位。');
    }

    var list = $('ag-seat-list');
    if (!list) return;
    list.innerHTML = '';
    var bySeat = {};
    for (var i = 0; i < seats.length; i++) {
      var s = seats[i];
      if (s && s.seat) bySeat[s.seat] = s;
    }
    for (var n = 1; n <= Math.max(2, Number(r.max_seats) || 2); n++) {
      var p = bySeat[n];
      var row = document.createElement('div');
      row.className = 'ag-seatrow' + (p ? '' : ' is-empty') + (p && p.left ? ' is-away' : '');
      var num = document.createElement('i');
      num.textContent = String(n);
      row.appendChild(num);
      var name = document.createElement('b');
      name.textContent = p ? (p.name || p.no || '同学') : '空位 · 等同学';
      row.appendChild(name);
      if (n === 1) row.appendChild(badge('房主'));
      if (p && p.seat === S.seat) row.appendChild(badge('你'));
      if (p && p.left) row.appendChild(badge('离开'));
      if (p && isHost && p.seat !== S.seat && !S.local) {
        var kick = document.createElement('button');
        kick.type = 'button';
        kick.className = 'ag-kick';
        kick.textContent = p.left ? '清掉空座' : '请出';
        kick.setAttribute('data-kick', String(p.seat));
        kick.title = '把 ' + (p.name || p.no || '这位同学') + ' 请出房间';
        row.appendChild(kick);
      }
      list.appendChild(row);
    }
  }

  function badge(text) {
    var el = document.createElement('em');
    el.className = 'ag-seatbadge';
    el.textContent = text;
    return el;
  }


  function myNo() {
    if (!S.room || S.seat < 1) return '';
    var seats = S.room.seats || [];
    for (var i = 0; i < seats.length; i++) {
      if (Number(seats[i].seat) === Number(S.seat)) return seats[i].no || '';
    }
    return '';
  }

  function seatNameByNo(no) {
    var seats = (S.room && S.room.seats) || [];
    for (var i = 0; i < seats.length; i++) {
      if (seats[i].no === no) return seats[i].name || seats[i].no || '对方';
    }
    return '对方';
  }

  function renderOver() {
    var r = S.room;
    if (!r) return;
    var seats = r.seats || [];
    var win = r.winner;
    var who = '';
    for (var i = 0; i < seats.length; i++) if (seats[i].seat === win) who = seats[i].name || seats[i].no;
    txt('ag-over-kicker', S.local ? '对局结束 · 本机对局' : '对局结束 · 房号 ' + r.code);
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

    // 每一局都留了记录：显示编号，并给一个「看回放」
    var recId = Number(r.record_id) || 0;
    var localRec = S.local && S.localRecord ? S.localRecord : null;
    var recLine = $('ag-over-record');
    if (recLine) {
      recLine.hidden = !(recId || localRec);
      recLine.textContent = recId
        ? '对局记录 #' + recId + ' 已保存'
        : (localRec ? '本局已存进本机记录（登录后会同步到服务器）' : '');
    }
    var viewBtn = $('ag-over-view');
    if (viewBtn) {
      viewBtn.hidden = !(recId || localRec);
      viewBtn.disabled = !(recId || localRec);
    }

    var again = $('ag-over-again');
    if (again) {
      if (S.local) {
        again.hidden = false;
        again.disabled = false;
        again.textContent = '再来一局';
      } else {
        var mine = myNo();
        var by = r.rematch_by || '';
        again.hidden = S.seat < 1;
        again.disabled = !!(by && by === mine);
        again.textContent = by && by !== mine ? '同意再来一局'
          : (by === mine ? '已邀请，等对方' : '邀请再来一局');
      }
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
    setTimeout(function () {
      if (!S.mod || !S.room) return;
      var stage = $('ag-stage');
      if (!stage || stage.children.length) return;
      stage.innerHTML = '<p class="ag-empty">画面没画出来。' +
        '<button class="ag-link" id="ag-stage-lobby" type="button">回大厅重进一次</button></p>';
      var b = $('ag-stage-lobby');
      if (b) b.addEventListener('click', function () { leaveRoom(false); });
    }, 1200);
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

  function replaySend() {
    return Promise.reject(new Error('回看是只读的'));
  }

  function makeCtx() {
    var r = S.room || {};
    var seats = r.seats || [];
    var replay = (S.view === 'replay' && S.replay) ? {
      on: true,
      index: S.replay.index,
      total: S.replay.total,
      broken: !!S.replay.broken,
      id: S.replay.rec.id || S.replay.rec.localId || ''
    } : null;
    var localSeat = replay ? 0 : (S.local ? (r.turn || 1) : S.seat);
    var me = null;
    for (var i = 0; i < seats.length; i++) {
      if (seats[i].seat === localSeat && localSeat > 0) me = seats[i];
    }
    return {
      game: r.game,
      seat: localSeat,
      room: r,
      state: (r.state && typeof r.state === 'object') ? r.state : {},
      me: me,
      isHost: replay ? false : (S.local ? true : (S.seat === 1)),
      players: seats,
      isMyTurn: replay ? false :
        (S.local ? (r.status === 'play') : (r.status === 'play' && r.turn === S.seat && S.seat > 0)),
      local: !!S.local && !replay,
      replay: replay,
      send: replay ? replaySend : (S.local ? localSend : sendAction),
      onChange: function (fn) {
        if (typeof fn !== 'function') return function () {};
        S.subs.push(fn);
        return function () {
          var k = S.subs.indexOf(fn);
          if (k >= 0) S.subs.splice(k, 1);
        };
      },
      refresh: function () { return replay ? Promise.resolve() : syncRoom(true); },
      toast: function (msg) { B8.toast(msg); },
      setStatus: function (msg) {
        txt(replay ? 'ag-replay-status' : 'ag-status', msg || '—');
      },
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

    var sig = S.seat + '|' + JSON.stringify(action || {});
    if (S.lastActionSig === sig && Date.now() - (S.lastActionAt || 0) < 600) {
      return Promise.resolve({ deduped: true });
    }
    S.lastActionSig = sig;
    S.lastActionAt = Date.now();

    // 先把本端画面推进（动起来），服务器回来再对齐；失败就回滚
    var before = {
      state: S.room.state, turn: S.room.turn, status: S.room.status,
      winner: S.room.winner, seq: S.room.seq
    };
    if (nextState) S.room.state = nextState;
    if (opts.turn != null) S.room.turn = opts.turn;
    if (opts.status === 'over') {
      S.room.status = 'over';
      S.room.winner = opts.winner == null ? null : opts.winner;
    }
    S.room.seq = (S.room.seq || 0) + 1;
    renderRoom();
    notify();

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
        if (!Array.isArray(res.room.watchers)) res.room.watchers = (S.room && S.room.watchers) || [];
        S.room = res.room;
        renderRoom();
        notify();
      }
      wsSend({ type: 'changed' });
      return res;
    }).catch(function (err) {
      // 回滚到服务器之前的局面
      if (S.room && S.room.code) {
        S.room.state = before.state;
        S.room.turn = before.turn;
        S.room.status = before.status;
        S.room.winner = before.winner;
        S.room.seq = before.seq;
        renderRoom();
        notify();
      }
      B8.toast(errText(err));
      syncRoom(true);
      throw err;
    });
  }

  function buildInit(r) {
    var seats = (r && r.seats) || [];
    if (seats.length < 2) return null;
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
      return null;
    }
    if (!init) { B8.toast('这个游戏还没准备好'); return null; }
    return init;
  }

  function startGame() {
    var r = S.room;
    if (!r) return;
    if (S.seat !== 1) { B8.toast('只有房主可以开局'); return; }
    if ((r.seats || []).length < 2) { B8.toast('至少两个人才能开局'); return; }
    var init = buildInit(r);
    if (!init) return;
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

  // v2.160：再来一局要对方同意；接受后同一个房间重开，两个人都还在。
  function surrenderGame() {
    if (!S.room || S.local || S.seat < 1 || S.room.status !== 'play') return;
    B8.confirm('确定投降？本局直接判对方获胜。', {
      title: '投降', okText: '确定投降', danger: true
    }).then(function (ok) {
      if (!ok || !S.room) return;
      rpc('b8_arcade_surrender', { p_token: token(), p_code: S.room.code })
        .then(function (res) {
          if (res && res.room) {
            S.room = res.room;
            renderRoom();
            notify();
          }
          wsSend({ type: 'changed' });
          loadRecords(true);
        })
        .catch(function (err) { B8.toast(errText(err)); });
    });
  }

  function rematchClick() {
    if (!S.room) return;
    if (S.local) { startLocal(); return; }
    var r = S.room;
    if (r.status !== 'over' || S.seat < 1) return;
    var mine = myNo();
    var by = r.rematch_by || '';
    if (by && by !== mine) { acceptRematch(false); return; }
    if (by === mine) { B8.toast('已经邀请，等对方同意'); return; }
    rpc('b8_arcade_rematch', { p_token: token(), p_code: r.code })
      .then(function (res) {
        if (res && res.room) { S.room = res.room; renderRoom(); }
        wsSend({ type: 'changed' });
        B8.toast('已邀请对方，等他同意');
      })
      .catch(function (err) { B8.toast(errText(err)); });
  }

  function acceptRematch(ask) {
    var r = S.room;
    if (!r || S.local || r.status !== 'over') return;
    function go() {
      var init = buildInit(r);
      if (!init) return;
      rpc('b8_arcade_rematch_accept', {
        p_token: token(), p_code: r.code, p_state: init
      }).then(function (res) {
        if (res && res.room) {
          S.rematchPrompted = false;
          S.overShown = false;
          showGame('ag-over', false);
          applyRoom(res.room, S.seat);
        }
        wsSend({ type: 'changed' });
      }).catch(function (err) { B8.toast(errText(err)); });
    }
    if (!ask) { go(); return; }
    B8.confirm(seatNameByNo(r.rematch_by) + ' 邀请你再来一局，同意吗？', {
      title: '再来一局', okText: '同意'
    }).then(function (ok) { if (ok) go(); });
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
     七、绑定 / 启动
     ============================================================ */

  function bindEmojiBars() {
    var bars = document.querySelectorAll('[data-emoji-target]');
    for (var i = 0; i < bars.length; i++) {
      (function (bar) {
        var input = $(bar.getAttribute('data-emoji-target'));
        if (!input) return;
        var btns = bar.querySelectorAll('button');
        for (var j = 0; j < btns.length; j++) {
          (function (btn) {
            btn.addEventListener('click', function () {
              var max = Number(input.getAttribute('maxlength')) || 200;
              input.value = (input.value + btn.textContent).slice(0, max);
              try { input.focus(); } catch (e) {}
            });
          })(btns[j]);
        }
      })(bars[i]);
    }
  }

  function bind() {
    bindEmojiBars();
    var create = $('ag-create');
    if (create) create.addEventListener('click', function () { createRoom(); });
    var local = $('ag-local');
    if (local) local.addEventListener('click', openLocalSetup);
    var localStart = $('ag-local-start');
    if (localStart) localStart.addEventListener('click', submitLocalSetup);
    var localCasual = $('ag-local-casual');
    if (localCasual) localCasual.addEventListener('click', function () {
      var names = [];
      for (var i = 1; i <= S.seats; i++) names.push(defaultSeatName(i));
      startLocal(names);
    });
    var localCancel = $('ag-local-cancel');
    if (localCancel) localCancel.addEventListener('click', closeLocalSetup);

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

    var pageBack = $('ag-page-back');
    if (pageBack) {
      pageBack.addEventListener('click', function (e) {
        if (sameOriginReferrer()) {
          e.preventDefault();
          safeHistoryBack(function () { location.href = 'index.html'; });
        }
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
    if (closeRoom) closeRoom.addEventListener('click', closeRoomNow);
    var surrenderBtn = $('ag-surrender');
    if (surrenderBtn) surrenderBtn.addEventListener('click', surrenderGame);
    var waitClose = $('ag-wait-close');
    if (waitClose) waitClose.addEventListener('click', closeRoomNow);
    var seatList = $('ag-seat-list');
    if (seatList) {
      seatList.addEventListener('click', function (e) {
        var t = e.target;
        var btn = t && t.closest ? t.closest('[data-kick]') : null;
        if (!btn) return;
        kickSeat(Number(btn.getAttribute('data-kick')));
      });
    }

    var again = $('ag-again');
    if (again) {
      again.addEventListener('click', function () {
        if (S.local) startLocal();
        else rematchClick();
      });
    }

    var overAgain = $('ag-over-again');
    if (overAgain) {
      overAgain.addEventListener('click', function () {
        if (S.local) startLocal();
        else rematchClick();
      });
    }

    var overLobby = $('ag-over-lobby');
    if (overLobby) overLobby.addEventListener('click', function () { leaveRoom(false); });

    // 打完这一局看回放（联机记录在服务器，本机记录在本机）
    var overView = $('ag-over-view');
    if (overView) {
      overView.addEventListener('click', function () {
        if (S.local && S.localRecord) { openRecord(S.localRecord); return; }
        if (S.room && S.room.record_id) { openRecord(Number(S.room.record_id)); return; }
        B8.toast('这一局的记录还没同步下来，稍等一下');
      });
    }

    var recMine = $('ag-rec-mine');
    if (recMine) {
      recMine.addEventListener('click', function () {
        S.recTab = 'mine';
        renderRecords();
        loadRecords(false);
      });
    }
    var recRecent = $('ag-rec-recent');
    if (recRecent) {
      recRecent.addEventListener('click', function () {
        S.recTab = 'recent';
        renderRecords();
        loadRecords(false);
      });
    }
    var recRefresh = $('ag-rec-refresh');
    if (recRefresh) recRefresh.addEventListener('click', function () { loadRecords(true); });

    var repBack = $('ag-replay-back');
    if (repBack) repBack.addEventListener('click', backFromReplay);
    var analysisCanvas = $('ag-analysis-canvas');
    if (analysisCanvas) {
      analysisCanvas.title = '点线跳到对应步数';
      analysisCanvas.addEventListener('click', function (e) {
        var rp = S.replay;
        if (!rp || rp.rec.game !== 'quoridor' || !rp.total) return;
        var rect = analysisCanvas.getBoundingClientRect();
        if (!rect.width) return;
        var pad = analysisPad();
        var plot = rect.width - pad.left - pad.right;
        var x = e.clientX - rect.left;
        if (plot <= 0 || x < pad.left - 2 || x > rect.width - pad.right + 2) return;
        var idx = Math.round((x - pad.left) / plot * rp.total);
        replayTo(Math.max(0, Math.min(rp.total, idx)));
      });
    }
    var repFirst = $('ag-replay-first');
    if (repFirst) repFirst.addEventListener('click', function () { replayTo(0); });
    var repPrev = $('ag-replay-prev');
    if (repPrev) repPrev.addEventListener('click', function () {
      if (S.replay) replayTo(S.replay.index - 1);
    });
    var repNext = $('ag-replay-next');
    if (repNext) repNext.addEventListener('click', function () {
      if (S.replay) replayTo(S.replay.index + 1);
    });
    var repLast = $('ag-replay-last');
    if (repLast) repLast.addEventListener('click', function () {
      if (S.replay) replayTo(S.replay.total);
    });
    var repPlay = $('ag-replay-play');
    if (repPlay) repPlay.addEventListener('click', toggleReplayAuto);
    var repShare = $('ag-replay-share');
    if (repShare) {
      repShare.addEventListener('click', function () {
        if (!S.replay || !S.replay.rec.id || S.replay.rec.localId) {
          B8.toast('本机记录没有分享链接');
          return;
        }
        var url = location.origin + location.pathname + '?rec=' + encodeURIComponent(S.replay.rec.id);
        if (B8.copy) B8.copy(url);
      });
    }

    window.addEventListener('resize', function () {
      if (S.view === 'replay') drawQuoridorAnalysis();
    });

    document.addEventListener('keydown', function (e) {
      if (S.view !== 'replay' || !S.replay) return;
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName || '')) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { replayTo(S.replay.index - 1); e.preventDefault(); }
      else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { replayTo(S.replay.index + 1); e.preventDefault(); }
      else if (e.key === 'Escape') { closeReplay(false); e.preventDefault(); }
      else if (e.key === ' ') { toggleReplayAuto(); e.preventDefault(); }
    });

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
    else el.textContent = '未登录（能本机玩 / 看回放）';
  }

  function boot() {
    renderGames();
    renderOptions();
    bind();
    updateWho();
    loadLists(true);
    renderRecords();
    loadRecords(true);

    if (B8.auth && B8.auth.ready) {
      B8.auth.ready(function () {
        updateWho();
        loadLists(true);
        loadRecords(true);
      });
    }

    var room = (location.search || '').match(/[?&]room=([A-Za-z0-9]{4})/);
    if (room) {
      if (B8.auth && B8.auth.ready) {
        B8.auth.ready(function () { joinRoom(room[1]); });
      } else {
        joinRoom(room[1]);
      }
    } else {
      // arcade.html?rec=123 直接打开一局的回看（和 board.html?rec=123 一个意思）
      var rec = (location.search || '').match(/[?&]rec=(\d{1,12})/);
      if (rec) openRecord(Number(rec[1]));
    }

    setInterval(function () {
      if (S.view === 'lobby' && !document.hidden) loadLists(false);
    }, 15000);
  }

  // 任何未捕获错误都把大厅亮出来，别留一整页白
  window.addEventListener('error', function () {
    var lobby = $('ag-lobby');
    var room = $('ag-room');
    var replay = $('ag-replay');
    if (lobby && room && lobby.hidden && room.hidden && (!replay || replay.hidden)) {
      lobby.hidden = false;
      room.hidden = true;
    }
  });

  A.boot = boot;
  A.state = S;
  // 自检用（_shared/arcade-replay-harness.html）：不参与线上流程
  A._test = {
    openRecord: openRecord,
    closeReplay: closeReplay,
    startLocal: startLocal,
    classStudentNo: classStudentNo,
    digitsOnly: digitsOnly,
    localSend: localSend,
    saveLocalMatch: saveLocalMatch,
    enterRoom: enterRoom,
    visibleRecords: visibleRecords,
    readLocalRecords: readLocalRecords
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
