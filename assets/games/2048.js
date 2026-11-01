/* ============================================================
   2048 · 八班游乐场版
   ------------------------------------------------------------
   为什么用 DOM 而不是 canvas：16 个方块用绝对定位 + transform，
   CSS 负责过渡，JS 只管数据。手机上不用管 DPR，字号也能跟着
   clamp() 走，比 canvas 好维护得多。

   数据模型：slots[16]，每个格子是 null 或 {id, v, el, in}。
   移动时先算新位置、立刻更新模型与 DOM，被合并掉的方块元素
   滑到目标格后再删掉——这样连按方向键也不会错位。
   ============================================================ */
(function () {
  'use strict';

  var B8 = window.B8 = window.B8 || {};
  var KEY_BEST = 'b8.2048.best';
  var N = 4;

  var board, layerEl, scoreEl, bestEl, maxEl, restartBtn, stateEl, noteEl;
  var slots = [];
  var uid = 0;
  var score = 0;
  var best = 0;
  var over = false;
  var won = false;
  var submitted = 0;      // 已经上传过的最高分，避免重复写库
  var submitTimer = 0;
  var writable = false;
  var started = false;

  /* ---------- 小工具 ---------- */
  function whenReady(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  function readBest() {
    try { return Number(localStorage.getItem(KEY_BEST) || 0) || 0; } catch (e) { return 0; }
  }

  function saveBest(v) {
    try { localStorage.setItem(KEY_BEST, String(v)); } catch (e) {}
  }

  function tf(c, r) {
    return 'translate(' + (c * 100) + '%,' + (r * 100) + '%)';
  }

  function setState(msg, good) {
    if (!stateEl) return;
    stateEl.textContent = msg;
    if (good) stateEl.classList.add('is-good');
    else stateEl.classList.remove('is-good');
  }

  function setNote(msg, isErr) {
    if (!noteEl) return;
    noteEl.textContent = msg || '';
    noteEl.classList[isErr ? 'add' : 'remove']('err');
  }

  /* ---------- 棋盘 DOM ---------- */
  function buildGrid() {
    var frag = document.createDocumentFragment();
    for (var i = 0; i < N * N; i++) {
      var c = document.createElement('div');
      c.className = 'b2048-cell';
      frag.appendChild(c);
    }
    B8.qs('#g2048-grid').appendChild(frag);
  }

  function paint(t) {
    var cls = 'b2048-in';
    if (t.v > 2048) cls += ' vbig';
    else cls += ' v' + t.v;
    if (t.v >= 1000) cls += ' d4';
    else if (t.v >= 100) cls += ' d3';
    t.in.className = cls;
    t.in.textContent = String(t.v);
  }

  function place(t, idx) {
    t.el.style.transform = tf(idx % N, Math.floor(idx / N));
  }

  function makeTile(idx, v) {
    var t = { id: ++uid, v: v };
    var el = document.createElement('div');
    el.className = 'b2048-tile is-new';
    var inner = document.createElement('div');
    el.appendChild(inner);
    t.el = el;
    t.in = inner;
    paint(t);
    place(t, idx);
    layerEl.appendChild(el);
    // 动画跑完就把标记去掉，免得下次合并时误触发
    setTimeout(function () { el.classList.remove('is-new'); }, 200);
    return t;
  }

  function spawn() {
    var free = [];
    for (var i = 0; i < slots.length; i++) if (!slots[i]) free.push(i);
    if (!free.length) return null;
    var idx = free[Math.floor(Math.random() * free.length)];
    var t = makeTile(idx, Math.random() < 0.9 ? 2 : 4);
    slots[idx] = t;
    return t;
  }

  function updateMax() {
    var max = 0;
    for (var i = 0; i < slots.length; i++) if (slots[i] && slots[i].v > max) max = slots[i].v;
    if (maxEl) maxEl.textContent = max ? String(max) : '—';
    return max;
  }

  function updateScore() {
    if (scoreEl) scoreEl.textContent = String(score);
    if (bestEl) bestEl.textContent = String(best);
  }

  /* ---------- 上传成绩 ---------- */
  // 一局只上报一次：结束、合成 2048、或者点重开时各调用一次 reportOnce，
  // 靠 gameSubmitted 兜住，绝不因为「每走一步都在加分」就写一堆行进来。
  function reportOnce() {
    if (gameSubmitted || cheated || !writable) return;
    if (!B8.auth || !B8.auth.token()) return;
    if (score <= 0) return;
    gameSubmitted = true;
    submitScore(score);
  }

  function submitScore(v) {
    if (!writable || !B8.auth || !B8.auth.token()) return;
    v = Math.floor(v);
    if (v <= 0 || v <= submitted || v > 1000000) return;
    submitted = v;
    B8.sb.rpc('b8_score_add', { p_token: B8.auth.token(), p_game: '2048', p_score: v })
      .then(function () {
        setNote('已记到排行榜：' + v + ' 分。');
        if (B8.fun && B8.fun.rankSaved) B8.fun.rankSaved('2048');
      })
      .catch(function (err) {
        submitted = 0;   // 失败就别占着位置，下次纪录再试
        setNote('成绩没传上去：' + (err && err.message ? err.message : '未知错误'), true);
      });
  }

  function scheduleSubmit() {
    if (!writable) return;
    clearTimeout(submitTimer);
    // 连着合方块时不必每一下都写库，停手 1.4 秒再传当前最高分
    submitTimer = setTimeout(function () { submitScore(score); }, 1400);
  }

  /* ---------- 规则 ---------- */
  function lineIndexes(dir) {
    var lines = [];
    var i, j, r, c, line;
    if (dir === 'left' || dir === 'right') {
      for (r = 0; r < N; r++) {
        line = [];
        for (i = 0; i < N; i++) {
          c = dir === 'left' ? i : N - 1 - i;
          line.push(r * N + c);
        }
        lines.push(line);
      }
    } else {
      for (c = 0; c < N; c++) {
        line = [];
        for (j = 0; j < N; j++) {
          r = dir === 'up' ? j : N - 1 - j;
          line.push(r * N + c);
        }
        lines.push(line);
      }
    }
    return lines;
  }

  function move(dir) {
    if (!started || over) return;

    var lines = lineIndexes(dir);
    var moved = false;
    var gained = 0;
    var ghosts = [];

    for (var li = 0; li < lines.length; li++) {
      var line = lines[li];
      var tiles = [];
      var p;
      for (p = 0; p < line.length; p++) {
        var t = slots[line[p]];
        if (t) tiles.push({ pos: line[p], t: t });
        slots[line[p]] = null;
      }

      var target = 0;
      var i = 0;
      while (i < tiles.length) {
        var cur = tiles[i];
        var next = tiles[i + 1];
        var dest = line[target];

        if (next && next.t.v === cur.t.v) {
          // 合并：保留靠前那个方块的元素，后一个当「影子」滑过去再删
          var nv = cur.t.v * 2;
          cur.t.v = nv;
          paint(cur.t);
          slots[dest] = cur.t;
          place(cur.t, dest);
          moved = true;
          ghosts.push({ el: next.t.el, idx: dest });
          cur.t.el.classList.add('is-merged');
          (function (el) {
            setTimeout(function () { el.classList.remove('is-merged'); }, 220);
          })(cur.t.el);
          gained += nv;
          i += 2;
        } else {
          slots[dest] = cur.t;
          if (dest !== cur.pos) {
            place(cur.t, dest);
            moved = true;
          }
          i += 1;
        }
        target++;
      }
    }

    if (!moved) return;

    // 影子方块：滑到目标格（与留下的那块重叠），120ms 后移除
    for (var g = 0; g < ghosts.length; g++) {
      var ge = ghosts[g].el;
      ge.classList.add('is-dying');
      ge.style.transform = tf(ghosts[g].idx % N, Math.floor(ghosts[g].idx / N));
      (function (el) {
        setTimeout(function () {
          if (el.parentNode) el.parentNode.removeChild(el);
        }, 120);
      })(ge);
    }

    if (gained > 0) {
      score += gained;
      if (score > best) {
        best = score;
        saveBest(best);
        if (bestEl) {
          bestEl.classList.add('is-record');
          setTimeout(function () { if (bestEl) bestEl.classList.remove('is-record'); }, 900);
        }
      }
      updateScore();
      // 走一步就不再上报了：成绩统一在一局结束时记一次
    }

    spawn();
    var max = updateMax();

    if (max >= 2048 && !won) {
      won = true;
      setState('合成 2048 了！可以接着玩，也可以重开。', true);
      B8.toast('2048！这一局可以记在八班名下了。');
      reportOnce();
    }

    if (!canMove()) {
      over = true;
      board.classList.add('is-over');
      setState('没有可走的方向了。这一局 ' + score + ' 分，点重开再来。', false);
      reportOnce();
    } else if (!won) {
      setState('得分 ' + score + ' · 最大方块 ' + max + '。', false);
    } else {
      setState('已合成 2048 · 得分 ' + score + ' · 最大方块 ' + max + '。', true);
    }
  }

  function canMove() {
    var i;
    for (i = 0; i < slots.length; i++) if (!slots[i]) return true;
    for (var r = 0; r < N; r++) {
      for (var c = 0; c < N; c++) {
        var v = slots[r * N + c].v;
        if (c < N - 1 && slots[r * N + c + 1].v === v) return true;
        if (r < N - 1 && slots[(r + 1) * N + c].v === v) return true;
      }
    }
    return false;
  }

  /* ---------- 开局 / 重开 ---------- */
  function reset() {
    clearTimeout(submitTimer);
    // 重开前把这一局的分送出去（只送这一次，除非开过作弊）
    if (started && score > 0) reportOnce();
    slots = [];
    for (var i = 0; i < N * N; i++) slots.push(null);
    layerEl.innerHTML = '';
    uid = 0;
    score = 0;
    over = false;
    won = false;
    submitted = 0;
    gameSubmitted = false;   // 新的一局，可以再记一次
    cheated = false;         // 作弊标记只在单局内有效
    cheatOn = false;
    picked = [];
    started = true;
    var ce = cheatEls();
    if (ce.panel) ce.panel.hidden = true;
    if (ce.toggle) {
      ce.toggle.setAttribute('aria-pressed', 'false');
      ce.toggle.textContent = '作弊模式';
    }
    board.classList.remove('is-over');
    updateScore();
    spawn();
    spawn();
    updateMax();
    setState('新的一局。方向键 / WASD 移动，手机上直接滑。');
    setNote(writable
      ? '一局只记一次成绩：结束或重开时上榜，中途不会重复写。'
      : '成绩只存在这台设备：数据库还没接，暂时不上传排行榜。');
  }

  /* ---------- 输入 ---------- */
  function focusBoard() {
    if (!board) return;
    try { board.focus({ preventScroll: true }); } catch (e) { board.focus(); }
  }

  function bindInput() {
    var keys = {
      arrowleft: 'left', a: 'left',
      arrowright: 'right', d: 'right',
      arrowup: 'up', w: 'up',
      arrowdown: 'down', s: 'down'
    };

    B8.on(board, 'keydown', function (e) {
      var k = e.key || '';
      var low = k.length === 1 ? k.toLowerCase() : k.toLowerCase();
      var dir = keys[low];
      if (dir) {
        e.preventDefault();
        focusBoard();
        move(dir);
        return;
      }
      if ((k === 'Enter' || k === ' ') && over) {
        e.preventDefault();
        reset();
      }
    });

    B8.on(board, 'mousedown', focusBoard);
    B8.on(board, 'touchstart', focusBoard);   // 手机上点一下等于「选中棋盘」，便于读屏

    // 触摸滑动：位移 > 24px 且取主轴
    var start = null;
    B8.on(board, 'touchstart', function (e) {
      if (e.touches.length !== 1) { start = null; return; }
      start = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }, { passive: true });

    B8.on(board, 'touchmove', function (e) {
      if (!start || e.touches.length !== 1) return;
      var dx = e.touches[0].clientX - start.x;
      var dy = e.touches[0].clientY - start.y;
      // 棋盘已 touch-action:none；这里再拦一次，防止个别浏览器把页面一起滚走
      if (e.cancelable && (Math.abs(dx) > 12 || Math.abs(dy) > 12)) e.preventDefault();
    }, { passive: false });

    B8.on(board, 'touchend', function (e) {
      if (!start) return;
      var t = e.changedTouches && e.changedTouches[0];
      var s0 = start;
      start = null;
      if (!t) return;
      var dx = t.clientX - s0.x;
      var dy = t.clientY - s0.y;
      var ax = Math.abs(dx);
      var ay = Math.abs(dy);
      if (Math.max(ax, ay) < 24) return;   // 太短，当点击处理，不动棋盘
      if (ax > ay) move(dx > 0 ? 'right' : 'left');
      else move(dy > 0 ? 'down' : 'up');
    });

    B8.on(board, 'touchcancel', function () { start = null; });
    B8.on(restartBtn, 'click', reset);
  }

  /* ---------- 作弊模式 ---------- */
  // 只在本地改棋盘，不动分数、不上榜；开了作弊的这一局 reportOnce 会被 cheated 挡住。
  var cheatOn = false;

  function cheatEls() {
    return {
      panel: B8.qs('#g2048-cheat'),
      toggle: B8.qs('#g2048-cheat-toggle'),
      num: B8.qs('#g2048-cheat-num'),
      setBtn: B8.qs('#g2048-cheat-set'),
      swapBtn: B8.qs('#g2048-cheat-swap'),
      clearBtn: B8.qs('#g2048-cheat-clear')
    };
  }

  function cellFromPoint(clientX, clientY) {
    var grid = B8.qs('#g2048-grid');
    if (!grid) return -1;
    var r = grid.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return -1;
    var c = Math.floor(((clientX - r.left) / r.width) * N);
    var row = Math.floor(((clientY - r.top) / r.height) * N);
    if (c < 0 || c >= N || row < 0 || row >= N) return -1;
    return row * N + c;
  }

  function markPicked() {
    var el = B8.qs('#g2048-board');
    if (!el) return;
    B8.qsa('.b2048-tile', el).forEach(function (node) { node.classList.remove('is-picked'); });
    picked.forEach(function (idx) {
      var t = slots[idx];
      if (t && t.el) t.el.classList.add('is-picked');
    });
  }

  function refreshCheatButtons() {
    var e = cheatEls();
    if (!e.setBtn) return;
    e.setBtn.disabled = picked.length < 1;
    e.swapBtn.disabled = picked.length < 2;
    e.clearBtn.disabled = picked.length < 1;
  }

  function pickCell(idx) {
    if (!cheatOn || idx < 0) return;
    var at = picked.indexOf(idx);
    if (at >= 0) picked.splice(at, 1);
    else {
      picked.push(idx);
      if (picked.length > 2) picked.shift();
    }
    markPicked();
    refreshCheatButtons();
  }

  function setCell(idx, v) {
    if (slots[idx]) {
      slots[idx].v = v;
      paint(slots[idx]);
    } else {
      var t = makeTile(idx, v);
      place(t, idx);
      slots[idx] = t;
      if (!t.el.parentNode) layerEl.appendChild(t.el);
    }
    updateMax();
    markPicked();
  }

  function initCheat() {
    var e = cheatEls();
    if (!e.toggle) return;

    B8.on(e.toggle, 'click', function () {
      cheatOn = !cheatOn;
      cheated = cheated || cheatOn;              // 只要开过，这一局就不算数
      e.toggle.setAttribute('aria-pressed', cheatOn ? 'true' : 'false');
      e.toggle.textContent = cheatOn ? '退出作弊' : '作弊模式';
      if (e.panel) e.panel.hidden = !cheatOn;
      picked = [];
      markPicked();
      refreshCheatButtons();
      if (cheatOn) {
        setNote('作弊模式已开：这一局不计入排行榜。点格子选中，改数字或交换。');
      } else if (cheated) {
        setNote('这一局动过作弊模式，结束也不会记到排行榜。想上榜就点重开。');
      }
    });

    // 点棋盘选格子（只有作弊模式下有用）
    B8.on(board, 'click', function (ev) {
      if (!cheatOn) return;
      ev.preventDefault();
      pickCell(cellFromPoint(ev.clientX, ev.clientY));
    });

    B8.on(e.setBtn, 'click', function () {
      if (!picked.length) return;
      var v = Number(e.num && e.num.value);
      if (!v || v < 2 || (v & (v - 1)) !== 0 || v > 131072) {
        B8.toast('填 2、4、8 这种 2 的幂（最大 131072）');
        return;
      }
      setCell(picked[picked.length - 1], v);
      B8.toast('第 ' + (picked[picked.length - 1] + 1) + ' 格改成 ' + v);
    });

    B8.on(e.swapBtn, 'click', function () {
      if (picked.length < 2) return;
      var a = slots[picked[0]];
      var b2 = slots[picked[1]];
      slots[picked[0]] = b2 || null;
      slots[picked[1]] = a || null;
      if (slots[picked[0]]) place(slots[picked[0]], picked[0]);
      if (slots[picked[1]]) place(slots[picked[1]], picked[1]);
      updateMax();
      picked = [];
      markPicked();
      refreshCheatButtons();
      B8.toast('两格已交换');
    });

    B8.on(e.clearBtn, 'click', function () {
      if (!picked.length) return;
      var idx = picked[picked.length - 1];
      var t = slots[idx];
      if (t && t.el && t.el.parentNode) t.el.parentNode.removeChild(t.el);
      slots[idx] = null;
      updateMax();
      picked = [];
      markPicked();
      refreshCheatButtons();
      B8.toast('清空了一格');
    });
  }

  /* ---------- 启动 ---------- */
  function init() {
    board = B8.qs('#g2048-board');
    if (!board) return;
    layerEl = B8.qs('#g2048-tiles-layer');
    scoreEl = B8.qs('#g2048-score');
    bestEl = B8.qs('#g2048-best');
    maxEl = B8.qs('#g2048-max');
    restartBtn = B8.qs('#g2048-restart');
    stateEl = B8.qs('#g2048-state');
    noteEl = B8.qs('#g2048-note');

    buildGrid();
    best = readBest();
    if (bestEl) bestEl.textContent = String(best);
    bindInput();
    initCheat();

    if (!B8.auth) return;
    B8.auth.ready(function (st) {
      writable = !!B8.sb.ready && st.kind !== 'preview';
      reset();
    });
  }

  whenReady(init);
  B8.games = B8.games || {};
  B8.games['2048'] = { reset: reset };
})();
