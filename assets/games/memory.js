/* ============================================================
   记忆翻牌 · 八班游乐场版
   ------------------------------------------------------------
   八对牌 = 八班元素单字：八、四、届、班、课、考、球、歌。
   3D 翻转交给 CSS（.mem-inner 的 rotateY），JS 只切 class，
   这样翻牌不占主线程，也不会出现两张牌动画不同步。

   步数按「翻一对」计：越少越好。排行榜是越大越好，所以
   上传 1000 − 步数（界面上写明了这件事，免得同学困惑）。
   ============================================================ */
(function () {
  'use strict';

  var B8 = window.B8 = window.B8 || {};
  var KEY_BEST = 'b8.memory.best';
  var CHARS = ['八', '四', '届', '班', '课', '考', '球', '歌'];

  var grid, stepsEl, timeEl, bestEl, stateEl, noteEl, restartBtn;
  var deck = [];        // [{v, matched}]
  var cards = [];       // 与 deck 同序的按钮
  var first = -1;
  var second = -1;
  var locked = false;
  var finished = false;
  var steps = 0;
  var matched = 0;
  var startAt = 0;
  var timer = 0;
  var best = 0;
  var writable = false;
  var submitted = false;
  var gen = 0;          // 重开代数：旧局留下的 setTimeout 不许动新局

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

  function fmt(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    var m = Math.floor(s / 60);
    var r = s % 60;
    return m + ':' + (r < 10 ? '0' + r : '' + r);
  }

  /* ---------- 牌桌 ---------- */
  function shuffled() {
    var list = [];
    var i;
    for (i = 0; i < CHARS.length; i++) {
      list.push({ v: CHARS[i], matched: false });
      list.push({ v: CHARS[i], matched: false });
    }
    // Fisher–Yates
    for (i = list.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = list[i];
      list[i] = list[j];
      list[j] = tmp;
    }
    return list;
  }

  function render() {
    grid.innerHTML = '';
    cards = [];
    for (var i = 0; i < deck.length; i++) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'mem-card';
      b.setAttribute('aria-label', '第 ' + (i + 1) + ' 张牌，未翻开');

      var inner = document.createElement('span');
      inner.className = 'mem-inner';

      var back = document.createElement('span');
      back.className = 'mem-face mem-back';
      back.textContent = '八';
      back.setAttribute('aria-hidden', 'true');

      var front = document.createElement('span');
      front.className = 'mem-face mem-front';
      front.textContent = deck[i].v;
      front.setAttribute('aria-hidden', 'true');

      inner.appendChild(back);
      inner.appendChild(front);
      b.appendChild(inner);

      (function (idx) {
        B8.on(b, 'click', function () { flip(idx); });
      })(i);

      grid.appendChild(b);
      cards.push(b);
    }
  }

  function reveal(i) {
    cards[i].classList.add('is-flip');
    cards[i].setAttribute('aria-label', '第 ' + (i + 1) + ' 张牌：' + deck[i].v);
  }

  function hide(i) {
    cards[i].classList.remove('is-flip');
    cards[i].setAttribute('aria-label', '第 ' + (i + 1) + ' 张牌，未翻开');
  }

  function startTimer() {
    if (startAt) return;
    startAt = Date.now();
    timer = setInterval(function () {
      if (timeEl) timeEl.textContent = fmt(Date.now() - startAt);
    }, 250);
  }

  function stopTimer() {
    if (timer) { clearInterval(timer); timer = 0; }
  }

  function updatePairs() {
    setState('已配对 ' + (matched / 2) + ' / 8 · 步数 ' + steps + '。', false);
  }

  function flip(i) {
    if (locked || finished || !deck[i] || deck[i].matched) return;
    if (i === first || i === second) return;

    startTimer();

    if (first < 0) {
      first = i;
      reveal(i);
      if (!steps && matched === 0) setState('再翻一张，看看是不是同一个字。');
      return;
    }

    reveal(i);
    second = i;
    steps++;
    if (stepsEl) stepsEl.textContent = String(steps);
    locked = true;

    var a = first;
    var b = i;
    var g = gen;

    if (deck[a].v === deck[b].v) {
      // 配对成功：等翻牌动画过了再标记，视觉上更顺
      setTimeout(function () {
        if (g !== gen) return;
        deck[a].matched = true;
        deck[b].matched = true;
        matched += 2;
        cards[a].classList.add('is-matched');
        cards[b].classList.add('is-matched');
        cards[a].disabled = true;
        cards[b].disabled = true;
        cards[a].setAttribute('aria-label', '已配对：' + deck[a].v);
        cards[b].setAttribute('aria-label', '已配对：' + deck[b].v);
        first = -1;
        second = -1;
        locked = false;
        updatePairs();
        if (matched === 16) finish();
      }, 360);
    } else {
      setState('不一样，记一下位置。');
      setTimeout(function () {
        if (g !== gen) return;
        hide(a);
        hide(b);
        first = -1;
        second = -1;
        locked = false;
        updatePairs();
      }, 760);
    }
  }

  /* ---------- 完成 ---------- */
  function submitScore() {
    if (!writable || submitted || !B8.auth || !B8.auth.token()) return;
    submitted = true;
    // 步数越少越好 → 换算成 1000 - 步数 传给「越大越好」的榜
    var score = Math.max(0, Math.min(1000000, 1000 - steps));
    B8.sb.rpc('b8_score_add', { p_token: B8.auth.token(), p_game: 'memory', p_score: score })
      .then(function () {
        setNote('已记到排行榜：' + steps + ' 步（上榜分 ' + score + '）。');
        if (B8.fun && B8.fun.rankSaved) B8.fun.rankSaved('memory');
      })
      .catch(function (err) {
        submitted = false;
        setNote('成绩没传上去：' + (err && err.message ? err.message : '未知错误'), true);
      });
  }

  function finish() {
    finished = true;
    stopTimer();
    var used = startAt ? Date.now() - startAt : 0;
    if (timeEl) timeEl.textContent = fmt(used);

    if (!best || steps < best) {
      best = steps;
      saveBest(best);
      if (bestEl) bestEl.textContent = best + ' 步';
    }

    setState('八对都配上了！用了 ' + steps + ' 步 · ' + fmt(used) + '。', true);

    if (best === steps) B8.toast('新纪录：' + steps + ' 步');
    else B8.toast('全部配对：' + steps + ' 步');

    submitScore();
  }

  /* ---------- 重开 ---------- */
  function reset() {
    gen++;
    stopTimer();
    first = -1;
    second = -1;
    locked = false;
    finished = false;
    steps = 0;
    matched = 0;
    startAt = 0;
    submitted = false;
    deck = shuffled();
    render();
    if (stepsEl) stepsEl.textContent = '0';
    if (timeEl) timeEl.textContent = '0:00';
    if (bestEl) bestEl.textContent = best ? best + ' 步' : '—';
    setState('翻开两张牌，找一样的字。', false);
    setNote(writable
      ? '完成后自动上传：上榜分 = 1000 − 步数（步数越少越靠前）。'
      : '成绩只存在这台设备：数据库还没接，暂时不上传排行榜。');
  }

  /* ---------- 启动 ---------- */
  function init() {
    grid = B8.qs('#gmemory-grid');
    if (!grid) return;
    stepsEl = B8.qs('#gmemory-steps');
    timeEl = B8.qs('#gmemory-time');
    bestEl = B8.qs('#gmemory-best');
    stateEl = B8.qs('#gmemory-state');
    noteEl = B8.qs('#gmemory-note');
    restartBtn = B8.qs('#gmemory-restart');

    best = readBest();
    B8.on(restartBtn, 'click', reset);

    if (!B8.auth) return;
    B8.auth.ready(function (st) {
      writable = !!B8.sb.ready && st.kind !== 'preview';
      reset();
    });
  }

  whenReady(init);
  B8.games = B8.games || {};
  B8.games.memory = { reset: reset };
})();
