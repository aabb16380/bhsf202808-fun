/* ============================================================
   钢琴辉 · 四道音游（v3 · Phi+Mil 计分）
   ------------------------------------------------------------
   判定（固定窗口，所有难度一致）：
     ±70ms 以内  PERFECT
     ±70～140ms   GOOD
     超过 140ms   MISS
   计分（满分 1000000，只有全 PERFECT 才能拿满）：
     判定分 900000 按音符总数平分：PERFECT 100%，GOOD 65%
     连击分 100000 × 最大连击 / 音符总数
     空击每个 −5000（不中断连击，只是扣分）
   评级：EX+ 1000000 / EX 950000+ / S 850000+ / A 750000+ /
         B 650000+ / C 600000+ / F 其余

   难度不再靠改判定窗口（那会改成绩的含金量），而是靠谱面密度、
   滚动速度和和弦。简单档保留原谱，往上逐档加八分/十六分音符与和弦；
   极难档在慢歌上会打出一串 120ms 左右的连打。
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
  var PERFECT_MS = 70;         // Phi+Mil 判定窗口
  var GOOD_MS = 140;
  var BASE_JUDGE = 900000;
  var BASE_COMBO = 100000;
  var EMPTY_PENALTY = 5000;
  var MAX_SCORE = 1000000;

  var PITCH = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  var SOLFEGE = ['1', '#1', '2', 'b3', '3', '4', '#4', '5', 'b6', '6', 'b7', '7'];
  var HARMONY = [12, 7, 12, 7];

  var SONGS = [
    {
      id: 'twinkle',
      name: '小星星',
      bpm: 100,
      desc: '一拍一个音，最后一拍拖长。四档里最稳的入门曲。',
      lv: { easy: 2, normal: 5, hard: 8, extreme: 11 },
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
      desc: '中间有一段八分音符，四档会把它拆成更细的连打。',
      lv: { easy: 3, normal: 6, hard: 9, extreme: 12 },
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
      lv: { easy: 3, normal: 6, hard: 10, extreme: 13 },
      chart:
        'E4 E4 F4 G4 G4 F4 E4 D4 C4 C4 D4 E4 E4:1.5 D4:0.5 D4:2 ' +
        'E4 E4 F4 G4 G4 F4 E4 D4 C4 C4 D4 E4 D4:1.5 C4:0.5 C4:2'
    },
    {
      id: 'bells',
      name: '铃儿响叮当',
      bpm: 122,
      desc: '副歌。有休止符，空一拍再下手。',
      lv: { easy: 4, normal: 7, hard: 10, extreme: 14 },
      chart:
        'E4 E4 E4 -:1 E4 E4 E4 -:1 E4 G4 C4 D4 E4:4 ' +
        'F4 F4 F4 F4 F4 E4 E4 E4 E4 D4 D4 E4 D4:2 G4:2 ' +
        'E4 E4 E4 -:1 E4 E4 E4 -:1 E4 G4 C4 D4 E4:4 ' +
        'F4 F4 F4 F4 F4 E4 E4 E4 G4 G4 F4 D4 C4:4'
    },
    {
      id: 'birthday',
      name: '生日快乐',
      bpm: 108,
      desc: '三拍子的附点节奏，极难档会在长音里塞进十六分连打。',
      lv: { easy: 2, normal: 5, hard: 8, extreme: 11 },
      chart:
        'G4:0.75 G4:0.25 A4 G4 C5 B4:2 ' +
        'G4:0.75 G4:0.25 A4 G4 D5 C5:2 ' +
        'G4:0.75 G4:0.25 G5 E5 C5 B4 A4:2 ' +
        'F5:0.75 F5:0.25 E5 C5 D5 C5:2'
    },
    {
      id: 'jasmine',
      name: '茉莉花',
      bpm: 92,
      desc: '长音多，适合练「按住节奏等下一颗」，极难档会拆成密集的十六分。',
      lv: { easy: 3, normal: 6, hard: 9, extreme: 12 },
      chart:
        'E4 E4 G4 A4 C5 C5 A4 G4 G4 A4 G4 E4 D4 E4:2 ' +
        'E4 E4 G4 A4 C5 C5 A4 G4 G4 A4 G4 E4 D4 E4:2 ' +
        'G4 G4 A4 G4 E4 D4 E4 G4 A4 C5 A4 G4:2'
    },
    {
      id: 'farewell',
      name: '送别',
      bpm: 84,
      desc: '慢歌，但极难档的滚动很快——慢歌不代表手能慢。',
      lv: { easy: 3, normal: 6, hard: 10, extreme: 13 },
      chart:
        'G4 E4 G4 C5 B4 A4 G4:2 ' +
        'G4 C5 D5 E5 D5 C5 D5:2 ' +
        'G4 E4 G4 C5 B4 A4 G4:2 ' +
        'G4 D5 C5 B4 A4 G4:4'
    },
    {
      id: 'cancan',
      name: '康康舞曲',
      bpm: 152,
      desc: '本来就快。极难档主要靠 150ms 上下的音符和和弦压手。',
      lv: { easy: 4, normal: 8, hard: 11, extreme: 15 },
      chart:
        'G4:0.5 G4:0.5 G4:0.5 G4:0.5 G4:0.5 G4:0.5 G4:0.5 G4:0.5 ' +
        'A4:0.5 A4:0.5 A4:0.5 A4:0.5 G4:2 ' +
        'E4:0.5 E4:0.5 E4:0.5 E4:0.5 E4:0.5 E4:0.5 E4:0.5 E4:0.5 ' +
        'F4:0.5 F4:0.5 F4:0.5 F4:0.5 E4:2 ' +
        'D4:0.5 D4:0.5 D4:0.5 D4:0.5 D4:0.5 D4:0.5 D4:0.5 D4:0.5 ' +
        'E4:0.5 E4:0.5 E4:0.5 E4:0.5 D4:2'
    },
    {
      id: 'turkish',
      name: '土耳其进行曲',
      bpm: 132,
      desc: '半音与跳进多，道号变化最频繁。',
      lv: { easy: 5, normal: 8, hard: 12, extreme: 16 },
      chart:
        'B4 A4 G#4 A4 C5:2 B4 A4 G#4 A4 E5:2 ' +
        'D5 C5 B4 C5 D5:2 C5 B4 A4 B4 C5:2 ' +
        'B4 A4 G#4 A4 B4:2 A4 G#4 F#4 G#4 A4:2 ' +
        'E5 D5 C5 B4 A4:2 C5 B4 A4 G#4 A4:2'
    },
    {
      id: 'elise',
      name: '致爱丽丝',
      bpm: 116,
      desc: '著名的半音回旋，极难档会变成左右手一起按的和弦流。',
      lv: { easy: 4, normal: 7, hard: 11, extreme: 15 },
      chart:
        'E5 D#5 E5 D#5 E5 B4 D5 C5 A4:1.5 ' +
        'C4 E4 A4 B4:1.5 E4 G#4 B4 C5:1.5 ' +
        'E4 E5 D#5 E5 D#5 E5 B4 D5 C5 A4:1.5 ' +
        'C4 E4 A4 B4:1.5 E4 C5 B4 A4:2'
    }
  ];

  /* 四档难度：判定窗口不变，只有谱面密度和滚动速度变。
     sub  = 每拍最多拆成几个音符（受 minStep 限制）
     rate = 曲速倍率（极难档整体更快）
     travel = 音符从顶部落到判定线的时间（越小越快）
     chord = 每多少拍加一个和弦音（0 = 不加） */
  var DIFFS = [
    { id: 'easy', name: '简单', sub: 1, rate: 0.78, travel: 2200, tileMax: 116, chord: 0, chord2: 0, minStep: 0 },
    { id: 'normal', name: '普通', sub: 2, rate: 0.92, travel: 1580, tileMax: 100, chord: 4, chord2: 0, minStep: 155 },
    { id: 'hard', name: '困难', sub: 3, rate: 1.05, travel: 1120, tileMax: 80, chord: 2, chord2: 0, minStep: 132 },
    { id: 'extreme', name: '极难', sub: 4, rate: 1.18, travel: 790, tileMax: 62, chord: 0.5, chord2: 4, minStep: 112 }
  ];

  /* ============================================================
     谱面解析 / 生成
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

  /**
   * 把简谱串按难度展开成音符表。
   * 简单档 = 原谱；普通/困难/极难把每个音按拍长拆成更细的连打，
   * 第二颗以后叠八度 / 五度，既让音色有变化，也把道号拉开。
   */
  function chartOf(song, diff) {
    song._charts = song._charts || {};
    if (song._charts[diff.id]) return song._charts[diff.id];

    var raw = parseChart(song.chart);
    var beatMs = 60000 / (song.bpm * (diff.rate || 1));
    var minStepBeats = diff.minStep ? diff.minStep / beatMs : 0;
    var notes = [];
    var cursor = LEAD_BEATS;

    for (var i = 0; i < raw.length; i++) {
      var n = raw[i];
      if (n.midi === null) { cursor += n.beats; continue; }

      var steps = 1;
      if ((diff.sub || 1) > 1) {
        var cap = minStepBeats > 0
          ? Math.max(1, Math.floor(n.beats / minStepBeats + 1e-6))
          : 64;
        steps = Math.min(cap, Math.max(1, Math.round(n.beats * diff.sub)));
      }
      var stepBeats = n.beats / steps;

      for (var j = 0; j < steps; j++) {
        var midi = n.midi;
        if (j > 0) midi = n.midi + HARMONY[(j - 1) % HARMONY.length];
        notes.push({ midi: midi, t: (cursor + j * stepBeats) * beatMs, dur: stepBeats * beatMs });
      }

      // 和弦：只在基础音的拍点上加，和主音同时落下，逼玩家分指。
      // 极难档每颗基础音都带一个和弦音，四拍处再叠第二个。
      if (diff.chord && cursor >= LEAD_BEATS && Math.abs(cursor % diff.chord) < 1e-6) {
        var seq = Math.round(cursor / diff.chord);
        notes.push({
          midi: n.midi + (seq % 2 ? 7 : 12),
          t: cursor * beatMs,
          dur: beatMs * 0.6
        });
        if (diff.chord2 && Math.abs(cursor % diff.chord2) < 1e-6) {
          notes.push({
            midi: n.midi + (seq % 2 ? 12 : 7),
            t: cursor * beatMs,
            dur: beatMs * 0.5
          });
        }
      }

      cursor += n.beats;
    }

    // 道号按音高排：低音在左、高音在右
    var seen = {};
    var pitches = [];
    for (i = 0; i < notes.length; i++) {
      var mm = notes[i].midi;
      if (!seen[mm]) { seen[mm] = 1; pitches.push(mm); }
    }
    pitches.sort(function (a, b) { return a - b; });

    // 同一时刻、同一条道最多一个音符（和弦可能撞道）
    notes.sort(function (a, b) { return a.t - b.t || a.midi - b.midi; });
    var used = {};
    var shift = [0, 1, -1, 2, -2, 3, -3];
    for (i = 0; i < notes.length; i++) {
      var note = notes[i];
      var rank = pitches.indexOf(note.midi);
      var lane = pitches.length > 1
        ? Math.round(rank * (LANES - 1) / (pitches.length - 1))
        : 1;
      var tk = Math.round(note.t * 10);
      var row = used[tk] || (used[tk] = {});
      for (var s = 0; s < shift.length; s++) {
        var l = lane + shift[s];
        if (l >= 0 && l < LANES && !row[l]) { lane = l; break; }
      }
      row[lane] = 1;
      note.lane = lane;
      note.num = SOLFEGE[((note.midi % 12) + 12) % 12];
      note.state = 'idle';
      note.el = null;
    }

    var chart = {
      diff: diff,
      beatMs: beatMs,
      notes: notes,
      len: cursor * beatMs + 300,
      bass: bassOf(cursor, beatMs)
    };
    song._charts[diff.id] = chart;
    return chart;
  }

  /* ============================================================
     计分
     ============================================================ */

  function scoreOf(c, mc, n) {
    if (!n) return 0;
    var judge = BASE_JUDGE * (c.perfect + c.good * 0.65) / n;
    var combo = BASE_COMBO * mc / n;
    var v = Math.round(judge + combo - c.empty * EMPTY_PENALTY);
    if (v < 0) v = 0;
    if (v > MAX_SCORE) v = MAX_SCORE;
    return v;
  }

  function partsOf(c, mc, n) {
    if (!n) return { judge: 0, combo: 0, penalty: 0 };
    return {
      judge: Math.round(BASE_JUDGE * (c.perfect + c.good * 0.65) / n),
      combo: Math.round(BASE_COMBO * mc / n),
      penalty: c.empty * EMPTY_PENALTY
    };
  }

  function gradeOf(v) {
    if (v >= 1000000) return 'EX+';
    if (v >= 950000) return 'EX';
    if (v >= 850000) return 'S';
    if (v >= 750000) return 'A';
    if (v >= 650000) return 'B';
    if (v >= 600000) return 'C';
    return 'F';
  }

  /* ============================================================
     状态
     ============================================================ */

  var mode = 'menu';            // menu | count | play | pause | over
  var song = SONGS[0];
  var diff = DIFFS[1];
  var chart = null;
  var notes = [];
  var total = 0;

  var score = 0;
  var combo = 0;
  var maxCombo = 0;
  var counts = { perfect: 0, good: 0, miss: 0, empty: 0 };
  var fullCombo = false;

  var t0 = 0;                   // 曲子的时间原点（performance.now 标尺）
  var pausedAt = 0;
  var pausedTotal = 0;
  var raf = 0;
  var lastFrame = 0;
  var lastMissSfx = 0;
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
    var h = Math.round(38 + note.dur * 0.24);
    if (h < 40) h = 40;
    var max = (diff && diff.tileMax) || 116;
    if (h > max) h = max;
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
    setTimeout(function () {
      if (p.parentNode) p.parentNode.removeChild(p);
    }, 560);
  }

  function paint() {
    var judged = counts.perfect + counts.good + counts.miss;
    score = scoreOf(counts, maxCombo, total);
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
    if (livesEl) livesEl.textContent = 'MISS ' + counts.miss;
    if (progEl) progEl.style.width = (total ? (judged / total * 100) : 0) + '%';
  }

  /* ============================================================
     一局的生命周期
     ============================================================ */

  function startRound() {
    if (!lanesEl) return;
    gen++;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }

    chart = chartOf(song, diff);
    notes = chart.notes;
    total = notes.length;

    score = 0;
    combo = 0;
    maxCombo = 0;
    counts = { perfect: 0, good: 0, miss: 0, empty: 0 };
    fullCombo = false;
    submitted = 0;
    pausedAt = 0;
    pausedTotal = 0;
    bassIdx = 0;
    lastFrame = 0;
    lastMissSfx = 0;

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

  function finish() {
    if (mode === 'over') return;
    mode = 'over';
    if (raf) { cancelAnimationFrame(raf); raf = 0; }

    // 兜底：没判到的音符按 MISS 记，保证判定分的分母永远是总音符数
    for (var i = 0; i < notes.length; i++) {
      if (notes[i].state === 'idle') {
        notes[i].state = 'miss';
        counts.miss++;
      }
    }

    fullCombo = counts.miss === 0 && counts.perfect + counts.good === total;
    score = scoreOf(counts, maxCombo, total);

    var best = readNum(KEY_BEST);
    var isNew = score > best;
    if (isNew) store(KEY_BEST, String(score));

    paint();
    showResult(isNew, best);
    submitScore(score);
  }

  /** 主循环：时间 → 位置。所有判断都用时间，位置只影响观感 */
  function frame(ts) {
    if (mode !== 'count' && mode !== 'play') return;

    var now = ts || performance.now();
    if (!lastFrame) lastFrame = now;
    lastFrame = now;

    var el = now - t0 - pausedTotal;

    if (mode === 'count') {
      var left = -el;
      if (el >= 0) {
        mode = 'play';
        countdownEl.hidden = true;
      } else if (left > 0) {
        var n = Math.max(1, Math.min(3, Math.ceil(left / (COUNT_MS / 3))));
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
      // 漏接：过了 GOOD 窗口还没点
      var missed = false;
      for (i = 0; i < notes.length; i++) {
        var m = notes[i];
        if (m.state !== 'idle') continue;
        if (el > m.t + GOOD_MS) {
          m.state = 'miss';
          counts.miss++;
          combo = 0;
          popup(m.lane, 'MISS', 'miss');
          missed = true;
        }
      }
      if (missed) {
        paint();
        if (now - lastMissSfx > 70) { lastMissSfx = now; playMiss(); }
      }
      updateBass(el);
      if (counts.perfect + counts.good + counts.miss >= total && el > chart.len + 500) {
        finish();
        return;
      }
    }

    raf = requestAnimationFrame(frame);
  }

  function makeTile(note) {
    var el = document.createElement('div');
    el.className = 'tile';
    el.style.height = tileH(note) + 'px';

    var shade = document.createElement('span');
    shade.className = 'shade';
    el.appendChild(shade);

    var num = document.createElement('span');
    num.className = 'num';
    num.textContent = note.num;
    el.appendChild(num);

    laneEls[note.lane].appendChild(el);
    return el;
  }

  function updateBass(el) {
    if (!bassOn || muted || !chart || !chart.bass) return;
    while (bassIdx < chart.bass.length && el >= chart.bass[bassIdx].t - 30) {
      if (el - chart.bass[bassIdx].t < 200) {
        tone(chart.bass[bassIdx].midi, 1.6, 0.085, 'sine');
      }
      bassIdx++;
    }
  }

  /* ============================================================
     敲
     ============================================================ */

  function press(lane, at) {
    if (mode !== 'play') return;

    flashKey(lane, 100);

    // at 只给自检用：正常游戏一律用曲子时间，暂停时也不会错位
    var el = typeof at === 'number' ? at : (performance.now() - t0 - pausedTotal);
    var best = null;
    var bestD = 1e9;
    var i;

    for (i = 0; i < notes.length; i++) {
      var n = notes[i];
      if (n.state !== 'idle' || n.lane !== lane) continue;
      var d = Math.abs(el - n.t);
      if (d <= GOOD_MS && d < bestD) { best = n; bestD = d; }
    }

    if (!best) {
      counts.empty++;
      paint();
      popup(lane, '空 −5000', 'miss');
      return;
    }

    var perfect = bestD <= PERFECT_MS;
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
      (d.id === diff.id ? 'true' : 'false') + '">' + d.name +
      '<small>Lv ' + song.lv[d.id] + '</small></button>';
  }

  function levelTable() {
    var out = '<details class="lv-table"><summary>曲目表 · 四档难度（定数）</summary>' +
      '<table><thead><tr><th>曲目</th><th>简单</th><th>普通</th><th>困难</th><th>极难</th></tr></thead><tbody>';
    for (var i = 0; i < SONGS.length; i++) {
      var s = SONGS[i];
      out += '<tr' + (s.id === song.id ? ' class="is-on"' : '') + '><td>' + s.name + '</td>' +
        '<td>' + s.lv.easy + '</td><td>' + s.lv.normal + '</td>' +
        '<td>' + s.lv.hard + '</td><td>' + s.lv.extreme + '</td></tr>';
    }
    return out + '</tbody></table></details>';
  }

  function showMenu() {
    mode = 'menu';
    countdownEl.hidden = true;
    var songsHtml = '';
    var i;
    for (i = 0; i < SONGS.length; i++) songsHtml += chipSong(SONGS[i]);
    var diffsHtml = '';
    for (i = 0; i < DIFFS.length; i++) diffsHtml += chipDiff(DIFFS[i]);
    var noteCount = chartOf(song, diff).notes.length;

    panel.innerHTML =
      '<h1>钢琴辉</h1>' +
      '<p class="sub">辉辉踩着拍子往下掉，落在判定线的一瞬点中它。<br>' +
        '±70ms 内 PERFECT，±140ms 内 GOOD；满分 1000000 只有全 PERFECT 才拿得到。</p>' +
      '<div class="pick"><span class="pick-label">选一首 · BPM</span>' +
        '<div class="chips">' + songsHtml + '</div></div>' +
      '<div class="pick"><span class="pick-label">难度 · 定数</span>' +
        '<div class="chips">' + diffsHtml + '</div>' +
        '<p class="tip" style="margin:8px 0 0">' + song.desc + '<br>' +
          '<b>Lv ' + song.lv[diff.id] + '</b> · 音符 ' + noteCount +
          ' 个 · 滚动 ' + diff.travel + 'ms</p></div>' +
      '<p class="tip score-rule">' +
        '判定分 <b>900000</b> 按音符平分（PERFECT 100%、GOOD 65%）；' +
        '连击分 <b>100000</b> × 最大连击 / 音符数；空击每个 <b>−5000</b>。' +
        'EX+ 1000000 · EX 950000+ · S 850000+ · A 750000+ · B 650000+ · C 600000+ · F。</p>' +
      levelTable() +
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
      '<p class="sub">' + song.name + ' · ' + diff.name + ' Lv ' + song.lv[diff.id] + '<br>' +
        '现在 ' + score + ' 分，最高连击 ×' + maxCombo + '</p>' +
      '<button class="btn-main" type="button" data-act="resume">继续</button>' +
      '<button class="btn-2nd" type="button" data-act="again">重开这一局</button>' +
      '<button class="btn-2nd" type="button" data-act="menu">换一首</button>' +
      '<p class="tip"><a href="index.html">← 回游乐场</a></p>';
    overlay.hidden = false;
  }

  function showResult(isNew, oldBest) {
    var judged = counts.perfect + counts.good + counts.miss;
    var pct = judged ? Math.round((counts.perfect + counts.good * 0.65) / judged * 100) : 0;
    var g = gradeOf(score);
    var p = partsOf(counts, maxCombo, total);

    panel.innerHTML =
      '<h1>' + (g === 'EX+' ? '全部 PERFECT' : (fullCombo ? '全连！' : (isNew ? '新纪录' : '弹完了'))) + '</h1>' +
      '<p class="sub">' + song.name + ' · ' + diff.name + ' Lv ' + song.lv[diff.id] + ' · ' + total + ' 个音符</p>' +
      '<div class="result">' +
        '<div><span class="big">' + score + '</span><span class="big-unit">分</span></div>' +
        '<p class="rank-line">评级 <b>' + g + '</b> · 准确率 ' + pct + '% · 最高连击 ×' + maxCombo + ' / ' + total + '</p>' +
        '<dl>' +
          '<div><dt>PERFECT</dt><dd class="perfect">' + counts.perfect + '</dd></div>' +
          '<div><dt>GOOD</dt><dd class="good">' + counts.good + '</dd></div>' +
          '<div><dt>MISS</dt><dd class="miss">' + counts.miss + '</dd></div>' +
          '<div><dt>空敲</dt><dd>' + counts.empty + '</dd></div>' +
        '</dl>' +
        '<p class="score-parts">判定分 ' + p.judge + ' + 连击分 ' + p.combo +
          (p.penalty ? ' − 空击 ' + p.penalty : '') + ' = <b>' + score + '</b></p>' +
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
    // 满分就是 1000000，服务端也正好卡在这个上限
    if (!v || v <= submitted || v > MAX_SCORE) return;
    submitted = v;
    B8.sb.rpc('b8_score_add', {
      p_token: B8.auth.token(),
      p_game: 'piano',
      p_score: Math.floor(v)
    }).then(function () {
      setNote('成绩已记到排行榜：' + v + ' 分（' + song.name + ' · ' + diff.name + ' Lv ' + song.lv[diff.id] + '）。');
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

  /* 给调试/自检用：无头浏览器里可以直接开局、按时间敲、读状态。
     ?t= 调试入口才放出谱面，正常访问拿不到，免得一键自动满分。 */
  B8.games = B8.games || {};
  var api = {
    start: function () { startRound(); },
    press: function (lane, at) { press(lane, at); },
    pause: pauseRound,
    resume: resumeRound,
    menu: showMenu,
    // 没有 rAF 的环境（部分无头浏览器）用这个手动推帧
    tick: function (ts) {
      if (mode === 'count' || mode === 'play') frame(ts || performance.now());
    },
    // 自检：把当前局直接切到 play，并按指定判定走完整首
    forcePlay: function () {
      if (mode === 'count') { countdownEl.hidden = true; }
      if (mode === 'count' || mode === 'play') mode = 'play';
    },
    simulate: function (kind) {
      if (mode !== 'play') return null;
      for (var i = 0; i < notes.length; i++) {
        var n = notes[i];
        if (kind === 'miss') {
          if (n.state === 'idle') { n.state = 'miss'; counts.miss++; combo = 0; }
        } else if (kind === 'good') {
          press(n.lane, n.t + 100);
        } else {
          press(n.lane, n.t);
        }
      }
      paint();
      return { score: score, counts: counts, maxCombo: maxCombo };
    },
    finish: function () { finish(); },
    scoreFor: function (p, g, m, mc, e, n) {
      return scoreOf({ perfect: p, good: g, miss: m, empty: e }, mc, n || total || 1);
    },
    gradeFor: gradeOf,
    state: function () {
      return {
        mode: mode, score: score, combo: combo, maxCombo: maxCombo,
        song: song.id, diff: diff.id, level: song.lv[diff.id],
        judged: counts.perfect + counts.good + counts.miss,
        total: total, counts: counts, grade: gradeOf(score),
        parts: partsOf(counts, maxCombo, total)
      };
    }
  };

  if (window.B8_TEST) {
    api.chart = function () {
      var out = [];
      for (var i = 0; i < notes.length; i++) {
        out.push({ lane: notes[i].lane, t: notes[i].t, state: notes[i].state });
      }
      return { t0: t0, paused: pausedTotal, notes: out, len: chart ? chart.len : 0 };
    };
    api.mute = function () { muted = true; };
    api.songs = function () {
      return SONGS.map(function (s) {
        return { id: s.id, name: s.name, bpm: s.bpm, lv: s.lv };
      });
    };
    api.chartCounts = function () {
      var out = {};
      for (var i = 0; i < SONGS.length; i++) {
        var row = {};
        for (var j = 0; j < DIFFS.length; j++) {
          row[DIFFS[j].id] = chartOf(SONGS[i], DIFFS[j]).notes.length;
        }
        out[SONGS[i].id] = row;
      }
      return out;
    };
  }

  B8.games.piano = api;
})();
