/* ============================================================
   无猜扫雷 · 八班游乐场街机模块
   ------------------------------------------------------------
   · 三档难度，首击 3×3 安全；
   · 生成时用确定推理求解器反复验证，绝不返回需要猜的棋盘；
   · 逻辑部分放在 _test 里，_shared/test-arcade-mines.js 可直接用
     Node 加载本文件自检。
   ============================================================ */
(function () {
  'use strict';

  var A = window.B8Arcade = window.B8Arcade || {};
  A.games = A.games || {};

  var LEVELS = {
    beginner: {
      key: 'beginner',
      name: '初级',
      w: 9,
      h: 9,
      mines: 10,
      base: 100,
      factor: 1
    },
    intermediate: {
      key: 'intermediate',
      name: '中级',
      w: 16,
      h: 16,
      mines: 40,
      base: 300,
      factor: 1.5
    },
    expert: {
      key: 'expert',
      name: '高级',
      w: 16,
      h: 30,
      mines: 99,
      base: 800,
      factor: 2
    }
  };
  var LEVEL_ORDER = ['beginner', 'intermediate', 'expert'];
  var LEVEL_ALIAS = {
    easy: 'beginner',
    medium: 'intermediate',
    hard: 'expert',
    '初级': 'beginner',
    '中级': 'intermediate',
    '高级': 'expert'
  };
  var GEN_TRY_LIMIT = 400;
  var GEN_BUDGET_MS = 6000;
  var SLICE_MS = 40;
  var SLICE_TRIES = 12;
  var EXACT_MAX_NODES = 90000;
  var EXACT_MAX_CELLS = 26;
  var NB_CACHE = {};

  /* ---------- 纯逻辑：棋盘与求解器 ---------- */

  function levelOf(level) {
    if (level && typeof level === 'object') {
      if (level.key && LEVELS[level.key]) return LEVELS[level.key];
      if (typeof level.w === 'number' && typeof level.h === 'number' &&
          typeof level.mines === 'number') return level;
    }
    var key = level == null || level === '' ? 'beginner' : String(level);
    if (LEVEL_ALIAS[key]) key = LEVEL_ALIAS[key];
    return LEVELS[key] || null;
  }

  function neighborTable(w, h) {
    var key = w + 'x' + h;
    if (NB_CACHE[key]) return NB_CACHE[key];
    var all = [];
    for (var i = 0; i < w * h; i++) {
      var x = i % w;
      var y = Math.floor(i / w);
      var list = [];
      for (var dy = -1; dy <= 1; dy++) {
        for (var dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          var nx = x + dx;
          var ny = y + dy;
          if (nx >= 0 && nx < w && ny >= 0 && ny < h) list.push(ny * w + nx);
        }
      }
      all.push(list);
    }
    NB_CACHE[key] = all;
    return all;
  }

  function toMineSet(mines) {
    var set = new Set();
    if (!mines) return set;
    if (typeof mines.forEach === 'function') {
      mines.forEach(function (v) {
        var n = Number(v);
        if (isFinite(n) && n >= 0 && Math.floor(n) === n) set.add(n);
      });
      return set;
    }
    if (typeof mines.length === 'number') {
      for (var i = 0; i < mines.length; i++) {
        if (!mines[i]) continue;
        var v = Number(isFinite(mines[i]) ? mines[i] : i);
        if (isFinite(v) && v >= 0 && Math.floor(v) === v) set.add(v);
      }
    }
    return set;
  }

  function toOpenedSet(total, opened) {
    var set = new Set();
    var i;
    if (!opened) return set;
    function add(v) {
      var n = Number(v);
      if (isFinite(n) && n >= 0 && n < total && Math.floor(n) === n) set.add(n);
    }
    if (typeof opened.forEach === 'function' && typeof opened.has === 'function') {
      opened.forEach(add);
      return set;
    }
    if (typeof opened.length === 'number') {
      var booleanForm = false;
      for (i = 0; i < opened.length; i++) {
        if (typeof opened[i] === 'boolean') {
          booleanForm = true;
          break;
        }
      }
      if (booleanForm) {
        for (i = 0; i < opened.length; i++) if (opened[i]) add(i);
      } else {
        for (i = 0; i < opened.length; i++) add(opened[i]);
      }
      return set;
    }
    if (typeof opened === 'object') {
      for (var key in opened) {
        if (Object.prototype.hasOwnProperty.call(opened, key) && opened[key]) add(key);
      }
    }
    return set;
  }

  function setToArray(set) {
    var arr = [];
    set.forEach(function (v) { arr.push(v); });
    return arr;
  }

  function makeCounts(w, h, mines) {
    var table = neighborTable(w, h);
    var counts = new Array(w * h);
    for (var i = 0; i < w * h; i++) {
      if (mines.has(i)) {
        counts[i] = -1;
        continue;
      }
      var nbrs = table[i];
      var c = 0;
      for (var k = 0; k < nbrs.length; k++) {
        if (mines.has(nbrs[k])) c++;
      }
      counts[i] = c;
    }
    return counts;
  }

  function buildConstraints(table, counts, opened, knownMine) {
    var arr = setToArray(opened);
    var cons = [];
    var seen = {};
    for (var oi = 0; oi < arr.length; oi++) {
      var idx = arr[oi];
      var nbrs = table[idx];
      var unknown = [];
      var flagged = 0;
      var number = counts[idx];
      for (var k = 0; k < nbrs.length; k++) {
        var n = nbrs[k];
        if (opened.has(n)) continue;
        if (knownMine.has(n)) flagged++;
        else unknown.push(n);
      }
      var rem = number - flagged;
      if (rem < 0 || rem > unknown.length) {
        return { invalid: true, list: [] };
      }
      if (!unknown.length) {
        if (rem !== 0) return { invalid: true, list: [] };
        continue;
      }
      unknown.sort(function (a, b) { return a - b; });
      var key = unknown.join(',');
      if (seen[key] && seen[key].rem !== rem) {
        return { invalid: true, list: [] };
      }
      if (seen[key]) continue;
      var con = { cells: unknown, rem: rem };
      seen[key] = con;
      cons.push(con);
    }
    return { invalid: false, list: cons };
  }

  function floodKnownZeros(table, counts, opened, safe) {
    var queue = [];
    opened.forEach(function (idx) {
      if (counts[idx] === 0) queue.push(idx);
    });
    var changed = false;
    var head = 0;
    while (head < queue.length) {
      var cur = queue[head++];
      var nbrs = table[cur];
      for (var k = 0; k < nbrs.length; k++) {
        var n = nbrs[k];
        if (opened.has(n) || counts[n] === -1) continue;
        opened.add(n);
        safe.add(n);
        changed = true;
        if (counts[n] === 0) queue.push(n);
      }
    }
    return changed;
  }

  function addSafe(cells, opened, safe, knownMine) {
    var changed = false;
    for (var i = 0; i < cells.length; i++) {
      var x = cells[i];
      if (opened.has(x) || knownMine.has(x)) continue;
      opened.add(x);
      safe.add(x);
      changed = true;
    }
    return changed;
  }

  function addMines(cells, opened, safe, knownMine) {
    var changed = false;
    for (var i = 0; i < cells.length; i++) {
      var x = cells[i];
      if (knownMine.has(x)) continue;
      if (opened.has(x) || safe.has(x)) return { changed: changed, invalid: true };
      knownMine.add(x);
      changed = true;
    }
    return { changed: changed, invalid: false };
  }

  function cellsSubset(a, b) {
    for (var i = 0; i < a.length; i++) {
      if (b.indexOf(a[i]) === -1) return false;
    }
    return true;
  }

  function componentsOf(cons) {
    var used = new Array(cons.length);
    var result = [];
    for (var i = 0; i < cons.length; i++) {
      if (used[i]) continue;
      var queue = [i];
      used[i] = true;
      var comp = [];
      var cellMap = {};
      var cells = [];
      var head = 0;
      while (head < queue.length) {
        var ci = queue[head++];
        var con = cons[ci];
        comp.push(con);
        for (var k = 0; k < con.cells.length; k++) {
          var cell = con.cells[k];
          if (!cellMap[cell]) {
            cellMap[cell] = true;
            cells.push(cell);
          }
        }
        for (var j = 0; j < cons.length; j++) {
          if (used[j]) continue;
          var other = cons[j].cells;
          var shares = false;
          for (var q = 0; q < other.length; q++) {
            if (cellMap[other[q]]) {
              shares = true;
              break;
            }
          }
          if (shares) {
            used[j] = true;
            queue.push(j);
          }
        }
      }
      result.push({ cells: cells, cons: comp });
    }
    return result;
  }

  /*
   * 对一个连通约束分量做穷举。只有“全部解都一致”的格子才算推出，
   * 因此它仍然是纯确定推理，不是猜测；节点数超过上限就整块放弃。
   */
  function enumerateComponent(cells, cons, maxNodes) {
    var m = cells.length;
    var pos = {};
    var i;
    for (i = 0; i < m; i++) pos[cells[i]] = i;
    var localCons = [];
    var byVar = [];
    for (i = 0; i < m; i++) byVar.push([]);
    for (i = 0; i < cons.length; i++) {
      var vars = [];
      for (var k = 0; k < cons[i].cells.length; k++) vars.push(pos[cons[i].cells[k]]);
      var lc = { vars: vars, rem: cons[i].rem };
      if (lc.rem < 0 || lc.rem > vars.length) return { status: 'none', safe: [], mine: [] };
      localCons.push(lc);
      for (var q = 0; q < vars.length; q++) byVar[vars[q]].push(localCons.length - 1);
    }
    var order = [];
    for (i = 0; i < m; i++) order.push(i);
    order.sort(function (a, b) { return byVar[b].length - byVar[a].length; });
    var assigned = new Array(m);
    for (i = 0; i < m; i++) assigned[i] = -1;
    var rem = new Array(localCons.length);
    for (i = 0; i < localCons.length; i++) rem[i] = localCons[i].rem;
    var fixed = new Array(m);
    for (i = 0; i < m; i++) fixed[i] = -1;
    var nodes = 0;
    var sols = 0;
    var aborted = false;

    function feasible(v) {
      var list = byVar[v];
      for (var a = 0; a < list.length; a++) {
        var ci = list[a];
        if (rem[ci] < 0) return false;
        var vars2 = localCons[ci].vars;
        var un = 0;
        for (var b = 0; b < vars2.length; b++) {
          if (assigned[vars2[b]] === -1) un++;
        }
        if (rem[ci] > un) return false;
      }
      return true;
    }

    function dfs(depth) {
      if (aborted) return;
      nodes++;
      if (nodes > maxNodes) {
        aborted = true;
        return;
      }
      if (depth === order.length) {
        for (var ci = 0; ci < localCons.length; ci++) {
          if (rem[ci] !== 0) return;
        }
        sols++;
        for (var i2 = 0; i2 < m; i2++) {
          if (fixed[i2] === -1) fixed[i2] = assigned[i2];
          else if (fixed[i2] !== assigned[i2]) fixed[i2] = -2;
        }
        return;
      }
      var v = order[depth];
      var list = byVar[v];
      var z;
      assigned[v] = 0;
      if (feasible(v)) dfs(depth + 1);
      assigned[v] = 1;
      for (z = 0; z < list.length; z++) rem[list[z]]--;
      if (feasible(v)) dfs(depth + 1);
      for (z = 0; z < list.length; z++) rem[list[z]]++;
      assigned[v] = -1;
    }

    dfs(0);
    if (aborted) return { status: 'aborted', safe: [], mine: [] };
    if (!sols) return { status: 'none', safe: [], mine: [] };
    var safe = [];
    var mine = [];
    for (i = 0; i < m; i++) {
      if (fixed[i] === 0) safe.push(cells[i]);
      else if (fixed[i] === 1) mine.push(cells[i]);
    }
    return { status: 'ok', safe: safe, mine: mine };
  }

  function solve(w, h, minesInput, openedInput) {
    var table = neighborTable(w, h);
    var total = w * h;
    var mines = toMineSet(minesInput);
    var opened = toOpenedSet(total, openedInput);
    var safe = new Set();
    var knownMine = new Set();
    var invalid = false;
    var counts = makeCounts(w, h, mines);
    var guard = 0;

    opened.forEach(function (idx) {
      if (mines.has(idx)) invalid = true;
      else safe.add(idx);
    });
    if (invalid) return { solved: false, safe: new Set(), mine: new Set() };

    while (!invalid && guard++ < 1000) {
      floodKnownZeros(table, counts, opened, safe);
      var built = buildConstraints(table, counts, opened, knownMine);
      if (built.invalid) {
        invalid = true;
        break;
      }
      var cons = built.list;
      if (!cons.length) break;
      var progressed = false;

      /* 单格数字约束：剩余雷数 0 → 全安全；等于未知数 → 全雷。 */
      for (var ci = 0; ci < cons.length; ci++) {
        var con = cons[ci];
        if (con.rem === 0) {
          if (addSafe(con.cells, opened, safe, knownMine)) progressed = true;
          break;
        }
        if (con.rem === con.cells.length) {
          var addedMine = addMines(con.cells, opened, safe, knownMine);
          if (addedMine.invalid) {
            invalid = true;
            break;
          }
          if (addedMine.changed) progressed = true;
          break;
        }
      }
      if (invalid) break;
      if (progressed) continue;

      /* 子集推理：A⊆B，则 B\A 的雷数为 rem(B)-rem(A)。 */
      for (var a = 0; a < cons.length && !progressed; a++) {
        var A = cons[a];
        for (var b = 0; b < cons.length; b++) {
          if (a === b) continue;
          var B = cons[b];
          if (B.cells.length <= A.cells.length) continue;
          if (!cellsSubset(A.cells, B.cells)) continue;
          var diff = [];
          for (var di = 0; di < B.cells.length; di++) {
            if (A.cells.indexOf(B.cells[di]) === -1) diff.push(B.cells[di]);
          }
          var dcount = B.rem - A.rem;
          if (dcount < 0 || dcount > diff.length) {
            invalid = true;
            break;
          }
          if (dcount === 0) {
            if (addSafe(diff, opened, safe, knownMine)) progressed = true;
          } else if (dcount === diff.length) {
            var diffMine = addMines(diff, opened, safe, knownMine);
            if (diffMine.invalid) {
              invalid = true;
              break;
            }
            if (diffMine.changed) progressed = true;
          }
          if (progressed) break;
        }
      }
      if (invalid) break;
      if (progressed) continue;

      /* 总雷数约束：剩余雷数为 0，或所有未知格恰好都是剩余雷。 */
      var hidden = [];
      for (var hi = 0; hi < total; hi++) {
        if (!opened.has(hi) && !knownMine.has(hi)) hidden.push(hi);
      }
      var remain = mines.size - knownMine.size;
      if (remain < 0) {
        invalid = true;
        break;
      }
      if (remain === 0) {
        if (addSafe(hidden, opened, safe, knownMine)) continue;
      } else if (hidden.length === remain) {
        var allHidden = addMines(hidden, opened, safe, knownMine);
        if (allHidden.invalid) {
          invalid = true;
          break;
        }
        if (allHidden.changed) continue;
      }

      /* 精确枚举：对较小的连通约束分量求所有解，只取公共结论。 */
      var comps = componentsOf(cons);
      comps.sort(function (x, y) { return x.cells.length - y.cells.length; });
      var exactProgress = false;
      for (var cci = 0; cci < comps.length; cci++) {
        var comp = comps[cci];
        if (comp.cells.length > EXACT_MAX_CELLS) continue;
        var exact = enumerateComponent(comp.cells, comp.cons, EXACT_MAX_NODES);
        if (exact.status === 'none') {
          invalid = true;
          break;
        }
        if (exact.status !== 'ok') continue;
        if (exact.safe.length) {
          if (addSafe(exact.safe, opened, safe, knownMine)) exactProgress = true;
        }
        if (exact.mine.length) {
          var exactMine = addMines(exact.mine, opened, safe, knownMine);
          if (exactMine.invalid) {
            invalid = true;
            break;
          }
          if (exactMine.changed) exactProgress = true;
        }
        if (exactProgress) break;
      }
      if (invalid) break;
      if (exactProgress) continue;
      break;
    }

    var solved = !invalid;
    if (solved) {
      for (var si = 0; si < total; si++) {
        if (!mines.has(si) && !opened.has(si)) {
          solved = false;
          break;
        }
      }
    }
    if (solved) {
      for (var mi = 0; mi < total; mi++) {
        if (!opened.has(mi)) knownMine.add(mi);
        else safe.add(mi);
      }
    }
    return { solved: solved, safe: safe, mine: knownMine };
  }

  function firstSafeCells(w, h, firstIdx) {
    var table = neighborTable(w, h);
    var cells = [firstIdx];
    var nbrs = table[firstIdx];
    for (var i = 0; i < nbrs.length; i++) cells.push(nbrs[i]);
    return cells;
  }

  function isSolvable(w, h, minesInput, firstIdx) {
    var first = Number(firstIdx);
    if (!isFinite(first) || first < 0 || first >= w * h ||
        Math.floor(first) !== first) return false;
    var mines = toMineSet(minesInput);
    var safeCells = firstSafeCells(w, h, first);
    for (var i = 0; i < safeCells.length; i++) {
      if (mines.has(safeCells[i])) return false;
    }
    return solve(w, h, mines, [first]).solved;
  }

  function candidateBoard(level, firstIdx) {
    var L = levelOf(level);
    if (!L) throw new Error('未知扫雷难度');
    var w = L.w;
    var h = L.h;
    var total = w * h;
    var first = Number(firstIdx);
    if (!isFinite(first) || Math.floor(first) !== first || first < 0 || first >= total) {
      first = Math.floor(total / 2);
    }
    var protectedMap = {};
    var protectedCells = firstSafeCells(w, h, first);
    for (var p = 0; p < protectedCells.length; p++) protectedMap[protectedCells[p]] = true;
    var pool = [];
    for (var i = 0; i < total; i++) {
      if (!protectedMap[i]) pool.push(i);
    }
    if (pool.length < L.mines) return null;
    for (var k = 0; k < L.mines; k++) {
      var j = k + Math.floor(Math.random() * (pool.length - k));
      var tmp = pool[k];
      pool[k] = pool[j];
      pool[j] = tmp;
    }
    var mines = new Set();
    for (var m = 0; m < L.mines; m++) mines.add(pool[m]);
    if (!isSolvable(w, h, mines, first)) return null;
    return {
      w: w,
      h: h,
      firstIdx: first,
      mines: mines,
      counts: makeCounts(w, h, mines)
    };
  }

  function generateBoard(level, firstIdx) {
    for (var i = 0; i < GEN_TRY_LIMIT; i++) {
      var board = candidateBoard(level, firstIdx);
      if (board) return board;
    }
    throw new Error('暂时没能生成无猜棋盘');
  }

  function scoreFor(level, seconds) {
    var L = levelOf(level);
    if (!L) return 1;
    var sec = Number(seconds);
    if (!isFinite(sec) || sec < 0) sec = 0;
    sec = Math.floor(sec);
    return Math.max(1, Math.round(L.base * L.factor) - sec);
  }

  /* ---------- UI 样式 ---------- */

  var STYLE_TEXT = [
    '.mn-ms{',
    '  --mn-cell:32px;',
    '  --mn-gap:3px;',
    '  --mn-open:color-mix(in srgb, var(--ink) 7%, var(--card));',
    '  width:100%;max-width:760px;margin:0 auto;color:var(--ink);',
    '  font-family:var(--serif);box-sizing:border-box;',
    '  -webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent;',
    '}',
    '.mn-ms{-webkit-touch-callout:none;}',
    '.mn-ms [hidden]{display:none !important;}',
    '.mn-ms.mn-ms-level-beginner .mn-ms-grid{--mn-cell:34px;}',
    '.mn-ms.mn-ms-level-intermediate .mn-ms-grid{--mn-cell:27px;}',
    '.mn-ms.mn-ms-level-expert .mn-ms-grid{--mn-cell:23px;}',
    '.mn-ms-head{display:flex;align-items:flex-end;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:10px;}',
    '.mn-ms-stats{display:flex;gap:7px;flex-wrap:wrap;}',
    '.mn-ms-stat{min-width:88px;padding:7px 10px 6px;background:var(--card);border:1px solid var(--line);border-radius:var(--radius);box-shadow:0 1px 0 color-mix(in srgb, var(--ink) 5%, transparent);}',
    '.mn-ms-stat-k{display:block;font-family:var(--mono);font-size:9px;line-height:1;letter-spacing:.13em;color:var(--ink-3);}',
    '.mn-ms-stat-v{display:block;margin-top:4px;font-family:var(--mono);font-size:19px;font-weight:700;line-height:1;color:var(--ink);font-variant-numeric:tabular-nums;}',
    '.mn-ms-tools{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}',
    '.mn-ms-btn{height:35px;padding:0 13px;background:var(--card);color:var(--ink-2);border:1px solid var(--line-2);border-radius:var(--radius);font-family:var(--serif);font-size:13px;line-height:1;cursor:pointer;}',
    '.mn-ms-btn:hover{color:var(--seal);border-color:var(--seal);}',
    '.mn-ms-btn:active{transform:translateY(1px);}',
    '.mn-ms-btn.mn-is-on{background:var(--seal);border-color:var(--seal);color:#fffaf2;}',
    '.mn-ms-btn.mn-is-on:hover{color:#fffaf2;}',
    '.mn-ms-levels{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;}',
    '.mn-ms-level{flex:1 1 0;min-width:104px;padding:8px 10px;text-align:left;background:var(--card);border:1px solid var(--line);border-radius:var(--radius);color:var(--ink-2);cursor:pointer;font-family:var(--serif);}',
    '.mn-ms-level:hover{border-color:var(--line-2);}',
    '.mn-ms-level b{display:block;font-size:13px;font-weight:600;line-height:1.2;color:var(--ink);}',
    '.mn-ms-level span{display:block;margin-top:3px;font-family:var(--mono);font-size:9px;line-height:1.2;letter-spacing:.02em;color:var(--ink-3);}',
    '.mn-ms-level.mn-is-active{border-color:var(--jade);background:color-mix(in srgb, var(--jade) 10%, var(--card));box-shadow:inset 0 -2px 0 var(--jade);}',
    '.mn-ms-level.mn-is-active b{color:var(--jade);}',
    '.mn-ms-result{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:10px;padding:9px 11px;background:var(--card);border:1px solid var(--line);border-left:3px solid var(--jade);border-radius:var(--radius);}',
    '.mn-ms-result.mn-ms-result-lost{border-left-color:var(--seal);}',
    '.mn-ms-result-text{min-width:0;}',
    '.mn-ms-result-title{font-size:14px;line-height:1.3;color:var(--ink);}',
    '.mn-ms-result-meta{display:block;margin-top:2px;font-family:var(--mono);font-size:9.5px;line-height:1.4;color:var(--ink-3);}',
    '.mn-ms-boardbox{position:relative;padding:9px;background:var(--card);border:1px solid var(--line);border-radius:calc(var(--radius) + 3px);box-shadow:0 12px 34px -30px color-mix(in srgb, var(--ink) 55%, transparent);}',
    '.mn-ms-scroll{max-width:100%;max-height:62vh;max-height:min(62vh, 690px);overflow:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;scrollbar-width:thin;scrollbar-color:var(--line-2) transparent;}',
    '.mn-ms-grid{display:grid;grid-auto-rows:var(--mn-cell);gap:var(--mn-gap);width:max-content;margin:0 auto;touch-action:manipulation;}',
    '.mn-ms-cell{width:var(--mn-cell);height:var(--mn-cell);min-width:18px;min-height:18px;padding:0;margin:0;display:flex;align-items:center;justify-content:center;box-sizing:border-box;background:var(--card-2);border:1px solid var(--line-2);border-radius:4px;color:var(--ink);font-family:var(--mono);font-size:calc(var(--mn-cell) * .48);font-weight:700;line-height:1;cursor:pointer;box-shadow:inset 0 1px 0 rgba(255,255,255,.34),0 1px 1px rgba(25,22,18,.08);-webkit-appearance:none;appearance:none;}',
    '.mn-ms-cell:hover{border-color:color-mix(in srgb, var(--seal) 45%, var(--line-2));}',
    '.mn-ms-cell:active{transform:translateY(1px);}',
    '.mn-ms-cell:disabled{cursor:default;}',
    '.mn-ms-cell.mn-is-open{background:var(--mn-open);border-color:color-mix(in srgb, var(--line) 88%, transparent);box-shadow:none;cursor:default;}',
    '.mn-ms-cell.mn-is-open:active{transform:none;}',
    '.mn-ms-cell.mn-is-flag{color:var(--seal);font-size:calc(var(--mn-cell) * .52);}',
    '.mn-ms-cell.mn-is-question{color:var(--ink-2);}',
    '.mn-ms-cell.mn-is-mine{background:color-mix(in srgb, var(--seal) 15%, var(--card));color:var(--seal);}',
    '.mn-ms-cell.mn-is-hit{background:var(--seal);border-color:var(--seal);color:#fffaf2;}',
    '.mn-ms-cell.mn-is-wrong{color:var(--seal);background:color-mix(in srgb, var(--seal) 10%, var(--card));text-decoration:line-through;}',
    '.mn-ms-cell.mn-ms-n1{color:#2f5f9e;}',
    '.mn-ms-cell.mn-ms-n2{color:#2f7048;}',
    '.mn-ms-cell.mn-ms-n3{color:#b04436;}',
    '.mn-ms-cell.mn-ms-n4{color:#5c4a8c;}',
    '.mn-ms-cell.mn-ms-n5{color:#8a4a2d;}',
    '.mn-ms-cell.mn-ms-n6{color:#2d7373;}',
    '.mn-ms-cell.mn-ms-n7{color:#3f3a33;}',
    '.mn-ms-cell.mn-ms-n8{color:#777064;}',
    '.mn-ms-loading{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;padding:18px;text-align:center;background:color-mix(in srgb, var(--card) 91%, transparent);border-radius:calc(var(--radius) + 3px);color:var(--ink-2);font-size:12.5px;z-index:2;}',
    '.mn-ms-spinner{width:19px;height:19px;border:2px solid var(--line-2);border-top-color:var(--seal);border-radius:50%;animation:mn-spin .8s linear infinite;}',
    '@keyframes mn-spin{to{transform:rotate(360deg);}}',
    '.mn-ms-tip{margin:9px 2px 0;font-family:var(--mono);font-size:9.5px;line-height:1.75;color:var(--ink-3);}',
    '.mn-ms-best{margin-top:13px;padding-top:10px;border-top:1px dashed var(--line-2);}',
    '.mn-ms-best-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:7px;}',
    '.mn-ms-best-title{font-size:12.5px;color:var(--ink-2);}',
    '.mn-ms-best-note{font-family:var(--mono);font-size:8.5px;letter-spacing:.08em;color:var(--ink-3);}',
    '.mn-ms-best-row{display:grid;grid-template-columns:20px minmax(0,1fr) auto auto;align-items:center;gap:8px;padding:5px 1px;border-bottom:1px solid color-mix(in srgb, var(--line) 75%, transparent);}',
    '.mn-ms-best-row:last-child{border-bottom:0;}',
    '.mn-ms-best-rank{font-family:var(--mono);font-size:10px;color:var(--ink-3);text-align:center;}',
    '.mn-ms-best-row:first-child .mn-ms-best-rank{color:var(--gold);}',
    '.mn-ms-best-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--ink-2);}',
    '.mn-ms-best-score{font-family:var(--mono);font-size:12px;font-weight:700;color:var(--seal);}',
    '.mn-ms-best-date{font-family:var(--mono);font-size:8.5px;line-height:1;color:var(--ink-3);white-space:nowrap;}',
    '.mn-ms-best-empty{margin:5px 0 1px;padding:8px 0;text-align:center;font-size:11.5px;color:var(--ink-3);}',
    'html[data-mode="night"] .mn-ms{--mn-open:color-mix(in srgb, var(--ink) 9%, var(--card));}',
    'html[data-mode="night"] .mn-ms-stat,',
    'html[data-mode="night"] .mn-ms-level,',
    'html[data-mode="night"] .mn-ms-btn,',
    'html[data-mode="night"] .mn-ms-boardbox,',
    'html[data-mode="night"] .mn-ms-result{background:var(--card);border-color:var(--line);color:var(--ink-2);}',
    'html[data-mode="night"] .mn-ms-cell{background:var(--card-2);border-color:var(--line-2);color:var(--ink);box-shadow:inset 0 1px 0 rgba(255,255,255,.06),0 1px 1px rgba(0,0,0,.22);}',
    'html[data-mode="night"] .mn-ms-cell.mn-is-open{background:var(--mn-open);border-color:var(--line);}',
    'html[data-mode="night"] .mn-ms-cell.mn-is-hit{background:var(--seal);color:#1a1512;}',
    'html[data-mode="night"] .mn-ms-level.mn-is-active{background:color-mix(in srgb, var(--jade) 14%, var(--card));border-color:var(--jade);}',
    'html[data-mode="night"] .mn-ms-cell.mn-ms-n1{color:#8ab4ee;}',
    'html[data-mode="night"] .mn-ms-cell.mn-ms-n2{color:#89c99d;}',
    'html[data-mode="night"] .mn-ms-cell.mn-ms-n3{color:#e59284;}',
    'html[data-mode="night"] .mn-ms-cell.mn-ms-n4{color:#b7a3e2;}',
    'html[data-mode="night"] .mn-ms-cell.mn-ms-n5{color:#d4a07d;}',
    'html[data-mode="night"] .mn-ms-cell.mn-ms-n6{color:#80c8c8;}',
    'html[data-mode="night"] .mn-ms-cell.mn-ms-n7{color:#d8d3c7;}',
    'html[data-mode="night"] .mn-ms-cell.mn-ms-n8{color:#a8a298;}',
    'html[data-mode="night"] .mn-ms-loading{background:color-mix(in srgb, var(--card) 92%, transparent);color:var(--ink-2);}',
    '@media (max-width:560px){',
    '  .mn-ms.mn-ms-level-beginner .mn-ms-grid{--mn-cell:32px;}',
    '  .mn-ms.mn-ms-level-intermediate .mn-ms-grid{--mn-cell:25px;}',
    '  .mn-ms.mn-ms-level-expert .mn-ms-grid{--mn-cell:22px;}',
    '  .mn-ms-head{gap:7px;}',
    '  .mn-ms-stat{flex:1 1 0;min-width:78px;}',
    '  .mn-ms-scroll{max-height:56vh;max-height:min(56vh, 560px);}',
    '  .mn-ms-level{min-width:88px;padding:7px 8px;}',
    '  .mn-ms-level span{font-size:8.5px;}',
    '  .mn-ms-tip{font-size:9px;}',
    '  .mn-ms-best-row{grid-template-columns:20px minmax(0,1fr) auto;}',
    '  .mn-ms-best-date{display:none;}',
    '}'
  ].join('\n');

  /* ---------- UI 状态与生命周期 ---------- */

  var S = {
    mounted: false,
    root: null,
    ctx: null,
    styleEl: null,
    styleOwned: false,
    bound: [],
    levelKey: 'beginner',
    levelBtns: {},
    game: null,
    state: 'idle',
    generating: false,
    genToken: 0,
    genTimer: 0,
    genWaveStart: 0,
    genWaveTries: 0,
    genTotalTries: 0,
    pendingFirst: -1,
    cache: {},
    timerId: 0,
    startAt: 0,
    timeSec: 0,
    flags: 0,
    flagMode: false,
    cells: [],
    grid: null,
    shell: null,
    mineEl: null,
    timeEl: null,
    flagBtn: null,
    loadingEl: null,
    loadingTextEl: null,
    resultEl: null,
    resultTitleEl: null,
    resultMetaEl: null,
    resultBtn: null,
    bestTitleEl: null,
    bestListEl: null,
    bestSeq: 0,
    longTimer: 0,
    touchIdx: -1,
    touchX: 0,
    touchY: 0,
    touchFired: false,
    clickGuardUntil: 0,
    clickGuardIdx: -1,
    chordGuardUntil: 0
  };

  function ensureStyle() {
    var existing = document.getElementById('mn-style');
    if (existing) {
      S.styleEl = existing;
      S.styleOwned = false;
      return;
    }
    var style = document.createElement('style');
    style.id = 'mn-style';
    style.textContent = STYLE_TEXT;
    var head = document.head || document.documentElement;
    head.appendChild(style);
    S.styleEl = style;
    S.styleOwned = true;
  }

  function bind(el, type, fn, opt) {
    if (!el || !el.addEventListener) return;
    el.addEventListener(type, fn, opt || false);
    S.bound.push({ el: el, type: type, fn: fn, opt: opt || false });
  }

  function callStatus(text) {
    if (S.ctx && typeof S.ctx.setStatus === 'function') {
      try { S.ctx.setStatus(text); } catch (e) {}
    }
  }

  function setStatusIdle() {
    callStatus('点击任意方格开始 · 首击周围 3×3 必定安全');
  }

  function readElapsed() {
    if (!S.startAt) return S.timeSec || 0;
    var n = Math.floor((Date.now() - S.startAt) / 1000);
    return n > 0 ? n : 0;
  }

  function startTimer() {
    if (S.timerId) {
      clearInterval(S.timerId);
      S.timerId = 0;
    }
    S.startAt = Date.now();
    S.timeSec = 0;
    S.timerId = setInterval(function () {
      if (!S.mounted || S.state !== 'playing') return;
      var sec = readElapsed();
      if (sec !== S.timeSec) {
        S.timeSec = sec;
        updateHUD();
      }
    }, 250);
  }

  function stopTimer() {
    if (S.timerId) {
      clearInterval(S.timerId);
      S.timerId = 0;
    }
  }

  function pad3(n) {
    var neg = n < 0;
    var s = String(Math.abs(n));
    while (s.length < 3) s = '0' + s;
    return (neg ? '-' : '') + s;
  }

  function formatTime(seconds) {
    var sec = Number(seconds) || 0;
    if (sec < 0) sec = 0;
    var m = Math.floor(sec / 60);
    var s = sec % 60;
    return (m < 10 ? '0' + m : '' + m) + ':' + (s < 10 ? '0' + s : '' + s);
  }

  function mk(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function buildUi() {
    var root = S.root;
    root.innerHTML = '';
    var shell = mk('div', 'mn-ms mn-ms-level-' + S.levelKey);
    S.shell = shell;

    var head = mk('div', 'mn-ms-head');
    var stats = mk('div', 'mn-ms-stats');
    var mineStat = mk('div', 'mn-ms-stat');
    var mineK = mk('span', 'mn-ms-stat-k', '剩余地雷');
    var mineV = mk('b', 'mn-ms-stat-v', '000');
    mineStat.appendChild(mineK);
    mineStat.appendChild(mineV);
    var timeStat = mk('div', 'mn-ms-stat');
    var timeK = mk('span', 'mn-ms-stat-k', '用时');
    var timeV = mk('b', 'mn-ms-stat-v', '00:00');
    timeStat.appendChild(timeK);
    timeStat.appendChild(timeV);
    stats.appendChild(mineStat);
    stats.appendChild(timeStat);
    S.mineEl = mineV;
    S.timeEl = timeV;

    var tools = mk('div', 'mn-ms-tools');
    var flagBtn = mk('button', 'mn-ms-btn', '插旗模式');
    flagBtn.type = 'button';
    flagBtn.setAttribute('aria-pressed', 'false');
    var restartBtn = mk('button', 'mn-ms-btn', '重开');
    restartBtn.type = 'button';
    tools.appendChild(flagBtn);
    tools.appendChild(restartBtn);
    S.flagBtn = flagBtn;

    head.appendChild(stats);
    head.appendChild(tools);
    shell.appendChild(head);

    var levels = mk('div', 'mn-ms-levels');
    levels.setAttribute('role', 'tablist');
    levels.setAttribute('aria-label', '扫雷难度');
    S.levelBtns = {};
    for (var li = 0; li < LEVEL_ORDER.length; li++) {
      var lk = LEVEL_ORDER[li];
      var L = LEVELS[lk];
      var lb = mk('button', 'mn-ms-level');
      lb.type = 'button';
      lb.setAttribute('role', 'tab');
      lb.setAttribute('data-mn-level', lk);
      lb.setAttribute('aria-selected', lk === S.levelKey ? 'true' : 'false');
      var lbName = mk('b', null, L.name);
      var lbSub = mk('span', null, L.w + '×' + L.h + ' · ' + L.mines + ' 雷');
      lb.appendChild(lbName);
      lb.appendChild(lbSub);
      (function (key) {
        bind(lb, 'click', function () { switchLevel(key); });
      })(lk);
      levels.appendChild(lb);
      S.levelBtns[lk] = lb;
    }
    shell.appendChild(levels);

    var result = mk('div', 'mn-ms-result');
    result.hidden = true;
    var resultText = mk('div', 'mn-ms-result-text');
    var resultTitle = mk('div', 'mn-ms-result-title', '');
    var resultMeta = mk('span', 'mn-ms-result-meta', '');
    resultText.appendChild(resultTitle);
    resultText.appendChild(resultMeta);
    var resultBtn = mk('button', 'mn-ms-btn', '再来一局');
    resultBtn.type = 'button';
    result.appendChild(resultText);
    result.appendChild(resultBtn);
    S.resultEl = result;
    S.resultTitleEl = resultTitle;
    S.resultMetaEl = resultMeta;
    S.resultBtn = resultBtn;
    shell.appendChild(result);

    var boardbox = mk('div', 'mn-ms-boardbox');
    var scroll = mk('div', 'mn-ms-scroll');
    var grid = mk('div', 'mn-ms-grid');
    grid.setAttribute('role', 'grid');
    grid.setAttribute('aria-label', '扫雷棋盘');
    scroll.appendChild(grid);
    var loading = mk('div', 'mn-ms-loading');
    loading.hidden = true;
    var spinner = mk('span', 'mn-ms-spinner');
    spinner.setAttribute('aria-hidden', 'true');
    var loadingText = mk('span', 'mn-ms-loading-text', '正在生成无猜棋盘…');
    loading.appendChild(spinner);
    loading.appendChild(loadingText);
    boardbox.appendChild(scroll);
    boardbox.appendChild(loading);
    shell.appendChild(boardbox);
    S.grid = grid;
    S.loadingEl = loading;
    S.loadingTextEl = loadingText;

    var tip = mk('p', 'mn-ms-tip',
      '左键翻开 · 右键循环标记（旗 / 问号） · 双击数字格和弦 · 触屏长按插旗');
    shell.appendChild(tip);

    var best = mk('div', 'mn-ms-best');
    var bestHead = mk('div', 'mn-ms-best-head');
    var bestTitle = mk('span', 'mn-ms-best-title', '本难度最好成绩');
    var bestNote = mk('span', 'mn-ms-best-note', '前 5 名');
    bestHead.appendChild(bestTitle);
    bestHead.appendChild(bestNote);
    var bestList = mk('div', 'mn-ms-best-list');
    best.appendChild(bestHead);
    best.appendChild(bestList);
    shell.appendChild(best);
    S.bestTitleEl = bestTitle;
    S.bestListEl = bestList;

    root.appendChild(shell);

    bind(restartBtn, 'click', restartRound);
    bind(flagBtn, 'click', toggleFlagMode);
    bind(resultBtn, 'click', restartRound);
    bind(grid, 'click', onGridClick);
    bind(grid, 'contextmenu', onGridContext);
    bind(grid, 'dblclick', onGridDblClick);
    bind(grid, 'mousedown', onGridMouseDown);
    bind(grid, 'touchstart', onGridTouchStart);
    bind(grid, 'touchmove', onGridTouchMove);
    bind(grid, 'touchend', onGridTouchEnd);
    bind(grid, 'touchcancel', onGridTouchCancel);
  }

  function updateLevelButtons() {
    for (var i = 0; i < LEVEL_ORDER.length; i++) {
      var key = LEVEL_ORDER[i];
      var btn = S.levelBtns[key];
      if (!btn) continue;
      var on = key === S.levelKey;
      if (on) btn.classList.add('mn-is-active');
      else btn.classList.remove('mn-is-active');
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    if (S.shell) {
      for (var j = 0; j < LEVEL_ORDER.length; j++) {
        S.shell.classList.remove('mn-ms-level-' + LEVEL_ORDER[j]);
      }
      S.shell.classList.add('mn-ms-level-' + S.levelKey);
    }
    var L = LEVELS[S.levelKey];
    if (S.shell) S.shell.setAttribute('data-mn-level', L.key);
  }

  function hideResult() {
    if (!S.resultEl) return;
    S.resultEl.hidden = true;
    S.resultEl.classList.remove('mn-ms-result-win');
    S.resultEl.classList.remove('mn-ms-result-lost');
  }

  function showResult(won, score, seconds) {
    if (!S.resultEl) return;
    S.resultEl.hidden = false;
    S.resultEl.classList.remove('mn-ms-result-win');
    S.resultEl.classList.remove('mn-ms-result-lost');
    S.resultEl.classList.add(won ? 'mn-ms-result-win' : 'mn-ms-result-lost');
    S.resultTitleEl.textContent = won ? '扫雷成功' : '踩到雷了';
    S.resultMetaEl.textContent = won
      ? ('用时 ' + seconds + ' 秒 · 本局得分 ' + score)
      : ('用时 ' + seconds + ' 秒 · 本局 0 分');
  }

  function showLoading(text) {
    if (!S.loadingEl) return;
    S.loadingEl.hidden = false;
    if (S.loadingTextEl) S.loadingTextEl.textContent = text || '正在生成无猜棋盘…';
    if (S.grid) S.grid.setAttribute('aria-busy', 'true');
  }

  function hideLoading() {
    if (S.loadingEl) S.loadingEl.hidden = true;
    if (S.grid) S.grid.removeAttribute('aria-busy');
  }

  function buildGrid() {
    var L = LEVELS[S.levelKey];
    var grid = S.grid;
    if (!grid) return;
    grid.innerHTML = '';
    grid.className = 'mn-ms-grid mn-ms-grid-' + L.key;
    grid.style.gridTemplateColumns = 'repeat(' + L.w + ', var(--mn-cell))';
    grid.setAttribute('aria-rowcount', String(L.h));
    grid.setAttribute('aria-colcount', String(L.w));
    grid.setAttribute('aria-label', '扫雷棋盘，' + L.w + ' 列 ' + L.h + ' 行');
    var frag = document.createDocumentFragment();
    S.cells = [];
    for (var i = 0; i < L.w * L.h; i++) {
      var b = mk('button', 'mn-ms-cell');
      b.type = 'button';
      b.setAttribute('data-mn-i', String(i));
      b.setAttribute('role', 'gridcell');
      var row = Math.floor(i / L.w) + 1;
      var col = i % L.w + 1;
      b.setAttribute('aria-label', '第 ' + row + ' 行第 ' + col + ' 列，未翻开');
      frag.appendChild(b);
      S.cells.push(b);
    }
    grid.appendChild(frag);
    paintAll();
  }

  function paintAll() {
    for (var i = 0; i < S.cells.length; i++) paintCell(i);
  }

  function paintCell(i) {
    var b = S.cells[i];
    if (!b) return;
    var L = LEVELS[S.levelKey];
    var game = S.game;
    var row = Math.floor(i / L.w) + 1;
    var col = i % L.w + 1;
    var cls = 'mn-ms-cell';
    var text = '';
    var label = '第 ' + row + ' 行第 ' + col + ' 列';
    b.disabled = S.state === 'won' || S.state === 'lost';
    if (!game) {
      b.className = cls;
      b.textContent = '';
      b.setAttribute('aria-label', label + '，点击开始');
      return;
    }
    if (game.opened[i]) {
      cls += ' mn-is-open';
      var num = game.board.counts[i];
      if (num > 0) {
        cls += ' mn-ms-n' + num;
        text = String(num);
        label += '，数字 ' + num;
      } else {
        label += '，空白';
      }
    } else if (S.state === 'lost') {
      if (game.board.mines.has(i)) {
        cls += ' mn-is-mine';
        if (game.mark[i] === 1) {
          cls += ' mn-is-flag';
          text = '▲';
          label += '，地雷，已插旗';
        } else {
          text = '✹';
          label += '，地雷';
        }
      } else if (game.mark[i] === 1) {
        cls += ' mn-is-wrong';
        text = '✕';
        label += '，插错的旗';
      } else if (game.mark[i] === 2) {
        cls += ' mn-is-question';
        text = '?';
        label += '，问号';
      } else {
        label += '，未翻开';
      }
    } else if (S.state === 'won') {
      if (game.board.mines.has(i)) {
        cls += ' mn-is-flag';
        text = '▲';
        label += '，地雷，已插旗';
      } else if (game.mark[i] === 2) {
        cls += ' mn-is-question';
        text = '?';
        label += '，问号';
      } else {
        label += '，未翻开';
      }
    } else {
      if (game.mark[i] === 1) {
        cls += ' mn-is-flag';
        text = '▲';
        label += '，已插旗';
      } else if (game.mark[i] === 2) {
        cls += ' mn-is-question';
        text = '?';
        label += '，问号';
      } else {
        label += '，未翻开';
      }
    }
    if (S.state === 'lost' && game.hitIdx === i) cls += ' mn-is-hit';
    b.className = cls;
    b.textContent = text;
    b.setAttribute('aria-label', label);
  }

  function updateHUD() {
    var L = LEVELS[S.levelKey];
    if (S.mineEl) S.mineEl.textContent = pad3(L.mines - S.flags);
    if (S.timeEl) S.timeEl.textContent = formatTime(S.timeSec);
    if (S.flagBtn) {
      if (S.flagMode) S.flagBtn.classList.add('mn-is-on');
      else S.flagBtn.classList.remove('mn-is-on');
      S.flagBtn.setAttribute('aria-pressed', S.flagMode ? 'true' : 'false');
    }
    updateLevelButtons();
  }

  function playStatus() {
    if (S.state !== 'playing' || !S.game) return;
    var L = LEVELS[S.levelKey];
    var safeTotal = L.w * L.h - L.mines;
    callStatus('已翻开 ' + S.game.revealed + ' / ' + safeTotal +
      ' 个安全格 · 剩余雷数 ' + (L.mines - S.flags));
  }

  function switchLevel(key) {
    if (!LEVELS[key] || key === S.levelKey) return;
    S.levelKey = key;
    startNewRound(true);
  }

  function restartRound() {
    startNewRound(true);
  }

  function cancelGeneration() {
    S.genToken++;
    if (S.genTimer) {
      clearTimeout(S.genTimer);
      S.genTimer = 0;
    }
    S.generating = false;
    S.genWaveStart = 0;
    S.genWaveTries = 0;
    S.genTotalTries = 0;
    S.pendingFirst = -1;
    hideLoading();
  }

  function startNewRound(loadBestNow) {
    cancelGeneration();
    stopTimer();
    S.game = null;
    S.state = 'idle';
    S.startAt = 0;
    S.timeSec = 0;
    S.flags = 0;
    S.flagMode = false;
    S.clickGuardUntil = 0;
    S.clickGuardIdx = -1;
    S.chordGuardUntil = 0;
    hideResult();
    hideLoading();
    buildGrid();
    updateHUD();
    setStatusIdle();
    if (loadBestNow !== false) loadBest();
  }

  function toggleFlagMode() {
    if (!S.mounted) return;
    S.flagMode = !S.flagMode;
    updateHUD();
  }

  function setMark(idx, mark) {
    var g = S.game;
    if (!g || g.opened[idx]) return;
    var old = g.mark[idx] || 0;
    if (old === 1 && mark !== 1) S.flags--;
    else if (old !== 1 && mark === 1) S.flags++;
    g.mark[idx] = mark;
    paintCell(idx);
    updateHUD();
    playStatus();
  }

  function cycleMark(idx) {
    if (S.state !== 'playing' || !S.game || S.game.opened[idx]) return;
    var old = S.game.mark[idx] || 0;
    setMark(idx, old === 0 ? 1 : old === 1 ? 2 : 0);
  }

  function toggleFlagOnly(idx) {
    if (S.state !== 'playing' || !S.game || S.game.opened[idx]) return;
    var old = S.game.mark[idx] || 0;
    setMark(idx, old === 1 ? 0 : 1);
  }

  function indexFromEvent(e) {
    var node = e.target;
    while (node && node !== S.grid) {
      if (node.getAttribute) {
        var v = node.getAttribute('data-mn-i');
        if (v !== null) {
          var n = parseInt(v, 10);
          return isNaN(n) ? -1 : n;
        }
      }
      node = node.parentNode;
    }
    return -1;
  }

  function neighborsFor(idx) {
    var L = LEVELS[S.levelKey];
    return neighborTable(L.w, L.h)[idx] || [];
  }

  function loseGame(hitIdx) {
    endGame(false, hitIdx);
  }

  function floodReveal(startIdx) {
    var g = S.game;
    if (!g || S.state !== 'playing') return;
    if (g.board.mines.has(startIdx)) {
      loseGame(startIdx);
      return;
    }
    var L = LEVELS[S.levelKey];
    var table = neighborTable(L.w, L.h);
    var queue = [startIdx];
    var head = 0;
    while (head < queue.length) {
      var cur = queue[head++];
      if (g.opened[cur]) continue;
      if (g.mark[cur] === 1) continue;
      if (g.board.mines.has(cur)) {
        loseGame(cur);
        return;
      }
      g.opened[cur] = 1;
      g.mark[cur] = 0;
      g.revealed++;
      if (g.board.counts[cur] === 0) {
        var nbrs = table[cur];
        for (var k = 0; k < nbrs.length; k++) {
          var n = nbrs[k];
          if (g.opened[n] || g.mark[n] === 1 || g.board.mines.has(n)) continue;
          queue.push(n);
        }
      }
    }
  }

  function chordAt(idx) {
    var g = S.game;
    if (!g || S.state !== 'playing' || !g.opened[idx]) return;
    var number = g.board.counts[idx];
    if (number <= 0) return;
    var nbrs = neighborsFor(idx);
    var flags = 0;
    var i;
    for (i = 0; i < nbrs.length; i++) {
      if ((g.mark[nbrs[i]] || 0) === 1) flags++;
    }
    if (flags !== number) return;
    var targets = [];
    for (i = 0; i < nbrs.length; i++) {
      var n = nbrs[i];
      if (g.opened[n] || (g.mark[n] || 0) === 1) continue;
      if (g.board.mines.has(n)) {
        loseGame(n);
        return;
      }
      targets.push(n);
    }
    for (i = 0; i < targets.length; i++) {
      floodReveal(targets[i]);
      if (S.state !== 'playing') return;
    }
    afterAction();
  }

  function afterAction() {
    paintAll();
    updateHUD();
    if (S.state !== 'playing') return;
    var L = LEVELS[S.levelKey];
    var safeTotal = L.w * L.h - L.mines;
    if (S.game && S.game.revealed >= safeTotal) {
      endGame(true, -1);
      return;
    }
    playStatus();
  }

  function endGame(won, hitIdx) {
    if (S.state !== 'playing' || !S.game) return;
    var L = LEVELS[S.levelKey];
    var seconds = readElapsed();
    S.timeSec = seconds;
    S.startAt = 0;
    stopTimer();
    S.state = won ? 'won' : 'lost';
    if (won) {
      for (var i = 0; i < L.w * L.h; i++) {
        if (S.game.board.mines.has(i)) S.game.mark[i] = 1;
      }
      S.flags = L.mines;
    } else {
      S.game.hitIdx = typeof hitIdx === 'number' ? hitIdx : -1;
    }
    paintAll();
    updateHUD();
    var score = won ? scoreFor(L, seconds) : 0;
    showResult(won, score, seconds);
    callStatus(won
      ? ('清场成功 · 用时 ' + seconds + ' 秒 · 得分 ' + score)
      : ('踩到雷了 · 用时 ' + seconds + ' 秒 · 本局 0 分'));
    var res = {
      won: won,
      score: score,
      seconds: seconds,
      level: L.key,
      detail: {
        level: L.key,
        seconds: seconds,
        mines: L.mines,
        cells: L.w * L.h
      }
    };
    if (S.ctx && typeof S.ctx.onFinish === 'function') {
      try { S.ctx.onFinish(res); } catch (e) {}
    }
    if (won) loadBest();
  }

  function onGridClick(e) {
    if (!S.mounted) return;
    var now = Date.now();
    if (now < S.chordGuardUntil) return;
    var idx = indexFromEvent(e);
    if (idx < 0) return;
    if (now < S.clickGuardUntil && S.clickGuardIdx === idx) {
      S.clickGuardUntil = 0;
      S.clickGuardIdx = -1;
      return;
    }
    if (S.state === 'starting' || S.generating) return;
    if (S.state === 'idle') {
      beginRound(idx);
      return;
    }
    if (S.state !== 'playing' || !S.game) return;
    var g = S.game;
    if (S.flagMode) {
      if (g.opened[idx]) chordAt(idx);
      else cycleMark(idx);
      return;
    }
    if (g.opened[idx]) return;
    if ((g.mark[idx] || 0) === 1) return;
    if ((g.mark[idx] || 0) === 2) {
      g.mark[idx] = 0;
      paintCell(idx);
    }
    floodReveal(idx);
    afterAction();
  }

  function onGridContext(e) {
    if (e && e.preventDefault) e.preventDefault();
    if (!S.mounted || Date.now() < S.chordGuardUntil) return;
    if (S.state !== 'playing' || !S.game) return;
    var idx = indexFromEvent(e);
    if (idx < 0) return;
    /* 部分安卓浏览器长按也会发 contextmenu：这里只补一次旗，不再多走一格。 */
    if (S.longTimer && S.touchIdx === idx) {
      clearLongPress();
      toggleFlagOnly(idx);
      S.touchFired = true;
      S.clickGuardUntil = Date.now() + 700;
      S.clickGuardIdx = idx;
      return;
    }
    if (Date.now() < S.clickGuardUntil && S.clickGuardIdx === idx) return;
    cycleMark(idx);
  }

  function onGridDblClick(e) {
    if (!S.mounted) return;
    if (e && e.preventDefault) e.preventDefault();
    if (S.state !== 'playing' || !S.game) return;
    var idx = indexFromEvent(e);
    if (idx < 0) return;
    if (S.game.opened[idx]) chordAt(idx);
  }

  function onGridMouseDown(e) {
    if (!S.mounted || S.state !== 'playing' || !S.game) return;
    var chord = e.button === 1 || e.buttons === 3;
    if (!chord) return;
    var idx = indexFromEvent(e);
    if (idx < 0 || !S.game.opened[idx]) return;
    if (S.game.board.counts[idx] <= 0) return;
    if (e.preventDefault) e.preventDefault();
    S.chordGuardUntil = Date.now() + 450;
    S.clickGuardUntil = Date.now() + 450;
    S.clickGuardIdx = idx;
    chordAt(idx);
  }

  function clearLongPress() {
    if (S.longTimer) {
      clearTimeout(S.longTimer);
      S.longTimer = 0;
    }
  }

  function onGridTouchStart(e) {
    clearLongPress();
    S.touchFired = false;
    if (!S.mounted || S.state !== 'playing' || !S.game) return;
    if (!e.touches || e.touches.length !== 1) return;
    var idx = indexFromEvent(e);
    if (idx < 0 || S.game.opened[idx]) return;
    S.touchIdx = idx;
    S.touchX = e.touches[0].clientX;
    S.touchY = e.touches[0].clientY;
    S.longTimer = setTimeout(function () {
      S.longTimer = 0;
      if (!S.mounted || S.state !== 'playing' || !S.game) return;
      toggleFlagOnly(S.touchIdx);
      S.touchFired = true;
      S.clickGuardUntil = Date.now() + 700;
      S.clickGuardIdx = S.touchIdx;
    }, 460);
  }

  function onGridTouchMove(e) {
    if (!S.longTimer || !e.touches || !e.touches.length) return;
    var dx = e.touches[0].clientX - S.touchX;
    var dy = e.touches[0].clientY - S.touchY;
    if (dx * dx + dy * dy > 100) clearLongPress();
  }

  function onGridTouchEnd(e) {
    clearLongPress();
    if (S.touchFired) {
      S.touchFired = false;
      S.clickGuardUntil = Date.now() + 700;
      S.clickGuardIdx = S.touchIdx;
      if (e && e.cancelable && e.preventDefault) e.preventDefault();
    }
    S.touchIdx = -1;
  }

  function onGridTouchCancel() {
    clearLongPress();
    S.touchFired = false;
    S.touchIdx = -1;
  }

  function beginRound(firstIdx) {
    if (!S.mounted) return;
    if (S.state !== 'idle') return;
    S.state = 'starting';
    S.generating = true;
    S.pendingFirst = firstIdx;
    S.genToken++;
    var token = S.genToken;
    S.genWaveStart = 0;
    S.genWaveTries = 0;
    S.genTotalTries = 0;
    showLoading('正在生成无猜棋盘…');
    callStatus('正在生成无猜棋盘…');
    S.genTimer = setTimeout(function () {
      generationStep(token);
    }, 0);
  }

  function cacheFor(firstIdx) {
    var entry = S.cache[S.levelKey];
    if (!entry || !entry.board) return null;
    var board = entry.board;
    var L = LEVELS[S.levelKey];
    if (board.w !== L.w || board.h !== L.h) return null;
    if (entry.firstIdx === firstIdx || isSolvable(board.w, board.h, board.mines, firstIdx)) {
      return board;
    }
    return null;
  }

  function generationStep(token) {
    S.genTimer = 0;
    if (!S.mounted || token !== S.genToken || S.state !== 'starting') return;
    var first = S.pendingFirst;
    var cached = cacheFor(first);
    if (cached) {
      commitBoard(cached, first);
      return;
    }
    var L = LEVELS[S.levelKey];
    if (!S.genWaveStart) S.genWaveStart = Date.now();
    var sliceStart = Date.now();
    var tries = 0;
    while (S.mounted && token === S.genToken) {
      var board = candidateBoard(L, first);
      S.genWaveTries++;
      S.genTotalTries++;
      tries++;
      if (board) {
        S.cache[L.key] = { board: board, firstIdx: first };
        commitBoard(board, first);
        return;
      }
      if (tries >= SLICE_TRIES || Date.now() - sliceStart >= SLICE_MS) break;
      if (S.genWaveTries >= GEN_TRY_LIMIT ||
          Date.now() - S.genWaveStart >= GEN_BUDGET_MS) break;
    }
    if (S.genWaveTries >= GEN_TRY_LIMIT ||
        Date.now() - S.genWaveStart >= GEN_BUDGET_MS) {
      S.genWaveStart = Date.now();
      S.genWaveTries = 0;
    }
    var msg = '正在生成无猜棋盘…';
    if (S.genTotalTries > 0) msg += '（第 ' + S.genTotalTries + ' 次尝试）';
    showLoading(msg);
    callStatus(msg);
    S.genTimer = setTimeout(function () {
      generationStep(token);
    }, 0);
  }

  function commitBoard(board, firstIdx) {
    if (!S.mounted) return;
    S.generating = false;
    S.state = 'playing';
    S.timeSec = 0;
    S.flags = 0;
    S.pendingFirst = -1;
    S.genWaveStart = 0;
    S.genWaveTries = 0;
    S.genTotalTries = 0;
    hideLoading();
    var total = board.w * board.h;
    var opened = new Array(total);
    var mark = new Array(total);
    for (var i = 0; i < total; i++) {
      opened[i] = 0;
      mark[i] = 0;
    }
    S.game = {
      board: board,
      opened: opened,
      mark: mark,
      revealed: 0,
      hitIdx: -1,
      firstIdx: firstIdx
    };
    startTimer();
    floodReveal(firstIdx);
    afterAction();
  }

  function loadBest() {
    if (!S.bestListEl || !S.bestTitleEl) return;
    var L = LEVELS[S.levelKey];
    S.bestTitleEl.textContent = '本难度最好成绩 · ' + L.name;
    S.bestSeq++;
    var seq = S.bestSeq;
    S.bestListEl.innerHTML = '';
    var pending = mk('p', 'mn-ms-best-empty', '正在读取排行榜…');
    S.bestListEl.appendChild(pending);
    if (!S.ctx || typeof S.ctx.best !== 'function') {
      renderBest([], false);
      return;
    }
    var done = false;
    function cb(rows) {
      if (done) return;
      done = true;
      if (!S.mounted || seq !== S.bestSeq) return;
      renderBest(rows, false);
    }
    try {
      var ret = S.ctx.best(cb);
      if (ret && typeof ret.then === 'function') {
        ret.then(cb, function () {
          if (done) return;
          done = true;
          if (!S.mounted || seq !== S.bestSeq) return;
          renderBest([], true);
        });
      }
    } catch (e) {
      if (done) return;
      done = true;
      if (!S.mounted || seq !== S.bestSeq) return;
      renderBest([], true);
    }
  }

  function rowMatchesLevel(row) {
    if (!row) return false;
    var lv = row.level;
    if (lv == null || lv === '') return true;
    var L = LEVELS[S.levelKey];
    var s = String(lv).toLowerCase();
    return s === L.key || String(lv) === L.name ||
      (LEVEL_ALIAS[s] === L.key);
  }

  function bestDate(value) {
    if (!value) return '';
    if (window.B8 && typeof window.B8.date === 'function') {
      try {
        var d = window.B8.date(value);
        if (d) return d;
      } catch (e) {}
    }
    var s = String(value);
    return s.length > 10 ? s.slice(0, 10) : s;
  }

  function renderBest(rows, failed) {
    if (!S.bestListEl) return;
    S.bestListEl.innerHTML = '';
    if (failed) {
      S.bestListEl.appendChild(mk('p', 'mn-ms-best-empty', '排行榜暂时读不到'));
      return;
    }
    var list = [];
    var src = rows && typeof rows.length === 'number' ? rows : [];
    for (var i = 0; i < src.length; i++) {
      var row = src[i];
      if (!row || !rowMatchesLevel(row)) continue;
      var score = Number(row.score);
      if (!isFinite(score)) continue;
      list.push({ row: row, score: score });
    }
    list.sort(function (a, b) { return b.score - a.score; });
    if (list.length > 5) list = list.slice(0, 5);
    if (!list.length) {
      S.bestListEl.appendChild(mk('p', 'mn-ms-best-empty', '还没有人上榜'));
      return;
    }
    var frag = document.createDocumentFragment();
    for (var j = 0; j < list.length; j++) {
      var item = list[j];
      var r = item.row;
      var line = mk('div', 'mn-ms-best-row');
      var rank = mk('span', 'mn-ms-best-rank', String(j + 1));
      var nick = mk('span', 'mn-ms-best-name',
        r.nick == null || r.nick === '' ? '匿名' : String(r.nick));
      var sc = mk('b', 'mn-ms-best-score', String(item.score));
      line.appendChild(rank);
      line.appendChild(nick);
      line.appendChild(sc);
      var dateText = bestDate(r.created_at);
      if (dateText) {
        var dt = mk('span', 'mn-ms-best-date', dateText);
        line.appendChild(dt);
      }
      frag.appendChild(line);
    }
    S.bestListEl.appendChild(frag);
  }

  function destroy() {
    if (S.mounted) {
      S.mounted = false;
      S.genToken++;
    }
    S.bestSeq++;
    cancelGeneration();
    stopTimer();
    clearLongPress();
    for (var i = S.bound.length - 1; i >= 0; i--) {
      var b = S.bound[i];
      try { b.el.removeEventListener(b.type, b.fn, b.opt); } catch (e) {}
    }
    S.bound = [];
    if (S.styleEl && S.styleOwned && S.styleEl.parentNode) {
      S.styleEl.parentNode.removeChild(S.styleEl);
    }
    if (S.root) {
      try { S.root.innerHTML = ''; } catch (e) {}
    }
    S.root = null;
    S.ctx = null;
    S.styleEl = null;
    S.styleOwned = false;
    S.game = null;
    S.state = 'idle';
    S.generating = false;
    S.cells = [];
    S.grid = null;
    S.shell = null;
    S.levelBtns = {};
    S.cache = {};
    S.timeSec = 0;
    S.startAt = 0;
    S.flags = 0;
    S.flagMode = false;
    S.pendingFirst = -1;
    S.loadingEl = null;
    S.loadingTextEl = null;
    S.resultEl = null;
    S.mineEl = null;
    S.timeEl = null;
    S.flagBtn = null;
    S.bestTitleEl = null;
    S.bestListEl = null;
  }

  function mount(root, ctx) {
    if (!root) return;
    if (S.mounted) destroy();
    S.mounted = true;
    S.root = root;
    S.ctx = ctx || {};
    S.levelKey = 'beginner';
    S.cache = {};
    S.state = 'idle';
    S.game = null;
    ensureStyle();
    buildUi();
    updateLevelButtons();
    startNewRound(true);
  }

  A.games.mines = {
    key: 'mines',
    title: '扫雷',
    icon: '雷',
    sub: '无猜版 · 三档难度',
    mode: 'solo',
    mount: mount,
    destroy: destroy,
    _test: {
      levels: LEVELS,
      gen: generateBoard,
      neighborCount: function (w, h, mines, idx) {
        var total = w * h;
        if (typeof idx !== 'number' || idx < 0 || idx >= total ||
            Math.floor(idx) !== idx) return 0;
        var set = toMineSet(mines);
        var nbrs = neighborTable(w, h)[idx];
        var c = 0;
        for (var i = 0; i < nbrs.length; i++) {
          if (set.has(nbrs[i])) c++;
        }
        return c;
      },
      solve: solve,
      isSolvable: isSolvable,
      scoreFor: scoreFor
    }
  };
})();
