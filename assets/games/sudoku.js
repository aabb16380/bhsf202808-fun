/* ============================================================
   数独 · 八班游乐场
   ------------------------------------------------------------
   · 四档难度：简单 / 普通 / 困难 / 极难，各自有难度系数
   · 输入只靠屏幕上的 1–9 按键，不要求键盘
   · 辅助：笔记、自动候选、提示推演、撤销、错误提示
   · 计分：基础 1000，按用时扣（最多 400）、提示每个 −60、
     错误每个 −30，最低 600；再乘难度系数（1.00–1.75）
   · 排行：game = sudoku:<难度>，每人每档一行；b8_sudoku_top
     取每个人所有档里最高的一行，所以挑战高难度永远更划算

   题池是离线生成好的（_shared/gen-sudoku.py），运行时只做
   数字置换 + 行/列/宫互换，不跑求解器，手机上也秒开。
   ============================================================ */
(function () {
  'use strict';

  var B8 = window.B8;
  if (!B8) return;

  var DIFFS = [
    { id: 'easy',   name: '简单', coef: 1.00, target: 300, clues: 40, desc: '40 个已知数 · 先热身' },
    { id: 'normal', name: '普通', coef: 1.20, target: 480, clues: 34, desc: '34 个已知数起 · 日常难度' },
    { id: 'hard',   name: '困难', coef: 1.45, target: 720, clues: 28, desc: '28 个已知数起 · 要推几步' },
    { id: 'expert', name: '极难', coef: 1.75, target: 900, clues: 24, desc: '24 个已知数起 · 慢慢来' }
  ];
  var DIFF_BY_ID = {};
  DIFFS.forEach(function (d) { DIFF_BY_ID[d.id] = d; });

  var POOL = {
    easy: [
      { p: '.2...3468..4.1239..9........7963...11532.78464...8573........2..1637.5..5478...1.', s: '721953468684712395395468172879634251153297846462185739938541627216379584547826913' },
      { p: '6..752.1.32..6.79..57.93....982...63.4.....7.76...152....92.14..76.1..38.1.387..2', s: '689752314321468795457193286198275463542639871763841529835926147276514938914387652' },
      { p: '.2843.1...3..8.6.24.5....935..89.2.6.9.5.3.8.7.3.24..987....9.12.9.6..5...6.4972.', s: '928436175137985642465271893541897236692513487783624519874352961219768354356149728' },
      { p: '28.41...33..9......4156...741.3.596.83.....72.592.6.311...5238......1..55...34.16', s: '285417693367928154941563827412375968836149572759286431174652389623891745598734216' }
    ],
    normal: [
      { p: '..56..192.9..4.5....19.5..325...96....8...9....37...541..5.73....9.8..6.586..47..', s: '845673192392841576671925843257439618418256937963718254124567389739182465586394721' },
      { p: '69.3.........746.54..1.6.7.3......9157.8.1.2686......7.4.7.2..32.569.........8.52', s: '697325418182974635453186279324567891579841326861239547948752163215693784736418952' },
      { p: '69....1...279..3..81...6.57...79463.....1.....42563...93.4...81..4..829...8....46', s: '695387124427951368813246957581794632369812475742563819936425781154678293278139546' },
      { p: '8.....15..9..8.7.63.2..6.89.1...56.8...6.2...6.38...1.73.9..2.52.6.3..9..49.....7', s: '864793152591284736372156489917345628485612973623879514738961245256437891149528367' }
    ],
    hard: [
      { p: '5.2..1.8..49...3.2.8..5...12..31.................42..86...9..1.4.8...53..5.1..2.7', s: '572431986149867352386259741294318675861975423735642198627593814418726539953184267' },
      { p: '.....2..52...95.7.51........53.6...1..85.46..6...7.54........32.2.48...63..6.....', s: '984712365236895174517346298453269781178534629692178543861957432725483916349621857' },
      { p: '....6......6.47.8.8.75.......5...1.972.1.6.353.9...8.......13.2.5.32.7......5....', s: '192863547536947281847512963465238179728196435319475826974681352651324798283759614' },
      { p: '....2739..3.....5..62..51...4.6....3.5..7..8.8....1.4...45..92..9.....6..8624....', s: '518427396437196852962835174749682513651374289823951647374568921295713468186249735' }
    ],
    expert: [
      { p: '..6.53..1.5...2..3..7.........83...7.3.....9.8...41.........2..4..6...8.7..38.4..', s: '946753821158492763327168954261839547534276198879541632683914275415627389792385416' },
      { p: '59........8..1.5.71...5...3...2.8....7..4..2....7.5...8...6...52.4.7..9........48', s: '597386412483912567162457983941238756375641829628795134839164275254873691716529348' },
      { p: '......6.7.6..15..3...8...4..9.5...1...4.9.8...7...8.2..1...3...8..17..3.7.9......', s: '183942657462715983957836241398527416624391875571468329215683794846179532739254168' },
      { p: '5...3..4..6..9....38.1....5......6....38459....2......4....6.57....5..1..1..8...3', s: '529738146167594382384162795851923674673845921942671538498316257236457819715289463' }
    ]
  };

  var KEY_DIFF = 'b8.sudoku.diff';
  var KEY_BEST = 'b8.sudoku.best.';

  var boardEl, padEl, statusEl, timerEl, diffEl, missEl, hintEl;
  var overlayEl, panelEl, newBtn;
  var cells = [];
  var units = [];
  var grid = [];
  var solution = [];
  var given = [];
  var notes = [];
  var wrong = [];
  var hintMark = [];
  var conflicts = [];
  var history = [];
  var selected = -1;
  var diff = 'easy';
  var notesMode = false;
  var showCand = false;
  var mistakes = 0;
  var hints = 0;
  var filled = 0;
  var started = false;
  var finished = false;
  var startAt = 0;
  var elapsedMs = 0;
  var ticker = 0;
  var submitted = false;
  var scoreInfo = null;
  var writable = false;

  function $(id) { return document.getElementById(id); }

  function whenReady(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  function readLS(key) {
    try { return localStorage.getItem(key) || ''; } catch (e) { return ''; }
  }

  function writeLS(key, val) {
    try { localStorage.setItem(key, String(val)); } catch (e) {}
  }

  function bestKey(id) { return KEY_BEST + id; }

  function readBest(id) {
    return Number(readLS(bestKey(id)) || 0) || 0;
  }

  function saveBest(id, v) {
    if (v > readBest(id)) writeLS(bestKey(id), v);
  }

  function diffOf(id) { return DIFF_BY_ID[id] || DIFFS[0]; }

  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function fmt(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    var m = Math.floor(s / 60);
    var r = s % 60;
    return (m < 10 ? '0' + m : m) + ':' + (r < 10 ? '0' + r : r);
  }

  /* ---------- 把题池里的一道题随机换成同构题 ---------- */
  function buildPuzzle(id) {
    var d = diffOf(id);
    var pool = POOL[d.id] || POOL.easy;
    var base = pool[Math.floor(Math.random() * pool.length)];

    // 数字置换：1–9 随便换，仍是同一道题
    var digits = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    shuffle(digits);
    var map = {};
    for (var i = 0; i < 9; i++) map[String(i + 1)] = String(digits[i]);

    // 行、列、宫互换：保持数独规则
    var rowOrder = [];
    var colOrder = [];
    var bands = [0, 1, 2];
    shuffle(bands);
    bands.forEach(function (b) {
      var rs = [0, 1, 2];
      shuffle(rs);
      rs.forEach(function (r) { rowOrder.push(b * 3 + r); });
    });
    var stacks = [0, 1, 2];
    shuffle(stacks);
    stacks.forEach(function (st) {
      var cs = [0, 1, 2];
      shuffle(cs);
      cs.forEach(function (c) { colOrder.push(st * 3 + c); });
    });
    var transpose = Math.random() < 0.5;

    function transform(str) {
      var a = str.split('');
      var out = new Array(81);
      var r, c, nr, nc, ch;
      for (r = 0; r < 9; r++) {
        for (c = 0; c < 9; c++) {
          nr = rowOrder[r];
          nc = colOrder[c];
          ch = a[nr * 9 + nc];
          out[r * 9 + c] = (ch === '.') ? '.' : map[ch];
        }
      }
      if (transpose) {
        var t = new Array(81);
        for (r = 0; r < 9; r++) {
          for (c = 0; c < 9; c++) t[c * 9 + r] = out[r * 9 + c];
        }
        out = t;
      }
      return out;
    }

    return { puzzle: transform(base.p), solution: transform(base.s) };
  }

  /* ---------- 棋盘 / 候选 ---------- */
  function buildUnits() {
    units = [];
    var r, c, br, bc, i;
    for (r = 0; r < 9; r++) {
      var row = [];
      for (c = 0; c < 9; c++) row.push(r * 9 + c);
      units.push(row);
    }
    for (c = 0; c < 9; c++) {
      var col = [];
      for (r = 0; r < 9; r++) col.push(r * 9 + c);
      units.push(col);
    }
    for (br = 0; br < 3; br++) {
      for (bc = 0; bc < 3; bc++) {
        var box = [];
        for (r = 0; r < 3; r++) {
          for (c = 0; c < 3; c++) box.push((br * 3 + r) * 9 + bc * 3 + c);
        }
        units.push(box);
      }
    }
    // 每个格子的 20 个邻居，用位图存，算候选时不用每次扫三遍
    // （这里直接现算，81 格 × 9 个数字，量很小）
  }

  function isPeer(a, b) {
    var ra = Math.floor(a / 9), ca = a % 9;
    var rb = Math.floor(b / 9), cb = b % 9;
    return ra === rb || ca === cb ||
      (Math.floor(ra / 3) === Math.floor(rb / 3) && Math.floor(ca / 3) === Math.floor(cb / 3));
  }

  function candidateList(i) {
    if (grid[i] !== '.') return [];
    var used = {};
    var r = Math.floor(i / 9), c = i % 9;
    var br = Math.floor(r / 3) * 3, bc = Math.floor(c / 3) * 3;
    var x, y;
    for (x = 0; x < 9; x++) {
      if (grid[r * 9 + x] !== '.') used[grid[r * 9 + x]] = true;
      if (grid[x * 9 + c] !== '.') used[grid[x * 9 + c]] = true;
    }
    for (x = 0; x < 3; x++) {
      for (y = 0; y < 3; y++) {
        var v = grid[(br + x) * 9 + bc + y];
        if (v !== '.') used[v] = true;
      }
    }
    var out = [];
    for (x = 1; x <= 9; x++) if (!used[String(x)]) out.push(x);
    return out;
  }

  function computeConflicts() {
    conflicts = [];
    var i;
    for (i = 0; i < 81; i++) conflicts[i] = false;
    units.forEach(function (unit) {
      var seen = {};
      unit.forEach(function (idx) {
        var v = grid[idx];
        if (v === '.') return;
        if (seen[v] === undefined) seen[v] = idx;
        else {
          conflicts[idx] = true;
          conflicts[seen[v]] = true;
        }
      });
    });
  }

  function notesHtml(set) {
    var out = '<span class="sd-notes">';
    for (var n = 1; n <= 9; n++) {
      out += '<span>' + (set[n] ? n : '') + '</span>';
    }
    return out + '</span>';
  }

  function cellText(i) {
    if (grid[i] !== '.') return '<span class="sd-val">' + grid[i] + '</span>';
    if (showCand) {
      var cs = candidateList(i);
      var set = {};
      cs.forEach(function (n) { set[n] = true; });
      if (cs.length) return notesHtml(set);
    }
    if (notes[i] && Object.keys(notes[i]).length) return notesHtml(notes[i]);
    return '';
  }

  function paintCell(i) {
    var cell = cells[i];
    if (!cell) return;
    var cls = 'sd-cell';
    var col = i % 9, row = Math.floor(i / 9);
    if (col === 2 || col === 5) cls += ' br';
    if (row === 2 || row === 5) cls += ' bb';
    if (given[i]) cls += ' is-given';
    else if (grid[i] !== '.') cls += ' is-user';
    if (selected === i) cls += ' is-sel';
    else if (selected >= 0 && isPeer(i, selected)) cls += ' is-peer';
    if (selected >= 0 && i !== selected && grid[selected] !== '.' && grid[i] === grid[selected]) {
      cls += ' is-same';
    }
    if (conflicts[i]) cls += ' is-conflict';
    if (wrong[i]) cls += ' is-wrong';
    if (hintMark[i]) cls += ' is-hint';
    cell.className = cls;

    var html = cellText(i);
    if (html) cell.innerHTML = html;
    else cell.textContent = '';

    var pos = '第 ' + (row + 1) + ' 行第 ' + (col + 1) + ' 列';
    if (grid[i] !== '.') {
      cell.setAttribute('aria-label', pos + '：' + grid[i] + (given[i] ? '（题目）' : ''));
    } else {
      var cs = candidateList(i);
      cell.setAttribute('aria-label', pos + '：空' + (cs.length ? '，候选 ' + cs.join(' ') : ''));
    }
  }

  function paintAll() {
    computeConflicts();
    for (var i = 0; i < 81; i++) paintCell(i);
    updateHud();
  }

  function updateHud() {
    if (diffEl) diffEl.textContent = diffOf(diff).name;
    if (timerEl) timerEl.textContent = fmt(finished ? elapsedMs : elapsed());
    if (missEl) missEl.textContent = String(mistakes);
    if (hintEl) hintEl.textContent = String(hints);
    var bar = $('sd-diffs');
    if (bar) {
      B8.qsa('.sd-diff-chip', bar).forEach(function (b) {
        b.setAttribute('aria-pressed', b.getAttribute('data-diff') === diff ? 'true' : 'false');
      });
    }
    var noteBtn = $('sd-notes-btn');
    if (noteBtn) {
      noteBtn.textContent = '笔记：' + (notesMode ? '开' : '关');
      noteBtn.setAttribute('aria-pressed', notesMode ? 'true' : 'false');
      noteBtn.classList.toggle('on', notesMode);
    }
    var candBtn = $('sd-cand-btn');
    if (candBtn) {
      candBtn.textContent = '候选：' + (showCand ? '开' : '关');
      candBtn.setAttribute('aria-pressed', showCand ? 'true' : 'false');
      candBtn.classList.toggle('on', showCand);
    }
  }

  function setStatus(msg, bad) {
    if (!statusEl) return;
    statusEl.textContent = msg || '';
    statusEl.classList[bad ? 'add' : 'remove']('is-bad');
  }

  function elapsed() {
    if (finished) return elapsedMs;
    return startAt ? Math.max(0, Date.now() - startAt) : 0;
  }

  function startClock() {
    if (started || finished) return;
    started = true;
    startAt = Date.now();
    ticker = setInterval(function () {
      if (timerEl) timerEl.textContent = fmt(elapsed());
    }, 250);
  }

  function stopClock() {
    if (ticker) { clearInterval(ticker); ticker = 0; }
  }

  /* ---------- 历史 / 填数 ---------- */
  function pushHistory() {
    history.push({
      grid: grid.slice(),
      notes: notes.map(function (o) {
        var c = {};
        for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) c[k] = o[k];
        return c;
      }),
      mistakes: mistakes,
      hints: hints,
      filled: filled
    });
    if (history.length > 120) history.shift();
  }

  function clearNotesPeers(idx, val) {
    for (var i = 0; i < 81; i++) {
      if (i !== idx && isPeer(i, idx) && notes[i]) delete notes[i][val];
    }
  }

  function recountFilled() {
    var n = 0;
    for (var i = 0; i < 81; i++) if (grid[i] !== '.') n++;
    filled = n;
  }

  function isSolved() {
    for (var i = 0; i < 81; i++) if (grid[i] !== solution[i]) return false;
    return true;
  }

  function selectCell(i) {
    if (i < 0 || i > 80) return;
    selected = i;
    paintAll();
    var r = Math.floor(i / 9), c = i % 9;
    var pos = '第 ' + (r + 1) + ' 行第 ' + (c + 1) + ' 列';
    if (given[i]) {
      setStatus(pos + '是题目给的数字，不能改。');
    } else if (grid[i] !== '.') {
      setStatus(pos + '：' + grid[i] + (wrong[i] ? '（这个数不对）' : '') + '。点数字可以改，点同一个数字是擦掉。');
    } else {
      var cs = candidateList(i);
      setStatus(pos + '：' + (cs.length ? '候选 ' + cs.join(' / ') : '这一格暂时没有合法候选，检查一下别的格子。'));
    }
  }

  function inputDigit(d) {
    if (finished || selected < 0) {
      if (!finished) setStatus('先点一个格子，再点下面的 1–9。');
      return;
    }
    if (given[selected]) {
      setStatus('题目给的数字不能改。');
      return;
    }
    startClock();

    if (notesMode) {
      if (grid[selected] !== '.') {
        setStatus('这一格已经填了数，先擦掉再用笔记。');
        return;
      }
      pushHistory();
      var key = String(d);
      if (notes[selected][key]) delete notes[selected][key];
      else notes[selected][key] = true;
      hintMark = [];
      paintAll();
      setStatus('笔记已更新。再点一次同一个数字可以取消。');
      return;
    }

    if (grid[selected] === String(d)) {
      eraseCell();
      return;
    }

    pushHistory();
    grid[selected] = String(d);
    hintMark = [];
    if (String(d) !== solution[selected]) {
      mistakes++;
      wrong[selected] = true;
      setStatus('这个数不对（错误 +1）。不扣寿命，只扣分；擦掉重填就行。', true);
    } else {
      wrong[selected] = false;
      clearNotesPeers(selected, String(d));
      setStatus('填上了 ' + d + '。');
    }
    recountFilled();
    paintAll();
    if (!wrong[selected] && isSolved()) finish();
  }

  function eraseCell() {
    if (finished || selected < 0 || given[selected]) return;
    if (grid[selected] === '.' && (!notes[selected] || !Object.keys(notes[selected]).length)) return;
    pushHistory();
    grid[selected] = '.';
    wrong[selected] = false;
    notes[selected] = {};
    hintMark = [];
    recountFilled();
    paintAll();
    setStatus('擦掉了这一格。');
  }

  function undo() {
    if (!history.length) { setStatus('没有可以撤销的步骤。'); return; }
    var h = history.pop();
    grid = h.grid;
    notes = h.notes;
    mistakes = h.mistakes;
    hints = h.hints;
    filled = h.filled;
    hintMark = [];
    wrong = [];
    for (var i = 0; i < 81; i++) wrong[i] = grid[i] !== '.' && grid[i] !== solution[i];
    paintAll();
    setStatus('撤销了一步。');
  }

  /* ---------- 提示 / 推演 ---------- */
  function hint() {
    if (finished) return;
    startClock();

    var target = -1;
    var reason = '';

    function cellName(i) {
      return '第 ' + (Math.floor(i / 9) + 1) + ' 行第 ' + (i % 9 + 1) + ' 列';
    }

    // 1) 选中的格子正好是错的：先把这格纠正
    if (selected >= 0 && grid[selected] !== '.' && grid[selected] !== solution[selected]) {
      target = selected;
      reason = cellName(target) + ' 填错了，应该是 ' + solution[target] + '。';
    }

    // 2) 唯一候选（裸单）
    if (target < 0) {
      var order = [];
      if (selected >= 0 && grid[selected] === '.') order.push(selected);
      for (var i = 0; i < 81; i++) if (grid[i] === '.') order.push(i);
      for (var k = 0; k < order.length; k++) {
        var cs = candidateList(order[k]);
        if (cs.length === 1) {
          target = order[k];
          reason = cellName(target) + ' 只剩 ' + cs[0] + ' 可以填（同行、同列、同宫都排除了别的数）。';
          break;
        }
      }
    }

    // 3) 隐性唯一：某一行 / 列 / 宫里，只有这一格能放这个数
    if (target < 0) {
      outer:
      for (var u = 0; u < units.length; u++) {
        var unit = units[u];
        for (var d = 1; d <= 9; d++) {
          var ds = String(d);
          var already = false;
          var spots = [];
          for (var q = 0; q < unit.length; q++) {
            var idx = unit[q];
            if (grid[idx] === ds) { already = true; break; }
            if (grid[idx] === '.' && candidateList(idx).indexOf(d) >= 0) spots.push(idx);
          }
          if (already) continue;
          if (spots.length === 1) {
            target = spots[0];
            reason = cellName(target) + ' 是这一' + (u < 9 ? '行' : (u < 18 ? '列' : '宫')) +
              '里唯一能填 ' + d + ' 的格子。';
            break outer;
          }
        }
      }
    }

    // 4) 找不到简单推理：直接告诉一个空格（仍然只扣一次提示分）
    if (target < 0) {
      var empty = [];
      for (var z = 0; z < 81; z++) if (grid[z] === '.' || grid[z] !== solution[z]) empty.push(z);
      if (!empty.length) return;
      target = empty[Math.floor(Math.random() * empty.length)];
      reason = '这一步没有唯一候选，直接告诉你：' + cellName(target) + ' 是 ' + solution[target] + '。';
    }

    pushHistory();
    grid[target] = solution[target];
    wrong[target] = false;
    clearNotesPeers(target, solution[target]);
    hintMark = [];
    hintMark[target] = true;
    hints++;
    recountFilled();
    selected = target;
    paintAll();
    setStatus('提示：' + reason + '（提示 +1，每个 −60 分）', false);
    if (isSolved()) finish();
  }

  /* ---------- 计分 / 结算 ---------- */
  function calcScore() {
    var d = diffOf(diff);
    var sec = Math.max(1, elapsedMs / 1000);
    var timePen = Math.min(400, Math.round(sec / d.target * 400));
    var hintPen = hints * 60;
    var missPen = mistakes * 30;
    var base = Math.max(600, 1000 - timePen - hintPen - missPen);
    var final = Math.round(base * d.coef);
    return {
      sec: sec, timePen: timePen, hintPen: hintPen, missPen: missPen,
      base: base, coef: d.coef, final: final
    };
  }

  function finish() {
    elapsedMs = elapsed();
    finished = true;
    startAt = 0;
    stopClock();
    recountFilled();
    paintAll();
    scoreInfo = calcScore();
    saveBest(diff, scoreInfo.final);
    renderResult();
    submitScore(scoreInfo.final);
  }

  function renderResult() {
    if (!panelEl || !overlayEl) return;
    var d = diffOf(diff);
    var best = readBest(diff);
    var s = scoreInfo || calcScore();
    var html =
      '<h1>完成了</h1>' +
      '<p class="sub">' + d.name + '难度 · 用时 ' + fmt(elapsedMs) + ' · 错误 ' + mistakes +
        ' · 提示 ' + hints + '</p>' +
      '<div class="result"><div class="big">' + s.final +
        '<span class="big-unit">分</span></div>' +
        '<p class="rank-line">难度系数 <b>×' + d.coef.toFixed(2) + '</b> · 本机最高 <b>' + best + '</b> 分</p>' +
      '<dl>' +
        '<div><dt>基础</dt><dd>1000</dd></div>' +
        '<div><dt>用时扣</dt><dd>−' + s.timePen + '</dd></div>' +
        '<div><dt>提示扣</dt><dd>−' + s.hintPen + '</dd></div>' +
        '<div><dt>错误扣</dt><dd>−' + s.missPen + '</dd></div>' +
        '<div><dt>基础分</dt><dd>' + s.base + '</dd></div>' +
        '<div><dt>最终</dt><dd>' + s.final + '</dd></div>' +
      '</dl></div>' +
      '<p class="note-line" id="sd-result-note">' +
        (writable ? '正在把成绩记到排行榜…' : '没登录，成绩只留在本机。回游乐场登录后再玩一局才会进榜。') +
      '</p>' +
      '<button class="btn-main" type="button" id="sd-again">再来一局（' + d.name + '）</button>' +
      '<button class="btn-2nd" type="button" id="sd-change">换难度</button>' +
      '<a class="btn-2nd" href="index.html">回游乐场</a>';
    panelEl.innerHTML = html;
    overlayEl.hidden = false;
    B8.on($('sd-again'), 'click', function () { newGame(diff, true); });
    B8.on($('sd-change'), 'click', openMenu);
  }

  function submitScore(final) {
    if (!writable || submitted || !B8.auth || !B8.auth.token()) return;
    submitted = true;
    B8.sb.rpc('b8_score_add', {
      p_token: B8.auth.token(),
      p_game: 'sudoku:' + diff,
      p_score: final
    }).then(function () {
      var n = $('sd-result-note');
      if (n) n.textContent = '已记到排行榜（' + diffOf(diff).name + '档 ' + final + ' 分）。';
      if (B8.fun && B8.fun.rankSaved) B8.fun.rankSaved('sudoku');
    }).catch(function (err) {
      submitted = false;
      var n = $('sd-result-note');
      var msg = err && err.message ? err.message : '网络异常';
      if (n) n.textContent = '成绩没传上去：' + msg;
    });
  }

  /* ---------- 菜单 ---------- */
  function openMenu() {
    if (!panelEl || !overlayEl) return;
    var html =
      '<h1>数独</h1>' +
      '<p class="sub">选一个难度。填数用下面的 1–9 按键；笔记、候选和提示都在棋盘下面。</p>' +
      '<div class="pick"><span class="pick-label">难度 / DIFFICULTY</span><div class="sd-diffs">';
    DIFFS.forEach(function (d) {
      html += '<button class="sd-diff' + (d.id === diff ? ' is-on' : '') + '" type="button" data-diff="' + d.id + '">' +
        '<b>' + d.name + '</b><span>' + d.desc + '</span>' +
        '<em>×' + d.coef.toFixed(2) + ' · 本机 ' + readBest(d.id) + ' 分</em></button>';
    });
    html += '</div></div>' +
      '<button class="btn-main" type="button" id="sd-start">开始</button>' +
      '<button class="btn-2nd" type="button" id="sd-close">' + (started && !finished ? '继续这一局' : '先看看') + '</button>' +
      '<p class="tip">分数 = （1000 − 用时扣分 − 提示×60 − 错误×30，最低 600）× 难度系数。<br>' +
      '<b>简单 ×1.00 / 普通 ×1.20 / 困难 ×1.45 / 极难 ×1.75</b>，所以挑战高难度更容易上高分。</p>';
    panelEl.innerHTML = html;
    overlayEl.hidden = false;

    B8.qsa('.sd-diff', panelEl).forEach(function (b) {
      B8.on(b, 'click', function () {
        diff = b.getAttribute('data-diff');
        writeLS(KEY_DIFF, diff);
        B8.qsa('.sd-diff', panelEl).forEach(function (x) {
          x.classList.toggle('is-on', x === b);
        });
        updateHud();
      });
    });
    B8.on($('sd-start'), 'click', function () { newGame(diff, false); });
    B8.on($('sd-close'), 'click', function () { overlayEl.hidden = true; });
  }

  function newGame(id, skipConfirm) {
    id = DIFF_BY_ID[id] ? id : diff;
    if (!skipConfirm && !finished && started && !window.confirm('重开一局？这一局的进度会丢掉。')) return;

    diff = id;
    writeLS(KEY_DIFF, diff);
    var built = buildPuzzle(diff);
    solution = built.solution;
    grid = built.puzzle.slice();
    given = [];
    notes = [];
    wrong = [];
    hintMark = [];
    for (var i = 0; i < 81; i++) {
      given[i] = grid[i] !== '.';
      notes[i] = {};
      wrong[i] = false;
      hintMark[i] = false;
    }
    recountFilled();
    selected = -1;
    mistakes = 0;
    hints = 0;
    started = false;
    finished = false;
    startAt = 0;
    elapsedMs = 0;
    submitted = false;
    scoreInfo = null;
    history = [];
    stopClock();
    if (overlayEl) overlayEl.hidden = true;
    buildBoard();
    paintAll();
    updateHud();
    setStatus('选中格子，点下面的 1–9 填数。先用笔记或候选推一推也可以。');
  }

  function buildBoard() {
    if (!boardEl) return;
    boardEl.innerHTML = '';
    cells = [];
    for (var i = 0; i < 81; i++) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'sd-cell';
      b.setAttribute('role', 'gridcell');
      b.setAttribute('data-i', String(i));
      (function (idx) {
        B8.on(b, 'click', function () { selectCell(idx); });
      })(i);
      boardEl.appendChild(b);
      cells.push(b);
    }
  }

  function buildPad() {
    if (!padEl) return;
    padEl.innerHTML = '';
    for (var n = 1; n <= 9; n++) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'sd-num';
      b.textContent = String(n);
      b.setAttribute('aria-label', '填 ' + n);
      b.setAttribute('data-n', String(n));
      B8.on(b, 'click', function (e) {
        var n2 = Number(e.currentTarget.getAttribute('data-n'));
        inputDigit(n2);
      });
      padEl.appendChild(b);
    }
  }

  function buildDiffBar() {
    var bar = $('sd-diffs');
    if (!bar) return;
    bar.innerHTML = '';
    DIFFS.forEach(function (d) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip sd-diff-chip';
      b.textContent = d.name;
      b.setAttribute('data-diff', d.id);
      b.setAttribute('aria-pressed', d.id === diff ? 'true' : 'false');
      B8.on(b, 'click', function () { newGame(d.id, false); });
      bar.appendChild(b);
    });
  }

  /* ---------- 键盘只是附赠，手机不用键盘 ---------- */
  function onKey(e) {
    if (overlayEl && !overlayEl.hidden) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var k = e.key;
    if (k >= '1' && k <= '9') {
      e.preventDefault();
      inputDigit(Number(k));
    } else if (k === 'Backspace' || k === 'Delete') {
      e.preventDefault();
      eraseCell();
    } else if (k === 'n' || k === 'N') {
      e.preventDefault();
      toggleNotes();
    } else if (k === 'h' || k === 'H') {
      e.preventDefault();
      hint();
    } else if (k === 'z' || k === 'Z') {
      e.preventDefault();
      undo();
    } else if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown') {
      e.preventDefault();
      var r = selected < 0 ? 0 : Math.floor(selected / 9);
      var c = selected < 0 ? 0 : selected % 9;
      if (k === 'ArrowLeft') c = (c + 8) % 9;
      if (k === 'ArrowRight') c = (c + 1) % 9;
      if (k === 'ArrowUp') r = (r + 8) % 9;
      if (k === 'ArrowDown') r = (r + 1) % 9;
      selectCell(r * 9 + c);
    }
  }

  function toggleNotes() {
    notesMode = !notesMode;
    updateHud();
    setStatus(notesMode ? '笔记模式：点 1–9 在格子里做小标记，不填数。' : '笔记模式已关。');
  }

  function toggleCand() {
    showCand = !showCand;
    paintAll();
    setStatus(showCand ? '已显示每格的合法候选数（自动推演）。' : '候选数已隐藏。');
  }

  /* ---------- 启动 ---------- */
  function init() {
    boardEl = $('sd-board');
    padEl = $('sd-pad');
    statusEl = $('sd-status');
    timerEl = $('sd-timer');
    diffEl = $('sd-diff');
    missEl = $('sd-mistakes');
    hintEl = $('sd-hints');
    overlayEl = $('sd-overlay');
    panelEl = $('sd-panel');

    if (!boardEl) return;
    buildUnits();

    var saved = readLS(KEY_DIFF);
    diff = DIFF_BY_ID[saved] ? saved : 'easy';

    buildPad();
    buildDiffBar();
    B8.on($('btn-exit'), 'click', function () { location.href = 'index.html'; });
    B8.on($('sd-new'), 'click', function () { newGame(diff, false); });

    var tools = $('sd-tools');
    if (tools) {
      B8.on(tools, 'click', function (e) {
        var b = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
        if (!b) return;
        var act = b.getAttribute('data-act');
        if (act === 'erase') eraseCell();
        else if (act === 'notes') toggleNotes();
        else if (act === 'cand') toggleCand();
        else if (act === 'hint') hint();
        else if (act === 'undo') undo();
      });
    }

    B8.on(document, 'keydown', onKey);
    updateHud();
    openMenu();

    if (B8.auth) {
      B8.auth.ready(function (st) {
        writable = !!(B8.sb && B8.sb.ready) && B8.auth.isLogged() && st.kind !== 'preview';
      });
    }

    var api = {
      reset: function (id) { newGame(id || diff, true); }
    };
    if (window.B8_TEST) {
      api.state = function () {
        return {
          diff: diff, grid: grid.slice(), solution: solution.slice(),
          given: given.slice(), mistakes: mistakes, hints: hints,
          finished: finished, elapsed: elapsed(), score: scoreInfo,
          selected: selected, writable: writable
        };
      };
      api.fill = function () {
        if (finished) return;
        pushHistory();
        grid = solution.slice();
        wrong = [];
        for (var i = 0; i < 81; i++) wrong[i] = false;
        recountFilled();
        paintAll();
        finish();
      };
      api.hint = hint;
      api.input = inputDigit;
    }
    B8.games = B8.games || {};
    B8.games.sudoku = api;
  }

  whenReady(init);
})();
