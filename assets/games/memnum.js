/* ============================================================
   记忆数字（Number Memory）· 八班游乐场
   ------------------------------------------------------------
   数字闪一下 → 凭记忆输入 → 每级 5 轮。
   和「动态视力测试」同一套等级梯度，但计分改成可比较的标准分：

     单轮得分 = 按位正确的比例（0～1）
     最终得分 = 5 轮平均 × 等级系数 × 400000

   等级系数随信息密度递增（1.00 → 2.50），所以：
     · 低等级全对拿不到满分（Lv1 是 400000）
     · 只有最高等级五轮全对才刚好 1000000
     · 高等级更快更难，但同样的准确率会得到更高分——排行榜跨等级比较时
       不会因为「只敢玩低等级」而占便宜。

   排行榜 p_game = 'memnum'，分数本身就是 0～1000000 的标准分。
   ============================================================ */
(function () {
  'use strict';

  var B8 = window.B8;
  if (!B8) return;

  /* 等级表：位数 / 闪现毫秒 / 系数
     系数 = 该等级满分 ÷ 400000；最高 2.50，所以 Lv11 全对才是 1000000。 */
  var LEVELS = [
    { len: 2, time: 700, coef: 1.00 },
    { len: 3, time: 650, coef: 1.05 },
    { len: 3, time: 600, coef: 1.10 },
    { len: 4, time: 550, coef: 1.18 },
    { len: 5, time: 500, coef: 1.28 },
    { len: 5, time: 450, coef: 1.40 },
    { len: 6, time: 400, coef: 1.55 },
    { len: 7, time: 300, coef: 1.75 },
    { len: 7, time: 200, coef: 1.95 },
    { len: 8, time: 100, coef: 2.20 },
    { len: 10, time: 50, coef: 2.50 }
  ];

  var ROUNDS = 5;
  var BASE = 400000;           // 400000 × 2.50 = 1000000
  var MAX_SCORE = 1000000;
  var KEY_BEST = 'b8.memnum.best';

  var screenEl, digitsEl, hintEl, progressEl, inputEl, submitEl, skipEl, feedbackEl;
  var overlay, panel;
  var levelEl, roundEl, scoreEl, bestEl;

  var level = 0;               // 0-based
  var round = 0;               // 1..5
  var results = [];            // { target, input, hits, acc }
  var target = '';
  var phase = 'menu';          // menu | count | show | input | feedback | over
  var timers = [];
  var gen = 0;
  var writable = false;
  var submitted = 0;
  var best = 0;

  function $(id) { return document.getElementById(id); }

  function whenReady(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  function readNum(key) {
    try { return Number(localStorage.getItem(key) || 0) || 0; } catch (e) { return 0; }
  }

  function store(key, val) {
    try { localStorage.setItem(key, String(val)); } catch (e) {}
  }

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function later(fn, ms) {
    var id = setTimeout(fn, ms);
    timers.push(id);
    return id;
  }

  function clearTimers() {
    for (var i = 0; i < timers.length; i++) clearTimeout(timers[i]);
    timers = [];
  }

  function randomNumber(len) {
    var out = String(Math.floor(Math.random() * 9) + 1);
    for (var i = 1; i < len; i++) out += String(Math.floor(Math.random() * 10));
    return out;
  }

  /* ============================================================
     计分
     ============================================================ */

  function scoreOf(levelIdx, accs) {
    var sum = 0;
    for (var i = 0; i < ROUNDS; i++) sum += (accs[i] || 0);
    var avg = sum / ROUNDS;
    var coef = LEVELS[levelIdx].coef;
    return clamp(Math.round(avg * coef * BASE), 0, MAX_SCORE);
  }

  function avgOf(list) {
    var sum = 0;
    for (var i = 0; i < list.length; i++) sum += list[i].acc;
    return sum / ROUNDS;       // 分母固定 5：中途显示时也不会虚高
  }

  function levelText() {
    return 'Lv' + (level + 1);
  }

  /* ============================================================
     HUD
     ============================================================ */

  function paintHud() {
    if (levelEl) levelEl.textContent = 'Lv' + (level + 1);
    if (roundEl) roundEl.textContent = round ? (round + '/' + ROUNDS) : '—';
    if (scoreEl) {
      var live = Math.round(avgOf(results) * LEVELS[level].coef * BASE);
      scoreEl.textContent = String(clamp(live, 0, MAX_SCORE));
    }
    if (bestEl) bestEl.textContent = String(best);
  }

  function setProgress(text) {
    if (progressEl) progressEl.textContent = text;
  }

  function setHint(text) {
    if (hintEl) hintEl.textContent = text;
  }

  function setFeedback(html) {
    if (feedbackEl) feedbackEl.innerHTML = html || '';
  }

  function setControls(on) {
    if (inputEl) inputEl.disabled = !on;
    if (submitEl) submitEl.disabled = !on;
    if (skipEl) skipEl.disabled = !on;
  }

  /* ============================================================
     一局流程
     ============================================================ */

  function startLevel(idx) {
    level = clamp(idx, 0, LEVELS.length - 1);
    results = [];
    round = 0;
    target = '';
    submitted = 0;
    gen++;
    clearTimers();
    overlay.hidden = true;
    if (inputEl) inputEl.value = '';
    paintHud();
    nextRound();
  }

  function nextRound() {
    if (round >= ROUNDS) { finish(); return; }
    round++;
    target = '';
    phase = 'count';
    gen++;
    clearTimers();

    if (inputEl) { inputEl.value = ''; inputEl.disabled = true; }
    setControls(false);
    setFeedback('');
    if (screenEl) screenEl.classList.remove('is-show');
    if (digitsEl) {
      digitsEl.className = 'is-count';
      digitsEl.textContent = '3';
    }
    setProgress(levelText() + ' · 第 ' + round + ' / ' + ROUNDS + ' 轮');
    setHint('准备…');
    paintHud();

    countdown(3, gen);
  }

  function countdown(n, g) {
    if (g !== gen) return;
    if (n <= 0) { showTarget(g); return; }
    if (digitsEl) {
      digitsEl.className = 'is-count';
      digitsEl.textContent = String(n);
    }
    later(function () { countdown(n - 1, g); }, 620);
  }

  function showTarget(g) {
    if (g !== gen) return;
    var cfg = LEVELS[level];
    target = randomNumber(cfg.len);
    phase = 'show';

    if (digitsEl) {
      digitsEl.className = '';
      digitsEl.textContent = target;
    }
    if (screenEl) screenEl.classList.add('is-show');
    setHint('看清这 ' + cfg.len + ' 位——只出现 ' + cfg.time + ' 毫秒。');

    later(function () {
      if (g !== gen) return;
      if (screenEl) screenEl.classList.remove('is-show');
      if (digitsEl) digitsEl.textContent = '';
      phase = 'input';
      setControls(true);
      if (inputEl) {
        inputEl.value = '';
        inputEl.maxLength = cfg.len;
        inputEl.focus();
      }
      setHint('输入你看到的数字，按回车或点「提交」。');
    }, cfg.time);
  }

  function onInput() {
    if (!inputEl) return;
    var digits = inputEl.value.replace(/\D/g, '');
    var max = LEVELS[level].len;
    if (digits.length > max) digits = digits.slice(0, max);
    if (inputEl.value !== digits) inputEl.value = digits;
  }

  function submitAnswer() {
    if (phase !== 'input') return;
    var val = (inputEl.value || '').replace(/\D/g, '');
    if (!val) {
      setFeedback('<span class="msg">先输入数字，再提交。</span>');
      inputEl.focus();
      return;
    }

    var len = target.length;
    var hits = 0;
    var html = '';
    for (var i = 0; i < len; i++) {
      var u = val.charAt(i);
      if (!u) {
        html += '<span class="miss">_</span>';
      } else if (u === target.charAt(i)) {
        hits++;
        html += '<span class="ok">' + u + '</span>';
      } else {
        html += '<span class="bad">' + u + '<span class="correct">(' + target.charAt(i) + ')</span></span>';
      }
    }

    results.push({ target: target, input: val, hits: hits, acc: hits / len });
    phase = 'feedback';
    setControls(false);
    setFeedback(html + '<br><span class="msg">' + hits + ' / ' + len + ' 位正确</span>');
    setHint('记住这一轮，下一轮马上来。');
    paintHud();

    later(nextRound, 1350);
  }

  function skipRound() {
    if (phase !== 'show' && phase !== 'input') return;
    // 清掉本轮还没跑的计时器（尤其是「闪现结束 → 开放输入」那个），
    // 否则跳过之后它还会把输入框打开，让同一轮被提交两次。
    clearTimers();
    results.push({ target: target, input: '跳过', hits: 0, acc: 0 });
    phase = 'feedback';
    setControls(false);
    if (screenEl) screenEl.classList.remove('is-show');
    if (digitsEl) digitsEl.textContent = '';
    setFeedback('<span class="msg">已跳过本轮，记 0 分。</span>');
    setHint('下一轮马上来。');
    paintHud();
    later(nextRound, 950);
  }

  function finish() {
    phase = 'over';
    clearTimers();
    setControls(false);
    setProgress('五轮结束');
    setHint('成绩已结算。');

    var accs = [];
    for (var i = 0; i < results.length; i++) accs.push(results[i].acc);
    var score = scoreOf(level, accs);
    var isNew = score > best;
    if (isNew) {
      best = score;
      store(KEY_BEST, best);
    }
    paintHud();
    showResult(score, isNew);
    submitScore(score);
  }

  /* ============================================================
     面板
     ============================================================ */

  function menuTable() {
    var out = '<table class="lv-table"><thead><tr>' +
      '<th>等级</th><th>位数</th><th>闪现</th><th>系数</th><th>满分</th></tr></thead><tbody>';
    for (var i = 0; i < LEVELS.length; i++) {
      var L = LEVELS[i];
      out += '<tr' + (i === level ? ' class="is-on"' : '') + '>' +
        '<td>Lv' + (i + 1) + '</td><td>' + L.len + '</td><td>' + L.time + 'ms</td>' +
        '<td>×' + L.coef.toFixed(2) + '</td><td>' + Math.round(L.coef * BASE) + '</td></tr>';
    }
    return out + '</tbody></table>';
  }

  function showMenu() {
    phase = 'menu';
    clearTimers();
    setControls(false);
    setFeedback('');
    setProgress('选一个等级，开始五轮');
    setHint('数字闪一下，凭记忆输入；每级五轮。');
    if (screenEl) screenEl.classList.remove('is-show');
    if (digitsEl) {
      digitsEl.className = '';
      digitsEl.textContent = '准备';
    }

    var chips = '';
    for (var i = 0; i < LEVELS.length; i++) {
      chips += '<button class="chip" type="button" data-level="' + i + '" aria-pressed="' +
        (i === level ? 'true' : 'false') + '">Lv' + (i + 1) +
        '<small>' + LEVELS[i].len + '位</small></button>';
    }
    var L = LEVELS[level];

    panel.innerHTML =
      '<h1>记忆数字</h1>' +
      '<p class="sub">数字闪一下，凭记忆把它敲回来。<br>每级五轮，按准确率和等级系数折算标准分。</p>' +
      '<div class="pick"><span class="pick-label">等级 · 位数 / 闪现</span>' +
        '<div class="chips">' + chips + '</div></div>' +
      '<p class="tip" style="margin:8px 0 0">当前 <b>Lv' + (level + 1) + '</b>：' +
        L.len + ' 位 · ' + L.time + 'ms · 系数 <b>×' + L.coef.toFixed(2) + '</b> · ' +
        '满分 <b>' + Math.round(L.coef * BASE) + '</b>。</p>' +
      '<ul class="rules" style="margin-top:12px">' +
        '<li>每轮先 3、2、1 倒计时，然后数字闪现；闪完输入。</li>' +
        '<li>按<b>位</b>计分：位置和数字都对才算一位，错一位只扣那一位。</li>' +
        '<li>五轮平均 × <b>等级系数 × 400000</b> = 最终分；最高 Lv11 全对才是 1000000。</li>' +
        '<li>系数就是公平性：高等级更难，但同样准确率会得到更高分。</li>' +
      '</ul>' +
      '<div class="pick" style="margin-top:4px"><span class="pick-label">评分标准 · 全部等级</span>' +
        menuTable() + '</div>' +
      '<button class="btn-main" type="button" data-act="go">开始 Lv' + (level + 1) + '</button>' +
      '<p class="tip">' +
        (B8.auth && B8.auth.isLogged()
          ? '成绩会记到排行榜（标准分，跨等级可比；本机最高 ' + best + '）。'
          : '没登录，成绩只存在这台设备 · <a href="index.html">回游乐场登录</a>') +
      '</p>' +
      '<p class="tip"><a href="index.html">← 回游乐场</a></p>';

    overlay.hidden = false;
    paintHud();
  }

  function showResult(score, isNew) {
    var acc = avgOf(results);
    var pct = Math.round(acc * 1000) / 10;
    var coef = LEVELS[level].coef;
    var max = Math.round(coef * BASE);
    var rows = '';
    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      rows += '<tr><td>' + (i + 1) + '</td><td>' + r.target + '</td><td>' + r.input +
        '</td><td>' + r.hits + '/' + r.target.length + '</td></tr>';
    }

    panel.innerHTML =
      '<h1>' + (isNew ? '新纪录' : '五轮结束') + '</h1>' +
      '<p class="sub">Lv' + (level + 1) + ' · ' + LEVELS[level].len + ' 位 · ' +
        LEVELS[level].time + 'ms · 系数 ×' + coef.toFixed(2) + '</p>' +
      '<div class="result">' +
        '<div><span class="big">' + score + '</span><span class="big-unit">分</span></div>' +
        '<p class="rank-line">平均准确率 <b>' + pct + '%</b> · 本级满分 ' + max + '</p>' +
        '<dl>' +
          '<div><dt>平均准确率</dt><dd>' + pct + '%</dd></div>' +
          '<div><dt>等级系数</dt><dd>×' + coef.toFixed(2) + '</dd></div>' +
          '<div><dt>本机最高</dt><dd>' + best + '</dd></div>' +
        '</dl>' +
        '<table class="lv-table" style="margin:12px 0 0"><thead><tr>' +
          '<th>轮</th><th>答案</th><th>你的输入</th><th>正确位</th></tr></thead><tbody>' +
          rows + '</tbody></table>' +
      '</div>' +
      '<p class="note-line" id="mn-note">' +
        (isNew ? '本机新纪录。' : '本机最高 ' + best + ' 分。') +
      '</p>' +
      '<button class="btn-main" type="button" data-act="again">再来一次 Lv' + (level + 1) + '</button>' +
      '<button class="btn-2nd" type="button" data-act="menu">换等级</button>' +
      '<p class="tip"><a href="index.html">← 回游乐场</a></p>';

    overlay.hidden = false;
  }

  function setNote(msg, isErr) {
    var n = $('mn-note');
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
      p_game: 'memnum',
      p_score: Math.floor(v)
    }).then(function () {
      setNote('成绩已记到排行榜：' + v + ' 分（Lv' + (level + 1) + ' · 系数 ×' + LEVELS[level].coef.toFixed(2) + '）。');
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
      while (t && t.nodeType === 1) {
        if (t.getAttribute && t.getAttribute('data-level') !== null) {
          level = clamp(Number(t.getAttribute('data-level')) || 0, 0, LEVELS.length - 1);
          showMenu();
          return;
        }
        if (t.getAttribute && t.getAttribute('data-act')) break;
        t = t.parentNode;
      }

      var act = t && t.getAttribute ? t.getAttribute('data-act') : null;
      if (!act && ev.target.closest) {
        var b = ev.target.closest('[data-act]');
        act = b ? b.getAttribute('data-act') : null;
      }
      if (!act) return;
      if (act === 'go' || act === 'again') startLevel(level);
      else if (act === 'menu') showMenu();
    });
  }

  function init() {
    screenEl = $('mn-screen');
    digitsEl = $('mn-digits');
    hintEl = $('mn-hint');
    progressEl = $('mn-progress');
    inputEl = $('mn-input');
    submitEl = $('mn-submit');
    skipEl = $('mn-skip');
    feedbackEl = $('mn-feedback');
    overlay = $('overlay');
    panel = $('panel');
    levelEl = $('mn-level');
    roundEl = $('mn-round');
    scoreEl = $('mn-score');
    bestEl = $('mn-best');

    if (!panel || !inputEl) return;

    best = readNum(KEY_BEST);
    paintHud();
    bindPanel();

    B8.on(submitEl, 'click', submitAnswer);
    B8.on(skipEl, 'click', skipRound);
    B8.on(inputEl, 'input', onInput);
    B8.on(inputEl, 'keydown', function (ev) {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        submitAnswer();
      }
    });
    B8.on($('btn-exit'), 'click', function () { location.href = 'index.html'; });

    B8.on(document, 'keydown', function (ev) {
      if (ev.key === 'Escape' && phase !== 'menu' && phase !== 'over') {
        showMenu();
      }
    });

    var apply = function () {
      writable = !!(B8.sb && B8.sb.ready) && B8.auth.isLogged() && B8.auth.kind() !== 'preview';
      if (phase === 'menu') showMenu();
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
    start: function (lv) { startLevel((Number(lv) || 1) - 1); },
    menu: showMenu,
    skip: skipRound,
    scoreFor: function (lv, accs) { return scoreOf((Number(lv) || 1) - 1, accs || []); },
    levels: function () {
      return LEVELS.map(function (L, i) {
        return { level: i + 1, len: L.len, time: L.time, coef: L.coef, max: Math.round(L.coef * BASE) };
      });
    },
    state: function () {
      return {
        phase: phase, level: level + 1, round: round,
        target: window.B8_TEST ? target : null,
        results: results.length, best: best, writable: writable
      };
    }
  };

  if (window.B8_TEST) {
    api.answer = function (v) {
      if (phase !== 'input') return false;
      if (inputEl) inputEl.value = String(v == null ? '' : v);
      submitAnswer();
      return true;
    };
    api.result = function () {
      var accs = [];
      for (var i = 0; i < results.length; i++) accs.push(results[i].acc);
      return { accs: accs, score: scoreOf(level, accs) };
    };
  }

  B8.games.memnum = api;
})();
