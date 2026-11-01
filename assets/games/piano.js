/* ============================================================
   钢琴辉 · 四道音游（v2）
   ------------------------------------------------------------
   1. 谱面写成简谱串（"C4 C4 G4:2"，冒号后面是拍数），解析后按音高
      排名自动分到四条道——低音在左、高音在右，每首歌不用手写道号。
   2. 判定以「音符时间」为准，不看像素位置：掉帧只会让画面卡一下，
      不会让你莫名 miss。
   3. 漏掉一个音符扣一颗 ♥，三颗没了就结束；空敲只断连击、扣一点分，
      不扣血——这是下课十分钟的游戏，不是考试。
   4. 右上角 ♪ 可以静音（教室里用）。伴奏是每小节自动补的根音，
      不参与判定，只负责让节奏听得见。
   ============================================================ */
(function () {
  'use strict';

  var B8 = window.B8;
  if (!B8) return;

  /* ============================================================
     常量与谱面
     ============================================================ */

  var LANES = 4;
  var LANE_KEYS = ['D', 'F', 'J', 'K'];
  var KEY_BEST = 'b8.piano.best';
  var KEY_PREFS = 'b8.piano.prefs';
  var LEAD_BEATS = 4;          // 曲首留 4 拍空拍，第一个音符才有下落时间
  var COUNT_MS = 1400;         // 3 / 2 / 1
  var MIN_TILE = 54;
  var MAX_TILE = 116;

  var PITCH = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  var SOLFEGE = ['1', '#1', '2', 'b3', '3', '4', '#4', '5', 'b6', '6', 'b7', '7'];

  var SONGS = [
    {
      id: 'twinkle',
      name: '小星星',
      bpm: 100,
      desc: '一拍一个音，最后一拍拖长。最稳的入门曲。',
      chart:
        'C4 C4 G4 G4 A4 A4 G4:2 ' +
        'F4 F4 E4 E4 D4 D4 C4:2 ' +
        'G4 G4 F4 F4 E4 E4 D4:2 ' +
        'G4 G4 F4 F4 E4 E4 D4:2 ' +
        'C4 C4 G4 G4 A4 A4 G4:2 ' +
        'F4 F4 E4 E4 D4 D4 C4:2'
    },
    {
      id: 'tiger',
      name: '两只老虎',
      bpm: 112,
      desc: '中间有一段八分音符，手要稍微快一点。',
      chart:
        'C4 D4 E4 C4 C4 D4 E4 C4 E4 F4 G4:2 E4 F4 G4:2 ' +
        'G4:0.5 A4:0.5 G4:0.5 F4:0.5 E4 C4 G4:0.5 A4:0.5 G4:0.5 F4:0.5 E4 C4 ' +
        'D4 G4 C4:2 D4 G4 C4:2'
    },
    {
      id: 'joy',
      name: '欢乐颂',
      bpm: 96,
      desc: '音符密度最大的一首，考验换道。',
      chart:
        'E4 E4 F4 G4 G4 F4 E4 D4 C4 C4 D4 E4 E4:1.5 D4:0.5 D4:2 ' +
        'E4 E4 F4 G4 G4 F4 E4 D4 C4 C4 D4 E4 D4:1.5 C4:0.5 C4:2'
    },
    {
      id: 'bells',
      name: '铃儿响叮当',
      bpm: 122,
      desc: '副歌。有休止符，空一拍再下手。',
      chart:
        'E4 E4 E4 -:1 E4 E4 E4 -:1 E4 G4 C4 D4 E4:4 ' +
        'F4 F4 F4 F4 F4 E4 E4 E4 E4 D4 D4 E4 D4:2 G4:2 ' +
        'E4 E4 E4 -:1 E4 E4 E4 -:1 E4 G4 C4 D4 E4:4 ' +
        'F4 F4 F4 F4 F4 E4 E4 E4 G4 G4 F4 D4 C4:4'
    }
  ];

  var DIFFS = [
    { id: 'easy', name: '简单', perfect: 112, good: 195, travel: 2200, mult: 1 },
    { id: 'normal', name: '普通', perfect: 82, good: 152, travel: 1720, mult: 1.15 },
    { id: 'hard', name: '困难', perfect: 56, good: 114, travel: 1360, mult: 1.35 }
  ];

  /* ============================================================
     谱面解析
     ============================================================ */

  function midiOf(name) {
    var m = /^([A-G])(#?)(-?\d)$/.exec(name);
    if (!m) return null;
    return (Number(m[3]) + 1) * 12 + PITCH[m[1]] + (m[2] ? 1 : 0);
  }

  function parseChart(src) {
    var toks = String(src).split(/\s+/);
    var out = [];
    for (var i = 0; i < toks.length; i++) {
      var t = toks[i];
      if (!t) continue;
      var parts = t.split(':');
      var beats = parts.length > 1 ? Number(parts[1]) : 1;
      if (!beats || beats <= 0) beats = 1;
      out.push({ midi: parts[0] === '-' ? null : midiOf(parts[0]), beats: beats });
    }
    return out;
  }

  /** 把简谱串变成带时间的音符表，顺手算好四条道 */
  function chartOf(song) {
    if (song._notes) return song._notes;

    var raw = parseChart(song.chart);
    var beatMs = 60000 / song.bpm;
    var pitches = [];
    var i;
    for (i = 0; i < raw.length; i++) {
      var mm = raw[i].midi;
      if (mm !== null && pitches.indexOf(mm) < 0) pitches.push(mm);
    }
    pitches.sort(function (a, b) { return a - b; });

    var notes = [];
    var cursor = LEAD_BEATS;
    for (i = 0; i < raw.length; i++) {
      var n = raw[i];
      if (n.midi === null) { cursor += n.beats; continue; }

      var rank = pitches.indexOf(n.midi);
      var lane = pitches.length > 1
        ? Math.round(rank * (LANES - 1) / (pitches.length - 1))
        : 1;

      notes.push({
        midi: n.midi,
        lane: lane,
        num: SOLFEGE[((n.midi % 12) + 12) % 12],
        t: cursor * beatMs,
        dur: n.beats * beatMs,
        state: 'idle',
        el: null
      });
      cursor += n.beats;
    }

    song._notes = notes;
    song._len = cursor * beatMs;          // 含收尾空拍
    song._bass = bassOf(cursor, beatMs, song.bpm);
    return notes;
  }

  /** 伴奏：每小节第 1 拍 C2、第 3 拍 G2，软软的铺一层 */
  function bassOf(totalBeats, beatMs) {
    var out = [];
    var bar = 0;
    while (bar * 4 < totalBeats) {
      out.push({ t: bar * 4 * beatMs, midi: bar % 2 === 0 ? 36 : 43 });
      out.push({ t: (bar * 4 + 2) * beatMs, midi: bar % 2 === 0 ? 43 : 36 });
      bar++;
    }
    return out;
  }

  /* ============================================================
     状态
     ============================================================ */

  var mode = 'menu';            // menu | count | play | pause | over
  var song = SONGS[0];
  var diff = DIFFS[1];
  var notes = [];
  var total = 0;

  var score = 0;
  var combo = 0;
  var maxCombo = 0;
  var lives = 3;
  var counts = { perfect: 0, good: 0, miss: 0, empty: 0 };
  var fullCombo = false;

  var t0 = 0;                   // 曲子的时间原点（performance.now 标尺）
  var pausedAt = 0;
  var pausedTotal = 0;
  var raf = 0;
  var lastFrame = 0;
  var bassIdx = 0;
  var gen = 0;                  // 每一局 +1，旧局的 setTimeout 不许碰新局
  var writable = false;
  var submitted = 0;
  var bassOn = true;
  var muted = false;

  var stage, lanesEl, keysEl, judgeEl, countdownEl, cdNum, overlay, panel;
  var scoreEl, comboEl, accEl, bestEl, livesEl, progEl;
  var laneEls = [];

  /* ---------- DOM 小工具 ---------- */

  function $(id) { return document.getElementById(id); }

  function whenReady(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  function closest(node, sel) {
    while (node && node.nodeType === 1) {
      if (node.matches && node.matches(sel)) return node;
      node = node.parentNode;
    }
    return null;
  }

  function store(key, val) {
    try { localStorage.setItem(key, val); } catch (e) {}
  }

  function readNum(key) {
    try { return Number(localStorage.getItem(key) || 0) || 0; } catch (e) { return 0; }
  }

  function readJson(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; }
  }

  /* ============================================================
     声音
     ============================================================ */

  var ac = null;
  var master = null;

  function audioCtx() {
    if (ac) return ac;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try {
      ac = new AC();
      master = ac.createGain();
      master.gain.value = 0.9;
      master.connect(ac.destination);
    } catch (e) {
      ac = null;
    }
    return ac;
  }

  function resumeAudio() {
    var c = audioCtx();
    if (c && c.state === 'suspended') c.resume();
  }

  /** 一个带包络的琴音：三角波为主，叠一层八度的正弦让它亮一点 */
  function tone(midi, dur, gain, type, delay) {
    var c = audioCtx();
    if (!c || muted) return;
    var t = c.currentTime + (delay || 0.005);
    var f = 440 * Math.pow(2, (midi - 69) / 12);

    var osc = c.createOscillator();
    var osc2 = c.createOscillator();
    var g = c.createGain();
    var g2 = c.createGain();

    osc.type = type || 'triangle';
    osc.frequency.value = f;
    osc2.type = 'sine';
    osc2.frequency.value = f * 2;
    g2.gain.value = 0.16;

    osc.connect(g);
    osc2.connect(g2);
    g2.connect(g);
    g.connect(master);

    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain || 0.24, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(0.1, dur));

    osc.start(t);
    osc2.start(t);
    osc.stop(t + dur + 0.03);
    osc2.stop(t + dur + 0.03);
  }

  function playMiss() {
    var c = audioCtx();
    if (!c || muted) return;
    var t = c.currentTime;
    var osc = c.createOscillator();
    var g = c.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(150, t);
    osc.frequency.exponentialRampToValueAtTime(62, t + 0.2);
    g.gain.setValueAtTime(0.14, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
    osc.connect(g);
    g.connect(master);
    osc.start(t);
    osc.stop(t + 0.26);
  }

  /* ============================================================
     画面
     ============================================================ */

  function laneH() {
    return lanesEl ? lanesEl.clientHeight : 0;
  }

  function tileH(note) {
    var h = Math.round(46 + note.dur * 0.42);
    if (h < MIN_TILE) h = MIN_TILE;
    if (h > MAX_TILE) h = MAX_TILE;
    return h;
  }

  function buildStage() {
    lanesEl.innerHTML = '';
    laneEls = [];
    for (var i = 0; i < LANES; i++) {
      var lane = document.createElement('div');
      lane.className = 'lane';
      lane.setAttribute('data-lane', String(i));
      lanesEl.appendChild(lane);
      laneEls.push(lane);
    }

    keysEl.innerHTML = '';
    for (var k = 0; k < LANES; k++) {
      var key = document.createElement('button');
      key.type = 'button';
      key.className = 'key';
      key.setAttribute('data-lane', String(k));
      key.setAttribute('aria-label', '琴键 ' + LANE_KEYS[k]);
      key.innerHTML = '<span class="ring"></span><span class="k-bar"></span>' +
        '<span class="k-letter">' + LANE_KEYS[k] + '</span>';
      keysEl.appendChild(key);
    }
  }

  function clearStage() {
    for (var i = 0; i < laneEls.length; i++) laneEls[i].innerHTML = '';
    judgeEl.innerHTML = '';
    var keys = keysEl.querySelectorAll('.key');
    for (var k = 0; k < keys.length; k++) keys[k].classList.remove('is-down');
  }

  function flashKey(lane, ms) {
    var key = keysEl.querySelector('.key[data-lane="' + lane + '"]');
    if (!key) return;
    key.classList.add('is-down');
    var g = gen;
    setTimeout(function () {
      if (g === gen) key.classList.remove('is-down');
    }, ms || 110);
  }

  function popup(lane, text, cls) {
    if (!judgeEl) return;
    var p = document.createElement('span');
    p.className = 'judge-pop ' + (cls || '');
    p.textContent = text;
    p.style.left = ((lane + 0.5) / LANES * 100) + '%';
    judgeEl.appendChild(p);
    var g = gen;
    setTimeout(function () {
      if (p.parentNode) p.parentNode.removeChild(p);
      if (g !== gen) return;
    }, 560);
  }

  function paint() {
    var judged = counts.perfect + counts.good + counts.miss;
    if (scoreEl) scoreEl.textContent = String(score);
    if (comboEl) {
      comboEl.textContent = combo > 1 ? ('×' + combo) : '—';
      comboEl.classList.toggle('is-hot', combo >= 10);
    }
    if (accEl) {
      accEl.textContent = judged
        ? (Math.round((counts.perfect + counts.good * 0.65) / judged * 100) + '%')
        : '—';
    }
    if (bestEl) bestEl.textContent = String(readNum(KEY_BEST));
    if (livesEl) livesEl.textContent = lives > 0 ? new Array(lives + 1).join('♥') : '—';
    if (progEl) progEl.style.width = (total ? (judged / total * 100) : 0) + '%';
  }

  /* ============================================================
     一局的生命周期
     ============================================================ */

  function startRound() {
    if (!lanesEl) return;
    gen++;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }

    chartOf(song);
    notes = song._notes;
    total = notes.length;

    score = 0;
    combo = 0;
    maxCombo = 0;
    lives = 3;
    counts = { perfect: 0, good: 0, miss: 0, empty: 0 };
    fullCombo = false;
    submitted = 0;
    pausedAt = 0;
    pausedTotal = 0;
    bassIdx = 0;
    lastFrame = 0;

    for (var i = 0; i < notes.length; i++) {
      notes[i].state = 'idle';
      notes[i].el = null;
    }

    clearStage();
    paint();

    overlay.hidden = true;
    resumeAudio();

    t0 = performance.now() + COUNT_MS;
    mode = 'count';
    cdNum.textContent = '3';
    cdNum.style.animation = 'none';
    countdownEl.hidden = false;
    void cdNum.offsetWidth;                 // 强制重排，让动画每次都能重放
    cdNum.style.animation = '';

    raf = requestAnimationFrame(frame);
  }

  function pauseRound() {
    if (mode !== 'play') return;
    mode = 'pause';
    pausedAt = performance.now();
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    showPause();
  }

  function resumeRound() {
    if (mode !== 'pause') return;
    pausedTotal += performance.now() - pausedAt;
    pausedAt = 0;
    mode = 'play';
    overlay.hidden = true;
    lastFrame = 0;
    raf = requestAnimationFrame(frame);
  }

  function finish(reason) {
    if (mode === 'over') return;
    mode = 'over';
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    fullCombo = counts.miss === 0 && counts.perfect + counts.good === total;

    var judged = counts.perfect + counts.good + counts.miss;
    var acc = judged ? (counts.perfect + counts.good * 0.65) / judged : 0;
    var best = readNum(KEY_BEST);
    var isNew = score > best;
    if (isNew) store(KEY_BEST, String(score));

    paint();
    showResult(reason, acc, isNew, best);
    submitScore(score);
  }

  /** 主循环：时间 → 位置。所有判断都用时间，位置只影响观感 */
  function frame(ts) {
    if (mode !== 'count' && mode !== 'play') return;

    var now = ts || performance.now();
    if (!lastFrame) lastFrame = now;
    lastFrame = now;

    var el = now - t0;

    if (mode === 'count') {
      var left = COUNT_MS - (now - (t0 - COUNT_MS));
      if (el >= 0) {
        mode = 'play';
        countdownEl.hidden = true;
      } else if (left > 0) {
        var n = Math.max(1, Math.ceil(left / (COUNT_MS / 3)));
        if (cdNum.textContent !== String(n)) {
          cdNum.textContent = String(n);
          cdNum.style.animation = 'none';
          void cdNum.offsetWidth;
          cdNum.style.animation = '';
        }
      }
    }

    var H = laneH();
    var i;

    for (i = 0; i < notes.length; i++) {
      var n = notes[i];
      // 已经点中的交给 CSS 动画；漏掉的还要继续往下掉，不能冻在半空
      if (n.state === 'gone' || n.state === 'hit') continue;

      var y = -tileH(n) + (el - (n.t - diff.travel)) / diff.travel * H;
      if (!n.el && y + tileH(n) > -40 && y < H + 40) {
        n.el = makeTile(n);
      }
      if (n.el) {
        n.el.style.transform = 'translateY(' + y + 'px)';
        if (y > H + 8) {
          if (n.el.parentNode) n.el.parentNode.removeChild(n.el);
          n.el = null;
          n.state = 'gone';
        }
      }
    }

    if (mode === 'play') {
      // 漏接：过了 good 窗口还没点
      for (i = 0; i < notes.length; i++) {
        var m = notes[i];
        if (m.state !== 'idle') continue;
        if (el > m.t + diff.good) {
          m.state = 'miss';
          counts.miss++;
          lives--;
          combo = 0;
          playMiss();
          popup(m.lane, 'MISS', 'miss');
          paint();
          if (lives <= 0) { finish('fail'); return; }
        }
      }
      updateBass(el);
      if (counts.perfect + counts.good + counts.miss >= total && el > song._len + 600) {
        finish('clear');
        return;
      }
    }

    raf = requestAnimationFrame(frame);
  }

  function makeTile(note) {
    var el = document.createElement('div');
    el.className = 'tile';
    el.style.height = tileH(note) + 'px';

    var num = document.createElement('span');
    num.className = 'num';
    num.textContent = note.num;
    el.appendChild(num);

    var glow = document.createElement('span');
    glow.className = 'glow';
    el.appendChild(glow);

    var face = document.createElement('span');
    face.className = 'face';
    el.appendChild(face);

    laneEls[note.lane].appendChild(el);
    return el;
  }

  function updateBass(el) {
    if (!bassOn || muted || !song._bass) return;
    while (bassIdx < song._bass.length && el >= song._bass[bassIdx].t - 30) {
      if (el - song._bass[bassIdx].t < 200) {
        tone(song._bass[bassIdx].midi, 1.6, 0.085, 'sine');
      }
      bassIdx++;
    }
  }

  /* ============================================================
     敲
     ============================================================ */

  function press(lane) {
    if (mode !== 'play') return;

    flashKey(lane, 100);

    var el = performance.now() - t0 - pausedTotal;
    var best = null;
    var bestD = 1e9;
    var i;

    for (i = 0; i < notes.length; i++) {
      var n = notes[i];
      if (n.state !== 'idle' || n.lane !== lane) continue;
      var d = Math.abs(el - n.t);
      if (d <= diff.good + 4 && d < bestD) { best = n; bestD = d; }
    }

    if (!best) {
      combo = 0;
      counts.empty++;
      score = Math.max(0, score - 10);
      paint();
      popup(lane, '空', 'miss');
      return;
    }

    var perfect = bestD <= diff.perfect;
    best.state = 'hit';
    if (best.el) {
      best.el.classList.add('is-hit');
      best.el.style.setProperty('--y', best.el.style.transform.replace(/^translateY\((.*)\)$/, '$1') || '0px');
      (function (node, g) {
        setTimeout(function () {
          if (g !== gen) return;
          if (node.parentNode) node.parentNode.removeChild(node);
        }, 220);
      })(best.el, gen);
      best.el = null;
    }

    combo++;
    if (combo > maxCombo) maxCombo = combo;
    if (perfect) counts.perfect++; else counts.good++;

    var base = perfect ? 100 : 60;
    var bonus = Math.min(combo, 30) * 2;
    score += Math.round((base + bonus) * diff.mult);

    tone(best.midi, perfect ? 0.62 : 0.5, perfect ? 0.26 : 0.19);
    popup(lane, perfect ? 'PERFECT' : 'GOOD', perfect ? 'perfect' : 'good');

    if (combo > 0 && combo % 10 === 0) {
      popup(lane, '连击 ×' + combo, 'perfect');
    }

    paint();
  }

  /* ============================================================
     面板
     ============================================================ */

  function chipSong(s) {
    return '<button class="chip" type="button" data-song="' + s.id + '" aria-pressed="' +
      (s.id === song.id ? 'true' : 'false') + '">' + s.name +
      '<small>' + s.bpm + '</small></button>';
  }

  function chipDiff(d) {
    return '<button class="chip" type="button" data-diff="' + d.id + '" aria-pressed="' +
      (d.id === diff.id ? 'true' : 'false') + '">' + d.name + '</button>';
  }

  function showMenu() {
    mode = 'menu';
    countdownEl.hidden = true;
    var songsHtml = '';
    var i;
    for (i = 0; i < SONGS.length; i++) songsHtml += chipSong(SONGS[i]);
    var diffsHtml = '';
    for (i = 0; i < DIFFS.length; i++) diffsHtml += chipDiff(DIFFS[i]);

    panel.innerHTML =
      '<h1>钢琴辉</h1>' +
      '<p class="sub">辉辉踩着拍子往下掉，落在判定线的一瞬点中它。<br>' +
        '点得越准分越高，漏一个扣一颗 ♥。</p>' +
      '<div class="pick"><span class="pick-label">选一首 · BPM</span>' +
        '<div class="chips">' + songsHtml + '</div></div>' +
      '<div class="pick"><span class="pick-label">难度</span>' +
        '<div class="chips">' + diffsHtml + '</div>' +
        '<p class="tip" style="margin:8px 0 0">' + song.desc + '</p></div>' +
      '<button class="btn-main" type="button" data-act="go">开始</button>' +
      '<button class="btn-2nd" type="button" data-act="bass">伴奏：' +
        (bassOn ? '开' : '关') + '（不影响判定）</button>' +
      '<p class="tip">键盘 <b>D F J K</b> · 手机直接点四道琴键 · 空格开始<br>' +
        (B8.auth && B8.auth.isLogged()
          ? '成绩会记到排行榜（本机最高 ' + readNum(KEY_BEST) + '）'
          : '没登录，成绩只存在这台设备 · <a href="index.html">回游乐场登录</a>') +
        '</p>' +
      '<p class="tip"><a href="index.html">← 回游乐场</a></p>';

    overlay.hidden = false;
  }

  function showPause() {
    panel.innerHTML =
      '<h1>歇一下</h1>' +
      '<p class="sub">' + song.name + ' · ' + diff.name + '<br>' +
        '现在 ' + score + ' 分，最高连击 ×' + maxCombo + '</p>' +
      '<button class="btn-main" type="button" data-act="resume">继续</button>' +
      '<button class="btn-2nd" type="button" data-act="again">重开这一局</button>' +
      '<button class="btn-2nd" type="button" data-act="menu">换一首</button>' +
      '<p class="tip"><a href="index.html">← 回游乐场</a></p>';
    overlay.hidden = false;
  }

  function gradeOf(acc) {
    if (acc >= 0.96) return 'S';
    if (acc >= 0.90) return 'A';
    if (acc >= 0.78) return 'B';
    if (acc >= 0.60) return 'C';
    return 'D';
  }

  function showResult(reason, acc, isNew, oldBest) {
    var judged = counts.perfect + counts.good + counts.miss;
    var pct = judged ? Math.round(acc * 100) : 0;
    var g = reason === 'fail' ? '—' : gradeOf(acc);

    panel.innerHTML =
      '<h1>' + (reason === 'fail' ? '漏太多了' : (fullCombo ? '全连！' : (isNew ? '新纪录' : '弹完了'))) + '</h1>' +
      '<p class="sub">' + song.name + ' · ' + diff.name + '</p>' +
      '<div class="result">' +
        '<div><span class="big">' + score + '</span><span class="big-unit">分</span></div>' +
        '<p class="rank-line">评级 <b>' + g + '</b> · 准确率 ' + pct + '% · 最高连击 ×' + maxCombo + '</p>' +
        '<dl>' +
          '<div><dt>PERFECT</dt><dd class="perfect">' + counts.perfect + '</dd></div>' +
          '<div><dt>GOOD</dt><dd class="good">' + counts.good + '</dd></div>' +
          '<div><dt>MISS</dt><dd class="miss">' + counts.miss + '</dd></div>' +
          '<div><dt>空敲</dt><dd>' + counts.empty + '</dd></div>' +
        '</dl>' +
      '</div>' +
      '<p class="note-line" id="piano-note">' +
        (isNew ? '本机新纪录，上一版是 ' + oldBest + ' 分。'
               : '本机最高 ' + readNum(KEY_BEST) + ' 分。') +
      '</p>' +
      '<button class="btn-main" type="button" data-act="again">再来一次</button>' +
      '<button class="btn-2nd" type="button" data-act="menu">换一首 / 换难度</button>' +
      '<p class="tip"><a href="index.html">← 回游乐场</a></p>';

    overlay.hidden = false;
  }

  function setNote(msg, isErr) {
    var n = $('piano-note');
    if (!n) return;
    n.textContent = msg;
    n.classList[isErr ? 'add' : 'remove']('is-err');
  }

  /* ============================================================
     排行榜
     ============================================================ */

  function submitScore(v) {
    if (!writable || !B8.auth || !B8.sb) return;
    if (!v || v <= submitted || v > 990000) return;
    submitted = v;
    B8.sb.rpc('b8_score_add', {
      p_token: B8.auth.token(),
      p_game: 'piano',
      p_score: Math.floor(v)
    }).then(function () {
      setNote('成绩已记到排行榜：' + v + ' 分（' + song.name + ' · ' + diff.name + '）。');
    }).catch(function (err) {
      submitted = 0;
      setNote('成绩没传上去：' + (err && err.message ? err.message : '网络异常'), true);
    });
  }

  /* ============================================================
     输入
     ============================================================ */

  function laneAt(clientX) {
    var r = stage.getBoundingClientRect();
    if (!r.width) return -1;
    var lane = Math.floor(((clientX - r.left) / r.width) * LANES);
    if (lane < 0) lane = 0;
    if (lane >= LANES) lane = LANES - 1;
    return lane;
  }

  function onStageDown(ev) {
    if (mode !== 'play') return;
    ev.preventDefault();
    var lane = laneAt(ev.clientX);
    if (lane >= 0) press(lane);
  }

  function onKey(ev) {
    var k = String(ev.key || '').toUpperCase();
    // 焦点在面板按钮上时，把空格/回车让给按钮自己
    var onPanelBtn = ev.target && ev.target.closest && ev.target.closest('#panel button');

    if (mode === 'menu' || mode === 'over') {
      if ((k === ' ' || k === 'ENTER') && !onPanelBtn) {
        ev.preventDefault();
        startRound();
      }
      return;
    }
    if (mode === 'pause') {
      if (k === ' ' || k === 'ENTER' || k === 'ESCAPE') {
        ev.preventDefault();
        resumeRound();
      }
      return;
    }
    if (mode === 'count') return;

    var idx = LANE_KEYS.indexOf(k);
    if (idx >= 0) {
      ev.preventDefault();
      if (!ev.repeat) press(idx);
      return;
    }
    if (k === 'ESCAPE') {
      ev.preventDefault();
      pauseRound();
    }
  }

  /* ============================================================
     启动
     ============================================================ */

  function bindPanel() {
    panel.addEventListener('click', function (ev) {
      var chip = closest(ev.target, '[data-song]');
      if (chip) {
        var id = chip.getAttribute('data-song');
        for (var i = 0; i < SONGS.length; i++) {
          if (SONGS[i].id === id) song = SONGS[i];
        }
        savePrefs();
        showMenu();
        return;
      }

      chip = closest(ev.target, '[data-diff]');
      if (chip) {
        var did = chip.getAttribute('data-diff');
        for (var j = 0; j < DIFFS.length; j++) {
          if (DIFFS[j].id === did) diff = DIFFS[j];
        }
        savePrefs();
        showMenu();
        return;
      }

      var act = closest(ev.target, '[data-act]');
      if (!act) return;
      var a = act.getAttribute('data-act');

      if (a === 'go' || a === 'again') { startRound(); return; }
      if (a === 'resume') { resumeRound(); return; }
      if (a === 'menu') { showMenu(); return; }
      if (a === 'bass') { bassOn = !bassOn; savePrefs(); showMenu(); return; }
    });
  }

  function paintSound() {
    var btn = $('btn-sound');
    if (!btn) return;
    btn.setAttribute('aria-pressed', muted ? 'false' : 'true');
    btn.textContent = '♪';
    btn.setAttribute('aria-label', muted ? '声音关' : '声音开');
  }

  function savePrefs() {
    try {
      localStorage.setItem(KEY_PREFS, JSON.stringify({
        song: song.id, diff: diff.id, bass: bassOn, muted: muted
      }));
    } catch (e) {}
  }

  function loadPrefs() {
    var p = readJson(KEY_PREFS);
    if (!p) return;
    var i;
    for (i = 0; i < SONGS.length; i++) if (SONGS[i].id === p.song) song = SONGS[i];
    for (i = 0; i < DIFFS.length; i++) if (DIFFS[i].id === p.diff) diff = DIFFS[i];
    if (typeof p.bass === 'boolean') bassOn = p.bass;
    if (typeof p.muted === 'boolean') muted = p.muted;
  }

  function init() {
    stage = $('stage');
    lanesEl = $('lanes');
    keysEl = $('keys');
    judgeEl = $('judge');
    countdownEl = $('countdown');
    cdNum = $('cd-num');
    overlay = $('overlay');
    panel = $('panel');
    scoreEl = $('hud-score');
    comboEl = $('hud-combo');
    accEl = $('hud-acc');
    bestEl = $('hud-best');
    livesEl = $('hud-lives');
    progEl = $('prog-fill');

    if (!lanesEl || !panel) return;

    loadPrefs();
    buildStage();
    paint();
    paintSound();
    bindPanel();
    showMenu();

    B8.on(stage, 'pointerdown', onStageDown, { passive: false });
    B8.on(document, 'keydown', onKey);

    B8.on($('btn-pause'), 'click', function () {
      if (mode === 'play') pauseRound();
      else if (mode === 'pause') resumeRound();
    });

    B8.on($('btn-exit'), 'click', function () { location.href = 'index.html'; });

    B8.on($('btn-sound'), 'click', function () {
      muted = !muted;
      paintSound();
      savePrefs();
      resumeAudio();
    });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden && mode === 'play') pauseRound();
    });

    document.addEventListener('b8:auth', function () {
      writable = !!(B8.sb && B8.sb.ready) && B8.auth.isLogged() && B8.auth.kind() !== 'preview';
      if (mode === 'menu') showMenu();
    });

    if (B8.auth) {
      B8.auth.ready(function (st) {
        writable = !!(B8.sb && B8.sb.ready) && st.kind !== 'preview' && B8.auth.isLogged();
        if (mode === 'menu') showMenu();
      });
    }
  }

  whenReady(init);

  /* 给调试/自检用：无头浏览器里可以直接开局、敲键、读状态。
     ?t= 调试入口才放出谱面，正常访问拿不到，免得一键自动满分。 */
  B8.games = B8.games || {};
  var api = {
    start: function () { startRound(); },
    press: function (lane) { press(lane); },
    pause: pauseRound,
    resume: resumeRound,
    menu: showMenu,
    // 没有 rAF 的环境（部分无头浏览器）用这个手动推帧
    tick: function (ts) {
      if (mode === 'count' || mode === 'play') frame(ts || performance.now());
    },
    state: function () {
      return {
        mode: mode, score: score, combo: combo, lives: lives,
        song: song.id, diff: diff.id,
        judged: counts.perfect + counts.good + counts.miss,
        total: total, counts: counts
      };
    }
  };

  if (window.B8_TEST) {
    api.chart = function () {
      var out = [];
      for (var i = 0; i < notes.length; i++) {
        out.push({ lane: notes[i].lane, t: notes[i].t, state: notes[i].state });
      }
      return { t0: t0, paused: pausedTotal, notes: out };
    };
  }

  B8.games.piano = api;
})();
