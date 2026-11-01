/* ============================================================
   钢琴辉
   ------------------------------------------------------------
   四个琴键，辉辉从天而降。落到底线以内点中它就算接住，
   点空 / 漏掉都算失误。三失误结束。
   键盘：D F J K；手机：直接点琴键。
   ============================================================ */
(function () {
  'use strict';

  var B8 = window.B8;
  if (!B8) return;

  var KEY_BEST = 'b8.piano.best';
  var LANES = 4;
  var LANE_KEYS = ['D', 'F', 'J', 'K'];

  var board, layers, scoreEl, comboEl, bestEl, livesEl, stateEl, noteEl, startBtn;
  var running = false;
  var score = 0;
  var combo = 0;
  var maxCombo = 0;
  var lives = 3;
  var hits = 0;
  var misses = 0;

  var raf = 0;
  var lastTs = 0;
  var spawnTimer = 0;
  var spawnGap = 900;          // 毫秒，会越来越短
  var speed = 0.42;            // px/ms，会越来越快
  var tiles = [];              // { el, lane, y, h, hit }
  var pending = [];            // 待判定
  var laneEls = [];
  var uid = 0;
  var writable = false;
  var over = false;

  function whenReady(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  function readBest() {
    try { return Number(localStorage.getItem(KEY_BEST) || 0) || 0; } catch (e) { return 0; }
  }

  function saveBest(v) {
    try { localStorage.setItem(KEY_BEST, String(v)); } catch (e) {}
  }

  function setState(msg, good) {
    if (!stateEl) return;
    stateEl.textContent = msg || '';
    stateEl.classList.toggle('is-good', !!good);
  }

  function setNote(msg) {
    if (noteEl) noteEl.textContent = msg || '';
  }

  function paintHud() {
    if (scoreEl) scoreEl.textContent = String(score);
    if (comboEl) comboEl.textContent = combo > 1 ? ('×' + combo) : '—';
    if (bestEl) bestEl.textContent = String(readBest());
    if (livesEl) livesEl.textContent = new Array(lives + 1).join('♥') || '—';
  }

  function laneHeight() {
    return board ? board.clientHeight : 0;
  }

  function spawn() {
    if (!running) return;
    var lane = Math.floor(Math.random() * LANES);
    var h = Math.max(72, Math.round(laneHeight() * 0.19));

    var t = el('button', 'piano-tile');
    t.type = 'button';
    t.setAttribute('data-lane', String(lane));
    t.setAttribute('data-uid', String(++uid));
    t.setAttribute('aria-label', '辉辉');
    t.style.height = h + 'px';

    var face = el('span', 'piano-face');
    t.appendChild(face);

    var hit = el('span', 'piano-ring');
    t.appendChild(hit);

    laneEls[lane].appendChild(t);

    var item = { el: t, lane: lane, y: -h, h: h, dead: false, id: uid };
    t.__item = item;
    tiles.push(item);
  }

  function hitZoneTop() {
    var H = laneHeight();
    return H - Math.round(H * 0.22);   // 底部 22% 是判定区
  }

  function judge(item) {
    if (item.dead || !running) return;
    var H = laneHeight();
    var zoneTop = hitZoneTop();
    var bottom = item.y + item.h;

    // 只有"碰到判定区"的才算，太早太晚都算点空
    if (bottom >= zoneTop && item.y <= H) {
      item.dead = true;
      item.el.classList.add('is-hit');
      combo += 1;
      hits += 1;
      maxCombo = Math.max(maxCombo, combo);
      score += 10 + Math.min(combo, 20) * 2;
      paintHud();
      if (combo >= 3) setState('连击 ×' + combo, true);
      setTimeout(function () {
        if (item.el.parentNode) item.el.parentNode.removeChild(item.el);
      }, 220);
    } else {
      // 点空了
      combo = 0;
      score = Math.max(0, score - 5);
      paintHud();
      setState('点空了', false);
      item.el.classList.add('is-shake');
      setTimeout(function () {
        if (item.el) item.el.classList.remove('is-shake');
      }, 220);
      miss();
    }
  }

  function miss() {
    if (!running) return;
    lives -= 1;
    misses += 1;
    combo = 0;
    paintHud();
    if (lives <= 0) gameOver();
  }

  function removeTile(item) {
    item.dead = true;
    if (item.el && item.el.parentNode) item.el.parentNode.removeChild(item.el);
  }

  function tick(ts) {
    if (!running) return;
    if (!lastTs) lastTs = ts;
    var dt = Math.min(64, ts - lastTs);
    lastTs = ts;

    var H = laneHeight();
    var zoneTop = hitZoneTop();

    spawnTimer += dt;
    if (spawnTimer >= spawnGap) {
      spawnTimer = 0;
      spawn();
    }

    for (var i = tiles.length - 1; i >= 0; i--) {
      var t = tiles[i];
      if (t.dead) { tiles.splice(i, 1); continue; }
      t.y += speed * dt;
      t.el.style.transform = 'translateY(' + t.y + 'px)';

      // 整个越过底线还没点 → 漏
      if (t.y > H + 8) {
        removeTile(t);
        tiles.splice(i, 1);
        setState('漏了一个', false);
        miss();
      } else if (t.y + t.h > zoneTop) {
        t.el.classList.add('is-zone');
      }
    }

    raf = requestAnimationFrame(tick);
  }

  function reset() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    lastTs = 0;
    score = 0; combo = 0; maxCombo = 0; lives = 3; hits = 0; misses = 0;
    spawnTimer = 0; spawnGap = 900; speed = 0.42;
    tiles.forEach(function (t) { if (t.el && t.el.parentNode) t.el.parentNode.removeChild(t.el); });
    tiles = [];
    over = false;
    laneEls.forEach(function (l) { l.innerHTML = ''; });
    paintHud();
  }

  function start() {
    if (!board) return;
    reset();
    running = true;
    over = false;
    if (startBtn) startBtn.hidden = true;
    board.classList.add('is-running');
    setState('开始了，接住辉辉');
    setNote('点中判定区里的辉辉得分，点空或漏掉扣 ♥。');
    raf = requestAnimationFrame(tick);
  }

  function gameOver() {
    running = false;
    over = true;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    board.classList.remove('is-running');
    if (startBtn) {
      startBtn.hidden = false;
      startBtn.textContent = '再来一局';
    }
    setState('结束了：' + score + ' 分，最高连击 ×' + maxCombo, false);

    var best = readBest();
    if (score > best) { saveBest(score); paintHud(); setNote('新纪录！'); }
    else setNote('最高分 ' + best + ' 分。');

    submitScore(score);
  }

  /* ---------- 上传成绩 ---------- */
  var submitted = 0;

  function submitScore(v) {
    if (!writable || !B8.auth || !B8.auth.token()) return;
    v = Math.floor(v);
    if (v <= 0 || v <= submitted || v > 1000000) return;
    submitted = v;
    B8.sb.rpc('b8_score_add', { p_token: B8.auth.token(), p_game: 'piano', p_score: v })
      .then(function () {
        setNote('成绩已记到排行榜：' + v + ' 分。');
        if (B8.fun && B8.fun.rankSaved) B8.fun.rankSaved('piano');
      })
      .catch(function (err) {
        submitted = 0;
        setNote('成绩没传上去：' + (err && err.message ? err.message : '网络异常'));
      });
  }

  /* ---------- 输入 ---------- */
  function laneFromPoint(clientX) {
    if (!board) return -1;
    var r = board.getBoundingClientRect();
    if (!r.width) return -1;
    var x = clientX - r.left;
    var lane = Math.floor((x / r.width) * LANES);
    if (lane < 0 || lane >= LANES) return -1;
    return lane;
  }

  function tileInLane(lane) {
    // 判定区里最靠下的那一块
    var best = null;
    var H = laneHeight();
    for (var i = 0; i < tiles.length; i++) {
      var t = tiles[i];
      if (t.dead || t.lane !== lane) continue;
      if (t.y + t.h < hitZoneTop()) continue;
      if (t.y > H) continue;
      if (!best || t.y > best.y) best = t;
    }
    return best;
  }

  function pressLane(lane) {
    if (!running) return;
    var t = tileInLane(lane);
    if (t) { judge(t); return; }
    // 该道没有可判定块 → 点空
    combo = 0;
    score = Math.max(0, score - 5);
    paintHud();
    setState('点空了', false);
    miss();
  }

  function init() {
    board = B8.qs('#piano-board');
    if (!board) return;

    scoreEl = B8.qs('#piano-score');
    comboEl = B8.qs('#piano-combo');
    bestEl = B8.qs('#piano-best');
    livesEl = B8.qs('#piano-lives');
    stateEl = B8.qs('#piano-state');
    noteEl = B8.qs('#piano-note');
    startBtn = B8.qs('#piano-start');

    layers = B8.qs('#piano-lanes');
    laneEls = [];
    if (layers) {
      layers.innerHTML = '';
      for (var i = 0; i < LANES; i++) {
        var lane = el('div', 'piano-lane');
        lane.setAttribute('data-lane', String(i));
        var key = el('span', 'piano-key', LANE_KEYS[i]);
        lane.appendChild(key);
        layers.appendChild(lane);
        laneEls.push(lane);
      }
    }

    B8.on(board, 'pointerdown', function (ev) {
      if (!running) return;
      ev.preventDefault();
      var lane = laneFromPoint(ev.clientX);
      if (lane >= 0) pressLane(lane);
    });

    B8.on(startBtn, 'click', start);

    B8.on(document, 'keydown', function (ev) {
      if (!running) {
        if ((ev.key === 'Enter' || ev.key === ' ') && document.activeElement === startBtn) {
          ev.preventDefault();
          start();
        }
        return;
      }
      var k = String(ev.key || '').toUpperCase();
      var idx = LANE_KEYS.indexOf(k);
      if (idx >= 0) {
        ev.preventDefault();
        pressLane(idx);
      }
      if (k === 'ESCAPE') { running = false; reset(); setState('停下来了'); if (startBtn) startBtn.hidden = false; }
    });

    window.addEventListener('resize', function () {
      if (!running) return;
      // 尺寸变了就按新的高度重排，避免判定区错位
    });

    paintHud();
    setNote('点「开始」或者按空格。键盘 D F J K 对应四道。');

    if (!B8.auth) return;
    B8.auth.ready(function (st) {
      writable = !!B8.sb.ready && st.kind !== 'preview';
      if (!writable) setNote('没登录，成绩只存在这台设备。');
    });
  }

  whenReady(init);
  B8.games = B8.games || {};
  B8.games['piano'] = { reset: reset, start: start };
})();
