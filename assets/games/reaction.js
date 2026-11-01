/* ============================================================
   专注方格（Schulte Table）· 八班游乐场版
   ------------------------------------------------------------
   25 个数字打乱，从 1 点到 25。计时用 performance.now()，
   比 Date.now() 稳；展示精确到毫秒，但只在收表那一刻定稿。

   点错一次计时 +1 秒，同时闪红——练的是「看准了再点」，手滑是有代价的。
   排行榜越大越好，所以上传 60000 − 毫秒。
   ============================================================ */
(function () {
  'use strict';

  var B8 = window.B8 = window.B8 || {};
  var KEY_BEST = 'b8.reaction.best';
  var N = 25;

  var grid, timeEl, bestEl, progressEl, stateEl, noteEl, restartBtn;
  var next = 1;
  var started = false;
  var finished = false;
  var startAt = 0;
  var ticker = 0;
  var penaltyMs = 0;      // 点错一次 +1 秒
  var best = 0;
  var writable = false;
  var submitted = false;
  var gen = 0;
  var wrongTimer = 0;

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

  function now() {
    return window.performance && window.performance.now ? window.performance.now() : Date.now();
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

  function fmt(ms, digits) {
    return (ms / 1000).toFixed(digits) + ' s';
  }

  function elapsed() {
    return Math.max(0, now() - startAt + penaltyMs);
  }

  function tick() {
    if (timeEl) timeEl.textContent = fmt(elapsed(), 3);
  }

  /* ---------- 牌面 ---------- */
  function build() {
    var order = [];
    var i;
    for (i = 1; i <= N; i++) order.push(i);
    for (i = order.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = order[i];
      order[i] = order[j];
      order[j] = tmp;
    }

    grid.innerHTML = '';
    for (i = 0; i < order.length; i++) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'schulte-cell';
      b.textContent = String(order[i]);
      b.setAttribute('data-v', String(order[i]));
      b.setAttribute('aria-label', '数字 ' + order[i]);
      B8.on(b, 'click', onCell);
      grid.appendChild(b);
    }
  }

  function onCell(e) {
    var btn = e.currentTarget;
    if (finished) return;

    if (!started) {
      started = true;
      startAt = now();
      ticker = setInterval(tick, 50);
    }

    var v = Number(btn.getAttribute('data-v'));

    if (v === next) {
      btn.classList.add('is-done');
      btn.disabled = true;
      next++;
      if (progressEl) progressEl.textContent = (next - 1) + ' / ' + N;
      if (next > N) finish();
      else setState('下一个：' + next + '。');
      return;
    }

    // 点错：红一下，并且计时 +1 秒
    penaltyMs += 1000;
    if (timeEl) timeEl.textContent = fmt(elapsed(), 3);
    if (wrongTimer) { clearTimeout(wrongTimer); wrongTimer = 0; }
    btn.classList.add('is-wrong');
    var g = gen;
    wrongTimer = setTimeout(function () {
      if (g !== gen) return;
      btn.classList.remove('is-wrong');
    }, 320);
    setState('点错了 +1 秒，现在要找 ' + next + '。', false);
  }

  function finish() {
    finished = true;
    if (ticker) { clearInterval(ticker); ticker = 0; }
    var ms = Math.max(1, Math.round(elapsed()));
    if (timeEl) timeEl.textContent = fmt(ms, 3);

    if (!best || ms < best) {
      best = ms;
      saveBest(best);
      if (bestEl) bestEl.textContent = fmt(best, 2);
      B8.toast('新纪录：' + fmt(ms, 2));
    } else {
      B8.toast('25 个点完了：' + fmt(ms, 2));
    }

    setState('点完了！用时 ' + fmt(ms, 3) + '。点重开再试一次。', true);
    submitScore(ms);
  }

  function submitScore(ms) {
    if (!writable || submitted || !B8.auth || !B8.auth.token()) return;
    submitted = true;
    // 毫秒越小越好 → 换算成 60000 - 毫秒 传给「越大越好」的榜
    var score = Math.max(0, Math.min(1000000, 60000 - ms));
    B8.sb.rpc('b8_score_add', { p_token: B8.auth.token(), p_game: 'schulte', p_score: score })
      .then(function () {
        setNote('已记到排行榜：' + (ms / 1000).toFixed(2) + ' 秒（上榜分 ' + score + '）。');
        if (B8.fun && B8.fun.rankSaved) B8.fun.rankSaved('schulte');
      })
      .catch(function (err) {
        submitted = false;
        setNote('成绩没传上去：' + (err && err.message ? err.message : '未知错误'), true);
      });
  }

  /* ---------- 重开 ---------- */
  function reset() {
    gen++;
    if (ticker) { clearInterval(ticker); ticker = 0; }
    if (wrongTimer) { clearTimeout(wrongTimer); wrongTimer = 0; }
    next = 1;
    started = false;
    finished = false;
    startAt = 0;
    penaltyMs = 0;
    submitted = false;

    build();
    if (timeEl) timeEl.textContent = '0.000 s';
    if (progressEl) progressEl.textContent = '0 / ' + N;
    if (bestEl) bestEl.textContent = best ? fmt(best, 2) : '—';
    setState('从 1 开始，按顺序点到 25；计时从第一下点击开始。', false);
    setNote(writable
      ? '完成后自动上传：上榜分 = 60000 − 毫秒（越快越靠前）。'
      : '成绩只存在这台设备：数据库还没接，暂时不上传排行榜。');
  }

  /* ---------- 启动 ---------- */
  function init() {
    grid = B8.qs('#gschulte-grid');
    if (!grid) return;
    timeEl = B8.qs('#gschulte-time');
    bestEl = B8.qs('#gschulte-best');
    progressEl = B8.qs('#gschulte-progress');
    stateEl = B8.qs('#gschulte-state');
    noteEl = B8.qs('#gschulte-note');
    restartBtn = B8.qs('#gschulte-restart');

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
  B8.games.schulte = { reset: reset };
})();
