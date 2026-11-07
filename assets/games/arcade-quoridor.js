/* ============================================================
   步步为营（Quoridor）· 2-4 人
   ------------------------------------------------------------
   服务端只存房间和整份局面 JSON，这里算全部规则：

     · 9×9 格，棋子站在四条边中央；走到对面那条边就完赛。
     · 每回合只能「走一格」或「放一块墙」。墙跨两格。
     · 任何一块墙落下去，都要保证仍在场的人都能走到自己的目标边。
     · 对方棋子贴在正前方时可以跳过去；正后方被墙/边/第三人堵住时，
       只能跳到对方棋子的左右两侧（不能斜走，也不能连跳第二人）。
     · 3/4 人先到的人进 rank、离开 order；剩最后一人时整局结束，
       rank[0] 就是冠军。

   外壳（arcade.js）负责房间、座位、聊天和同步。这里不碰网络，
   不自己造权威局面：每次 ctx.onChange 都拿 ctx.state 重画；
   落一步只把完整 nextState 交给 ctx.send。

   模块顶层不碰 DOM，自检脚本可以只加载 _test。
   ============================================================ */
(function () {
  'use strict';

  var A = window.B8Arcade = window.B8Arcade || {};
  A.games = A.games || {};

  /* ============================================================
     0. 常量与基础小工具
     ============================================================ */

  var N = 9;
  var WALL_COUNT = [0, 10, 10, 5, 5];   // 按人数；2 人各 10，3/4 人各 5
  var STYLE_ID = 'qc-style';

  // 1=下，2=上，3=左，4=右。dir 是朝目标线走的方向。
  var SEATS = {
    1: { x: 4, y: 8, axis: 'y', dir: -1, target: 0, edge: '上边' },
    2: { x: 4, y: 0, axis: 'y', dir: 1, target: 8, edge: '下边' },
    3: { x: 0, y: 4, axis: 'x', dir: 1, target: 8, edge: '右边' },
    4: { x: 8, y: 4, axis: 'x', dir: -1, target: 0, edge: '左边' }
  };

  var DIRS = [
    { dx: 0, dy: -1 },
    { dx: 1, dy: 0 },
    { dx: 0, dy: 1 },
    { dx: -1, dy: 0 }
  ];

  function isInt(v) {
    return typeof v === 'number' && isFinite(v) && Math.floor(v) === v;
  }

  function cloneState(state) {
    return JSON.parse(JSON.stringify(state));
  }

  function inBoard(x, y) {
    return x >= 0 && x < N && y >= 0 && y < N;
  }

  function seatNumber(v) {
    var n = Number(v);
    return isInt(n) ? n : 0;
  }

  function pawnOf(state, seat) {
    var list = (state && state.pawns) || [];
    seat = seatNumber(seat);
    for (var i = 0; i < list.length; i++) {
      if (seatNumber(list[i].seat) === seat) return list[i];
    }
    return null;
  }

  function pawnAt(state, x, y) {
    var list = (state && state.pawns) || [];
    for (var i = 0; i < list.length; i++) {
      if (Number(list[i].x) === x && Number(list[i].y) === y) return list[i];
    }
    return null;
  }

  function orderOf(state) {
    return (state && state.order) || [];
  }

  function isActive(state, seat) {
    seat = seatNumber(seat);
    var list = orderOf(state);
    return list.indexOf(seat) >= 0 && !!pawnOf(state, seat);
  }

  function nextSeatInOrder(order, seat) {
    var list = order || [];
    if (!list.length) return 0;
    seat = seatNumber(seat);
    var idx = list.indexOf(seat);
    if (idx >= 0) return seatNumber(list[(idx + 1) % list.length]);
    // 当前玩家刚完赛、已经从 order 里删掉时，按座位顺时针找下一个。
    for (var d = 1; d <= 4; d++) {
      var candidate = ((seat - 1 + d) % 4) + 1;
      if (list.indexOf(candidate) >= 0) return candidate;
    }
    return seatNumber(list[0]);
  }

  function wallLeftOf(state, seat) {
    var box = (state && state.wallsLeft) || {};
    var v = box[seat];
    if (v == null) v = box[String(seat)];
    return Number(v) || 0;
  }

  function normalizeWall(wall) {
    if (!wall || typeof wall !== 'object') return null;
    var x = wall.x;
    var y = wall.y;
    var dir = String(wall.dir == null ? '' : wall.dir).toLowerCase();
    if (!isInt(x) || !isInt(y) || x < 0 || x > 7 || y < 0 || y > 7) return null;
    if (dir !== 'h' && dir !== 'v') return null;
    return { x: x, y: y, dir: dir };
  }

  function wallProblem(wall) {
    if (!wall || typeof wall !== 'object') return '没有墙的位置';
    if (!isInt(wall.x) || !isInt(wall.y)) return '墙的坐标不对';
    if (wall.x < 0 || wall.x > 7 || wall.y < 0 || wall.y > 7) {
      return '墙只能放在棋盘的 8×8 个落点里';
    }
    var dir = String(wall.dir == null ? '' : wall.dir).toLowerCase();
    if (dir !== 'h' && dir !== 'v') return '墙的方向只能是横墙或竖墙';
    return '';
  }

  /* ============================================================
     1. 目标、棋盘、墙面
     ============================================================ */

  function wallsFor(n) {
    n = Number(n);
    return (n >= 2 && n <= 4) ? WALL_COUNT[n] : 0;
  }

  function goalOf(seat, n) {
    seat = Number(seat);
    var def = SEATS[seat];
    if (!def) return null;
    if (n != null) {
      n = Number(n);
      if (n >= 2 && n <= 4 && seat > n) return null;
    }
    return { axis: def.axis, dir: def.dir, target: def.target };
  }

  function goalEdge(seat) {
    var def = SEATS[Number(seat)];
    return def ? def.edge : '';
  }

  function isGoalAt(seat, n, x, y) {
    var g = goalOf(seat, n);
    if (!g) return false;
    return g.axis === 'x' ? x === g.target : y === g.target;
  }

  /*
    墙的坐标 (x,y) 是这块两格墙左上角所在格（0..7）：
      h：挡 (x,y)↔(x,y+1) 与 (x+1,y)↔(x+1,y+1)
      v：挡 (x,y)↔(x+1,y) 与 (x,y+1)↔(x+1,y+1)
  */
  function blockedBetween(state, x1, y1, x2, y2) {
    var walls = (state && state.walls) || [];
    var i, w;
    if (x1 === x2 && Math.abs(y1 - y2) === 1) {
      var top = Math.min(y1, y2);
      for (i = 0; i < walls.length; i++) {
        w = walls[i];
        if (String(w.dir).toLowerCase() !== 'h') continue;
        if (Number(w.y) !== top) continue;
        if (Number(w.x) === x1 || Number(w.x) + 1 === x1) return true;
      }
      return false;
    }
    if (y1 === y2 && Math.abs(x1 - x2) === 1) {
      var left = Math.min(x1, x2);
      for (i = 0; i < walls.length; i++) {
        w = walls[i];
        if (String(w.dir).toLowerCase() !== 'v') continue;
        if (Number(w.x) !== left) continue;
        if (Number(w.y) === y1 || Number(w.y) + 1 === y1) return true;
      }
      return false;
    }
    return true;
  }

  function wallConflict(state, wall) {
    var walls = (state && state.walls) || [];
    var a, h, v;
    for (var i = 0; i < walls.length; i++) {
      a = walls[i];
      if (!a) continue;
      var ad = String(a.dir).toLowerCase();
      if (ad === wall.dir) {
        if (Number(a.x) === wall.x && Number(a.y) === wall.y) {
          return '这里已经有一块墙了';
        }
        if (wall.dir === 'h' && Number(a.y) === wall.y &&
            Math.abs(Number(a.x) - wall.x) < 2) {
          return '两块墙重叠了';
        }
        if (wall.dir === 'v' && Number(a.x) === wall.x &&
            Math.abs(Number(a.y) - wall.y) < 2) {
          return '两块墙重叠了';
        }
      } else {
        h = wall.dir === 'h' ? wall : a;
        v = wall.dir === 'v' ? wall : a;
        // 横竖墙在同一落点会真正十字相交；只在端点相遇不算交叉。
        if (Number(h.x) === Number(v.x) && Number(h.y) === Number(v.y)) {
          return '两块墙交叉了';
        }
      }
    }
    return '';
  }

  /* ============================================================
     2. 纯规则：BFS、可走点、落墙、走子、初始局
     ============================================================ */

  function pathLen(state, seat) {
    if (!state) return -1;
    var p = pawnOf(state, seat);
    if (!p) return -1;
    var sx = Number(p.x), sy = Number(p.y);
    if (!inBoard(sx, sy)) return -1;
    var g = goalOf(seat, state.n);
    if (!g) return -1;

    var seen = [];
    var queue = [[sx, sy, 0]];
    var head = 0;
    seen[sy * N + sx] = true;
    while (head < queue.length) {
      var cur = queue[head++];
      if (g.axis === 'x' ? cur[0] === g.target : cur[1] === g.target) {
        return cur[2] + 1;               // 含起点格，所以开局中路是 9
      }
      for (var d = 0; d < DIRS.length; d++) {
        var nx = cur[0] + DIRS[d].dx;
        var ny = cur[1] + DIRS[d].dy;
        if (!inBoard(nx, ny)) continue;
        if (seen[ny * N + nx]) continue;
        if (blockedBetween(state, cur[0], cur[1], nx, ny)) continue;
        seen[ny * N + nx] = true;
        queue.push([nx, ny, cur[2] + 1]);
      }
    }
    return -1;
  }

  function pushMove(list, x, y, type) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].x === x && list[i].y === y) return;
    }
    list.push({ x: x, y: y, type: type });
  }

  function legalMoves(state, seat) {
    var out = [];
    if (!state || state.status === 'over') return out;
    var p = pawnOf(state, seat);
    if (!p) return out;
    var sx = Number(p.x), sy = Number(p.y);
    if (!inBoard(sx, sy)) return out;

    for (var d = 0; d < DIRS.length; d++) {
      var dir = DIRS[d];
      var nx = sx + dir.dx;
      var ny = sy + dir.dy;
      if (!inBoard(nx, ny)) continue;
      if (blockedBetween(state, sx, sy, nx, ny)) continue;
      var other = pawnAt(state, nx, ny);
      if (!other) {
        pushMove(out, nx, ny, 'move');
        continue;
      }

      var bx = nx + dir.dx;
      var by = ny + dir.dy;
      var backFree = inBoard(bx, by) &&
        !blockedBetween(state, nx, ny, bx, by) &&
        !pawnAt(state, bx, by);

      if (backFree) {
        pushMove(out, bx, by, 'jump');
        continue;
      }

      // 正后方被墙、棋盘边或第三枚棋子堵住时，才能向左右侧跳。
      var perp = dir.dx === 0
        ? [{ dx: -1, dy: 0 }, { dx: 1, dy: 0 }]
        : [{ dx: 0, dy: -1 }, { dx: 0, dy: 1 }];
      for (var k = 0; k < perp.length; k++) {
        var ox = nx + perp[k].dx;
        var oy = ny + perp[k].dy;
        if (!inBoard(ox, oy)) continue;
        if (blockedBetween(state, nx, ny, ox, oy)) continue;
        if (pawnAt(state, ox, oy)) continue;
        pushMove(out, ox, oy, 'sidejump');
      }
    }
    return out;
  }

  function canPlaceWall(state, wall) {
    var bad = wallProblem(wall);
    if (bad) return { ok: false, why: bad };
    if (!state) return { ok: false, why: '棋局还没同步好' };
    if (state.status === 'over') return { ok: false, why: '对局已经结束' };

    var w = normalizeWall(wall);
    if (!w) return { ok: false, why: '墙的坐标不对' };
    var issue = wallConflict(state, w);
    if (issue) return { ok: false, why: issue };

    var sim = cloneState(state);
    sim.walls = (sim.walls || []).concat([w]);
    var pawns = sim.pawns || [];
    for (var i = 0; i < pawns.length; i++) {
      if (pathLen(sim, pawns[i].seat) < 0) {
        return { ok: false, why: '这块墙会把 ' + pawns[i].seat + ' 号玩家的路封死' };
      }
    }
    return { ok: true, why: '' };
  }

  function placeWall(state, seat, wall) {
    if (!state || state.status === 'over') return null;
    seat = seatNumber(seat);
    if (!isActive(state, seat)) return null;
    if (seatNumber(state.turn) !== seat) return null;
    if (wallLeftOf(state, seat) <= 0) return null;
    var check = canPlaceWall(state, wall);
    if (!check.ok) return null;

    var w = normalizeWall(wall);
    var ns = cloneState(state);
    ns.walls = (ns.walls || []).concat([w]);
    ns.wallsLeft[seat] = wallLeftOf(state, seat) - 1;
    ns.turn = nextSeatInOrder(ns.order, seat);
    return ns;
  }

  function removePawn(ns, seat) {
    var list = ns.pawns || [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      if (seatNumber(list[i].seat) !== seat) out.push(list[i]);
    }
    ns.pawns = out;
  }

  function moveTo(state, seat, x, y) {
    if (!state || state.status === 'over') return null;
    seat = seatNumber(seat);
    if (!isActive(state, seat)) return null;
    if (seatNumber(state.turn) !== seat) return null;
    if (!isInt(x) || !isInt(y)) return null;

    var legal = legalMoves(state, seat);
    var found = null;
    for (var i = 0; i < legal.length; i++) {
      if (legal[i].x === x && legal[i].y === y) { found = legal[i]; break; }
    }
    if (!found) return null;

    var ns = cloneState(state);
    var p = pawnOf(ns, seat);
    p.x = x;
    p.y = y;

    if (isGoalAt(seat, ns.n, x, y)) {
      if (ns.rank.indexOf(seat) < 0) ns.rank.push(seat);
      var idx = ns.order.indexOf(seat);
      if (idx >= 0) ns.order.splice(idx, 1);
      removePawn(ns, seat);
      ns.winner = ns.rank.length ? seatNumber(ns.rank[0]) : 0;
      ns.status = ns.order.length <= 1 ? 'over' : 'play';
    }

    ns.turn = nextSeatInOrder(ns.order, seat);
    if (!ns.order.length) ns.turn = 0;
    return ns;
  }

  function init(n) {
    n = Number(n);
    if (n !== 2 && n !== 3 && n !== 4) return null;
    var order = [];
    var pawns = [];
    var wallsLeft = {};
    var goals = {};
    for (var seat = 1; seat <= n; seat++) {
      var def = SEATS[seat];
      order.push(seat);
      pawns.push({ seat: seat, x: def.x, y: def.y });
      wallsLeft[seat] = wallsFor(n);
      goals[seat] = { axis: def.axis, dir: def.dir, target: def.target };
    }
    return {
      v: 1,
      n: n,
      cells: 9,
      walls: [],
      pawns: pawns,
      wallsLeft: wallsLeft,
      goals: goals,
      rank: [],
      order: order,
      turn: order[0],
      status: 'play',
      winner: 0,
      startedAt: 0
    };
  }

  /* ============================================================
     3. 样式（qc- 前缀；夜间只改变量和少量表面色）
     ============================================================ */

  var STYLE = [
    '.qc-wrap{',
    '  --qc-board:#fbf5e6;',
    '  --qc-board-2:#f3ead7;',
    '  --qc-board-alt:rgba(163,50,40,.026);',
    '  --qc-grid:rgba(86,69,45,.16);',
    '  --qc-edge:rgba(86,69,45,.42);',
    '  --qc-wall:#815d3d;',
    '  --qc-wall-edge:#4f3823;',
    '  --qc-wall-shadow:rgba(74,50,27,.24);',
    '  --qc-ok:rgba(47,111,94,.68);',
    '  --qc-bad:rgba(193,82,47,.68);',
    '  --qc-on-seat:#fffdf7;',
    '  --qc-pawn-ring:rgba(255,255,255,.58);',
    '  --qc-p1:#c1522f;',
    '  --qc-p2:#2f6f5e;',
    '  --qc-p3:#ac7c25;',
    '  --qc-p4:#52618c;',
    '  --qc-me:rgba(47,111,94,.08);',
    '  color:var(--ink);',
    '  font-family:var(--sans,"PingFang SC","Microsoft YaHei",system-ui,sans-serif);',
    '  line-height:1.5;',
    '}',
    'html[data-mode="night"] .qc-wrap{',
    '  --qc-board:#202129;',
    '  --qc-board-2:#181920;',
    '  --qc-board-alt:rgba(255,255,255,.018);',
    '  --qc-grid:rgba(245,239,226,.13);',
    '  --qc-edge:rgba(245,239,226,.28);',
    '  --qc-wall:#d1bb95;',
    '  --qc-wall-edge:#806c4d;',
    '  --qc-wall-shadow:rgba(0,0,0,.38);',
    '  --qc-ok:rgba(111,168,179,.72);',
    '  --qc-bad:rgba(229,141,107,.74);',
    '  --qc-on-seat:#17181e;',
    '  --qc-pawn-ring:rgba(0,0,0,.30);',
    '  --qc-p1:#e58d6b;',
    '  --qc-p2:#78b1ba;',
    '  --qc-p3:#d5b466;',
    '  --qc-p4:#a2afe0;',
    '  --qc-me:rgba(111,168,179,.10);',
    '}',
    '.qc-wrap *{box-sizing:border-box;}',
    '.qc-head{display:flex;align-items:flex-end;justify-content:space-between;gap:10px 14px;flex-wrap:wrap;margin-bottom:10px;}',
    '.qc-kicker{margin:0 0 1px;font-family:var(--mono);font-size:9px;letter-spacing:.19em;color:var(--ink-3);}',
    '.qc-title{margin:0;font-family:var(--serif);font-size:18px;letter-spacing:.06em;line-height:1.25;}',
    '.qc-sub{margin:2px 0 0;font-size:10.5px;color:var(--ink-3);}',
    '.qc-statusbar{display:flex;align-items:center;gap:8px;min-height:28px;padding:4px 9px;border:1px solid var(--line);border-radius:999px;background:var(--card-2);font-size:11px;color:var(--ink-2);}',
    '.qc-status{max-width:330px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.qc-clock{padding:1px 7px;border-left:1px solid var(--line);font-family:var(--mono);font-size:11px;font-variant-numeric:tabular-nums;color:var(--jade);white-space:nowrap;}',
    '.qc-clock.is-low{color:var(--seal);font-weight:700;}',
    '.qc-clock[hidden]{display:none;}',
    '.qc-shell{display:grid;grid-template-columns:minmax(0,1fr) 222px;gap:14px;align-items:start;}',
    '.qc-boardbox{position:relative;min-width:0;}',
    '.qc-boardwrap{width:100%;max-width:640px;margin:0 auto;}',
    '.qc-canvas{display:block;width:100%;height:auto;border-radius:calc(var(--radius) + 2px);cursor:default;touch-action:manipulation;}',
    '.qc-canvas.is-act{cursor:crosshair;}',
    '.qc-canvas.is-act:not(.is-wall){cursor:pointer;}',
    '.qc-side{display:flex;flex-direction:column;gap:10px;min-width:0;}',
    '.qc-roster-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:6px;}',
    '.qc-roster-head b{font-family:var(--serif);font-size:12.5px;letter-spacing:.06em;}',
    '.qc-roster-head span{font-family:var(--mono);font-size:9px;color:var(--ink-3);}',
    '.qc-roster{display:flex;flex-direction:column;gap:5px;}',
    '.qc-player{display:flex;align-items:center;gap:7px;padding:6px 7px;border:1px solid var(--line);border-radius:var(--radius);background:var(--card-2);transition:border-color .15s,background .15s;}',
    '.qc-player.is-me{background:linear-gradient(90deg,var(--qc-me),var(--card-2) 72%);}',
    '.qc-player.is-turn{border-color:var(--jade);box-shadow:inset 3px 0 0 var(--jade);}',
    '.qc-player.is-done{opacity:.76;}',
    '.qc-player.is-dead{opacity:.5;}',
    '.qc-dot{display:grid;place-items:center;width:22px;height:22px;flex:0 0 auto;border-radius:50%;font-family:var(--mono);font-size:9.5px;font-weight:700;color:var(--qc-on-seat);box-shadow:inset 0 0 0 1px var(--qc-pawn-ring);}',
    '.qc-dot.s1{background:var(--qc-p1);}',
    '.qc-dot.s2{background:var(--qc-p2);}',
    '.qc-dot.s3{background:var(--qc-p3);}',
    '.qc-dot.s4{background:var(--qc-p4);}',
    '.qc-pmain{flex:1 1 auto;min-width:0;}',
    '.qc-pname{display:flex;align-items:center;gap:4px;min-width:0;}',
    '.qc-pname b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px;font-weight:650;color:var(--ink);}',
    '.qc-you{flex:0 0 auto;padding:0 4px;border:1px solid color-mix(in srgb,var(--jade) 42%,var(--line));border-radius:3px;font-family:var(--mono);font-size:8px;font-style:normal;color:var(--jade);line-height:1.6;}',
    '.qc-pmeta{display:block;margin-top:1px;font-size:9px;color:var(--ink-3);line-height:1.45;}',
    '.qc-pend{flex:0 0 auto;display:flex;flex-direction:column;align-items:flex-end;gap:2px;}',
    '.qc-walls{font-family:var(--mono);font-size:9px;color:var(--ink-3);line-height:1.2;text-align:right;white-space:nowrap;}',
    '.qc-walls b{font-size:13px;color:var(--ink);}',
    '.qc-walls.is-empty b{color:var(--seal);}',
    '.qc-place{font-size:8.5px;color:var(--ink-3);white-space:nowrap;}',
    '.qc-place.is-turn{color:var(--jade);font-weight:700;}',
    '.qc-place.is-rank{color:var(--seal);font-weight:700;}',
    '.qc-empty{margin:4px 0;font-size:10.5px;color:var(--ink-3);}',
    '.qc-controls{margin-top:2px;padding-top:9px;border-top:1px dashed var(--line);}',
    '.qc-controls-title{margin:0 0 6px;font-family:var(--mono);font-size:8.5px;letter-spacing:.16em;color:var(--ink-3);}',
    '.qc-btns{display:flex;flex-wrap:wrap;gap:5px;}',
    '.qc-btn{min-height:29px;padding:5px 9px;border:1px solid var(--line-2);border-radius:var(--radius);background:var(--card);font-family:var(--sans);font-size:10.5px;color:var(--ink-2);cursor:pointer;}',
    '.qc-btn:hover:not(:disabled){border-color:var(--seal);color:var(--seal);}',
    '.qc-btn.is-on{border-color:var(--jade);background:var(--jade);color:#fff;}',
    '.qc-btn.qc-mode{flex:1 1 100%;}',
    '.qc-btn.qc-dir{flex:1 1 0;}',
    '.qc-btn:disabled{opacity:.38;cursor:not-allowed;}',
    '.qc-hint{margin:7px 0 0;font-size:10px;line-height:1.65;color:var(--ink-3);}',
    '.qc-hint.is-warn{color:var(--seal);}',
    '.qc-hint.is-ok{color:var(--jade);}',
    '.qc-overlay{position:absolute;inset:0;z-index:2;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(247,242,232,.78);border-radius:calc(var(--radius) + 2px);backdrop-filter:blur(2.5px);}',
    '.qc-overlay[hidden]{display:none;}',
    'html[data-mode="night"] .qc-overlay{background:rgba(18,18,24,.80);}',
    '.qc-overlay-in{width:100%;max-width:390px;max-height:100%;overflow:auto;padding:16px 16px 14px;border:1px solid var(--line);border-radius:var(--radius);background:var(--card);box-shadow:0 16px 40px -24px rgba(25,23,19,.55);text-align:center;}',
    '.qc-ov-kicker{margin:0 0 3px;font-family:var(--mono);font-size:8.5px;letter-spacing:.18em;color:var(--ink-3);}',
    '.qc-ov-title{margin:0;font-family:var(--serif);font-size:20px;letter-spacing:.05em;line-height:1.35;}',
    '.qc-ov-sub{margin:5px 0 0;font-size:10.5px;line-height:1.7;color:var(--ink-2);}',
    '.qc-ov-wait{font-size:13px;line-height:1.8;color:var(--ink-2);}',
    '.qc-rank-list{display:flex;flex-direction:column;gap:4px;margin:11px 0 0;padding:0;list-style:none;text-align:left;}',
    '.qc-rank-row{display:flex;align-items:center;gap:7px;padding:5px 7px;border:1px solid var(--line);border-radius:var(--radius);background:var(--card-2);font-size:10.5px;}',
    '.qc-rank-row.is-me{border-color:var(--jade);background:var(--qc-me);}',
    '.qc-rank-no{display:grid;place-items:center;width:22px;height:22px;flex:0 0 auto;border-radius:50%;background:var(--card);border:1px solid var(--line-2);font-family:var(--mono);font-size:9px;color:var(--ink-3);}',
    '.qc-rank-row:first-child .qc-rank-no{border-color:var(--gold);color:var(--gold);}',
    '.qc-rank-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink);}',
    '.qc-rank-tag{font-family:var(--mono);font-size:8.5px;color:var(--ink-3);}',
    '.qc-foot{margin:8px 0 0;font-size:9.5px;line-height:1.7;color:var(--ink-3);}',
    '@media (max-width:840px){',
    '  .qc-shell{grid-template-columns:minmax(0,1fr);}',
    '  .qc-side{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);align-items:start;}',
    '  .qc-roster{grid-column:1;}',
    '  .qc-controls{grid-column:2;margin-top:0;padding-top:0;border-top:0;}',
    '  .qc-hint{grid-column:2;}',
    '}',
    '@media (max-width:560px){',
    '  .qc-head{align-items:flex-start;}',
    '  .qc-statusbar{width:100%;max-width:100%;}',
    '  .qc-status{max-width:none;}',
    '  .qc-side{display:flex;}',
    '  .qc-roster{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));}',
    '  .qc-player{min-width:0;}',
    '  .qc-controls{margin-top:2px;padding-top:9px;border-top:1px dashed var(--line);}',
    '  .qc-hint{grid-column:auto;}',
    '  .qc-overlay{padding:10px;}',
    '}'
  ].join('\n');

  /* ============================================================
     4. 浏览器界面
     ============================================================ */

  var S = {};

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function ensureStyle() {
    var style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement('style');
      style.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(style);
    }
    style.textContent = STYLE;
  }

  function b8Toast(msg) {
    if (S.ctx && typeof S.ctx.toast === 'function') {
      try { S.ctx.toast(msg); return; } catch (e) {}
    }
    var B8 = window.B8;
    if (B8 && typeof B8.toast === 'function') {
      try { B8.toast(msg); } catch (e2) {}
    }
  }

  function pageStatus(text) {
    if (S.lastPageStatus === text) return;
    S.lastPageStatus = text;
    if (S.ctx && typeof S.ctx.setStatus === 'function') {
      try { S.ctx.setStatus(text); } catch (e) {}
    }
  }

  function stateOf(P) {
    var st = P && P.state;
    if (!st || typeof st !== 'object' || Array.isArray(st)) return null;
    return st;
  }

  function statusOf(P) {
    var r = (P && P.room) || {};
    if (r.status === 'wait' || r.status === 'play' || r.status === 'over') return r.status;
    var st = stateOf(P);
    if (st && (st.status === 'play' || st.status === 'over')) return st.status;
    return 'wait';
  }

  function gameN(P) {
    var st = stateOf(P);
    var n = st && Number(st.n);
    if (n !== 2 && n !== 3 && n !== 4) {
      n = Number((P && P.room && P.room.max_seats) || 0);
    }
    if (n !== 2 && n !== 3 && n !== 4) {
      n = (P && P.room && P.room.seats && P.room.seats.length) || 2;
    }
    if (n < 2) n = 2;
    if (n > 4) n = 4;
    return n;
  }

  function turnOf(P) {
    var r = (P && P.room) || {};
    var t = Number(r.turn);
    if (t > 0) return t;
    var st = stateOf(P);
    return st ? Number(st.turn) || 0 : 0;
  }

  function playerName(seat) {
    seat = seatNumber(seat);
    var P = S.ctx || {};
    var pools = [];
    if (P.room && P.room.seats) pools.push(P.room.seats);
    if (P.players) pools.push(P.players);
    for (var p = 0; p < pools.length; p++) {
      for (var i = 0; i < pools[p].length; i++) {
        var row = pools[p][i];
        if (seatNumber(row.seat) === seat) {
          return String(row.name || row.no || ('玩家 ' + seat));
        }
      }
    }
    return seat ? (seat + ' 号') : '玩家';
  }

  function canActNow() {
    var P = S.ctx;
    if (!P || S.busy) return false;
    if (seatNumber(P.seat) <= 0) return false;
    if (statusOf(P) !== 'play') return false;
    var st = stateOf(P);
    if (!st || st.status === 'over') return false;
    if (turnOf(P) !== seatNumber(P.seat)) return false;
    return !!pawnOf(st, P.seat);
  }

  function canShowClock() {
    if (!S.alive || S.busy) return false;
    var P = S.ctx;
    if (!P || statusOf(P) !== 'play') return false;
    if (seatNumber(P.seat) <= 0) return false;
    var st = stateOf(P);
    if (!st || st.status === 'over') return false;
    if (turnOf(P) !== seatNumber(P.seat)) return false;
    return !!pawnOf(st, P.seat);
  }

  function boardSig(st) {
    if (!st) return '';
    return JSON.stringify([
      st.n, st.status, st.turn, st.walls, st.pawns,
      st.wallsLeft, st.rank, st.order
    ]);
  }

  function clockKey(P) {
    var r = (P && P.room) || {};
    return String(r.seq == null ? '' : r.seq) + '|' +
      String(turnOf(P)) + '|' + boardSig(stateOf(P));
  }

  function baseStatus() {
    var P = S.ctx;
    if (!P) return '等待棋局…';
    var status = statusOf(P);
    var baseState = stateOf(P);
    if (status === 'wait') return '等房主开局（2-4 人）';
    if (status === 'over' || (baseState && baseState.status === 'over')) return '对局结束';
    if (S.busy) return '正在同步棋局…';
    var st = baseState;
    if (!st || !st.pawns) return '等待棋局同步…';
    var turn = turnOf(P);
    if (seatNumber(P.seat) === 0) return '观战中 · 轮到 ' + playerName(turn);
    if (!pawnOf(st, P.seat)) return '你已完赛，等其他人下完';
    if (turn === seatNumber(P.seat)) return '轮到你';
    return '轮到 ' + playerName(turn);
  }

  function refreshStatus(sec) {
    if (!S.statusEl) return;
    var text = baseStatus();
    S.statusEl.textContent = text;
    var running = typeof sec === 'number' && sec >= 0;
    if (S.clockEl) {
      S.clockEl.hidden = !running;
      if (running) {
        S.clockEl.textContent = sec + ' 秒';
        S.clockEl.className = 'qc-clock' + (sec <= 10 ? ' is-low' : '');
        S.clockEl.setAttribute('aria-label', '本回合还剩 ' + sec + ' 秒');
      } else {
        S.clockEl.textContent = '';
      }
    }
    pageStatus(text + (running ? ' · ' + sec + ' 秒' : ''));
  }

  function showClock(sec) {
    if (!S.clockEl) return;
    if (sec == null) {
      S.clockEl.hidden = true;
      S.clockEl.textContent = '';
      return;
    }
    S.clockEl.hidden = false;
    S.clockEl.textContent = sec + ' 秒';
    S.clockEl.className = 'qc-clock' + (sec <= 10 ? ' is-low' : '');
    S.clockEl.setAttribute('aria-label', '本回合还剩 ' + sec + ' 秒');
  }

  function stopClock() {
    if (S.clockTimer) {
      clearInterval(S.clockTimer);
      S.clockTimer = 0;
    }
    S.clockKey = '';
    S.deadline = 0;
    S.lastSec = null;
    S.timeoutKey = '';
    showClock(null);
  }

  function clockTick() {
    if (!S.alive) return;
    if (!canShowClock()) {
      showClock(null);
      return;
    }
    var sec = Math.max(0, Math.ceil((S.deadline - Date.now()) / 1000));
    if (sec !== S.lastSec) {
      S.lastSec = sec;
      showClock(sec);
      refreshStatus(sec);
    }
    if (sec <= 0 && !S.busy && S.timeoutKey !== S.clockKey) {
      S.timeoutKey = S.clockKey;
      sendTimeout();
    }
  }

  function syncClock() {
    if (!canShowClock()) {
      if (S.clockTimer) stopClock();
      showClock(null);
      refreshStatus(null);
      return;
    }
    var key = clockKey(S.ctx);
    if (key !== S.clockKey) {
      S.clockKey = key;
      S.deadline = Date.now() + 60000;
      S.lastSec = null;
      S.timeoutKey = '';
    }
    if (!S.clockTimer) {
      S.clockTimer = setInterval(clockTick, 250);
    }
    var sec = Math.max(0, Math.ceil((S.deadline - Date.now()) / 1000));
    S.lastSec = sec;
    showClock(sec);
    refreshStatus(sec);
    if (sec <= 0 && !S.busy && S.timeoutKey !== S.clockKey) {
      S.timeoutKey = S.clockKey;
      sendTimeout();
    }
  }

  function updateControls() {
    if (!S.modeBtn) return;
    var P = S.ctx;
    var st = stateOf(P);
    var can = canActNow();
    var walls = st ? wallLeftOf(st, P.seat) : 0;
    var myTurn = !!P && statusOf(P) === 'play' && turnOf(P) === seatNumber(P.seat);
    var pawn = st ? pawnOf(st, P.seat) : null;

    if (S.wallMode && (!can || !walls)) S.wallMode = false;
    if (!myTurn || !pawn) S.selected = null;
    S.canAct = can;

    S.modeBtn.disabled = !can || walls <= 0;
    S.modeBtn.textContent = walls <= 0 ? '墙用完了' : (S.wallMode ? '取消放墙' : '放墙（剩 ' + walls + '）');
    S.modeBtn.className = 'qc-btn qc-mode' + (S.wallMode ? ' is-on' : '');
    S.modeBtn.setAttribute('aria-pressed', S.wallMode ? 'true' : 'false');

    var dirDisabled = !can || !S.wallMode || walls <= 0;
    S.dirHBtn.disabled = dirDisabled;
    S.dirVBtn.disabled = dirDisabled;
    S.dirHBtn.className = 'qc-btn qc-dir' + (S.wallDir === 'h' ? ' is-on' : '');
    S.dirVBtn.className = 'qc-btn qc-dir' + (S.wallDir === 'v' ? ' is-on' : '');
    S.dirHBtn.setAttribute('aria-pressed', S.wallDir === 'h' ? 'true' : 'false');
    S.dirVBtn.setAttribute('aria-pressed', S.wallDir === 'v' ? 'true' : 'false');

    if (S.canvas) {
      S.canvas.className = 'qc-canvas' + (can ? ' is-act' : '') + (can && S.wallMode ? ' is-wall' : '');
    }

    var hint = '';
    var warn = false;
    var good = false;
    if (!P) {
      hint = '等待棋局同步…';
    } else if (statusOf(P) === 'wait') {
      hint = '等房主开局（2-4 人），不要自己开始。';
    } else if (statusOf(P) === 'over') {
      hint = '对局结束。名次在棋盘上。';
    } else if (S.busy) {
      hint = '这一步已经发出，等房间同步。';
    } else if (seatNumber(P.seat) === 0) {
      hint = '观战中，棋盘只读。';
    } else if (!st || !st.pawns) {
      hint = '正在同步棋局…';
    } else if (!pawn) {
      hint = '你已完赛，剩下的名次由其他人下出来。';
    } else if (!can) {
      hint = '轮到 ' + playerName(turnOf(P)) + '，先等一下。';
    } else if (S.wallMode) {
      hint = '在棋盘内 8×8 个交叉点放墙；不能和已有墙重叠，也不能封死任何人的路。';
      good = true;
    } else if (S.selected) {
      hint = '点高亮圆点落子：圆点=普通移动，圆圈=跳子。再点自己的棋子可取消。';
      good = true;
    } else {
      hint = '点自己的棋子，看能走到哪里；也可以点「放墙」堵路。';
    }

    S.hintEl.textContent = hint;
    S.hintEl.className = 'qc-hint' + (warn ? ' is-warn' : (good ? ' is-ok' : ''));
    drawBoard();
  }

  /* ---------- 侧栏 ---------- */

  function rosterSeats(P, st) {
    var source = (P.room && P.room.seats) || P.players || [];
    var out = [];
    var seen = {};
    for (var i = 0; i < source.length; i++) {
      var seat = seatNumber(source[i].seat);
      if (seat <= 0 || seat > 4 || seen[seat]) continue;
      seen[seat] = true;
      out.push({
        seat: seat,
        name: String(source[i].name || source[i].no || ('玩家 ' + seat)),
        alive: source[i].alive !== false
      });
    }
    if (!out.length && st && st.pawns) {
      for (var k = 0; k < st.pawns.length; k++) {
        var ps = seatNumber(st.pawns[k].seat);
        if (ps <= 0 || ps > 4 || seen[ps]) continue;
        seen[ps] = true;
        out.push({ seat: ps, name: '玩家 ' + ps, alive: true });
      }
    }
    out.sort(function (a, b) { return a.seat - b.seat; });
    return out;
  }

  function renderRoster(P, st, n, status, turn) {
    if (!S.rosterEl) return;
    S.rosterEl.innerHTML = '';
    var rows = rosterSeats(P, st);
    if (!rows.length) {
      var empty = el('p', 'qc-empty', '还没有人入座。');
      S.rosterEl.appendChild(empty);
      return;
    }
    var over = status === 'over' || (st && st.status === 'over');
    var rank = (st && st.rank) || [];
    var order = (st && st.order) || [];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var isTurn = status === 'play' && !over && turn === row.seat;
      var isMe = seatNumber(P.seat) === row.seat;
      var rp = rank.indexOf(row.seat);
      var place = rp >= 0 ? rp + 1 : 0;
      if (!place && over && order.indexOf(row.seat) >= 0) {
        place = n;
      }

      var node = el('div', 'qc-player' +
        (isTurn ? ' is-turn' : '') +
        (isMe ? ' is-me' : '') +
        (place ? ' is-done' : '') +
        (!row.alive ? ' is-dead' : ''));
      node.appendChild(el('span', 'qc-dot s' + row.seat, String(row.seat)));

      var main = el('div', 'qc-pmain');
      var nameLine = el('div', 'qc-pname');
      nameLine.appendChild(el('b', '', row.name));
      if (isMe) nameLine.appendChild(el('em', 'qc-you', '你'));
      main.appendChild(nameLine);
      main.appendChild(el('span', 'qc-pmeta',
        row.seat + ' 号 · 目标' + goalEdge(row.seat) +
        (!row.alive ? ' · 已离开' : '')));
      node.appendChild(main);

      var end = el('div', 'qc-pend');
      var hasCounts = !!(st && st.wallsLeft);
      var left = hasCounts ? wallLeftOf(st, row.seat) : wallsFor(n);
      var walls = el('span', 'qc-walls' + (hasCounts && left === 0 ? ' is-empty' : ''));
      var wallText = hasCounts ? String(left) : (status === 'wait' ? String(left) : '—');
      walls.appendChild(el('b', '', wallText));
      walls.appendChild(document.createTextNode(' 墙'));
      end.appendChild(walls);

      var badge = el('span', 'qc-place');
      if (place) {
        badge.textContent = '第 ' + place + ' 名';
        badge.className += ' is-rank';
      } else if (isTurn) {
        badge.textContent = isMe ? '该你了' : '行动中';
        badge.className += ' is-turn';
      } else if (status === 'wait') {
        badge.textContent = '等人';
      } else if (over) {
        badge.textContent = '';
      } else {
        badge.textContent = '等待';
      }
      if (badge.textContent) end.appendChild(badge);
      node.appendChild(end);
      S.rosterEl.appendChild(node);
    }
  }

  /* ---------- 结束/等待遮罩 ---------- */

  function rankPlaces(P, st, n, status) {
    var out = [];
    var seen = {};
    var rank = (st && st.rank) || [];
    var i, seat;
    for (i = 0; i < rank.length; i++) {
      seat = seatNumber(rank[i]);
      if (seat && !seen[seat]) { seen[seat] = true; out.push(seat); }
    }
    if (status === 'over' || (st && st.status === 'over')) {
      var order = (st && st.order) || [];
      for (i = 0; i < order.length; i++) {
        seat = seatNumber(order[i]);
        if (seat && !seen[seat]) { seen[seat] = true; out.push(seat); }
      }
      if (!out.length) {
        var rows = rosterSeats(P, st);
        for (i = 0; i < rows.length; i++) {
          if (!seen[rows[i].seat]) { seen[rows[i].seat] = true; out.push(rows[i].seat); }
        }
      }
    }
    return out;
  }

  function showWaitOverlay() {
    S.overlay.hidden = false;
    S.ovKicker.textContent = 'QUORIDOR · 9×9';
    S.ovTitle.textContent = '等房主开局（2-4 人）';
    S.ovSub.textContent = '人齐后由房主点「开始游戏」。';
    S.ovWait.hidden = false;
    S.ovWait.textContent = '这一局支持 2、3、4 人；2 人各 10 块墙，3-4 人各 5 块墙。';
    S.ovRank.hidden = true;
    S.ovRank.innerHTML = '';
  }

  function showSyncOverlay() {
    S.overlay.hidden = false;
    S.ovKicker.textContent = 'QUORIDOR · 9×9';
    S.ovTitle.textContent = '正在同步棋局';
    S.ovSub.textContent = '房间状态已经更新，棋盘还在路上。';
    S.ovWait.hidden = false;
    S.ovWait.textContent = '稍等一下，页面会自动刷新。';
    S.ovRank.hidden = true;
    S.ovRank.innerHTML = '';
  }

  function renderResult(P, st, n, status) {
    var over = status === 'over' || (st && st.status === 'over');
    if (!over) {
      S.overlay.hidden = true;
      return;
    }
    var places = rankPlaces(P, st, n, status);
    var room = (P && P.room) || {};
    var winner = seatNumber(room.winner) || seatNumber(st && st.winner) ||
      (places.length ? places[0] : 0);
    var myPlace = 0;
    for (var i = 0; i < places.length; i++) {
      if (places[i] === seatNumber(P.seat)) { myPlace = i + 1; break; }
    }
    var winnerName = winner ? playerName(winner) : '';

    S.overlay.hidden = false;
    S.ovKicker.textContent = 'QUORIDOR · 终局';
    S.ovTitle.textContent = myPlace === 1 ? '你赢了' :
      (winnerName ? winnerName + ' 获胜' : '对局结束');
    var sub = '';
    if (seatNumber(P.seat) > 0) {
      if (myPlace) sub += '你第 ' + myPlace + ' 名。';
      if (winner && winner !== seatNumber(P.seat) && winnerName) {
        sub += '冠军是 ' + winnerName + '。';
      }
    } else {
      sub = winnerName ? '观战结束，' + winnerName + ' 获胜。' : '观战结束。';
    }
    if (!sub) sub = '本局已结束。';
    S.ovSub.textContent = sub;
    S.ovWait.hidden = true;
    S.ovRank.hidden = false;
    S.ovRank.innerHTML = '';

    if (!places.length) {
      var p = el('li', 'qc-rank-row qc-empty', '名次还没同步出来。');
      S.ovRank.appendChild(p);
    } else {
      for (var k = 0; k < places.length; k++) {
        var seat = places[k];
        var row = el('li', 'qc-rank-row' + (seat === seatNumber(P.seat) ? ' is-me' : ''));
        row.appendChild(el('span', 'qc-rank-no', String(k + 1)));
        row.appendChild(el('span', 'qc-rank-name', playerName(seat)));
        if (seat === seatNumber(P.seat)) {
          row.appendChild(el('span', 'qc-rank-tag', '你'));
        } else if (seat === winner) {
          row.appendChild(el('span', 'qc-rank-tag', '冠军'));
        } else {
          row.appendChild(el('span', 'qc-rank-tag', '第 ' + (k + 1) + ' 名'));
        }
        S.ovRank.appendChild(row);
      }
    }
  }

  function updateOverlay(P, st, n, status) {
    if (status === 'wait') {
      showWaitOverlay();
      return;
    }
    if (status === 'over' || (st && st.status === 'over')) {
      renderResult(P, st, n, status);
      return;
    }
    if (!st || !st.pawns) {
      showSyncOverlay();
      return;
    }
    S.overlay.hidden = true;
  }

  /* ============================================================
     5. Canvas 绘制
     ============================================================ */

  function cssPalette() {
    var cs = null;
    try { cs = window.getComputedStyle(S.wrap); } catch (e) {}
    function get(name, fallback) {
      var v = cs ? cs.getPropertyValue(name) : '';
      v = v ? v.replace(/^\s+|\s+$/g, '') : '';
      return v || fallback;
    }
    return {
      board: get('--qc-board', '#fbf5e6'),
      board2: get('--qc-board-2', '#f3ead7'),
      alt: get('--qc-board-alt', 'rgba(163,50,40,.026)'),
      grid: get('--qc-grid', 'rgba(86,69,45,.16)'),
      edge: get('--qc-edge', 'rgba(86,69,45,.42)'),
      wall: get('--qc-wall', '#815d3d'),
      wallEdge: get('--qc-wall-edge', '#4f3823'),
      wallShadow: get('--qc-wall-shadow', 'rgba(74,50,27,.24)'),
      ok: get('--qc-ok', 'rgba(47,111,94,.68)'),
      bad: get('--qc-bad', 'rgba(193,82,47,.68)'),
      onSeat: get('--qc-on-seat', '#fff'),
      ring: get('--qc-pawn-ring', 'rgba(255,255,255,.58)'),
      p1: get('--qc-p1', '#c1522f'),
      p2: get('--qc-p2', '#2f6f5e'),
      p3: get('--qc-p3', '#ac7c25'),
      p4: get('--qc-p4', '#52618c'),
      serif: get('--serif', '"Songti SC",serif'),
      mono: get('--mono', 'Consolas,monospace')
    };
  }

  function roundRect(g, x, y, w, h, r) {
    if (w < 0) { x += w; w = -w; }
    if (h < 0) { y += h; h = -h; }
    if (r > w / 2) r = w / 2;
    if (r > h / 2) r = h / 2;
    if (!r || r < 0) { g.rect(x, y, w, h); return; }
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  function wallRect(w, geom) {
    var cell = geom.cell;
    var cx = geom.pad + (Number(w.x) + 1) * cell;
    var cy = geom.pad + (Number(w.y) + 1) * cell;
    var len = cell * 2 - cell * 0.23;
    var thick = cell * 0.15;
    if (String(w.dir).toLowerCase() === 'h') {
      return { x: cx - len / 2, y: cy - thick / 2, w: len, h: thick, r: thick / 2 };
    }
    return { x: cx - thick / 2, y: cy - len / 2, w: thick, h: len, r: thick / 2 };
  }

  function seatColor(pal, seat) {
    if (seat === 1) return pal.p1;
    if (seat === 2) return pal.p2;
    if (seat === 3) return pal.p3;
    if (seat === 4) return pal.p4;
    return pal.p1;
  }

  function drawBoard() {
    if (!S.canvas || !S.boardWrap) return;
    var cssW = S.boardWrap.clientWidth || 0;
    if (cssW < 140) cssW = 480;
    var size = Math.min(640, cssW);
    var dpr = window.devicePixelRatio || 1;
    if (dpr < 1) dpr = 1;
    if (dpr > 3) dpr = 3;
    var px = Math.max(1, Math.round(size * dpr));
    if (S.canvas.width !== px || S.canvas.height !== px) {
      S.canvas.width = px;
      S.canvas.height = px;
    }
    var g = S.canvas.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, size, size);

    var pad = Math.max(15, Math.min(32, size * 0.05));
    var cell = (size - pad * 2) / N;
    var geom = { size: size, pad: pad, cell: cell };
    S.geom = geom;

    var pal = cssPalette();

    // 纸面
    var outer = Math.max(4, pad * 0.42);
    var grad = g.createLinearGradient(0, 0, size, size);
    grad.addColorStop(0, pal.board);
    grad.addColorStop(1, pal.board2);
    roundRect(g, outer, outer, size - outer * 2, size - outer * 2, 11);
    g.fillStyle = grad;
    g.fill();
    g.strokeStyle = pal.edge;
    g.lineWidth = 1;
    g.stroke();

    // 棋格
    for (var cy = 0; cy < N; cy++) {
      for (var cx = 0; cx < N; cx++) {
        if ((cx + cy) % 2 === 0) continue;
        g.fillStyle = pal.alt;
        g.fillRect(pad + cx * cell, pad + cy * cell, cell, cell);
      }
    }

    // 网格
    g.beginPath();
    for (var gi = 0; gi <= N; gi++) {
      var gp = pad + gi * cell;
      g.moveTo(gp, pad);
      g.lineTo(gp, pad + N * cell);
      g.moveTo(pad, gp);
      g.lineTo(pad + N * cell, gp);
    }
    g.strokeStyle = pal.grid;
    g.lineWidth = Math.max(0.6, cell * 0.018);
    g.stroke();

    // 目标边：每条边用对应座位的颜色标出来
    var st = stateOf(S.ctx);
    var n = gameN(S.ctx);
    for (var seat = 1; seat <= n; seat++) {
      if (!SEATS[seat]) continue;
      g.save();
      g.strokeStyle = seatColor(pal, seat);
      g.globalAlpha = 0.74;
      g.lineWidth = Math.max(2.2, cell * 0.07);
      g.lineCap = 'round';
      if (seat === 1) {
        g.beginPath(); g.moveTo(pad + cell * 0.18, pad + 1.3); g.lineTo(pad + N * cell - cell * 0.18, pad + 1.3); g.stroke();
      } else if (seat === 2) {
        g.beginPath(); g.moveTo(pad + cell * 0.18, pad + N * cell - 1.3); g.lineTo(pad + N * cell - cell * 0.18, pad + N * cell - 1.3); g.stroke();
      } else if (seat === 3) {
        g.beginPath(); g.moveTo(pad + N * cell - 1.3, pad + cell * 0.18); g.lineTo(pad + N * cell - 1.3, pad + N * cell - cell * 0.18); g.stroke();
      } else if (seat === 4) {
        g.beginPath(); g.moveTo(pad + 1.3, pad + cell * 0.18); g.lineTo(pad + 1.3, pad + N * cell - cell * 0.18); g.stroke();
      }
      g.restore();
    }

    // 可落墙的 64 个交叉点
    if (S.canAct && S.wallMode) {
      g.save();
      g.fillStyle = pal.edge;
      g.globalAlpha = 0.62;
      for (var wy = 0; wy < 8; wy++) {
        for (var wx = 0; wx < 8; wx++) {
          var ix = pad + (wx + 1) * cell;
          var iy = pad + (wy + 1) * cell;
          g.beginPath();
          g.arc(ix, iy, Math.max(1.5, cell * 0.038), 0, Math.PI * 2);
          g.fill();
        }
      }
      g.restore();
    }

    // 落墙预览
    if (S.hoverWall && S.canAct && S.wallMode) {
      var ghost = wallRect(S.hoverWall, geom);
      g.save();
      g.globalAlpha = 0.28;
      g.fillStyle = S.hoverOk ? pal.ok : pal.bad;
      roundRect(g, ghost.x, ghost.y, ghost.w, ghost.h, ghost.r);
      g.fill();
      g.globalAlpha = 0.86;
      g.strokeStyle = S.hoverOk ? pal.ok : pal.bad;
      g.lineWidth = 1.4;
      g.setLineDash([3, 3]);
      roundRect(g, ghost.x, ghost.y, ghost.w, ghost.h, ghost.r);
      g.stroke();
      g.restore();
    }

    // 已经放下的墙
    var walls = (st && st.walls) || [];
    for (var wi = 0; wi < walls.length; wi++) {
      var wall = walls[wi];
      if (!wall) continue;
      var wr = wallRect(wall, geom);
      g.save();
      g.shadowColor = pal.wallShadow;
      g.shadowBlur = Math.max(2, cell * 0.10);
      g.shadowOffsetY = Math.max(1, cell * 0.035);
      roundRect(g, wr.x, wr.y, wr.w, wr.h, wr.r);
      g.fillStyle = pal.wall;
      g.fill();
      g.restore();
      roundRect(g, wr.x, wr.y, wr.w, wr.h, wr.r);
      g.strokeStyle = pal.wallEdge;
      g.lineWidth = Math.max(1, cell * 0.018);
      g.stroke();
    }

    // 可走点
    var mySeat = S.ctx ? seatNumber(S.ctx.seat) : 0;
    if (S.selected && st && S.canAct) {
      var moves = legalMoves(st, mySeat);
      var color = seatColor(pal, mySeat);
      for (var mi = 0; mi < moves.length; mi++) {
        var mv = moves[mi];
        var mx = pad + (mv.x + 0.5) * cell;
        var my = pad + (mv.y + 0.5) * cell;
        g.save();
        if (mv.type === 'move') {
          g.globalAlpha = 0.62;
          g.fillStyle = color;
          g.beginPath();
          g.arc(mx, my, Math.max(4, cell * 0.12), 0, Math.PI * 2);
          g.fill();
          g.globalAlpha = 0.32;
          g.strokeStyle = color;
          g.lineWidth = 1.2;
          g.beginPath();
          g.arc(mx, my, Math.max(5, cell * 0.165), 0, Math.PI * 2);
          g.stroke();
        } else {
          g.globalAlpha = 0.82;
          g.strokeStyle = color;
          g.lineWidth = Math.max(1.6, cell * 0.045);
          g.beginPath();
          g.arc(mx, my, Math.max(6, cell * 0.19), 0, Math.PI * 2);
          g.stroke();
          g.globalAlpha = 0.38;
          g.fillStyle = color;
          g.beginPath();
          g.arc(mx, my, Math.max(2.2, cell * 0.062), 0, Math.PI * 2);
          g.fill();
        }
        g.restore();
      }
    }

    // 棋子
    var pawns = (st && st.pawns) || [];
    for (var pi = 0; pi < pawns.length; pi++) {
      var pawn = pawns[pi];
      if (!pawn) continue;
      var pseat = seatNumber(pawn.seat);
      var pxx = pad + (Number(pawn.x) + 0.5) * cell;
      var pyy = pad + (Number(pawn.y) + 0.5) * cell;
      var pr = Math.max(8, cell * 0.305);
      var turn = turnOf(S.ctx);
      var isTurn = statusOf(S.ctx) === 'play' && turn === pseat;
      var selected = S.selected && mySeat === pseat &&
        S.selected.x === Number(pawn.x) && S.selected.y === Number(pawn.y);

      g.save();
      if (isTurn) {
        g.globalAlpha = 0.22;
        g.fillStyle = seatColor(pal, pseat);
        g.beginPath();
        g.arc(pxx, pyy, pr * 1.34, 0, Math.PI * 2);
        g.fill();
        g.globalAlpha = 1;
      }
      g.shadowColor = 'rgba(20,18,14,.26)';
      g.shadowBlur = Math.max(2, cell * 0.10);
      g.shadowOffsetY = Math.max(1, cell * 0.045);
      g.fillStyle = seatColor(pal, pseat);
      g.beginPath();
      g.arc(pxx, pyy, pr, 0, Math.PI * 2);
      g.fill();
      g.restore();

      g.strokeStyle = pal.ring;
      g.lineWidth = Math.max(1, cell * 0.025);
      g.beginPath();
      g.arc(pxx, pyy, pr - Math.max(0.6, cell * 0.012), 0, Math.PI * 2);
      g.stroke();

      if (selected) {
        g.save();
        g.strokeStyle = '#c08c2c';
        g.lineWidth = Math.max(2, cell * 0.055);
        g.beginPath();
        g.arc(pxx, pyy, pr + Math.max(3, cell * 0.10), 0, Math.PI * 2);
        g.stroke();
        g.restore();
      }

      g.fillStyle = pal.onSeat;
      g.font = '700 ' + Math.round(Math.max(10, cell * 0.34)) + 'px ' + pal.serif;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(String(pseat), pxx, pyy + cell * 0.012);
    }

    // 无障碍描述
    var desc = '步步为营九乘九棋盘。';
    if (st && st.pawns) {
      for (var ai = 0; ai < st.pawns.length; ai++) {
        desc += ' ' + st.pawns[ai].seat + ' 号在 (' + st.pawns[ai].x + ',' + st.pawns[ai].y + ')。';
      }
    }
    if (S.statusEl) desc += ' ' + S.statusEl.textContent;
    S.canvas.setAttribute('aria-label', desc);
  }

  /* ============================================================
     6. 坐标映射与交互
     ============================================================ */

  function eventPoint(ev) {
    if (!S.canvas || !S.geom) return null;
    var rect = S.canvas.getBoundingClientRect();
    if (!rect || !rect.width) return null;
    var scale = S.geom.size / rect.width;
    return {
      x: (ev.clientX - rect.left) * scale,
      y: (ev.clientY - rect.top) * scale
    };
  }

  function cellAt(pt) {
    if (!pt || !S.geom) return null;
    var g = S.geom;
    var x = Math.floor((pt.x - g.pad) / g.cell);
    var y = Math.floor((pt.y - g.pad) / g.cell);
    if (x < 0 || x >= N || y < 0 || y >= N) return null;
    return { x: x, y: y };
  }

  function wallAt(pt) {
    if (!pt || !S.geom) return null;
    var g = S.geom;
    var right = g.pad + N * g.cell;
    if (pt.x < g.pad || pt.x > right || pt.y < g.pad || pt.y > right) return null;
    var ax = Math.round((pt.x - g.pad) / g.cell) - 1;
    var ay = Math.round((pt.y - g.pad) / g.cell) - 1;
    if (ax < 0) ax = 0;
    if (ay < 0) ay = 0;
    if (ax > 7) ax = 7;
    if (ay > 7) ay = 7;
    return { x: ax, y: ay, dir: S.wallDir };
  }

  function findMove(st, seat, x, y) {
    var moves = legalMoves(st, seat);
    for (var i = 0; i < moves.length; i++) {
      if (moves[i].x === x && moves[i].y === y) return moves[i];
    }
    return null;
  }

  function turnOptions(st) {
    var opts = { turn: st.turn };
    if (st.status === 'over') {
      opts.status = 'over';
      opts.winner = st.winner;
    }
    return opts;
  }

  function sendGame(action, next, opts) {
    if (!S.ctx || S.busy) return;
    var sentWith = S.ctx;
    S.busy = true;
    S.selected = null;
    S.hoverWall = null;
    stopClock();
    updateControls();
    refreshStatus(null);

    var send;
    try {
      send = sentWith.send(action, next, opts || {});
    } catch (e) {
      if (S.ctx !== sentWith) return;
      S.busy = false;
      S.clockKey = '';
      render();
      b8Toast('这一步没发出去：' + ((e && e.message) || '网络异常'));
      return;
    }

    if (S.sendGuard) clearTimeout(S.sendGuard);
    S.sendGuard = setTimeout(function () {
      S.sendGuard = 0;
      if (!S.alive) return;
      S.busy = false;
      S.clockKey = '';
      render();
      b8Toast('房间同步有点慢，先重新看一眼棋局。');
    }, 15000);

    if (!send || typeof send.then !== 'function') {
      S.busy = false;
      S.clockKey = '';
      render();
      return;
    }

    send.then(function () {
      if (!S.alive || S.ctx !== sentWith) return;
      if (!S.busy) return;
      if (S.ctx && typeof S.ctx.refresh === 'function') {
        try {
          var p = S.ctx.refresh();
          if (p && typeof p.catch === 'function') p.catch(function () {});
        } catch (e2) {}
      } else {
        if (S.sendGuard) { clearTimeout(S.sendGuard); S.sendGuard = 0; }
        S.busy = false;
        S.clockKey = '';
        render();
      }
    }).catch(function (err) {
      if (!S.alive || S.ctx !== sentWith) return;
      if (S.sendGuard) { clearTimeout(S.sendGuard); S.sendGuard = 0; }
      S.busy = false;
      S.clockKey = '';
      render();
      b8Toast('这一步没发出去：' + ((err && err.message) || '网络异常'));
    });
  }

  function sendTimeout() {
    var P = S.ctx;
    var st = stateOf(P);
    if (!canActNow() || !st) return;
    var ns = cloneState(st);
    ns.turn = nextSeatInOrder(ns.order, P.seat);
    if (!ns.order.length) ns.turn = 0;
    b8Toast('60 秒到了，自动过一手。');
    sendGame({ type: 'timeout' }, ns, turnOptions(ns));
  }

  function commitMove(target) {
    var P = S.ctx;
    var st = stateOf(P);
    if (!st) return;
    var next = moveTo(st, P.seat, target.x, target.y);
    if (!next) { b8Toast('这个走法现在不合法。'); return; }
    sendGame({
      type: 'move',
      seat: seatNumber(P.seat),
      x: target.x,
      y: target.y
    }, next, turnOptions(next));
  }

  function commitWall(wall) {
    var P = S.ctx;
    var st = stateOf(P);
    if (!st) return;
    if (wallLeftOf(st, P.seat) <= 0) {
      b8Toast('墙用完了，这一回合只能走棋。');
      return;
    }
    var check = canPlaceWall(st, wall);
    if (!check.ok) { b8Toast(check.why || '这里不能放墙。'); return; }
    var next = placeWall(st, P.seat, wall);
    if (!next) { b8Toast('这里不能放墙。'); return; }
    sendGame({
      type: 'wall',
      seat: seatNumber(P.seat),
      wall: { x: wall.x, y: wall.y, dir: wall.dir }
    }, next, turnOptions(next));
  }

  function canOperateByClick() {
    var P = S.ctx;
    if (!P) return false;
    if (S.busy) { b8Toast('正在同步，稍等一下。'); return false; }
    if (statusOf(P) === 'wait') { b8Toast('等房主开局（2-4 人）。'); return false; }
    var st = stateOf(P);
    if (statusOf(P) === 'over' || (st && st.status === 'over')) {
      b8Toast('对局已经结束。');
      return false;
    }
    if (seatNumber(P.seat) === 0) { b8Toast('观战中，棋盘只读。'); return false; }
    if (!st || !st.pawns) { b8Toast('棋局还没同步好。'); return false; }
    if (!pawnOf(st, P.seat)) { b8Toast('你已完赛，等其他人下完。'); return false; }
    if (turnOf(P) !== seatNumber(P.seat)) {
      b8Toast('还没轮到你，现在是 ' + playerName(turnOf(P)) + '。');
      return false;
    }
    return true;
  }

  function onCanvasClick(ev) {
    if (!S.alive) return;
    if (!canOperateByClick()) return;
    var P = S.ctx;
    var st = stateOf(P);
    var pt = eventPoint(ev);
    if (!pt) return;

    if (S.wallMode) {
      var wall = wallAt(pt);
      if (!wall) return;
      if (wallLeftOf(st, P.seat) <= 0) {
        b8Toast('墙用完了，只能走棋。');
        S.wallMode = false;
        updateControls();
        return;
      }
      var check = canPlaceWall(st, wall);
      if (!check.ok) {
        b8Toast(check.why || '这里不能放墙。');
        return;
      }
      commitWall(wall);
      return;
    }

    var cell = cellAt(pt);
    if (!cell) return;
    var pawn = pawnOf(st, P.seat);
    if (cell.x === Number(pawn.x) && cell.y === Number(pawn.y)) {
      if (S.selected) {
        S.selected = null;
      } else {
        S.selected = { x: cell.x, y: cell.y };
      }
      S.hoverWall = null;
      updateControls();
      return;
    }

    if (!S.selected) {
      if (pawnAt(st, cell.x, cell.y)) b8Toast('先点自己的棋子，再选落点。');
      return;
    }

    var mv = findMove(st, P.seat, cell.x, cell.y);
    if (mv) {
      commitMove(mv);
      return;
    }
    if (pawnAt(st, cell.x, cell.y)) {
      b8Toast('不能落在别的棋子上；正面贴着时可以跳过去。');
    } else {
      b8Toast('这一步走不了：只能上下左右一格，或者按规则跳子。');
    }
  }

  function onCanvasMove(ev) {
    if (!S.alive) return;
    if (!S.canAct || !S.wallMode) {
      if (S.hoverWall) {
        S.hoverWall = null;
        S.hoverOk = false;
        drawBoard();
      }
      return;
    }
    var pt = eventPoint(ev);
    var wall = wallAt(pt);
    if (!wall) {
      if (S.hoverWall) {
        S.hoverWall = null;
        S.hoverOk = false;
        drawBoard();
      }
      return;
    }
    if (S.hoverWall && S.hoverWall.x === wall.x &&
        S.hoverWall.y === wall.y && S.hoverWall.dir === wall.dir) return;
    S.hoverWall = wall;
    var check = canPlaceWall(stateOf(S.ctx), wall);
    S.hoverOk = check.ok;
    drawBoard();
  }

  function onCanvasLeave() {
    if (!S.alive) return;
    if (!S.hoverWall) return;
    S.hoverWall = null;
    S.hoverOk = false;
    drawBoard();
  }

  function toggleWallMode() {
    if (!canActNow()) {
      var P = S.ctx;
      if (!P) return;
      if (statusOf(P) === 'wait') b8Toast('等房主开局（2-4 人）。');
      else if (statusOf(P) === 'over') b8Toast('对局已经结束。');
      else if (seatNumber(P.seat) === 0) b8Toast('观战中，不能放墙。');
      else if (!pawnOf(stateOf(P), P.seat)) b8Toast('你已完赛。');
      else b8Toast('还没轮到你。');
      return;
    }
    var st = stateOf(S.ctx);
    if (wallLeftOf(st, S.ctx.seat) <= 0) {
      b8Toast('墙用完了，只能走棋。');
      return;
    }
    S.wallMode = !S.wallMode;
    S.selected = null;
    S.hoverWall = null;
    updateControls();
  }

  function setWallDir(dir) {
    if (!canActNow()) {
      b8Toast('还没轮到你。');
      return;
    }
    var st = stateOf(S.ctx);
    if (wallLeftOf(st, S.ctx.seat) <= 0) {
      b8Toast('墙用完了，只能走棋。');
      return;
    }
    S.wallDir = dir;
    S.wallMode = true;
    S.selected = null;
    S.hoverWall = null;
    updateControls();
  }

  /* ============================================================
     7. 渲染、挂载、销毁
     ============================================================ */

  function render() {
    if (!S.alive || !S.ctx || !S.root) return;
    var P = S.ctx;
    var st = stateOf(P);
    var status = statusOf(P);
    var n = gameN(P);
    var turn = turnOf(P);
    var over = status === 'over' || (st && st.status === 'over');

    if (!canActNow()) S.selected = null;
    renderRoster(P, st, n, status, turn);
    updateOverlay(P, st, n, status);
    updateControls();
    syncClock();
    if (over) pageStatus('对局结束');
    if (S.foot) {
      S.foot.textContent = '9×9 · 目标对面边线 · 墙：2 人各 10，3-4 人各 5 · 不能封死任何人的路';
    }
  }

  function scheduleDraw() {
    if (!S.alive) return;
    if (S.resizeTimer) clearTimeout(S.resizeTimer);
    S.resizeTimer = setTimeout(function () {
      S.resizeTimer = 0;
      if (S.alive) drawBoard();
    }, 80);
  }

  function onCtxChange(next) {
    if (!S.alive || !next) return;
    var oldSeat = S.ctx ? seatNumber(S.ctx.seat) : 0;
    var oldSig = boardSig(stateOf(S.ctx));
    var newSig = boardSig(stateOf(next));
    var changed = oldSig !== newSig ||
      oldSeat !== seatNumber(next.seat) ||
      !S.ctx ||
      statusOf(S.ctx) !== statusOf(next);
    S.ctx = next;
    if (changed) {
      S.busy = false;
      if (S.sendGuard) { clearTimeout(S.sendGuard); S.sendGuard = 0; }
      S.selected = null;
      S.hoverWall = null;
      S.hoverOk = false;
    }
    render();
  }

  function buildUi() {
    ensureStyle();
    S.root.innerHTML = '';

    S.wrap = el('div', 'qc-wrap');
    var head = el('div', 'qc-head');
    var hleft = el('div', '');
    hleft.appendChild(el('p', 'qc-kicker', 'QUORIDOR · 9×9'));
    var h = el('h2', 'qc-title', '步步为营');
    hleft.appendChild(h);
    hleft.appendChild(el('p', 'qc-sub', '2-4 人 · 放墙堵路'));
    head.appendChild(hleft);

    S.statusBar = el('div', 'qc-statusbar');
    S.statusEl = el('span', 'qc-status', '等待棋局…');
    S.statusEl.setAttribute('role', 'status');
    S.statusEl.setAttribute('aria-live', 'polite');
    S.clockEl = el('span', 'qc-clock', '');
    S.clockEl.hidden = true;
    S.statusBar.appendChild(S.statusEl);
    S.statusBar.appendChild(S.clockEl);
    head.appendChild(S.statusBar);
    S.wrap.appendChild(head);

    var shell = el('div', 'qc-shell');
    S.boardBox = el('div', 'qc-boardbox');
    S.boardWrap = el('div', 'qc-boardwrap');
    S.canvas = document.createElement('canvas');
    S.canvas.className = 'qc-canvas';
    S.canvas.setAttribute('role', 'img');
    S.canvas.setAttribute('aria-label', '步步为营棋盘');
    S.boardWrap.appendChild(S.canvas);
    S.boardBox.appendChild(S.boardWrap);

    S.overlay = el('div', 'qc-overlay');
    S.overlay.hidden = true;
    var ovIn = el('div', 'qc-overlay-in');
    S.ovKicker = el('p', 'qc-ov-kicker', 'QUORIDOR');
    S.ovTitle = el('h3', 'qc-ov-title', '');
    S.ovSub = el('p', 'qc-ov-sub', '');
    S.ovWait = el('p', 'qc-ov-wait', '');
    S.ovWait.hidden = true;
    S.ovRank = el('ol', 'qc-rank-list', '');
    S.ovRank.hidden = true;
    ovIn.appendChild(S.ovKicker);
    ovIn.appendChild(S.ovTitle);
    ovIn.appendChild(S.ovSub);
    ovIn.appendChild(S.ovWait);
    ovIn.appendChild(S.ovRank);
    S.overlay.appendChild(ovIn);
    S.boardBox.appendChild(S.overlay);
    shell.appendChild(S.boardBox);

    var side = el('aside', 'qc-side');
    var rosterBox = el('div', '');
    var rosterHead = el('div', 'qc-roster-head');
    rosterHead.appendChild(el('b', '', '座位'));
    rosterHead.appendChild(el('span', '', '顺时针'));
    rosterBox.appendChild(rosterHead);
    S.rosterEl = el('div', 'qc-roster');
    rosterBox.appendChild(S.rosterEl);
    side.appendChild(rosterBox);

    var controls = el('div', 'qc-controls');
    controls.appendChild(el('p', 'qc-controls-title', '操作'));
    var btns = el('div', 'qc-btns');
    S.modeBtn = el('button', 'qc-btn qc-mode', '放墙');
    S.modeBtn.type = 'button';
    S.modeBtn.setAttribute('aria-pressed', 'false');
    S.dirHBtn = el('button', 'qc-btn qc-dir', '横墙');
    S.dirHBtn.type = 'button';
    S.dirHBtn.setAttribute('aria-pressed', 'false');
    S.dirVBtn = el('button', 'qc-btn qc-dir', '竖墙');
    S.dirVBtn.type = 'button';
    S.dirVBtn.setAttribute('aria-pressed', 'false');
    btns.appendChild(S.modeBtn);
    btns.appendChild(S.dirHBtn);
    btns.appendChild(S.dirVBtn);
    controls.appendChild(btns);
    S.hintEl = el('p', 'qc-hint', '点自己的棋子，看能走到哪里。');
    controls.appendChild(S.hintEl);
    side.appendChild(controls);

    S.foot = el('p', 'qc-foot', '');
    side.appendChild(S.foot);
    shell.appendChild(side);
    S.wrap.appendChild(shell);

    S.root.appendChild(S.wrap);

    S.modeBtn.addEventListener('click', toggleWallMode);
    S.dirHBtn.addEventListener('click', function () { setWallDir('h'); });
    S.dirVBtn.addEventListener('click', function () { setWallDir('v'); });
    S.canvas.addEventListener('click', onCanvasClick);
    S.canvas.addEventListener('mousemove', onCanvasMove);
    S.canvas.addEventListener('mouseleave', onCanvasLeave);
  }

  function mount(root, ctx) {
    if (!root || !document) return;
    S = {
      alive: true,
      root: root,
      ctx: ctx || null,
      selected: null,
      wallMode: false,
      wallDir: 'h',
      hoverWall: null,
      hoverOk: false,
      busy: false,
      canAct: false,
      clockTimer: 0,
      clockKey: '',
      deadline: 0,
      lastSec: null,
      timeoutKey: '',
      sendGuard: 0,
      resizeTimer: 0,
      initialTimer: 0,
      lastPageStatus: '',
      unsub: null
    };

    buildUi();

    S.onResize = scheduleDraw;
    window.addEventListener('resize', S.onResize);
    S.onTheme = function () { if (S.alive) drawBoard(); };
    document.addEventListener('b8:theme', S.onTheme);

    if (ctx && typeof ctx.onChange === 'function') {
      S.unsub = ctx.onChange(onCtxChange);
    }

    render();
    // 等外壳把舞台排好版后再量一次宽度
    S.initialTimer = setTimeout(function () {
      S.initialTimer = 0;
      if (S.alive) drawBoard();
    }, 40);
  }

  function destroy() {
    if (!S || !S.alive) return;
    S.alive = false;
    if (S.unsub) {
      try { S.unsub(); } catch (e) {}
      S.unsub = null;
    }
    if (S.clockTimer) {
      clearInterval(S.clockTimer);
      S.clockTimer = 0;
    }
    if (S.sendGuard) {
      clearTimeout(S.sendGuard);
      S.sendGuard = 0;
    }
    if (S.resizeTimer) {
      clearTimeout(S.resizeTimer);
      S.resizeTimer = 0;
    }
    if (S.initialTimer) {
      clearTimeout(S.initialTimer);
      S.initialTimer = 0;
    }
    if (S.onResize) {
      try { window.removeEventListener('resize', S.onResize); } catch (e) {}
      S.onResize = null;
    }
    if (S.onTheme) {
      try { document.removeEventListener('b8:theme', S.onTheme); } catch (e) {}
      S.onTheme = null;
    }
    if (S.canvas) {
      try {
        S.canvas.removeEventListener('click', onCanvasClick);
        S.canvas.removeEventListener('mousemove', onCanvasMove);
        S.canvas.removeEventListener('mouseleave', onCanvasLeave);
      } catch (e) {}
    }
    if (S.root) S.root.innerHTML = '';
    S.root = null;
    S.canvas = null;
    S.ctx = null;
  }

  /* ============================================================
     8. 模块导出
     ============================================================ */

  A.games.quoridor = {
    key: 'quoridor',
    title: '步步为营',
    icon: '墙',
    sub: '2-4 人 · 放墙堵路',
    mode: 'multi',
    // 契约里 seats 写作 [2, 4]（人数区间）；真正支持 2/3/4 人。
    seats: [2, 4],
    minSeats: 2,
    maxSeats: 4,
    mount: mount,
    destroy: destroy,
    _test: {
      init: init,
      legalMoves: legalMoves,
      pathLen: pathLen,
      canPlaceWall: canPlaceWall,
      placeWall: placeWall,
      moveTo: moveTo,
      goalOf: goalOf,
      wallsFor: wallsFor
    }
  };
})();
