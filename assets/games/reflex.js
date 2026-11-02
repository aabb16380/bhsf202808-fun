/* ============================================================
   反应速度测试 · 八班游乐场
   ------------------------------------------------------------
   五轮：屏幕先保持安静 1.5–4 秒，然后变红；红了立刻点。
   抢跑一次 +800ms（累加到本轮），不直接判负——比"作废重来"
   更宽容，也更难靠乱点刷成绩。

   五次全部计入平均，不掐头去尾（抢跑仍按 +800ms/次计入本轮）。
   上榜分 = 1000000 − 平均毫秒 × 1000：
     150ms → 850000，200ms → 800000，250ms → 750000，300ms → 700000。
   ============================================================ */
(function () {
  'use strict';

  var B8 = window.B8;
  if (!B8) return;

  var ROUNDS = 5;
  var PENALTY_MS = 800;
  var MAX_SCORE = 1000000;
  var KEY_BEST = 'b8.reflex.best';

  var field, bigEl, subEl, flagEl, overlay, panel;
  var roundEl, lastEl, avgEl, bestEl;

  var state = 'menu';          // menu | wait | red | between | over
  var round = 0;
  var times = [];
  var penalties = [];
  var falseStarts = 0;
  var waitTimer = 0;
  var betweenTimer = 0;
  var redAt = 0;
  var gen = 0;
  var best = 0;
  var writable = false;
  var submitted = 0;

  function $(id) { return document.getElementById(id); }

  function whenReady(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  function now() {
    return window.performance && window.performance.now ? window.performance.now() : Date.now();
  }

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function readNum(key) {
    try { return Number(localStorage.getItem(key) || 0) || 0; } catch (e) { return 0; }
  }

  function store(key, val) {
    try { localStorage.setItem(key, String(val)); } catch (e) {}
  }

  function clearTimers() {
    if (waitTimer) { clearTimeout(waitTimer); waitTimer = 0; }
    if (betweenTimer) { clearTimeout(betweenTimer); betweenTimer = 0; }
  }

  /* ============================================================
     计分
     ============================================================ */

  function scoreOf(ms) {
    return clamp(Math.round(MAX_SCORE - ms * 1000), 0, MAX_SCORE);
  }

  /** 五次全部计入，直接取平均 */
  function average(list) {
    if (!list.length) return 0;
    var sum = 0;
    for (var i = 0; i < list.length; i++) sum += list[i];
    return sum / list.length;
  }

  function paintHud() {
    if (roundEl) roundEl.textContent = round ? (round + '/' + ROUNDS) : '—';
    if (lastEl) lastEl.textContent = times.length ? (Math.round(times[times.length - 1]) + 'ms') : '—';
    if (avgEl) avgEl.textContent = times.length ? (Math.round(average(times)) + 'ms') : '—';
    if (bestEl) bestEl.textContent = String(best);
  }

  function paintField(cls, big, sub, flag) {
    if (field) field.className = 'rf-field' + (cls ? ' ' + cls : '');
    if (bigEl) bigEl.textContent = big;
    if (subEl) subEl.textContent = sub;
    if (flagEl) flagEl.textContent = flag || '';
  }

  /* ============================================================
     一局流程
     ============================================================ */

  function start() {
    gen++;
    clearTimers();
    times = [];
    penalties = [];
    falseStarts = 0;
    round = 0;
    submitted = 0;
    overlay.hidden = true;
    paintHud();
    nextRound();
  }

  function nextRound() {
    if (round >= ROUNDS) { finish(); return; }
    round++;
    state = 'wait';
    paintHud();

    var extra = falseStarts ? (' · 抢跑 ' + falseStarts + ' 次（+' + (falseStarts * PENALTY_MS) + 'ms 已计入）') : '';
    paintField('is-wait', '等…', '屏幕变红的一瞬间点下去。', '第 ' + round + ' / ' + ROUNDS + ' 轮' + extra);

    var delay = 1500 + Math.random() * 2500;
    var g = gen;
    waitTimer = setTimeout(function () {
      if (g !== gen) return;
      turnRed();
    }, delay);
  }

  function turnRed() {
    if (state !== 'wait') return;
    state = 'red';
    redAt = now();
    paintField('is-red', '点！', '现在，越快越好。',
      '第 ' + round + ' / ' + ROUNDS + ' 轮' +
      (falseStarts ? (' · 抢跑 +' + (falseStarts * PENALTY_MS) + 'ms') : ''));
  }

  function press() {
    if (state === 'wait') {
      // 抢跑：+800ms，继续等红
      falseStarts++;
      paintField('is-wait', '等…', '抢跑了，这次 +800ms。继续等变红。',
        '第 ' + round + ' / ' + ROUNDS + ' 轮 · 抢跑 ' + falseStarts + ' 次');
      return;
    }
    if (state !== 'red') return;

    var rt = now() - redAt + falseStarts * PENALTY_MS;
    times.push(rt);
    penalties.push(falseStarts * PENALTY_MS);
    falseStarts = 0;
    state = 'between';
    paintHud();

    paintField('is-result', Math.round(rt) + 'ms',
      rt < 180 ? '快得有点不像人。' : (rt < 280 ? '不错，比平均快。' : '还有下一轮。'),
      '第 ' + round + ' / ' + ROUNDS + ' 轮' + (penalties[penalties.length - 1] ? ' · 含抢跑罚时' : ''));
    if (bigEl) bigEl.textContent = Math.round(rt) + 'ms';

    var g = gen;
    betweenTimer = setTimeout(function () {
      if (g !== gen) return;
      nextRound();
    }, 900);
  }

  function finish() {
    state = 'over';
    clearTimers();
    var avg = average(times);
    var score = scoreOf(avg);
    var isNew = score > best;
    if (isNew) {
      best = score;
      store(KEY_BEST, best);
    }
    paintHud();
    paintField('', '结束', '五次反应都记下来了。', '');
    showResult(avg, score, isNew);
    submitScore(score);
  }

  /* ============================================================
     面板
     ============================================================ */

  function showMenu() {
    state = 'menu';
    clearTimers();
    round = 0;
    times = [];
    penalties = [];
    falseStarts = 0;
    paintHud();
    paintField('', '准备', '点「开始」后，屏幕会先保持安静。', '');

    panel.innerHTML =
      '<h1>反应速度</h1>' +
      '<p class="sub">屏幕先安静 1.5–4 秒，然后变红。<br>红的瞬间点下去，看你的手比脑子快多少。</p>' +
      '<ul class="rules">' +
        '<li>一共 <b>5 轮</b>，每轮随机等待 1.5–4 秒。</li>' +
        '<li>红的之前点 = <b>抢跑</b>，本轮 <b>+800ms</b>，继续等。</li>' +
        '<li><b>五次全部计入平均</b>，不掐头去尾。</li>' +
        '<li>上榜分 = <b>1000000 − 平均毫秒 × 1000</b>：150ms → 850000，200ms → 800000，300ms → 700000。</li>' +
      '</ul>' +
      '<p class="rf-score-note">五次都算，每一轮都要认真；抢跑和手抖不会被自动丢掉。' +
        '手机触屏本身有几十毫秒延迟，成绩会比电脑略慢，这属于设备差异。</p>' +
      '<button class="btn-main" type="button" data-act="go">开始</button>' +
      '<p class="tip">' +
        (B8.auth && B8.auth.isLogged()
          ? '成绩会记到排行榜（本机最高 ' + best + ' 分）。'
          : '没登录，成绩只存在这台设备 · <a href="index.html">回游乐场登录</a>') +
      '</p>' +
      '<p class="tip"><a href="index.html">← 回游乐场</a></p>';

    overlay.hidden = false;
  }

  function showResult(avg, score, isNew) {
    var rows = '';
    for (var i = 0; i < times.length; i++) {
      rows += '<tr><td>' + (i + 1) + '</td><td>' + Math.round(times[i]) + 'ms</td><td>' +
        (penalties[i] ? ('+' + penalties[i] + 'ms') : '—') + '</td></tr>';
    }
    var bestSingle = times.length ? Math.min.apply(null, times) : 0;

    panel.innerHTML =
      '<h1>' + (isNew ? '新纪录' : '五轮结束') + '</h1>' +
      '<p class="sub">五次全部计入，直接取平均（最快 ' + Math.round(bestSingle) +
        'ms / 最慢 ' + Math.round(Math.max.apply(null, times)) + 'ms 只作参考，不剔除）。</p>' +
      '<div class="result">' +
        '<div><span class="big">' + score + '</span><span class="big-unit">分</span></div>' +
        '<p class="rank-line">平均反应 <b>' + Math.round(avg) + 'ms</b> · 本机最高 ' + best + '</p>' +
        '<dl>' +
          '<div><dt>平均</dt><dd>' + Math.round(avg) + 'ms</dd></div>' +
          '<div><dt>最快</dt><dd>' + Math.round(bestSingle) + 'ms</dd></div>' +
          '<div><dt>上榜分</dt><dd>' + score + '</dd></div>' +
        '</dl>' +
        '<table class="lv-table" style="margin:12px 0 0"><thead><tr>' +
          '<th>轮</th><th>反应</th><th>抢跑罚时</th></tr></thead><tbody>' +
          rows + '</tbody></table>' +
      '</div>' +
      '<p class="note-line" id="rf-note">' +
        (isNew ? '本机新纪录。' : '本机最高 ' + best + ' 分。') +
      '</p>' +
      '<button class="btn-main" type="button" data-act="again">再来一次</button>' +
      '<button class="btn-2nd" type="button" data-act="menu">回说明</button>' +
      '<p class="tip"><a href="index.html">← 回游乐场</a></p>';

    overlay.hidden = false;
  }

  function setNote(msg, isErr) {
    var n = $('rf-note');
    if (!n) return;
    n.textContent = msg;
    n.classList[isErr ? 'add' : 'remove']('is-err');
  }

  /* ============================================================
     排行榜
     ============================================================ */

  function submitScore(v) {
    if (!writable || !B8.auth || !B8.sb) return;
    if (!v || v <= submitted || v > MAX_SCORE) return;
    submitted = v;
    B8.sb.rpc('b8_score_add', {
      p_token: B8.auth.token(),
      p_game: 'reflex',
      p_score: Math.floor(v)
    }).then(function () {
      setNote('成绩已记到排行榜：' + v + ' 分（平均 ' + Math.round(average(times)) + 'ms）。');
    }).catch(function (err) {
      submitted = 0;
      setNote('成绩没传上去：' + (err && err.message ? err.message : '网络异常'), true);
    });
  }

  /* ============================================================
     启动
     ============================================================ */

  function bindPanel() {
    panel.addEventListener('click', function (ev) {
      var t = ev.target;
      while (t && t.nodeType === 1 && !(t.getAttribute && t.getAttribute('data-act'))) {
        t = t.parentNode;
      }
      var act = t && t.getAttribute ? t.getAttribute('data-act') : null;
      if (!act) return;
      if (act === 'go' || act === 'again') start();
      else if (act === 'menu') showMenu();
    });
  }

  function init() {
    field = $('rf-field');
    bigEl = $('rf-big');
    subEl = $('rf-sub');
    flagEl = $('rf-flag');
    overlay = $('overlay');
    panel = $('panel');
    roundEl = $('rf-round');
    lastEl = $('rf-last');
    avgEl = $('rf-avg');
    bestEl = $('rf-best');

    if (!field || !panel) return;

    best = readNum(KEY_BEST);
    paintHud();
    bindPanel();

    B8.on(field, 'pointerdown', function (ev) {
      ev.preventDefault();
      press();
    });
    B8.on(document, 'keydown', function (ev) {
      if (ev.key === ' ' || ev.key === 'Enter') {
        if (state === 'wait' || state === 'red') {
          ev.preventDefault();
          press();
        }
      }
      if (ev.key === 'Escape' && (state === 'wait' || state === 'red' || state === 'between')) {
        showMenu();
      }
    });
    B8.on($('btn-exit'), 'click', function () { location.href = 'index.html'; });

    var apply = function () {
      writable = !!(B8.sb && B8.sb.ready) && B8.auth.isLogged() && B8.auth.kind() !== 'preview';
      if (state === 'menu') showMenu();
    };
    document.addEventListener('b8:auth', apply);
    if (B8.auth) B8.auth.ready(apply);

    showMenu();
  }

  whenReady(init);

  /* ============================================================
     自检接口（?t= 调试入口下可用）
     ============================================================ */

  B8.games = B8.games || {};
  var api = {
    start: start,
    press: press,
    menu: showMenu,
    scoreFor: scoreOf,
    state: function () {
      return {
        state: state, round: round, times: times.slice(),
        penalties: penalties.slice(), falseStarts: falseStarts,
        avg: times.length ? average(times) : 0, best: best, writable: writable
      };
    }
  };

  if (window.B8_TEST) {
    api.forceRed = function () {
      if (state === 'wait') turnRed();
      return state;
    };
    api.feed = function (list) {
      times = (list || []).slice();
      penalties = [];
      falseStarts = 0;
      round = ROUNDS;
      finish();
      return { score: scoreOf(average(times)), avg: average(times) };
    };
  }

  B8.games.reflex = api;
})();
