/* ============================================================
   B8 · 棋类规则引擎（中国象棋 / 国际象棋 / 围棋 / 五子棋 / 国际跳棋）
   ------------------------------------------------------------
   纯函数式：init() 出初始局面，moves() 出全部合法着法，
   apply() 返回新局面（不修改传入对象）。浏览器挂到 B8.boardEngine，
   Node 里 module.exports，方便脱离页面跑规则自检。

   局面对象（JSON 可存库）：
     { v, game, size, board:[int], turn:1|2, status:'play'|'over',
       winner:0|1|2|3, reason, seq, last, caps:[n,n], ... }
     turn / winner：1 = 先手（象棋红、国象白、围棋黑、五子黑、跳棋白），
                     2 = 后手；0 = 未分；3 = 和棋。
   ============================================================ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') {
    window.B8 = window.B8 || {};
    window.B8.boardEngine = api;
  }
})(this, function () {
  'use strict';

  var E = { version: 1, games: {} };

  /* ---------- 小工具 ---------- */
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function inb(x, y, w, h) { return x >= 0 && y >= 0 && x < w && y < h; }
  function ix(x, y, w) { return y * w + x; }
  function un(i, w) { return [i % w, Math.floor(i / w)]; }
  function colorOf(p) { return p === 0 ? 0 : (p < 8 ? 1 : 2); }
  function typeOf(p) { return p === 0 ? 0 : (p < 8 ? p : p - 8); }
  function mk(game, size, board, turn, extra) {
    var st = {
      v: 1, game: game, size: size, board: board, turn: turn || 1,
      status: 'play', winner: 0, reason: '', seq: 0, last: null,
      caps: [0, 0], half: 0
    };
    if (extra) for (var k in extra) if (extra.hasOwnProperty(k)) st[k] = extra[k];
    return st;
  }
  function other(c) { return c === 1 ? 2 : 1; }

  /* ============================================================
     一、围棋
     ============================================================ */
  function goGroup(b, size, start) {
    var color = b[start], stack = [start], seen = {}, stones = [], libs = {};
    seen[start] = 1;
    while (stack.length) {
      var i = stack.pop(), p = un(i, size), x = p[0], y = p[1];
      stones.push(i);
      var nb = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]];
      for (var k = 0; k < 4; k++) {
        var nx = nb[k][0], ny = nb[k][1];
        if (!inb(nx, ny, size, size)) continue;
        var j = ny * size + nx;
        if (b[j] === 0) libs[j] = 1;
        else if (b[j] === color && !seen[j]) { seen[j] = 1; stack.push(j); }
      }
    }
    return { stones: stones, libs: Object.keys(libs).map(Number) };
  }

  // 试下一子；返回 {board, caps, ko}，非法（自杀）返回 null
  function goTry(st, i, color) {
    var size = st.size, b = st.board.slice(), caps = [];
    b[i] = color;
    var nb = [[i % size - 1, Math.floor(i / size)], [i % size + 1, Math.floor(i / size)],
              [i % size, Math.floor(i / size) - 1], [i % size, Math.floor(i / size) + 1]];
    for (var k = 0; k < 4; k++) {
      var x = nb[k][0], y = nb[k][1];
      if (!inb(x, y, size, size)) continue;
      var j = y * size + x;
      if (b[j] !== 0 && b[j] !== color) {
        var g = goGroup(b, size, j);
        if (!g.libs.length) {
          for (var s = 0; s < g.stones.length; s++) { b[g.stones[s]] = 0; caps.push(g.stones[s]); }
        }
      }
    }
    var own = goGroup(b, size, i);
    if (!own.libs.length) return null;
    var ko = -1;
    if (caps.length === 1 && own.stones.length === 1 && own.libs.length === 1) ko = caps[0];
    return { board: b, caps: caps, ko: ko };
  }

  function goScore(st) {
    var size = st.size, b = st.board, n = size * size;
    var seen = {}, points = [], terr = [0, 0], neutral = 0, i, j;
    for (i = 0; i < n; i++) points.push(b[i] || 0);
    for (i = 0; i < n; i++) {
      if (b[i] !== 0 || seen[i]) continue;
      var stack = [i], region = [], borders = {}, k;
      seen[i] = 1;
      while (stack.length) {
        var cur = stack.pop(); region.push(cur);
        var p = un(cur, size), x = p[0], y = p[1];
        var nb = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]];
        for (k = 0; k < 4; k++) {
          var nx = nb[k][0], ny = nb[k][1];
          if (!inb(nx, ny, size, size)) continue;
          j = ny * size + nx;
          if (b[j] === 0) { if (!seen[j]) { seen[j] = 1; stack.push(j); } }
          else borders[b[j]] = 1;
        }
      }
      var keys = Object.keys(borders);
      if (keys.length === 1) {
        var owner = Number(keys[0]);
        for (k = 0; k < region.length; k++) points[region[k]] = owner;
        terr[owner - 1] += region.length;
      } else {
        neutral += region.length;
      }
    }
    var stones = [0, 0];
    for (i = 0; i < n; i++) if (b[i]) stones[b[i] - 1]++;
    var komi = st.komi == null ? 7.5 : st.komi;
    var black = stones[0] + terr[0];
    var white = stones[1] + terr[1] + komi;
    return {
      black: black, white: white, stones: stones, terr: terr, neutral: neutral,
      komi: komi, diff: black - white, points: points,
      winner: black > white ? 1 : (white > black ? 2 : 0)
    };
  }

  var goCoordLetters = 'ABCDEFGHJKLMNOPQRSTUVWXYZ';
  function goCoord(idx, size) {
    var x = idx % size, y = Math.floor(idx / size);
    return goCoordLetters.charAt(x) + (size - y);
  }

  E.games.go = {
    id: 'go', name: '围棋', en: 'GO', sizes: [9, 13, 19],
    first: '黑方', second: '白方', kind: 'stone',
    init: function (opts) {
      opts = opts || {};
      var size = opts.size || 19, n = size * size, b = [];
      for (var i = 0; i < n; i++) b.push(0);
      return mk('go', size, b, 1, { ko: -1, passes: 0, komi: opts.komi == null ? 7.5 : opts.komi });
    },
    moves: function (st) {
      if (st.status !== 'play') return [];
      var out = [{ pass: true }], size = st.size, n = size * size;
      for (var i = 0; i < n; i++) {
        if (st.board[i] !== 0) continue;
        if (i === st.ko) continue;
        if (goTry(st, i, st.turn)) out.push({ t: i });
      }
      return out;
    },
    legal: function (st, mv) { return goLegal(st, mv); },
    apply: function (st, mv) {
      var color = st.turn;
      if (mv.pass) {
        st.passes = (st.passes || 0) + 1;
        if (st.passes >= 2) {
          var sc = goScore(st);
          st.score = sc;
          st.status = 'over';
          st.winner = sc.winner;
          st.reason = 'score';
          st.turn = other(color);
        } else {
          st.turn = other(color);
        }
        return st;
      }
      var res = goTry(st, mv.t, color);
      if (!res) { st.turn = other(color); return st; }
      st.board = res.board;
      st.ko = res.ko;
      st.passes = 0;
      st.caps[color - 1] += res.caps.length;
      st.turn = other(color);
      return st;
    },
    lastOf: function (mv) { return mv.pass ? { pass: true } : { t: mv.t }; },
    text: function (st, mv) {
      return mv.pass ? '停一手' : goCoord(mv.t, st.size);
    },
    result: function (st) {
      if (st.reason && st.reason !== 'score') {
        var why = { resign: '认输', timeout: '超时', agreement: '和棋协议' }[st.reason] || '';
        if (st.winner === 3) return '和棋' + (why ? ' · ' + why : '');
        if (st.winner === 1 || st.winner === 2) {
          return (st.winner === 1 ? '黑方' : '白方') + '胜' + (why ? ' · ' + why : '');
        }
      }
      var sc = st.score || goScore(st);
      if (!sc.winner) return '和棋（黑 ' + fmt(sc.black) + ' : 白 ' + fmt(sc.white) + '）';
      return (sc.winner === 1 ? '黑方' : '白方') + '胜 ' + fmt(Math.abs(sc.diff)) + ' 目' +
        '（黑 ' + fmt(sc.black) + ' : 白 ' + fmt(sc.white) + '）';
    }
  };

  function goLegal(st, mv) {
    if (st.status !== 'play') return false;
    if (mv && mv.pass) return true;
    if (!mv || mv.t == null) return false;
    if (st.board[mv.t] !== 0) return false;
    if (mv.t === st.ko) return false;
    return !!goTry(st, mv.t, st.turn);
  }

  function fmt(n) {
    var r = Math.round(n * 10) / 10;
    return String(r);
  }

  /* ============================================================
     二、五子棋（15×15，无禁手）
     ============================================================ */
  var gomokuLetters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

  E.games.gomoku = {
    id: 'gomoku', name: '五子棋', en: 'GOMOKU', sizes: [15],
    first: '黑方', second: '白方', kind: 'stone',
    init: function () {
      var n = 225, b = [];
      for (var i = 0; i < n; i++) b.push(0);
      return mk('gomoku', 15, b, 1, {});
    },
    moves: function (st) {
      var out = [];
      if (st.status !== 'play') return out;
      for (var i = 0; i < 225; i++) if (st.board[i] === 0) out.push({ t: i });
      return out;
    },
    legal: function (st, mv) {
      return st.status === 'play' && mv && mv.t != null && st.board[mv.t] === 0;
    },
    apply: function (st, mv) {
      var color = st.turn;
      st.board[mv.t] = color;
      st.turn = other(color);
      if (gomokuWin(st.board, mv.t, color)) {
        st.status = 'over'; st.winner = color; st.reason = 'five';
      } else if (st.board.indexOf(0) < 0) {
        st.status = 'over'; st.winner = 3; st.reason = 'full';
      }
      return st;
    },
    lastOf: function (mv) { return { t: mv.t }; },
    text: function (st, mv) {
      return gomokuLetters.charAt(mv.t % 15) + (15 - Math.floor(mv.t / 15));
    },
    result: function (st) {
      if (st.winner === 3) return '和棋 · 棋盘填满';
      return (st.winner === 1 ? '黑方' : '白方') + '胜 · 五连';
    }
  };

  function gomokuWin(b, idx, color) {
    var x = idx % 15, y = Math.floor(idx / 15);
    var dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
    for (var d = 0; d < 4; d++) {
      var dx = dirs[d][0], dy = dirs[d][1], n = 1, k;
      for (k = 1; k < 5; k++) {
        var nx = x + dx * k, ny = y + dy * k;
        if (!inb(nx, ny, 15, 15) || b[ny * 15 + nx] !== color) break;
        n++;
      }
      for (k = 1; k < 5; k++) {
        var mx = x - dx * k, my = y - dy * k;
        if (!inb(mx, my, 15, 15) || b[my * 15 + mx] !== color) break;
        n++;
      }
      if (n >= 5) return true;
    }
    return false;
  }

  /* ============================================================
     三、中国象棋
     棋子：红 1帅 2仕 3相 4马 5车 6炮 7兵；黑 +8
     ============================================================ */
  var XQ_W = 9, XQ_H = 10;
  var XQ_RED = ['', '帅', '仕', '相', '马', '车', '炮', '兵'];
  var XQ_BLACK = ['', '将', '士', '象', '马', '车', '炮', '卒'];

  function xqPalace(x, y, color) {
    if (x < 3 || x > 5) return false;
    return color === 1 ? (y >= 7 && y <= 9) : (y >= 0 && y <= 2);
  }
  function xqOwnSide(y, color) { return color === 1 ? y >= 5 : y <= 4; }
  function xqCrossed(y, color) { return color === 1 ? y <= 4 : y >= 5; }
  function xqCoord(i) {
    var x = i % XQ_W, y = Math.floor(i / XQ_W);
    return 'abcdefghi'.charAt(x) + (10 - y);
  }

  function xqFindKing(b, color) {
    var k = color === 1 ? 1 : 9;
    for (var i = 0; i < 90; i++) if (b[i] === k) return i;
    return -1;
  }

  function xqAttacked(b, idx, by) {
    var x = idx % XQ_W, y = Math.floor(idx / XQ_W), i, j, p;
    var dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];

    // 车 / 将帅照面
    for (var d = 0; d < 4; d++) {
      var dx = dirs[d][0], dy = dirs[d][1];
      var cx = x + dx, cy = y + dy;
      while (inb(cx, cy, XQ_W, XQ_H)) {
        p = b[cy * XQ_W + cx];
        if (p) {
          if (colorOf(p) === by) {
            if (typeOf(p) === 5) return true;
            if (typeOf(p) === 1 && dx === 0) return true;      // 将帅照面
            if (typeOf(p) === 1 && Math.abs(cx - x) + Math.abs(cy - y) === 1) return true;
          }
          break;
        }
        cx += dx; cy += dy;
      }
    }

    // 炮：隔一个炮架
    for (var d2 = 0; d2 < 4; d2++) {
      var ex = dirs[d2][0], ey = dirs[d2][1];
      var ax = x + ex, ay = y + ey, screen = false;
      while (inb(ax, ay, XQ_W, XQ_H)) {
        p = b[ay * XQ_W + ax];
        if (p) {
          if (!screen) { screen = true; }
          else {
            if (colorOf(p) === by && typeOf(p) === 6) return true;
            break;
          }
        }
        ax += ex; ay += ey;
      }
    }

    // 马（蹩马腿）
    var kn = [[1, 2, 1, 1], [-1, 2, -1, 1], [1, -2, 1, -1], [-1, -2, -1, -1],
              [2, 1, 1, 1], [2, -1, 1, -1], [-2, 1, -1, 1], [-2, -1, -1, -1]];
    for (i = 0; i < 8; i++) {
      var kx = x + kn[i][0], ky = y + kn[i][1];
      if (!inb(kx, ky, XQ_W, XQ_H)) continue;
      if (b[ky * XQ_W + kx] !== (by === 1 ? 4 : 12)) continue;
      if (b[(y + kn[i][3]) * XQ_W + (x + kn[i][2])] !== 0) continue;
      return true;
    }

    // 兵 / 卒：正面 + 过河后的左右
    for (i = 0; i < 90; i++) {
      p = b[i];
      if (colorOf(p) !== by || typeOf(p) !== 7) continue;
      var px = i % XQ_W, py = Math.floor(i / XQ_W);
      var fy = by === 1 ? py - 1 : py + 1;
      if (fx(px, fy)) return true;
      if (xqCrossed(py, by)) {
        if (fx(px - 1, py)) return true;
        if (fx(px + 1, py)) return true;
      }
    }
    return false;

    function fx(ax2, ay2) { return ax2 === x && ay2 === y; }
  }

  function xqInCheck(b, color) {
    var k = xqFindKing(b, color);
    if (k < 0) return true;
    return xqAttacked(b, k, other(color));
  }

  function xqPseudo(st, color) {
    var b = st.board, out = [];
    for (var i = 0; i < 90; i++) {
      var p = b[i];
      if (colorOf(p) !== color) continue;
      var t = typeOf(p), x = i % XQ_W, y = Math.floor(i / XQ_W);
      var k, nx, ny;

      if (t === 1) { // 帅
        var kd = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        for (k = 0; k < 4; k++) {
          nx = x + kd[k][0]; ny = y + kd[k][1];
          if (!xqPalace(nx, ny, color)) continue;
          if (colorOf(b[ny * XQ_W + nx]) === color) continue;
          out.push({ f: i, t: ny * XQ_W + nx });
        }
        // 飞将：同列无子，直接吃对方将
        var dir = color === 1 ? -1 : 1;
        ny = y + dir;
        while (inb(x, ny, XQ_W, XQ_H)) {
          var q = b[ny * XQ_W + x];
          if (q) {
            if (q === (color === 1 ? 9 : 1)) out.push({ f: i, t: ny * XQ_W + x });
            break;
          }
          ny += dir;
        }
      } else if (t === 2) { // 仕
        var ad = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
        for (k = 0; k < 4; k++) {
          nx = x + ad[k][0]; ny = y + ad[k][1];
          if (!xqPalace(nx, ny, color)) continue;
          if (colorOf(b[ny * XQ_W + nx]) === color) continue;
          out.push({ f: i, t: ny * XQ_W + nx });
        }
      } else if (t === 3) { // 相
        var bd = [[2, 2], [2, -2], [-2, 2], [-2, -2]];
        for (k = 0; k < 4; k++) {
          nx = x + bd[k][0]; ny = y + bd[k][1];
          if (!inb(nx, ny, XQ_W, XQ_H) || !xqOwnSide(ny, color)) continue;
          if (b[(y + bd[k][1] / 2) * XQ_W + (x + bd[k][0] / 2)] !== 0) continue;
          if (colorOf(b[ny * XQ_W + nx]) === color) continue;
          out.push({ f: i, t: ny * XQ_W + nx });
        }
      } else if (t === 4) { // 马
        var nd = [[1, 2, 0, 1], [-1, 2, 0, 1], [1, -2, 0, -1], [-1, -2, 0, -1],
                  [2, 1, 1, 0], [2, -1, 1, 0], [-2, 1, -1, 0], [-2, -1, -1, 0]];
        for (k = 0; k < 8; k++) {
          nx = x + nd[k][0]; ny = y + nd[k][1];
          if (!inb(nx, ny, XQ_W, XQ_H)) continue;
          if (b[(y + nd[k][3]) * XQ_W + (x + nd[k][2])] !== 0) continue;
          if (colorOf(b[ny * XQ_W + nx]) === color) continue;
          out.push({ f: i, t: ny * XQ_W + nx });
        }
      } else if (t === 5 || t === 6) { // 车 / 炮
        for (k = 0; k < 4; k++) {
          var dx = [1, -1, 0, 0][k], dy = [0, 0, 1, -1][k];
          var cx = x + dx, cy = y + dy, screen = false;
          while (inb(cx, cy, XQ_W, XQ_H)) {
            var q2 = b[cy * XQ_W + cx];
            if (t === 5) {
              if (!q2) out.push({ f: i, t: cy * XQ_W + cx });
              else { if (colorOf(q2) !== color) out.push({ f: i, t: cy * XQ_W + cx }); break; }
            } else {
              if (!screen) {
                if (!q2) out.push({ f: i, t: cy * XQ_W + cx });
                else screen = true;
              } else if (q2) {
                if (colorOf(q2) !== color) out.push({ f: i, t: cy * XQ_W + cx });
                break;
              }
            }
            cx += dx; cy += dy;
          }
        }
      } else if (t === 7) { // 兵
        var fy = color === 1 ? y - 1 : y + 1;
        if (inb(x, fy, XQ_W, XQ_H) && colorOf(b[fy * XQ_W + x]) !== color) out.push({ f: i, t: fy * XQ_W + x });
        if (xqCrossed(y, color)) {
          if (inb(x - 1, y, XQ_W, XQ_H) && colorOf(b[y * XQ_W + x - 1]) !== color) out.push({ f: i, t: y * XQ_W + x - 1 });
          if (inb(x + 1, y, XQ_W, XQ_H) && colorOf(b[y * XQ_W + x + 1]) !== color) out.push({ f: i, t: y * XQ_W + x + 1 });
        }
      }
    }
    return out;
  }

  function xqLegal(st, color) {
    var ps = xqPseudo(st, color), out = [];
    for (var i = 0; i < ps.length; i++) {
      var b = st.board.slice();
      b[ps[i].t] = b[ps[i].f];
      b[ps[i].f] = 0;
      if (!xqInCheck(b, color)) out.push(ps[i]);
    }
    return out;
  }

  E.games.xiangqi = {
    id: 'xiangqi', name: '中国象棋', en: 'XIANGQI', sizes: [10],
    first: '红方', second: '黑方', kind: 'piece',
    init: function () {
      var b = [];
      for (var i = 0; i < 90; i++) b.push(0);
      var back = [13, 12, 11, 10, 9, 10, 11, 12, 13];
      for (var x = 0; x < 9; x++) b[x] = back[x];
      b[2 * 9 + 1] = 14; b[2 * 9 + 7] = 14;
      for (x = 0; x < 9; x += 2) b[3 * 9 + x] = 15;
      for (x = 0; x < 9; x += 2) b[6 * 9 + x] = 7;
      b[7 * 9 + 1] = 6; b[7 * 9 + 7] = 6;
      var redBack = [5, 4, 3, 2, 1, 2, 3, 4, 5];
      for (x = 0; x < 9; x++) b[9 * 9 + x] = redBack[x];
      return mk('xiangqi', 10, b, 1, {});
    },
    moves: function (st) { return st.status === 'play' ? xqLegal(st, st.turn) : []; },
    legal: function (st, mv) {
      if (st.status !== 'play' || !mv) return false;
      var list = xqLegal(st, st.turn);
      for (var i = 0; i < list.length; i++) if (list[i].f === mv.f && list[i].t === mv.t) return true;
      return false;
    },
    apply: function (st, mv) {
      var color = st.turn, cap = st.board[mv.t];
      st.board[mv.t] = st.board[mv.f];
      st.board[mv.f] = 0;
      if (cap) st.caps[color - 1]++;
      st.turn = other(color);
      if (!xqLegal(st, st.turn).length) {
        st.status = 'over';
        st.winner = color;
        st.reason = xqInCheck(st.board, st.turn) ? 'checkmate' : 'stalemate';
      }
      return st;
    },
    lastOf: function (mv) { return { f: mv.f, t: mv.t }; },
    text: function (st, mv) {
      var p = st.board[mv.f] || st.board[mv.t];
      var names = colorOf(p) === 1 ? XQ_RED : XQ_BLACK;
      return names[typeOf(p)] + ' ' + xqCoord(mv.f) + '-' + xqCoord(mv.t);
    },
    result: function (st) {
      var name = st.winner === 1 ? '红方' : (st.winner === 2 ? '黑方' : '');
      var why = {
        checkmate: '将死', stalemate: '困毙', resign: '认输',
        timeout: '超时', agreement: '和棋协议'
      }[st.reason] || '';
      if (st.winner === 3) return '和棋' + (why ? ' · ' + why : '');
      if (!st.winner) return '';
      return name + '胜' + (why ? ' · ' + why : '');
    }
  };

  /* ============================================================
     四、国际象棋
     白 1兵 2马 3象 4车 5后 6王；黑 +8
     ============================================================ */
  var CH_W = 8;
  var CH_WHITE = ['', '兵', '马', '象', '车', '后', '王'];
  var CH_BLACK = ['', '兵', '马', '象', '车', '后', '王'];
  function chCoord(i) {
    return 'abcdefgh'.charAt(i % 8) + (8 - Math.floor(i / 8));
  }
  function chFindKing(b, color) {
    var k = color === 1 ? 6 : 14;
    for (var i = 0; i < 64; i++) if (b[i] === k) return i;
    return -1;
  }

  function chAttacked(b, idx, by) {
    var x = idx % 8, y = Math.floor(idx / 8), i, j, p;
    // 兵
    var py = y + (by === 1 ? 1 : -1);
    var pawn = by === 1 ? 1 : 9;
    if (inb(x - 1, py, 8, 8) && b[py * 8 + x - 1] === pawn) return true;
    if (inb(x + 1, py, 8, 8) && b[py * 8 + x + 1] === pawn) return true;
    // 马
    var kn = [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]];
    for (i = 0; i < 8; i++) {
      var kx = x + kn[i][0], ky = y + kn[i][1];
      if (!inb(kx, ky, 8, 8)) continue;
      p = b[ky * 8 + kx];
      if (p === (by === 1 ? 2 : 10)) return true;
    }
    // 王
    for (i = -1; i <= 1; i++) for (j = -1; j <= 1; j++) {
      if (!i && !j) continue;
      if (!inb(x + i, y + j, 8, 8)) continue;
      if (b[(y + j) * 8 + x + i] === (by === 1 ? 6 : 14)) return true;
    }
    // 象 / 后
    var diag = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
    for (i = 0; i < 4; i++) {
      var cx = x + diag[i][0], cy = y + diag[i][1];
      while (inb(cx, cy, 8, 8)) {
        p = b[cy * 8 + cx];
        if (p) {
          if (colorOf(p) === by && (typeOf(p) === 3 || typeOf(p) === 5)) return true;
          break;
        }
        cx += diag[i][0]; cy += diag[i][1];
      }
    }
    // 车 / 后
    var orth = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (i = 0; i < 4; i++) {
      var ex = x + orth[i][0], ey = y + orth[i][1];
      while (inb(ex, ey, 8, 8)) {
        p = b[ey * 8 + ex];
        if (p) {
          if (colorOf(p) === by && (typeOf(p) === 4 || typeOf(p) === 5)) return true;
          break;
        }
        ex += orth[i][0]; ey += orth[i][1];
      }
    }
    return false;
  }

  function chInCheck(st, color) {
    var k = chFindKing(st.board, color);
    if (k < 0) return true;
    return chAttacked(st.board, k, other(color));
  }

  function chPseudo(st, color) {
    var b = st.board, out = [], i, k, x, y, p, t;
    for (i = 0; i < 64; i++) {
      p = b[i];
      if (colorOf(p) !== color) continue;
      t = typeOf(p); x = i % 8; y = Math.floor(i / 8);

      if (t === 1) { // 兵
        var dir = color === 1 ? -1 : 1;
        var startY = color === 1 ? 6 : 1;
        var promoY = color === 1 ? 0 : 7;
        var one = y + dir;
        if (inb(x, one, 8, 8) && b[one * 8 + x] === 0) {
          addPawn(out, i, one * 8 + x, one === promoY);
          if (y === startY && b[(y + 2 * dir) * 8 + x] === 0) out.push({ f: i, t: (y + 2 * dir) * 8 + x });
        }
        var cx2 = x - 1, cy2 = y + dir;
        if (inb(cx2, cy2, 8, 8)) {
          var q = b[cy2 * 8 + cx2];
          if (q && colorOf(q) !== color) addPawn(out, i, cy2 * 8 + cx2, cy2 === promoY);
          else if (st.ep === cy2 * 8 + cx2) out.push({ f: i, t: cy2 * 8 + cx2, ep: true });
        }
        cx2 = x + 1;
        if (inb(cx2, cy2, 8, 8)) {
          q = b[cy2 * 8 + cx2];
          if (q && colorOf(q) !== color) addPawn(out, i, cy2 * 8 + cx2, cy2 === promoY);
          else if (st.ep === cy2 * 8 + cx2) out.push({ f: i, t: cy2 * 8 + cx2, ep: true });
        }
      } else if (t === 2) {
        var kn = [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]];
        for (k = 0; k < 8; k++) {
          var nx = x + kn[k][0], ny = y + kn[k][1];
          if (!inb(nx, ny, 8, 8)) continue;
          if (colorOf(b[ny * 8 + nx]) === color) continue;
          out.push({ f: i, t: ny * 8 + nx });
        }
      } else if (t === 3 || t === 4 || t === 5) {
        var dirs = (t === 3) ? [[1, 1], [1, -1], [-1, 1], [-1, -1]]
          : (t === 4) ? [[1, 0], [-1, 0], [0, 1], [0, -1]]
          : [[1, 1], [1, -1], [-1, 1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]];
        for (k = 0; k < dirs.length; k++) {
          var dx = dirs[k][0], dy = dirs[k][1];
          var ax = x + dx, ay = y + dy;
          while (inb(ax, ay, 8, 8)) {
            var q2 = b[ay * 8 + ax];
            if (!q2) out.push({ f: i, t: ay * 8 + ax });
            else {
              if (colorOf(q2) !== color) out.push({ f: i, t: ay * 8 + ax });
              break;
            }
            ax += dx; ay += dy;
          }
        }
      } else if (t === 6) { // 王
        for (var a = -1; a <= 1; a++) for (var b2 = -1; b2 <= 1; b2++) {
          if (!a && !b2) continue;
          var kx = x + a, ky = y + b2;
          if (!inb(kx, ky, 8, 8)) continue;
          if (colorOf(b[ky * 8 + kx]) === color) continue;
          out.push({ f: i, t: ky * 8 + kx });
        }
        // 易位
        var home = color === 1 ? 7 : 0;
        if (y === home && x === 4 && !chAttacked(b, i, other(color))) {
          if (color === 1 && st.castle.wk && b[63] === 4 && !b[61] && !b[62] &&
              !chAttacked(b, 61, 2) && !chAttacked(b, 62, 2)) out.push({ f: 60, t: 62, castle: 'k' });
          if (color === 1 && st.castle.wq && b[56] === 4 && !b[57] && !b[58] && !b[59] &&
              !chAttacked(b, 59, 2) && !chAttacked(b, 58, 2)) out.push({ f: 60, t: 58, castle: 'q' });
          if (color === 2 && st.castle.bk && b[7] === 12 && !b[5] && !b[6] &&
              !chAttacked(b, 5, 1) && !chAttacked(b, 6, 1)) out.push({ f: 4, t: 6, castle: 'k' });
          if (color === 2 && st.castle.bq && b[0] === 12 && !b[1] && !b[2] && !b[3] &&
              !chAttacked(b, 3, 1) && !chAttacked(b, 2, 1)) out.push({ f: 4, t: 2, castle: 'q' });
        }
      }
    }
    return out;
  }

  function addPawn(out, f, t, promo) {
    if (promo) { out.push({ f: f, t: t, promo: 5 }); }
    else out.push({ f: f, t: t });
  }

  function chMake(st, mv) {
    var b = st.board, f = mv.f, t = mv.t, p = b[f], color = colorOf(p), type = typeOf(p);
    var cap = b[t], capType = typeOf(cap);
    b[f] = 0;

    if (type === 1 && mv.ep) {
      b[t + (color === 1 ? 8 : -8)] = 0;
      cap = color === 1 ? 9 : 1;
      capType = 1;
    }
    if (type === 1 && (t < 8 || t >= 56)) {
      var promo = mv.promo || 5;
      b[t] = (color === 1 ? promo : promo + 8);
    } else {
      b[t] = p;
    }

    if (type === 6 && Math.abs(t - f) === 2) {
      if (t > f) { b[f + 1] = b[f + 3]; b[f + 3] = 0; }
      else { b[f - 1] = b[f - 4]; b[f - 4] = 0; }
    }

    if (type === 6) { st.castle.wk = 0; st.castle.wq = 0; }
    if (type === 4) {
      if (f === 63) st.castle.wk = 0;
      if (f === 56) st.castle.wq = 0;
      if (f === 7) st.castle.bk = 0;
      if (f === 0) st.castle.bq = 0;
    }
    if (capType === 4) {
      if (t === 63) st.castle.wk = 0;
      if (t === 56) st.castle.wq = 0;
      if (t === 7) st.castle.bk = 0;
      if (t === 0) st.castle.bq = 0;
    }

    if (type === 1 && Math.abs(t - f) === 16) st.ep = (f + t) / 2;
    else st.ep = -1;

    if (type === 1 || cap) st.half = 0; else st.half = (st.half || 0) + 1;
    return cap;
  }

  function chLegal(st, color) {
    var ps = chPseudo(st, color), out = [];
    for (var i = 0; i < ps.length; i++) {
      var ns = clone(st);
      chMake(ns, ps[i]);
      if (!chInCheck(ns, color)) out.push(ps[i]);
    }
    return out;
  }

  function chInsufficient(st) {
    var nonKing = [];
    for (var i = 0; i < 64; i++) {
      var t = typeOf(st.board[i]);
      if (t && t !== 6) nonKing.push(t);
    }
    if (nonKing.length === 0) return true;
    if (nonKing.length === 1 && (nonKing[0] === 2 || nonKing[0] === 3)) return true;
    return false;
  }

  E.games.chess = {
    id: 'chess', name: '国际象棋', en: 'CHESS', sizes: [8],
    first: '白方', second: '黑方', kind: 'piece',
    init: function () {
      var b = [], i;
      for (i = 0; i < 64; i++) b.push(0);
      var back = [12, 10, 11, 13, 14, 11, 10, 12];
      for (i = 0; i < 8; i++) b[i] = back[i];
      for (i = 0; i < 8; i++) b[8 + i] = 9;
      for (i = 0; i < 8; i++) b[48 + i] = 1;
      var wback = [4, 2, 3, 5, 6, 3, 2, 4];
      for (i = 0; i < 8; i++) b[56 + i] = wback[i];
      return mk('chess', 8, b, 1, { castle: { wk: 1, wq: 1, bk: 1, bq: 1 }, ep: -1 });
    },
    moves: function (st) { return st.status === 'play' ? chLegal(st, st.turn) : []; },
    legal: function (st, mv) {
      if (st.status !== 'play' || !mv) return false;
      var list = chLegal(st, st.turn);
      for (var i = 0; i < list.length; i++) if (list[i].f === mv.f && list[i].t === mv.t) return true;
      return false;
    },
    apply: function (st, mv) {
      var color = st.turn;
      var cap = chMake(st, mv);
      if (cap) st.caps[color - 1]++;
      st.turn = other(color);
      var legal = chLegal(st, st.turn);
      if (!legal.length) {
        st.status = 'over';
        if (chInCheck(st, st.turn)) { st.winner = color; st.reason = 'checkmate'; }
        else { st.winner = 3; st.reason = 'stalemate'; }
      } else if (st.half >= 100) {
        st.status = 'over'; st.winner = 3; st.reason = 'fifty';
      } else if (chInsufficient(st)) {
        st.status = 'over'; st.winner = 3; st.reason = 'material';
      }
      return st;
    },
    lastOf: function (mv) { return { f: mv.f, t: mv.t }; },
    text: function (st, mv) {
      var p = st.board[mv.f] || st.board[mv.t];
      var names = colorOf(p) === 1 ? CH_WHITE : CH_BLACK;
      var cap = st.board[mv.t] || mv.ep;
      var s = names[typeOf(p)] + ' ' + chCoord(mv.f) + (cap ? '×' : '-') + chCoord(mv.t);
      if (mv.promo) s += '=' + CH_WHITE[mv.promo];
      if (mv.castle) s = (mv.castle === 'k' ? '短易位' : '长易位') + ' ' + chCoord(mv.f) + '→' + chCoord(mv.t);
      return s;
    },
    result: function (st) {
      if (st.winner === 3) {
        var w = { stalemate: '逼和', fifty: '50 回合和棋', material: '子力不足' }[st.reason] || '';
        return '和棋 · ' + w;
      }
      var why = { checkmate: '将死', resign: '认输', timeout: '超时', agreement: '和棋协议' }[st.reason] || '';
      return (st.winner === 1 ? '白方' : '黑方') + '胜 · ' + why;
    }
  };

  /* ============================================================
     五、国际跳棋（10×10，必须吃、必须吃最多）
     白 1 兵 / 2 王；黑 9 兵 / 10 王；白先
     ============================================================ */
  var DR_W = 10;
  function drPlayable(x, y) { return (x + y) % 2 === 1; }
  function drCoord(i) { return 'abcdefghij'.charAt(i % 10) + (10 - Math.floor(i / 10)); }
  function drForward(color) { return color === 1 ? -1 : 1; }

  function drPieces(b, color) {
    var out = [];
    for (var i = 0; i < 100; i++) if (colorOf(b[i]) === color) out.push(i);
    return out;
  }

  function drCaptureSeqs(st, start) {
    var b = st.board, color = colorOf(b[start]), piece = b[start];
    var isKing = typeOf(piece) === 2;
    var results = [], seenSeq = {}, nodes = 0;
    var dirs = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

    function key(path, caps) {
      return path.join(',') + '|' + caps.slice().sort(function (a, b2) { return a - b2; }).join(',');
    }

    function dfs(pos, path, caps) {
      if (nodes++ > 30000) return;
      var extended = false;
      var x = pos % 10, y = Math.floor(pos / 10);
      for (var d = 0; d < 4; d++) {
        var dx = dirs[d][0], dy = dirs[d][1];
        if (!isKing) {
          var mx = x + dx, my = y + dy, lx = x + 2 * dx, ly = y + 2 * dy;
          if (!inb(lx, ly, 10, 10)) continue;
          var mid = my * 10 + mx, land = ly * 10 + lx;
          var mp = b[mid];
          if (!mp || colorOf(mp) === color || caps.indexOf(mid) >= 0) continue;
          if (b[land] !== 0) continue;
          extended = true;
          dfs(land, path.concat([land]), caps.concat([mid]));
        } else {
          var cx = x + dx, cy = y + dy;
          while (inb(cx, cy, 10, 10) && b[cy * 10 + cx] === 0) { cx += dx; cy += dy; }
          if (!inb(cx, cy, 10, 10)) continue;
          var ep = cy * 10 + cx;
          var epc = b[ep];
          if (!epc || colorOf(epc) === color || caps.indexOf(ep) >= 0) continue;
          var ax = cx + dx, ay = cy + dy;
          while (inb(ax, ay, 10, 10) && b[ay * 10 + ax] === 0) {
            extended = true;
            dfs(ay * 10 + ax, path.concat([ay * 10 + ax]), caps.concat([ep]));
            ax += dx; ay += dy;
          }
        }
      }
      if (!extended && path.length > 1) {
        var k = key(path, caps);
        if (!seenSeq[k]) { seenSeq[k] = 1; results.push({ p: path, c: caps }); }
      }
    }

    dfs(start, [start], []);
    return results;
  }

  function drMoves(st) {
    if (st.status !== 'play') return [];
    var b = st.board, color = st.turn, pieces = drPieces(b, color);
    var caps = [], i, j;
    for (i = 0; i < pieces.length; i++) {
      var seqs = drCaptureSeqs(st, pieces[i]);
      for (j = 0; j < seqs.length; j++) caps.push(seqs[j]);
    }
    if (caps.length) {
      var max = 0;
      for (i = 0; i < caps.length; i++) max = Math.max(max, caps[i].c.length);
      var out = [];
      for (i = 0; i < caps.length; i++) if (caps[i].c.length === max) out.push(caps[i]);
      return out;
    }
    var moves = [];
    for (i = 0; i < pieces.length; i++) {
      var p = b[pieces[i]], isKing = typeOf(p) === 2;
      var x = pieces[i] % 10, y = Math.floor(pieces[i] / 10);
      var dy = drForward(color);
      if (!isKing) {
        for (var sx = -1; sx <= 1; sx += 2) {
          var nx = x + sx, ny = y + dy;
          if (inb(nx, ny, 10, 10) && b[ny * 10 + nx] === 0) {
            moves.push({ p: [pieces[i], ny * 10 + nx], c: [] });
          }
        }
      } else {
        var dirs = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
        for (j = 0; j < 4; j++) {
          var ax = x + dirs[j][0], ay = y + dirs[j][1];
          while (inb(ax, ay, 10, 10) && b[ay * 10 + ax] === 0) {
            moves.push({ p: [pieces[i], ay * 10 + ax], c: [] });
            ax += dirs[j][0]; ay += dirs[j][1];
          }
        }
      }
    }
    return moves;
  }

  E.games.draughts = {
    id: 'draughts', name: '国际跳棋', en: 'DRAUGHTS', sizes: [10],
    first: '白方', second: '黑方', kind: 'piece',
    init: function () {
      var b = [];
      for (var i = 0; i < 100; i++) b.push(0);
      for (var y = 0; y < 4; y++) for (var x = 0; x < 10; x++) if (drPlayable(x, y)) b[y * 10 + x] = 9;
      for (y = 6; y < 10; y++) for (x = 0; x < 10; x++) if (drPlayable(x, y)) b[y * 10 + x] = 1;
      return mk('draughts', 10, b, 1, {});
    },
    moves: function (st) { return drMoves(st); },
    legal: function (st, mv) {
      if (st.status !== 'play' || !mv || !mv.p || mv.p.length < 2) return false;
      var list = drMoves(st);
      for (var i = 0; i < list.length; i++) {
        if (list[i].p.join(',') === mv.p.join(',') &&
            list[i].c.slice().sort().join(',') === (mv.c || []).slice().sort().join(',')) return true;
      }
      return false;
    },
    apply: function (st, mv) {
      var color = st.turn, path = mv.p, b = st.board;
      var piece = b[path[0]];
      var isKing = typeOf(piece) === 2;
      b[path[0]] = 0;
      var got = 0;
      for (var i = 0; i < mv.c.length; i++) if (b[mv.c[i]]) { b[mv.c[i]] = 0; got++; }
      var end = path[path.length - 1];
      var endY = Math.floor(end / 10);
      var promoRow = color === 1 ? 0 : 9;
      if (!isKing && endY === promoRow) piece = color === 1 ? 2 : 10;
      b[end] = piece;
      st.caps[color - 1] += got;
      st.turn = other(color);
      if (!drMoves(st).length) {
        st.status = 'over';
        st.winner = color;
        st.reason = 'nomove';
      }
      return st;
    },
    lastOf: function (mv) { return { pts: mv.p, caps: mv.c }; },
    text: function (st, mv) {
      var sep = mv.c && mv.c.length ? '×' : '-';
      var s = '';
      for (var i = 0; i < mv.p.length; i++) s += (i ? sep : '') + drCoord(mv.p[i]);
      return s;
    },
    result: function (st) {
      var why = {
        nomove: '对方无子可动', resign: '认输', timeout: '超时', agreement: '和棋协议'
      }[st.reason] || '';
      if (st.winner === 3) return '和棋' + (why ? ' · ' + why : '');
      if (!st.winner) return '';
      return (st.winner === 1 ? '白方' : '黑方') + '胜' + (why ? ' · ' + why : '');
    }
  };

  /* ============================================================
     对外 API
     ============================================================ */
  E.list = ['xiangqi', 'chess', 'go', 'gomoku', 'draughts'];

  E.info = function (game) { return E.games[game]; };

  E.init = function (game, opts) {
    var g = E.games[game];
    if (!g) throw new Error('未知棋种：' + game);
    return g.init(opts || {});
  };

  E.moves = function (st) {
    var g = E.games[st.game];
    return g ? g.moves(st) : [];
  };

  E.legal = function (st, mv) {
    var g = E.games[st.game];
    return g ? g.legal(st, mv) : false;
  };

  E.apply = function (st, mv) {
    if (!st || st.status !== 'play') return clone(st);
    var g = E.games[st.game];
    var ns = clone(st);
    g.apply(ns, mv);
    ns.seq = (st.seq || 0) + 1;
    ns.last = g.lastOf ? g.lastOf(mv) : null;
    if (!ns.status) ns.status = 'play';
    return ns;
  };

  E.replay = function (game, opts, moves) {
    var st = E.init(game, opts);
    for (var i = 0; i < (moves || []).length; i++) {
      if (st.status !== 'play') break;
      st = E.apply(st, moves[i]);
    }
    return st;
  };

  E.text = function (st, mv) {
    var g = E.games[st.game];
    return g && g.text ? g.text(st, mv) : '';
  };

  E.result = function (st) {
    var g = E.games[st.game];
    if (!g || st.status !== 'over') return '';
    return g.result ? g.result(st) : '';
  };

  E.turnText = function (st) {
    var g = E.games[st.game];
    if (!g) return '';
    return (st.turn === 1 ? g.first : g.second) + '走棋';
  };

  E.scoreGo = function (st) { return goScore(st); };
  E.checkIndex = function (st) {
    if (!st || st.status !== 'play') return -1;
    if (st.game === 'chess') {
      var ck = chFindKing(st.board, st.turn);
      return ck >= 0 && chAttacked(st.board, ck, other(st.turn)) ? ck : -1;
    }
    if (st.game === 'xiangqi') {
      var xk = xqFindKing(st.board, st.turn);
      return xk >= 0 && xqAttacked(st.board, xk, other(st.turn)) ? xk : -1;
    }
    return -1;
  };
  E.goCoord = goCoord;
  E.xiangqiCoord = xqCoord;
  E.chessCoord = chCoord;
  E.gomokuCoord = function (i) { return gomokuLetters.charAt(i % 15) + (15 - Math.floor(i / 15)); };
  E.draughtsCoord = drCoord;
  E.playable = drPlayable;
  E.clone = clone;

  return E;
});
