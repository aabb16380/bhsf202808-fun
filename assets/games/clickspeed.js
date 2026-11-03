/* ============================================================
   手速测试（10 秒点击）· 八班游乐场
   ------------------------------------------------------------
   倒计时 3、2、1 之后开始，10 秒内在点击区里点得越多越好。
   每个 pointerdown 算一次（多指触屏时每根手指各算一次），
   鼠标/触屏都行；空格用键盘代替点击也计入（不响应长按重复）。

   上榜分 = 点击数（1 次 = 1 分，不再乘 1000，避免没有意义的大数和溢出）。
   计数上限 100000 次/10 秒（v2.68 从 1000 次提高）。
   ============================================================ */
(function () {
  'use strict';

  var B8 = window.B8;
  if (!B8) return;

  var DURATION = 10000;
  var MAX_SCORE = 100000;
  var KEY_BEST = 'b8.clickspeed.best.v2';
  var OLD_KEY_BEST = 'b8.clickspeed.best';
  // v2.68 换了计分方式，用新键把旧版「点击数 × 1000」的榜单独隔开
  var GAME_KEY = 'clickspeed2';

  var pad, countEl, hintEl, tipEl, ringEl, overlay, panel;
  var timeEl, clicksEl, cpsEl, bestEl;

  var state = 'menu';       // menu | count | run | over
  var count = 0;
  var startAt = 0;
  var endAt = 0;
  var tickTimer = 0;
  var endTimer = 0;
  var countdownTimer = 0;
  var gen = 0;
  var best = 0;
  var writable = false;
  var submitted = 0;
  var lastRippleAt = 0;

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

  /** 旧版把分数存成 点击数 × 1000；v2.68 起直接存点击数，读一次旧记录做迁移 */
  function readBest() {
    var v = clamp(readNum(KEY_BEST), 0, MAX_SCORE);
    if (v > 0) return v;
    var old = readNum(OLD_KEY_BEST);
    if (old > 0) {
      v = clamp(Math.round(old / 1000), 0, MAX_SCORE);
      store(KEY_BEST, v);
      return v;
    }
    return 0;
  }

  function store(key, val) {
    try { localStorage.setItem(key, String(val)); } catch (e) {}
  }

  function clearTimers() {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = 0; }
    if (endTimer) { clearTimeout(endTimer); endTimer = 0; }
    if (countdownTimer) { clearTimeout(countdownTimer); countdownTimer = 0; }
  }

  function scoreOf(n) {
    return clamp(Math.round(n), 0, MAX_SCORE);
  }

  function bestClicks() {
    return best;
  }

  function paintHud(left) {
    var remain = typeof left === 'number' ? left : DURATION;
    if (timeEl) timeEl.textContent = (remain / 1000).toFixed(1);
    if (clicksEl) clicksEl.textContent = String(count);
    var elapsed = Math.max(0, DURATION - remain) / 1000;
    if (cpsEl) cpsEl.textContent = elapsed > 0.2 ? (count / elapsed).toFixed(2) : '0.00';
    if (bestEl) bestEl.textContent = String(bestClicks());
  }

  function paintPad(cls, big, hint, tip) {
    if (pad) pad.className = 'cs-pad' + (cls ? ' ' + cls : '');
    if (countEl) countEl.textContent = big;
    if (hintEl) hintEl.textContent = hint || '';
    if (tipEl) tipEl.textContent = tip || '';
  }

  function ripple() {
    if (!ringEl) return;
    // 高速连点时不要每一下都强制 reflow 重启动画，否则主线程会被拖住，
    // 计时器看起来就像卡死/走到 0 还不结束。
    var t = now();
    if (t - lastRippleAt < 70) return;
    lastRippleAt = t;
    ringEl.classList.remove('is-go');
    void ringEl.offsetWidth;
    ringEl.classList.add('is-go');
  }

  /* ============================================================
     一局流程
     ============================================================ */

  function start() {
    gen++;
    clearTimers();
    count = 0;
    submitted = 0;
    overlay.hidden = true;
    state = 'count';
    startAt = 0;
    endAt = 0;
    paintHud(DURATION);
    paintPad('is-count', '3', '准备', '3、2、1 之后开始，手放在点击区里。');
    countdown(3);
  }

  function countdown(n) {
    if (state !== 'count') return;
    if (n <= 0) { beginRun(); return; }
    paintPad('is-count', String(n), '准备', '3、2、1 之后开始，手放在点击区里。');
    var g = gen;
    countdownTimer = setTimeout(function () {
      if (g !== gen) return;
      countdown(n - 1);
    }, 650);
  }

  function beginRun() {
    if (state !== 'count') return;
    state = 'run';
    count = 0;
    startAt = now();
    endAt = startAt + DURATION;
    paintPad('is-run', '0', '现在！点！', '10 秒内点得越多越好。');
    paintHud(DURATION);

    tickTimer = setInterval(tick, 50);
    endTimer = setTimeout(finish, DURATION);
  }

  function tick() {
    if (state !== 'run') return;
    var left = Math.max(0, endAt - now());
    paintHud(left);
    if (left <= 0) finish();
  }

  function finish() {
    if (state !== 'run') return;

    // 定时器可能比 deadline 早几毫秒，也可能被卡顿/后台节流拖晚。
    // 早了就补一个定时器等满 10 秒；晚了才按结束处理。
    var remain = endAt - now();
    if (remain > 0) {
      if (endTimer) clearTimeout(endTimer);
      endTimer = setTimeout(finish, remain + 10);
      return;
    }

    state = 'over';
    clearTimers();

    var left = Math.max(0, endAt - now());
    paintHud(left);
    paintPad('is-over', String(count), '时间到', '点「再来一次」再冲 10 秒。');

    var score = scoreOf(count);
    var isNew = score > best;
    if (isNew) {
      best = score;
      store(KEY_BEST, best);
    }
    paintHud(0);
    showResult(score, isNew);
    submitScore(score);
  }

  /* ============================================================
     面板
     ============================================================ */

  function showMenu() {
    state = 'menu';
    clearTimers();
    count = 0;
    paintHud(DURATION);
    paintPad('', '0', '10 秒，点这块区域', '点「开始」后倒计时 3、2、1，然后开始计数。');

    panel.innerHTML =
      '<h1>手速测试</h1>' +
      '<p class="sub">10 秒，一块点击区，点得越多越好。<br>手指、鼠标都行，多指同时按每根手指都算。</p>' +
      '<ul class="rules">' +
        '<li>倒计时 3、2、1 后开始，固定 <b>10 秒</b>。</li>' +
        '<li>点击区里每个 <b>pointerdown</b> 算一次；长按不重复计数。</li>' +
        '<li>上报分 = <b>点击数</b>：1 次 = 1 分，不乘系数。</li>' +
        '<li>计数上限 <b>100000 次</b>（对应 100000 分），正常 10 秒到不了。</li>' +
        '<li>同一个人只留最高分；手机上多指轮点也算。</li>' +
      '</ul>' +
      '<p class="rf-score-note" style="margin:10px 0 0;font-size:11.5px;line-height:1.8;color:var(--ink-3);text-align:left">' +
        '10 秒对每个人都一样，成绩只和手速有关；鼠标和触屏的点击延迟不同，' +
        '这条差异在排行榜上没法区分，属于设备条件。</p>' +
      '<button class="btn-main" type="button" data-act="go">开始</button>' +
      '<p class="tip">' +
        (B8.auth && B8.auth.isLogged()
          ? '成绩会记到排行榜（本机最高 ' + bestClicks() + ' 次）。'
          : '没登录，成绩只存在这台设备 · <a href="index.html">回游乐场登录</a>') +
      '</p>' +
      '<p class="tip"><a href="index.html">← 回游乐场</a></p>';

    overlay.hidden = false;
  }

  function showResult(score, isNew) {
    var cps = count / (DURATION / 1000);
    panel.innerHTML =
      '<h1>' + (isNew ? '新纪录' : '时间到') + '</h1>' +
      '<p class="sub">10 秒结束，这一局点了 ' + count + ' 下。</p>' +
      '<div class="result">' +
        '<div><span class="big">' + score + '</span><span class="big-unit">分</span></div>' +
        '<p class="rank-line">点击 <b>' + count + '</b> 下 · 平均 <b>' + cps.toFixed(2) + '</b> 次/秒</p>' +
        '<dl>' +
          '<div><dt>点击数</dt><dd>' + count + '</dd></div>' +
          '<div><dt>每秒</dt><dd>' + cps.toFixed(2) + '</dd></div>' +
          '<div><dt>本机最高</dt><dd>' + bestClicks() + ' 下</dd></div>' +
        '</dl>' +
      '</div>' +
      '<p class="note-line" id="cs-note">' +
        (isNew ? '本机新纪录。' : '本机最高 ' + bestClicks() + ' 下。') +
      '</p>' +
      '<button class="btn-main" type="button" data-act="again">再来一次</button>' +
      '<button class="btn-2nd" type="button" data-act="menu">回说明</button>' +
      '<p class="tip"><a href="index.html">← 回游乐场</a></p>';

    overlay.hidden = false;
  }

  function setNote(msg, isErr) {
    var n = $('cs-note');
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
      p_game: GAME_KEY,
      p_score: Math.floor(v)
    }).then(function () {
      setNote('成绩已记到排行榜：' + v + ' 分（' + count + ' 下 / 10 秒）。');
    }).catch(function (err) {
      submitted = 0;
      setNote('成绩没传上去：' + (err && err.message ? err.message : '网络异常'), true);
    });
  }

  /* ============================================================
     输入
     ============================================================ */

  function hit(ev) {
    if (state !== 'run') return;

    // 用事件自己的时间戳判断这一下是不是真的发生在 10 秒内。
    // 网卡/连点把事件排队到 deadline 之后处理时，不能算进成绩。
    var stamp = (ev && typeof ev.timeStamp === 'number' && ev.timeStamp > 0 && ev.timeStamp < 1e12)
      ? ev.timeStamp
      : now();
    if (stamp > endAt) { finish(); return; }

    if (ev && ev.preventDefault) ev.preventDefault();
    if (count < MAX_SCORE) count++;
    if (countEl) countEl.textContent = String(count);
    if (clicksEl) clicksEl.textContent = String(count);
    ripple();
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
    pad = $('cs-pad');
    countEl = $('cs-count');
    hintEl = $('cs-hint');
    tipEl = $('cs-tip');
    ringEl = $('cs-ring');
    overlay = $('overlay');
    panel = $('panel');
    timeEl = $('cs-time');
    clicksEl = $('cs-clicks');
    cpsEl = $('cs-cps');
    bestEl = $('cs-best');

    if (!pad || !panel) return;

    best = readBest();
    paintHud(DURATION);
    bindPanel();

    B8.on(pad, 'pointerdown', hit, { passive: false });
    B8.on(pad, 'contextmenu', function (ev) { ev.preventDefault(); });

    // 切到后台再回来时，setInterval 可能已经被浏览器节流；
    // 回来第一件事就是按 deadline 结算，避免停在 0.0 不结束。
    B8.on(document, 'visibilitychange', function () {
      if (!document.hidden && state === 'run') tick();
    });

    B8.on(document, 'keydown', function (ev) {
      if (ev.key === ' ' || ev.key === 'Enter') {
        if (state === 'run') {
          ev.preventDefault();
          if (!ev.repeat) hit(ev);
        }
      }
      if (ev.key === 'Escape' && (state === 'count' || state === 'run')) {
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
    finish: finish,
    menu: showMenu,
    scoreFor: scoreOf,
    state: function () {
      return {
        state: state, count: count, score: scoreOf(count),
        best: best, bestClicks: bestClicks(), writable: writable,
        remain: state === 'run' ? Math.max(0, endAt - now()) : 0
      };
    }
  };

  if (window.B8_TEST) {
    api.forceRun = function () {
      if (state === 'count') {
        if (countdownTimer) { clearTimeout(countdownTimer); countdownTimer = 0; }
        beginRun();
      }
      return state;
    };
    api.hit = function (n) {
      var times = Math.max(1, Number(n) || 1);
      for (var i = 0; i < times; i++) hit(null);
      return count;
    };
    api.feed = function (n) {
      state = 'run';
      count = clamp(Number(n) || 0, 0, 100000);
      startAt = now() - DURATION;
      endAt = now() - 1;
      finish();
      return { score: scoreOf(count), count: count };
    };
  }

  B8.games.clickspeed = api;
})();
