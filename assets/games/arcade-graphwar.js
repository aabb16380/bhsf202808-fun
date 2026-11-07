/* ============================================================
   八班游乐场 · 函数大战（GraphWar）
   ------------------------------------------------------------
   2-8 人回合制：用屏幕键盘输入 y = f(x) 或 y'' = f(x)，
   炮弹沿曲线飞，打中别人的士兵就 -35 血。

   本文件分两层：
   1. 纯逻辑：解析器 / 弹道 / 局面结算，不碰 DOM，Node 自检直接跑；
   2. mount(root, ctx)：浏览器界面，所有 DOM 与动画都在 mount 之后才启动。

   依赖页面给的 B8Arcade 壳与 ctx，不依赖 B8 的其它 API。
   ============================================================ */
(function () {
  'use strict';

  var A = window.B8Arcade = window.B8Arcade || {};
  A.games = A.games || {};

  var VERSION = 1;
  var WORLD = { x0: -25, x1: 25, y0: -15, y1: 15 };
  var HP_MAX = 100;
  var DAMAGE = 35;
  var SOLDIER_R = 0.82;
  var HIT_R = 0.95;
  var NORMAL_STEP = 0.08;
  var RK_STEP = 0.05;
  var MAX_PATH = 2400;
  var PREVIEW_MAX = 300;
  var TURN_MS = 60000;
  var TEAM_RED = '红队';
  var TEAM_BLUE = '蓝队';
  var FUNCS = {
    sin: 1, cos: 1, tan: 1, sqrt: 1, abs: 1,
    log: 1, ln: 1, exp: 1
  };

  /* ============================================================
     0. 小工具
     ============================================================ */
  function isNum(v) {
    return typeof v === 'number' && isFinite(v);
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  function copyState(st) {
    return JSON.parse(JSON.stringify(st));
  }

  function roundNum(n, d) {
    var p = Math.pow(10, d == null ? 6 : d);
    return Math.round(n * p) / p;
  }

  function seatLabel(seat) {
    return '座位 ' + seat;
  }

  function aliveSoldier(st, seat) {
    var list = (st && st.soldiers) || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].seat === seat) {
        return !!(list[i].alive !== false && Number(list[i].hp) > 0);
      }
    }
    return false;
  }

  function soldierOf(st, seat) {
    var list = (st && st.soldiers) || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].seat === seat) return list[i];
    }
    return null;
  }

  /* ============================================================
     1. 函数解析器
     ------------------------------------------------------------
     手写分词 + 递归下降，绝不用 eval / new Function。
     优先级：加减 < 乘除 < 一元正负 < 幂（右结合）。
     因此 -2^2 = -(2^2) = -4，2^3^2 = 2^(3^2) = 512。
     ============================================================ */
  function parseFail(msg) {
    var e = new Error(msg);
    e.gwParse = true;
    throw e;
  }

  function isDigit(c) {
    return c >= '0' && c <= '9';
  }

  function isAlpha(c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
  }

  function tokenize(src) {
    var out = [];
    var i = 0, n = src.length;
    while (i < n) {
      var c = src.charAt(i);
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
        i++;
        continue;
      }
      if (isDigit(c) || (c === '.' && isDigit(src.charAt(i + 1)))) {
        var start = i;
        while (i < n && isDigit(src.charAt(i))) i++;
        if (src.charAt(i) === '.') {
          i++;
          while (i < n && isDigit(src.charAt(i))) i++;
        }
        if (src.charAt(i) === 'e' || src.charAt(i) === 'E') {
          var j = i + 1;
          if (src.charAt(j) === '+' || src.charAt(j) === '-') j++;
          if (isDigit(src.charAt(j))) {
            i = j;
            while (i < n && isDigit(src.charAt(i))) i++;
          }
        }
        var raw = src.slice(start, i);
        var val = Number(raw);
        if (!isFinite(val)) parseFail('数字“' + raw + '”看不明白');
        out.push({ k: 'num', v: val, text: raw, pos: start });
        continue;
      }
      if (isAlpha(c)) {
        var st = i;
        while (i < n && isAlpha(src.charAt(i))) i++;
        var name = src.slice(st, i);
        out.push({ k: 'name', v: name, text: name, pos: st });
        continue;
      }
      if ('+-*/^'.indexOf(c) >= 0) {
        out.push({ k: 'op', v: c, text: c, pos: i });
        i++;
        continue;
      }
      if (c === '(') {
        out.push({ k: 'lp', text: '(', pos: i });
        i++;
        continue;
      }
      if (c === ')') {
        out.push({ k: 'rp', text: ')', pos: i });
        i++;
        continue;
      }
      if (c === '.') parseFail('小数点后面缺少数字');
      parseFail('不认识的字符“' + c + '”');
    }
    out.push({ k: 'eof', text: '', pos: n });
    return out;
  }

  function Parser(tokens) {
    this.tokens = tokens;
    this.i = 0;
    this.depth = 0;
  }

  Parser.prototype.peek = function () {
    return this.tokens[this.i] || this.tokens[this.tokens.length - 1];
  };

  Parser.prototype.next = function () {
    var t = this.peek();
    if (this.i < this.tokens.length - 1) this.i++;
    return t;
  };

  Parser.prototype.enter = function () {
    this.depth++;
    if (this.depth > 80) parseFail('括号嵌套太深了（最多 80 层）');
  };

  Parser.prototype.leave = function () {
    if (this.depth > 0) this.depth--;
  };

  Parser.prototype.parseAll = function () {
    if (this.peek().k === 'eof') parseFail('式子不能为空，先输入一个函数吧');
    var node = this.parseAdd();
    var t = this.peek();
    if (t.k !== 'eof') {
      if (t.k === 'rp') parseFail('括号不匹配：多了一个右括号');
      if (t.k === 'num' || t.k === 'name' || t.k === 'lp') {
        parseFail('“' + t.text + '”前面缺少运算符（比如 *）');
      }
      parseFail('式子末尾多了一个“' + t.text + '”');
    }
    return node;
  };

  Parser.prototype.parseAdd = function () {
    var node = this.parseMul();
    while (true) {
      var t = this.peek();
      if (t.k !== 'op' || (t.v !== '+' && t.v !== '-')) break;
      this.next();
      var n = this.peek();
      if (n.k === 'eof' || n.k === 'rp') {
        parseFail('“' + t.v + '”后面缺少数字或表达式');
      }
      var rhs = this.parseMul();
      node = { t: 'bin', op: t.v, a: node, b: rhs };
    }
    return node;
  };

  Parser.prototype.parseMul = function () {
    var node = this.parseUnary();
    while (true) {
      var t = this.peek();
      if (t.k !== 'op' || (t.v !== '*' && t.v !== '/')) break;
      this.next();
      var n = this.peek();
      if (n.k === 'eof' || n.k === 'rp') {
        parseFail('“' + t.v + '”后面缺少数字或表达式');
      }
      var rhs = this.parseUnary();
      node = { t: 'bin', op: t.v, a: node, b: rhs };
    }
    return node;
  };

  Parser.prototype.parseUnary = function () {
    var t = this.peek();
    if (t.k === 'op' && (t.v === '+' || t.v === '-')) {
      this.next();
      var n = this.peek();
      if (n.k === 'eof' || n.k === 'rp') {
        parseFail('“' + t.v + '”后面缺少数字或表达式');
      }
      var val = this.parseUnary();
      return t.v === '-' ? { t: 'neg', a: val } : val;
    }
    return this.parsePower();
  };

  Parser.prototype.parsePower = function () {
    var base = this.parsePrimary();
    var t = this.peek();
    if (t.k === 'op' && t.v === '^') {
      this.next();
      var n = this.peek();
      if (n.k === 'eof' || n.k === 'rp') parseFail('^ 后面缺少指数');
      if (n.k === 'op' && n.v !== '-' && n.v !== '+') {
        parseFail('^ 后面缺少指数');
      }
      var exp = this.parseUnary();
      return { t: 'bin', op: '^', a: base, b: exp };
    }
    return base;
  };

  Parser.prototype.parsePrimary = function () {
    var t = this.peek();
    if (t.k === 'num') {
      this.next();
      return { t: 'num', v: t.v };
    }
    if (t.k === 'name') {
      this.next();
      if (t.v === 'x') return { t: 'x' };
      if (t.v === 'pi') return { t: 'num', v: Math.PI };
      if (t.v === 'e') return { t: 'num', v: Math.E };
      if (FUNCS[t.v]) {
        var lp = this.peek();
        if (lp.k !== 'lp') {
          parseFail(t.v + ' 后面缺少左括号（例如 ' + t.v + '(x)）');
        }
        this.next();
        var after = this.peek();
        if (after.k === 'rp') parseFail(t.v + ' 的括号里缺少表达式');
        if (after.k === 'eof') parseFail(t.v + ' 的括号没有闭合，缺少右括号');
        this.enter();
        var arg = this.parseAdd();
        var close = this.peek();
        this.leave();
        if (close.k !== 'rp') {
          if (close.k === 'eof') parseFail('括号不匹配，缺少右括号');
          parseFail('括号不匹配：' + t.v + ' 这里需要一个右括号');
        }
        this.next();
        return { t: 'call', name: t.v, a: arg };
      }
      parseFail('不认识“' + t.v + '”：只能用 x、pi、e 和 sin/cos/tan/sqrt/abs/log/ln/exp');
    }
    if (t.k === 'lp') {
      this.next();
      var now = this.peek();
      if (now.k === 'rp') parseFail('括号里缺少表达式');
      if (now.k === 'eof') parseFail('括号不匹配，缺少右括号');
      this.enter();
      var inner = this.parseAdd();
      var end = this.peek();
      this.leave();
      if (end.k !== 'rp') {
        if (end.k === 'eof') parseFail('括号不匹配，缺少右括号');
        parseFail('括号不匹配：这里需要一个右括号');
      }
      this.next();
      return inner;
    }
    if (t.k === 'rp') parseFail('括号不匹配：多了一个右括号');
    if (t.k === 'eof') parseFail('式子还没写完，缺少数字或表达式');
    if (t.k === 'op' && t.v === '^') parseFail('^ 前面缺少数字或表达式');
    if (t.k === 'op') parseFail('运算符“' + t.v + '”前面缺少数字或表达式');
    parseFail('这里需要一个数字、x 或函数');
  };

  function evalAst(node, x) {
    if (!node) return NaN;
    if (node.t === 'num') return node.v;
    if (node.t === 'x') return x;
    if (node.t === 'neg') return -evalAst(node.a, x);
    if (node.t === 'bin') {
      var a = evalAst(node.a, x);
      var b = evalAst(node.b, x);
      if (node.op === '+') return a + b;
      if (node.op === '-') return a - b;
      if (node.op === '*') return a * b;
      if (node.op === '/') return a / b;
      if (node.op === '^') return Math.pow(a, b);
      return NaN;
    }
    if (node.t === 'call') {
      var v = evalAst(node.a, x);
      if (node.name === 'sin') return Math.sin(v);
      if (node.name === 'cos') return Math.cos(v);
      if (node.name === 'tan') return Math.tan(v);
      if (node.name === 'sqrt') return Math.sqrt(v);
      if (node.name === 'abs') return Math.abs(v);
      if (node.name === 'log' || node.name === 'ln') return Math.log(v);
      if (node.name === 'exp') return Math.exp(v);
      return NaN;
    }
    return NaN;
  }

  function parse(text) {
    if (typeof text !== 'string') {
      return { ok: false, error: '函数表达式必须是一段文字' };
    }
    if (!text.replace(/\s+/g, '')) {
      return { ok: false, error: '式子不能为空，先输入一个函数吧' };
    }
    try {
      var tokens = tokenize(text);
      var ast = new Parser(tokens).parseAll();
      return {
        ok: true,
        fn: function (x) {
          var v = evalAst(ast, Number(x));
          return typeof v === 'number' ? v : NaN;
        }
      };
    } catch (e) {
      var msg = e && e.message ? e.message : '式子无法解析，请检查写法';
      if (!/[一-龥]/.test(msg)) msg = '式子有语法错误：' + msg;
      return { ok: false, error: msg };
    }
  }

  function evalAt(text, x) {
    var r = parse(text);
    if (!r.ok) return NaN;
    try {
      var v = r.fn(x);
      return isNum(v) ? v : NaN;
    } catch (e) {
      return NaN;
    }
  }

  /* ============================================================
     2. 几何、边界与弹道
     ============================================================ */
  function readBound(b, keys, dflt) {
    if (!b) return dflt;
    for (var i = 0; i < keys.length; i++) {
      var v = b[keys[i]];
      if (isNum(v)) return v;
    }
    return dflt;
  }

  function normBounds(b) {
    if (Array.isArray(b) && b.length >= 4) {
      b = { x0: b[0], x1: b[1], y0: b[2], y1: b[3] };
    }
    if (!b || typeof b !== 'object') b = {};
    var x0 = readBound(b, ['x0', 'xmin', 'minX', 'left'], WORLD.x0);
    var x1 = readBound(b, ['x1', 'xmax', 'maxX', 'right'], WORLD.x1);
    var y0 = readBound(b, ['y0', 'ymin', 'minY', 'bottom'], WORLD.y0);
    var y1 = readBound(b, ['y1', 'ymax', 'maxY', 'top'], WORLD.y1);
    if (x0 > x1) { var tx = x0; x0 = x1; x1 = tx; }
    if (y0 > y1) { var ty = y0; y0 = y1; y1 = ty; }
    return { x0: x0, x1: x1, y0: y0, y1: y1 };
  }

  function distToObstacle(px, py, ob) {
    if (!ob) return Infinity;
    var dx = Number(px) - Number(ob.x);
    var dy = Number(py) - Number(ob.y);
    if (!isFinite(dx) || !isFinite(dy)) return Infinity;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function obstacleAlive(ob) {
    return !!ob && !(isNum(Number(ob.hp)) && Number(ob.hp) <= 0);
  }

  function obstacleRadius(ob) {
    var r = Number(ob && ob.r);
    return isNum(r) && r > 0 ? r : 1.5;
  }

  function insideHole(ob, px, py) {
    var holes = (ob && Array.isArray(ob.holes)) ? ob.holes : null;
    if (!holes || !holes.length) return false;
    for (var i = 0; i < holes.length; i++) {
      var h = holes[i];
      var hr = Number(h && h.r);
      if (!isFinite(hr) || hr <= 0) continue;
      var dx = Number(px) - Number(h.x);
      var dy = Number(py) - Number(h.y);
      if (isFinite(dx) && isFinite(dy) && dx * dx + dy * dy < hr * hr) return true;
    }
    return false;
  }

  // 这个点是不是还实心：在圆里、且不在任何被炸出来的洞里
  function solidAt(ob, px, py) {
    if (!ob || !obstacleAlive(ob)) return false;
    var dx = Number(px) - Number(ob.x);
    var dy = Number(py) - Number(ob.y);
    if (!isFinite(dx) || !isFinite(dy)) return false;
    var r = obstacleRadius(ob) + 1e-3;   // 弹道点四舍五入到 6 位，边界留一点容差
    if (dx * dx + dy * dy > r * r) return false;
    return !insideHole(ob, px, py);
  }

  // 挖空就别留一个看不见的圆；采样够判断了
  function hasSolid(ob) {
    var r = obstacleRadius(ob);
    // 17×17 采样：洞只占球的一角时，另一侧还剩实心，不能整块删掉
    var steps = 8;
    for (var i = -steps; i <= steps; i++) {
      for (var j = -steps; j <= steps; j++) {
        if (solidAt(ob,
          Number(ob.x) + (i / steps) * r * 0.97,
          Number(ob.y) + (j / steps) * r * 0.97)) return true;
      }
    }
    return false;
  }

  // 炮弹打中障碍：在落点炸出一个固定半径的圆洞，洞是可以穿过去的（没有碰撞箱）
  function addHole(ob, x, y, r) {
    if (!ob) return;
    if (!Array.isArray(ob.holes)) ob.holes = [];
    ob.holes.push({
      x: roundNum(Number(x) || 0, 3),
      y: roundNum(Number(y) || 0, 3),
      r: roundNum(r > 0 ? r : HOLE_R, 3)
    });
    if (ob.holes.length > 24) ob.holes = ob.holes.slice(ob.holes.length - 24);
    delete ob.hp;
  }

  function closeToObstacle(ob, px, py) {
    var dx = Number(px) - Number(ob.x);
    var dy = Number(py) - Number(ob.y);
    var r = obstacleRadius(ob);
    return isFinite(dx) && isFinite(dy) && dx * dx + dy * dy <= (r + 0.15) * (r + 0.15);
  }

  function segmentCircleRange(x1, y1, x2, y2, ob) {
    var cx = Number(ob.x), cy = Number(ob.y), r = obstacleRadius(ob);
    var dx = x2 - x1, dy = y2 - y1;
    var fx = x1 - cx, fy = y1 - cy;
    var a = dx * dx + dy * dy;
    var b = 2 * (fx * dx + fy * dy);
    var c = fx * fx + fy * fy - r * r;
    if (a < 1e-14) return c <= 0 ? { t1: 0, t2: 0 } : null;
    var disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    var sd = Math.sqrt(disc);
    var t1 = (-b - sd) / (2 * a);
    var t2 = (-b + sd) / (2 * a);
    // 浮点误差：弹道最后一段常常正好停在圆边上，t 会算出 1.0000000009
    var eps = 1e-7;
    if (t2 < -eps || t1 > 1 + eps) return null;
    return { t1: Math.max(0, t1), t2: Math.min(1, t2) };
  }

  function segmentCircleT(x1, y1, x2, y2, ob) {
    var rr = segmentCircleRange(x1, y1, x2, y2, ob);
    if (!rr) {
      // 弹道点会四舍五入到 6 位；最后一段可能刚好落在圆面上、解析解算成「不相交」。
      // 端点实心就按命中处理，不然墙永远炸不出洞。
      if (solidAt(ob, x2, y2)) return 1;
      if (solidAt(ob, x1, y1)) return 0;
      return null;
    }
    // 没洞：还是原来的解析解，快
    if (!Array.isArray(ob.holes) || !ob.holes.length) return rr.t1;
    // 有洞：只在这一段和圆的交叠区间里采样，找第一个实心点
    var steps = 10;
    for (var s = 0; s <= steps; s++) {
      var t = rr.t1 + (rr.t2 - rr.t1) * (s / steps);
      if (solidAt(ob, x1 + (x2 - x1) * t, y1 + (y2 - y1) * t)) return t;
    }
    return null;
  }

  function firstObstacleOnSegment(p, q, obstacles) {
    var best = null;
    for (var i = 0; i < obstacles.length; i++) {
      var ob = obstacles[i];
      if (!obstacleAlive(ob)) continue;
      var t = segmentCircleT(p[0], p[1], q[0], q[1], ob);
      if (t != null && (!best || t < best.t)) {
        best = {
          index: i,
          t: t,
          point: [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]
        };
      }
    }
    return best;
  }

  function firstObstacleAtPoint(p, obstacles) {
    for (var i = 0; i < obstacles.length; i++) {
      if (solidAt(obstacles[i], p[0], p[1])) {
        return { index: i, t: 0, point: [p[0], p[1]] };
      }
    }
    return null;
  }

  function firstObstacleOnPath(points, obstacles) {
    if (!points || points.length < 1) return null;
    var at = firstObstacleAtPoint(points[0], obstacles);
    if (at) return at;
    for (var i = 1; i < points.length; i++) {
      var hit = firstObstacleOnSegment(points[i - 1], points[i], obstacles);
      if (hit) return hit;
    }
    return null;
  }

  function emptyTrajectory(error) {
    return {
      points: [],
      hitObstacle: false,
      obstacleIndex: -1,
      blockedAt: null,
      error: error || ''
    };
  }

  function trajectory(opts) {
    opts = opts || {};
    var b = normBounds(opts.bounds);
    var x0 = Number(opts.x0);
    var y0 = Number(opts.y0);
    if (!isFinite(x0)) x0 = 0;
    if (!isFinite(y0)) y0 = 0;
    var dir = Number(opts.dir) < 0 ? -1 : 1;
    var mode = opts.mode === 'y2' ? 'y2' : 'y';
    var obstacles = Array.isArray(opts.obstacles) ? opts.obstacles : [];
    var parsed;
    if (typeof opts.fnText === 'function') {
      parsed = { ok: true, fn: opts.fnText };
    } else {
      parsed = parse(String(opts.fnText == null ? '' : opts.fnText));
    }
    if (!parsed.ok) return emptyTrajectory(parsed.error);

    if (x0 < b.x0 - 1e-9 || x0 > b.x1 + 1e-9 || y0 < b.y0 - 1e-9 || y0 > b.y1 + 1e-9) {
      return emptyTrajectory('士兵不在战场范围内');
    }

    var points = [[x0, y0]];
    var result = {
      points: points,
      hitObstacle: false,
      obstacleIndex: -1,
      blockedAt: null,
      error: ''
    };

    var startHit = firstObstacleAtPoint(points[0], obstacles);
    if (startHit) {
      result.hitObstacle = true;
      result.obstacleIndex = startHit.index;
      result.blockedAt = startHit.point;
      return result;
    }

    if (mode === 'y') {
      var f0 = parsed.fn(x0);
      if (!isNum(f0)) return emptyTrajectory('函数在士兵位置算不出有限值');
      var x = x0;
      for (var i = 0; i < MAX_PATH; i++) {
        var nx = x + dir * NORMAL_STEP;
        if (nx < b.x0 - 1e-9 || nx > b.x1 + 1e-9) break;
        var fv = parsed.fn(nx);
        if (!isNum(fv)) break;
        var ny = y0 + (fv - f0);
        if (!isNum(ny)) break;
        if (ny < b.y0 - 1e-9 || ny > b.y1 + 1e-9) break;
        var segHit = firstObstacleOnSegment([x, points[points.length - 1][1]], [nx, ny], obstacles);
        if (segHit) {
          var contact = segHit.point;
          var last = points[points.length - 1];
          if (Math.abs(contact[0] - last[0]) > 1e-9 || Math.abs(contact[1] - last[1]) > 1e-9) {
            points.push([roundNum(contact[0], 6), roundNum(contact[1], 6)]);
          }
          result.hitObstacle = true;
          result.obstacleIndex = segHit.index;
          result.blockedAt = [roundNum(contact[0], 6), roundNum(contact[1], 6)];
          return result;
        }
        points.push([roundNum(nx, 6), roundNum(ny, 6)]);
        x = nx;
      }
      return result;
    }

    /* y'' = f(x)：RK4，步长固定 0.05（带方向的 x 步长）。 */
    var angle = clamp(Number(opts.angle) || 0, -80, 80);
    var slope = Math.tan(angle * Math.PI / 180) * dir;
    var cx = x0, cy = y0, cv = slope;
    var h = RK_STEP * dir;
    for (var k = 0; k < MAX_PATH; k++) {
      var nx2 = cx + h;
      if (nx2 < b.x0 - 1e-9 || nx2 > b.x1 + 1e-9) break;
      var f1 = parsed.fn(cx);
      var f2 = parsed.fn(cx + h / 2);
      var f3 = f2;
      var f4 = parsed.fn(cx + h);
      if (!isNum(f1) || !isNum(f2) || !isNum(f3) || !isNum(f4)) break;
      var k1y = cv, k1v = f1;
      var k2y = cv + h * k1v / 2, k2v = f2;
      var k3y = cv + h * k2v / 2, k3v = f3;
      var k4y = cv + h * k3v, k4v = f4;
      var ny2 = cy + h * (k1y + 2 * k2y + 2 * k3y + k4y) / 6;
      var nv = cv + h * (k1v + 2 * k2v + 2 * k3v + k4v) / 6;
      if (!isNum(ny2) || !isNum(nv) || Math.abs(ny2) > 1e7 || Math.abs(nv) > 1e7) break;
      if (ny2 < b.y0 - 1e-9 || ny2 > b.y1 + 1e-9) break;
      var segHit2 = firstObstacleOnSegment([cx, cy], [nx2, ny2], obstacles);
      if (segHit2) {
        points.push([roundNum(segHit2.point[0], 6), roundNum(segHit2.point[1], 6)]);
        result.hitObstacle = true;
        result.obstacleIndex = segHit2.index;
        result.blockedAt = [roundNum(segHit2.point[0], 6), roundNum(segHit2.point[1], 6)];
        return result;
      }
      cx = nx2;
      cy = ny2;
      cv = nv;
      points.push([roundNum(cx, 6), roundNum(cy, 6)]);
    }
    return result;
  }

  function segmentDist2(px, py, x1, y1, x2, y2) {
    var dx = x2 - x1, dy = y2 - y1;
    var l2 = dx * dx + dy * dy;
    var t = 0;
    if (l2 > 1e-14) {
      t = ((px - x1) * dx + (py - y1) * dy) / l2;
      t = clamp(t, 0, 1);
    }
    var qx = x1 + dx * t;
    var qy = y1 + dy * t;
    var ex = px - qx, ey = py - qy;
    return { d2: ex * ex + ey * ey, t: t };
  }

  function pathHitList(st, seat, points) {
    var out = [];
    if (!points || points.length < 1) return out;
    var soldiers = (st && st.soldiers) || [];
    for (var i = 0; i < soldiers.length; i++) {
      var s = soldiers[i];
      if (s.seat === seat) continue;
      if (s.alive === false || Number(s.hp) <= 0) continue;
      if ((st.mode || 'ffa') === 'team' && (s.seat % 2) === (seat % 2)) continue;
      var best = { d2: Infinity, seg: 0, t: 0 };
      if (points.length === 1) {
        var dx = points[0][0] - s.x, dy = points[0][1] - s.y;
        best.d2 = dx * dx + dy * dy;
        best.seg = 0;
        best.t = 0;
      } else {
        for (var p = 1; p < points.length; p++) {
          var d = segmentDist2(s.x, s.y, points[p - 1][0], points[p - 1][1], points[p][0], points[p][1]);
          if (d.d2 < best.d2) {
            best.d2 = d.d2;
            best.seg = p - 1;
            best.t = d.t;
          }
        }
      }
      if (best.d2 <= HIT_R * HIT_R) {
        out.push({
          seat: s.seat,
          dmg: DAMAGE,
          at: [s.x, s.y],
          seg: best.seg,
          t: best.t,
          d2: best.d2
        });
      }
    }
    out.sort(function (a, b) {
      if (a.seg !== b.seg) return a.seg - b.seg;
      return a.t - b.t;
    });
    return out;
  }

  /* ============================================================
     3. 局面、回合与结算
     ============================================================ */
  function normalizeN(n) {
    n = Math.floor(Number(n));
    if (!isFinite(n)) n = 2;
    return clamp(n, 2, 8);
  }

  function teams(n) {
    var map = {};
    var count = Math.floor(Number(n)) || 0;
    for (var i = 1; i <= count; i++) {
      map[i] = (i % 2 === 1) ? TEAM_RED : TEAM_BLUE;
    }
    return map;
  }

  function teamOf(seat) {
    return seat % 2 === 1 ? TEAM_RED : TEAM_BLUE;
  }

  function makeRng(seed) {
    if (seed == null) return Math.random;
    var s;
    if (typeof seed === 'number') {
      s = (seed >>> 0) || 1;
    } else {
      s = 2166136261;
      var str = String(seed);
      for (var i = 0; i < str.length; i++) {
        s ^= str.charCodeAt(i);
        s = Math.imul ? Math.imul(s, 16777619) >>> 0 : (s * 16777619) >>> 0;
      }
      s = s || 1;
    }
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  function facingDir(st, s) {
    var list = (st && st.soldiers) || [];
    var best = Infinity, dir = s.dir || 1;
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (t.seat === s.seat) continue;
      if (t.alive === false || Number(t.hp) <= 0) continue;
      if ((st.mode || 'ffa') === 'team' && (t.seat % 2) === (s.seat % 2)) continue;
      var dx = t.x - s.x, dy = t.y - s.y;
      var d = dx * dx + dy * dy;
      if (d < best) {
        best = d;
        dir = dx < 0 ? -1 : 1;
      }
    }
    return dir;
  }

  function autoFace(st) {
    var list = (st && st.soldiers) || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].alive === false || Number(list[i].hp) <= 0) continue;
      list[i].dir = facingDir(st, list[i]);
    }
    return st;
  }

  function sideY(count, idx) {
    var presets = [
      [0],
      [-3, 3],
      [-5, 0, 5],
      [-7, -2.35, 2.35, 7]
    ];
    var arr = presets[clamp(count, 1, 4) - 1];
    return arr[clamp(idx, 0, arr.length - 1)];
  }

  function placementOk(x, y, r, soldiers, obstacles) {
    if (x - r < WORLD.x0 + 0.35 || x + r > WORLD.x1 - 0.35) return false;
    if (y - r < WORLD.y0 + 0.35 || y + r > WORLD.y1 - 0.35) return false;
    for (var i = 0; i < soldiers.length; i++) {
      var s = soldiers[i];
      var dx = s.x - x, dy = s.y - y;
      if (Math.sqrt(dx * dx + dy * dy) < r + SOLDIER_R + 1.25) return false;
    }
    for (var k = 0; k < obstacles.length; k++) {
      var o = obstacles[k];
      var ox = o.x - x, oy = o.y - y;
      // 球和球之间留一点缝：洞才不会互相盖住，炸出来的缺口看得见
      if (Math.sqrt(ox * ox + oy * oy) < r + obstacleRadius(o) + 0.8) return false;
    }
    return true;
  }

  // v2.159：出生点随机。2 人固定一左一右；3 人以上随机撒开，只要求互相隔开。
  // 障碍一共 5 个球，球和球之间留缝，炸出来的洞才看得见；人不会生成在球里。
  var HOLE_R = 1.4;

  function newState(n, mode, seed) {
    n = normalizeN(n);
    mode = mode === 'team' ? 'team' : 'ffa';
    if (seed && typeof seed === 'object') {
      if (seed.seed != null) seed = seed.seed;
      else seed = null;   // 外壳传的是 {players,seats,teamMode}，没有 seed 就真随机
    }
    var rnd = makeRng(seed);
    var soldiers = [];
    var i, tries;

    if (n === 2) {
      // 两个人：左边一个、右边一个，位置随机但远离边界。
      soldiers.push({
        seat: 1, x: roundNum(-19 + rnd() * 6, 3), y: roundNum(-9 + rnd() * 18, 3),
        hp: HP_MAX, alive: true, dir: 1
      });
      soldiers.push({
        seat: 2, x: roundNum(13 + rnd() * 6, 3), y: roundNum(-9 + rnd() * 18, 3),
        hp: HP_MAX, alive: true, dir: -1
      });
    } else {
      // 3 人以上：随机位置，互相至少隔 7.2；实在放不下就退回一圈。
      for (i = 1; i <= n; i++) {
        var spot = null;
        for (tries = 0; tries < 600 && !spot; tries++) {
          var sx = -20 + rnd() * 40;
          var sy = -11 + rnd() * 22;
          var free = true;
          for (var q = 0; q < soldiers.length; q++) {
            var qx = soldiers[q].x - sx, qy = soldiers[q].y - sy;
            if (Math.sqrt(qx * qx + qy * qy) < 7.2) { free = false; break; }
          }
          if (free) spot = { x: sx, y: sy };
        }
        if (!spot) {
          var ang = (i / n) * Math.PI * 2;
          spot = { x: Math.cos(ang) * 17, y: Math.sin(ang) * 10 };
        }
        soldiers.push({
          seat: i, x: roundNum(spot.x, 3), y: roundNum(spot.y, 3),
          hp: HP_MAX, alive: true, dir: spot.x <= 0 ? 1 : -1
        });
      }
    }
    soldiers.sort(function (a, b) { return a.seat - b.seat; });

    // 2 人时先放一个正中间的球，保证两人连线一定被挡住。
    var obstacles = [];
    if (n === 2) {
      var my = clamp((soldiers[0].y + soldiers[1].y) / 2, -8, 8);
      obstacles.push({ x: 0, y: roundNum(my, 3), r: 2.6, holes: [] });
    }

    // 补到 5 个球；互不重叠，也避开所有士兵。
    tries = 0;
    while (obstacles.length < 5 && tries < 3000) {
      tries++;
      var br = 2.0 + rnd() * 0.8;
      var bx = -14 + rnd() * 28;
      var by = -12 + rnd() * 24;
      if (!placementOk(bx, by, br, soldiers, obstacles)) continue;
      obstacles.push({ x: roundNum(bx, 3), y: roundNum(by, 3), r: roundNum(br, 3), holes: [] });
    }

    var st = {
      v: VERSION,
      n: n,
      mode: mode,
      turn: 1,
      round: 1,
      soldiers: soldiers,
      obstacles: obstacles,
      shots: [],
      usedFuncs: [],
      log: ['座位 1 先手 · 共 ' + n + ' 人'],
      finished: false,
      winner: 0
    };
    autoFace(st);
    return st;
  }

  function nextTurn(st) {
    if (!st) return 0;
    var n = Number(st.n);
    var list = st.soldiers || [];
    if (!isFinite(n) || n < 2) {
      n = 0;
      for (var i = 0; i < list.length; i++) n = Math.max(n, Number(list[i].seat) || 0);
    }
    if (n < 1) return 0;
    var map = {};
    for (var j = 0; j < list.length; j++) {
      map[list[j].seat] = list[j].alive !== false && Number(list[j].hp) > 0;
    }
    var current = Number(st.turn);
    if (!isFinite(current) || current < 1) current = 0;
    for (var k = 1; k <= n; k++) {
      var seat = ((current - 1 + k) % n + n) % n + 1;
      if (map[seat]) return seat;
    }
    return 0;
  }

  function advanceRound(st, next) {
    var cur = Number(st.turn);
    if (next !== cur && next < cur) st.round = (Number(st.round) || 1) + 1;
    st.turn = next;
    return st;
  }

  function resolveWinner(st) {
    var list = st.soldiers || [];
    var alive = [];
    var red = [], blue = [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].alive === false || Number(list[i].hp) <= 0) continue;
      alive.push(list[i]);
      if (list[i].seat % 2 === 1) red.push(list[i].seat);
      else blue.push(list[i].seat);
    }
    var winner = 0;
    var over = false;
    if ((st.mode || 'ffa') === 'team') {
      if (red.length === 0 && blue.length === 0) {
        over = true;
      } else if (red.length === 0) {
        over = true;
        winner = Math.min.apply(null, blue);
      } else if (blue.length === 0) {
        over = true;
        winner = Math.min.apply(null, red);
      }
    } else if (alive.length <= 1) {
      over = true;
      winner = alive.length ? alive[0].seat : 0;
    }
    return { over: over, winner: winner, alive: alive.length };
  }

  function capLog(log) {
    if (!Array.isArray(log)) log = [];
    if (log.length > 60) log = log.slice(log.length - 60);
    return log;
  }

  function compressPoints(points, max) {
    if (!Array.isArray(points)) return [];
    if (points.length <= max) {
      return points.map(function (p) { return [roundNum(Number(p[0]), 5), roundNum(Number(p[1]), 5)]; });
    }
    var out = [];
    var step = (points.length - 1) / (max - 1);
    for (var i = 0; i < max; i++) {
      var p = points[Math.round(i * step)];
      out.push([roundNum(Number(p[0]), 5), roundNum(Number(p[1]), 5)]);
    }
    return out;
  }

  function normFunction(text) {
    return String(text == null ? '' : text).replace(/\s+/g, '').toLowerCase();
  }

  function usedFunctions(st) {
    var out = [], seen = {};
    function add(v) {
      var n = normFunction(v);
      if (!n || seen[n]) return;
      seen[n] = true;
      out.push(n);
    }
    if (st && Array.isArray(st.usedFuncs)) {
      for (var i = 0; i < st.usedFuncs.length; i++) add(st.usedFuncs[i]);
    }
    if (st && Array.isArray(st.shots)) {
      for (var j = 0; j < st.shots.length; j++) add(st.shots[j] && st.shots[j].fnText);
    }
    return out;
  }

  function applyShot(state, seat, shot) {
    if (!state) return state;
    var st = copyState(state);
    if (!Array.isArray(st.log)) st.log = [];
    shot = shot || {};
    var usedFns = usedFunctions(st);
    var shooter = soldierOf(st, seat);
    if (!shooter) return st;
    if (isNum(Number(shot.dir))) shooter.dir = Number(shot.dir) < 0 ? -1 : 1;

    var points = Array.isArray(shot.points) ? shot.points : [];
    var hits = [];
    var seen = {};
    if (Array.isArray(shot.hits)) {
      for (var h = 0; h < shot.hits.length; h++) {
        var hs = Number(shot.hits[h] && shot.hits[h].seat);
        if (!hs || seen[hs] || hs === seat) continue;
        if (!aliveSoldier(st, hs)) continue;
        if ((st.mode || 'ffa') === 'team' && (hs % 2) === (seat % 2)) continue;
        seen[hs] = true;
        hits.push({ seat: hs, dmg: DAMAGE });
      }
    }
    /* 物理路径经过了谁，也一并结算；避免只信客户端上交的 hits。 */
    var derived = pathHitList(st, seat, points);
    for (var d = 0; d < derived.length; d++) {
      if (seen[derived[d].seat]) continue;
      seen[derived[d].seat] = true;
      hits.push({ seat: derived[d].seat, dmg: DAMAGE });
    }

    var obsBefore = st.obstacles || [];
    var carved = [];
    var raw = Array.isArray(shot.destroyed) && shot.destroyed.length ? shot.destroyed :
      (shot.hitObstacle && Number(shot.obstacleIndex) >= 0 ? [Number(shot.obstacleIndex)] : null);
    if (!raw || !raw.length) {
      var found = firstObstacleOnPath(points, obsBefore);
      raw = found ? [found.index] : [];
    }
    var contact = Array.isArray(shot.blockedAt) ? shot.blockedAt :
      (points.length ? points[points.length - 1] : null);
    var used = {};
    for (var q = 0; q < raw.length; q++) {
      var idx = Number(raw[q]);
      if (!isFinite(idx) || idx < 0 || idx >= obsBefore.length || used[idx]) continue;
      used[idx] = true;
      var ob = obsBefore[idx];
      if (!obstacleAlive(ob)) continue;
      // 落点不在这个障碍上（索引过期/客户端乱报）就退到它的圆心
      var hx = contact && isFinite(Number(contact[0])) ? Number(contact[0]) : Number(ob.x);
      var hy = contact && isFinite(Number(contact[1])) ? Number(contact[1]) : Number(ob.y);
      if (!closeToObstacle(ob, hx, hy)) { hx = Number(ob.x); hy = Number(ob.y); }
      addHole(ob, hx, hy, HOLE_R);
      carved.push(idx);
      st.log.push(seatLabel(seat) + ' 在障碍上炸出一个洞');
    }
    if (carved.length) {
      // 整块被挖空的障碍删掉；还剩一圈的留着
      st.obstacles = obsBefore.filter(function (o) {
        return obstacleAlive(o) && hasSolid(o);
      });
    }

    var damaged = [];
    for (var m = 0; m < hits.length; m++) {
      var target = soldierOf(st, hits[m].seat);
      if (!target || target.alive === false || Number(target.hp) <= 0) continue;
      target.hp = Math.max(0, Number(target.hp) - DAMAGE);
      target.alive = target.hp > 0;
      damaged.push(hits[m].seat);
      st.log.push(seatLabel(seat) + ' 命中 ' + seatLabel(target.seat) + ' -' + DAMAGE);
    }
    if (!damaged.length && !carved.length) {
      st.log.push(seatLabel(seat) + ' 的炮弹落空了');
    }

    var rec = {
      seat: seat,
      fnText: String(shot.fnText == null ? '' : shot.fnText),
      mode: shot.mode === 'y2' ? 'y2' : 'y',
      angle: isNum(Number(shot.angle)) ? Number(shot.angle) : 0,
      dir: shooter.dir,
      points: compressPoints(points, 180),
      hits: hits.map(function (x) { return { seat: x.seat, dmg: DAMAGE }; }),
      destroyed: carved.slice()
    };
    if (carved.length) {
      rec.hitObstacle = true;
      rec.obstacleIndex = carved[0];
      rec.blockedAt = contact && isFinite(Number(contact[0]))
        ? [Number(contact[0]), Number(contact[1])] : null;
    }
    st.shots = Array.isArray(st.shots) ? st.shots : [];
    // 累计炮数：shots 只留最近 10 发，回看/观战靠它判断「是不是又来了一炮」
    var seqBefore = Number(st.shotSeq);
    if (!isFinite(seqBefore)) seqBefore = Math.max(0, st.shots.length);
    st.shotSeq = seqBefore + 1;
    st.shots.push(rec);
    if (st.shots.length > 10) st.shots = st.shots.slice(st.shots.length - 10);
    st.log = capLog(st.log);

    var win = resolveWinner(st);
    st.finished = win.over;
    st.winner = win.over ? win.winner : 0;
    if (win.over) {
      st.log.push(win.winner ? seatLabel(win.winner) + ' 获胜' : '本局结束');
      st.log = capLog(st.log);
    }
    var shotFn = normFunction(shot.fnText);
    if (shotFn && usedFns.indexOf(shotFn) < 0) usedFns.push(shotFn);
    st.usedFuncs = usedFns;
    return st;
  }

  /* ============================================================
     3.5 回放：按记录里的动作把一局重演（v2.152）
     ------------------------------------------------------------
     记录只存「谁、什么函数、什么模式、角度、方向」，不存弹道；
     这里用同一套 trajectory() 重算，和当时发射的弹道完全一致。
     ============================================================ */

  function shotFromAction(st, seat, act) {
    if (!st || !act) return null;
    var sd = soldierOf(st, seat);
    if (!sd) return null;
    var mode = act.mode === 'y2' ? 'y2' : 'y';
    var angle = isNum(Number(act.angle)) ? Number(act.angle) : 0;
    var dir = Number(act.dir) < 0 ? -1 : 1;
    var fnText = String(act.expr == null ? '' : act.expr);
    var tr = trajectory({
      fnText: fnText,
      mode: mode,
      angle: angle,
      x0: sd.x,
      y0: sd.y,
      dir: dir,
      bounds: WORLD,
      obstacles: st.obstacles || []
    });
    if (!tr.points || tr.points.length < 2) return null;
    var hits = pathHitList(st, seat, tr.points).map(function (h) {
      var target = soldierOf(st, h.seat);
      return { seat: h.seat, dmg: DAMAGE, at: target ? [target.x, target.y] : h.at };
    });
    return {
      seat: seat, fnText: fnText, mode: mode, angle: angle, dir: dir,
      points: tr.points, hits: hits,
      hitObstacle: !!tr.hitObstacle,
      obstacleIndex: tr.obstacleIndex,
      blockedAt: tr.blockedAt
    };
  }

  function applyAction(state, seat, act) {
    if (!state || typeof state !== 'object' || !act) return null;
    var st = copyState(state);
    var type = String(act.type || '');
    if (type === 'init') {
      return (act.state && typeof act.state === 'object') ? copyState(act.state) : st;
    }
    var who = Number(seat) || Number(act.seat) || Number(st.turn) || 0;
    if (!who) return null;

    if (type === 'timeout') {
      var nt = nextTurn(st);
      if (!nt) return st;
      st.log = capLog((st.log || []).concat(['座位 ' + who + ' 超时，跳过']));
      return advanceStateTurn(st, nt);
    }

    if (type === 'shot') {
      var shot = shotFromAction(st, who, act);
      if (!shot) return null;
      var next = applyShot(st, who, shot);
      if (next.finished) {
        next.turn = Number(next.winner) || next.turn;
        return next;
      }
      var after = nextTurn(next);
      if (after) advanceStateTurn(next, after);
      return next;
    }

    return st;
  }

  /* ============================================================
     4. 浏览器界面
     ------------------------------------------------------------
     下面所有变量都在模块作用域，但只有 mount 之后才会碰 DOM。
     ============================================================ */
  var GW_CSS = [
    '.gw-shell{--gw-red:var(--seal,#a33228);--gw-blue:#4f6f99;--gw-red-soft:rgba(163,50,40,.10);--gw-blue-soft:rgba(79,111,153,.12);width:100%;color:var(--ink,#191713);font-family:var(--sans,"PingFang SC","Microsoft YaHei",sans-serif);font-size:14px;line-height:1.5;}',
    '.gw-shell *{box-sizing:border-box}',
    '.gw-shell button{font:inherit}',
    '.gw-shell button:focus-visible{outline:2px solid var(--seal,#a33228);outline-offset:2px}',
    '.gw-shell [hidden]{display:none!important}',
    '.gw-head{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;margin:0 0 10px}',
    '.gw-kicker{font-family:var(--mono,monospace);font-size:10px;letter-spacing:.16em;color:var(--gold,#a9873f);text-transform:uppercase;margin-bottom:1px}',
    '.gw-title{font-family:var(--serif,serif);font-size:21px;line-height:1.2;color:var(--ink,#191713);letter-spacing:.035em;margin:0}',
    '.gw-title span{font-family:var(--mono,monospace);font-size:10px;font-weight:400;letter-spacing:.02em;color:var(--ink-3,#8a8375);margin-left:8px;white-space:nowrap}',
    '.gw-round{font-family:var(--mono,monospace);font-size:10.5px;letter-spacing:.06em;color:var(--ink-3,#8a8375);text-align:right;white-space:nowrap;padding-bottom:2px}',
    '.gw-players{display:grid;grid-template-columns:repeat(auto-fit,minmax(112px,1fr));gap:6px;margin-bottom:10px}',
    '.gw-player{--gwc:var(--seal,#a33228);position:relative;display:flex;align-items:center;gap:7px;min-width:0;padding:7px 8px;background:var(--card,#fffdf7);border:1px solid var(--line,#e2d9c7);border-radius:calc(var(--radius,4px) + 2px);overflow:hidden;transition:border-color .16s,opacity .16s}',
    '.gw-player.is-current{border-color:var(--gwc);box-shadow:inset 0 0 0 1px var(--gwc)}',
    '.gw-player.is-current:before{content:"";position:absolute;left:0;top:0;bottom:0;width:2px;background:var(--gwc)}',
    '.gw-player.is-dead{opacity:.42;filter:grayscale(.7)}',
    '.gw-av{flex:0 0 auto;width:29px;height:29px;border-radius:var(--radius,4px);background:var(--gwc);color:#fff;display:flex;align-items:center;justify-content:center;font-family:var(--serif,serif);font-weight:700;font-size:15px;line-height:1;user-select:none}',
    '.gw-pmain{min-width:0;flex:1}',
    '.gw-pname{display:flex;align-items:center;gap:4px;min-width:0;font-size:12px;font-weight:600;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--ink,#191713)}',
    '.gw-pname em{flex:0 0 auto;font-style:normal;font-family:var(--mono,monospace);font-size:8px;line-height:1.35;padding:0 3px;border-radius:2px;color:var(--gwc);background:var(--card,#fffdf7);border:1px solid currentColor;transform:scale(.92);transform-origin:left center}',
    '.gw-psub{display:flex;align-items:center;gap:5px;margin-top:1px;font-family:var(--mono,monospace);font-size:8.5px;line-height:1.35;letter-spacing:.02em;color:var(--ink-3,#8a8375);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.gw-psub i{font-style:normal;color:var(--gwc)}',
    '.gw-hp{height:3px;margin-top:4px;border-radius:99px;background:var(--line,#e2d9c7);overflow:hidden}',
    '.gw-hp u{display:block;height:100%;width:100%;border-radius:99px;background:var(--jade,#2c6a5b);transition:width .3s ease}',
    '.gw-player.is-low .gw-hp u{background:var(--seal,#a33228)}',
    '.gw-hpnum{flex:0 0 auto;font-family:var(--mono,monospace);font-size:9px;color:var(--ink-3,#8a8375);align-self:flex-end}',
    '.gw-c-red{--gwc:var(--gw-red)}.gw-c-blue{--gwc:var(--gw-blue)}',
    '.gw-c-jade{--gwc:var(--jade,#2c6a5b)}.gw-c-seal{--gwc:var(--seal,#a33228)}',
    '.gw-c-gold{--gwc:var(--gold,#a9873f)}.gw-c-ink{--gwc:var(--ink-2,#4b463c)}',
    '.gw-emptyplayers{margin:0 0 10px;padding:12px;border:1px dashed var(--line-2,#cfc3ab);border-radius:var(--radius,4px);color:var(--ink-3,#8a8375);font-size:12px;text-align:center}',
    '.gw-stage{position:relative;overflow:hidden;border:1px solid var(--line-2,#cfc3ab);border-radius:calc(var(--radius,4px) + 4px);background:#fbf7ec;box-shadow:var(--shadow-1,0 1px 2px rgba(25,23,19,.05))}',
    '.gw-canvas{display:block;width:100%;height:clamp(300px,52vh,540px);background:#fbf7ec;touch-action:none;cursor:grab;user-select:none;-webkit-user-select:none}',
    '.gw-canvas.is-drag{cursor:grabbing}',
    '.gw-overlay{position:absolute;inset:0;z-index:5;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;padding:24px;text-align:center;background:rgba(248,244,233,.82)}',
    '.gw-overlay b{font-family:var(--serif,serif);font-size:21px;font-weight:700;letter-spacing:.06em;color:var(--ink,#191713)}',
    '.gw-overlay p{margin:0;max-width:420px;font-size:12.5px;line-height:1.7;color:var(--ink-3,#8a8375)}',
    '.gw-overlay .gw-wait-seal{width:44px;height:44px;margin-bottom:4px;border:1px solid var(--line-2,#cfc3ab);border-radius:50%;display:flex;align-items:center;justify-content:center;font-family:var(--serif,serif);font-size:21px;color:var(--seal,#a33228);background:var(--card,#fffdf7)}',
    '.gw-zoombar{position:absolute;z-index:3;top:10px;right:10px;display:flex;gap:4px}',
    '.gw-zbtn{width:29px;height:29px;padding:0;border:1px solid var(--line-2,#cfc3ab);border-radius:var(--radius,4px);background:var(--card,#fffdf7);color:var(--ink-2,#4b463c);font-family:var(--mono,monospace);font-size:15px;line-height:1;cursor:pointer;opacity:.92}',
    '.gw-zbtn:hover{opacity:1;color:var(--seal,#a33228)}',
    '.gw-modebadge{position:absolute;z-index:3;left:10px;top:10px;padding:4px 8px;border:1px solid var(--line,#e2d9c7);border-radius:var(--radius,4px);background:rgba(255,253,247,.86);font-family:var(--mono,monospace);font-size:10px;letter-spacing:.05em;color:var(--ink-2,#4b463c);pointer-events:none}',
    '.gw-canvas-tip{position:absolute;z-index:2;right:12px;bottom:9px;font-family:var(--mono,monospace);font-size:9px;letter-spacing:.04em;color:var(--ink-3,#8a8375);opacity:.8;pointer-events:none}',
    '.gw-result{position:absolute;inset:0;z-index:8;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(25,23,19,.58);overflow:auto}',
    '.gw-result-card{width:100%;max-width:470px;max-height:100%;overflow:auto;padding:19px 19px 14px;background:var(--card,#fffdf7);border:1px solid var(--line-2,#cfc3ab);border-radius:calc(var(--radius,4px) + 5px);box-shadow:0 18px 60px -24px rgba(0,0,0,.55)}',
    '.gw-result-top{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:6px}',
    '.gw-result-kicker{font-family:var(--mono,monospace);font-size:9px;letter-spacing:.18em;color:var(--gold,#a9873f);text-transform:uppercase;margin-bottom:3px}',
    '.gw-result-title{margin:0;font-family:var(--serif,serif);font-size:22px;line-height:1.25;color:var(--ink,#191713);letter-spacing:.02em}',
    '.gw-result-sub{margin:0 0 12px;font-size:12px;line-height:1.65;color:var(--ink-3,#8a8375)}',
    '.gw-result-close{flex:0 0 auto;width:28px;height:28px;border:1px solid var(--line,#e2d9c7);border-radius:var(--radius,4px);background:var(--card,#fffdf7);color:var(--ink-3,#8a8375);font-family:var(--mono,monospace);font-size:14px;line-height:1;cursor:pointer}',
    '.gw-result-close:hover{color:var(--seal,#a33228);border-color:var(--seal,#a33228)}',
    '.gw-rank{display:flex;flex-direction:column;gap:4px;margin:10px 0 3px}',
    '.gw-rank-row{display:flex;align-items:center;gap:8px;padding:6px 7px;border:1px solid var(--line,#e2d9c7);border-radius:var(--radius,4px);background:var(--card-2,#fbf6ea)}',
    '.gw-rank-row.is-win{border-color:var(--gold,#a9873f);background:rgba(169,135,63,.07)}',
    '.gw-rank-no{flex:0 0 20px;text-align:center;font-family:var(--mono,monospace);font-size:10px;color:var(--ink-3,#8a8375)}',
    '.gw-rank-av{width:24px;height:24px;border-radius:var(--radius,4px);background:var(--gwc,var(--seal));color:#fff;display:flex;align-items:center;justify-content:center;font-family:var(--serif,serif);font-size:12px;font-weight:700}',
    '.gw-rank-main{min-width:0;flex:1;font-size:12px;font-weight:600;color:var(--ink,#191713);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.gw-rank-meta{font-family:var(--mono,monospace);font-size:9px;font-weight:400;color:var(--ink-3,#8a8375);margin-left:5px}',
    '.gw-rank-hp{font-family:var(--mono,monospace);font-size:9.5px;color:var(--ink-2,#4b463c);white-space:nowrap}',
    '.gw-panel{margin-top:10px;padding:10px 11px 11px;background:var(--card,#fffdf7);border:1px solid var(--line,#e2d9c7);border-radius:calc(var(--radius,4px) + 3px);box-shadow:var(--shadow-1,0 1px 2px rgba(25,23,19,.04))}',
    '.gw-toolrow{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-bottom:8px}',
    '.gw-chip{display:inline-flex;align-items:center;justify-content:center;gap:4px;min-height:28px;padding:4px 9px;border:1px solid var(--line-2,#cfc3ab);border-radius:var(--radius,4px);background:var(--card,#fffdf7);color:var(--ink-2,#4b463c);font-size:11.5px;cursor:pointer;white-space:nowrap}',
    '.gw-chip:hover:not(:disabled){border-color:var(--seal,#a33228);color:var(--seal,#a33228)}',
    '.gw-chip:disabled{opacity:.38;cursor:not-allowed}',
    '.gw-modebtn{font-family:var(--mono,monospace);letter-spacing:.02em;color:var(--jade,#2c6a5b);border-color:var(--jade,#2c6a5b)}',
    '.gw-modebtn:hover:not(:disabled){color:var(--jade,#2c6a5b);border-color:var(--jade,#2c6a5b);background:var(--card-2,#fbf6ea)}',
    '.gw-flip b{font-family:var(--mono,monospace);color:var(--seal,#a33228);font-weight:700}',
    '.gw-angle{display:inline-flex;align-items:center;gap:3px;min-height:28px;padding:2px 4px 2px 8px;border:1px solid var(--line,#e2d9c7);border-radius:var(--radius,4px);background:var(--card-2,#fbf6ea);font-size:10.5px;color:var(--ink-3,#8a8375);white-space:nowrap}',
    '.gw-angle b{min-width:38px;text-align:center;font-family:var(--mono,monospace);font-size:11px;color:var(--ink,#191713);font-weight:700}',
    '.gw-angle button{width:25px;height:24px;padding:0;border:1px solid var(--line-2,#cfc3ab);border-radius:3px;background:var(--card,#fffdf7);color:var(--ink-2,#4b463c);font-size:12px;line-height:1;cursor:pointer}',
    '.gw-angle button:disabled{opacity:.35;cursor:not-allowed}',
    '.gw-clock{margin-left:auto;min-height:28px;display:inline-flex;align-items:center;font-family:var(--mono,monospace);font-size:10.5px;letter-spacing:.02em;color:var(--ink-3,#8a8375);white-space:nowrap}',
    '.gw-clock.is-live{color:var(--seal,#a33228);font-weight:700}',
    '.gw-clock.is-low{animation:gw-pulse 1s steps(1) infinite}',
    '@keyframes gw-pulse{50%{opacity:.38}}',
    '@keyframes gw-blink{50%{opacity:0}}',
    '.gw-exprline{display:flex;align-items:center;gap:8px;min-height:44px;padding:8px 11px;border:1px solid var(--line-2,#cfc3ab);border-radius:var(--radius,4px);background:var(--card-2,#fbf6ea);transition:border-color .16s,box-shadow .16s}',
    '.gw-exprline.is-bad{border-color:var(--seal,#a33228);box-shadow:inset 0 0 0 1px var(--seal,#a33228)}',
    '.gw-prefix{flex:0 0 auto;font-family:var(--mono,monospace);font-size:14px;color:var(--ink-3,#8a8375);user-select:none}',
    '.gw-expr{flex:1;min-width:0;min-height:22px;font-family:var(--mono,monospace);font-size:16px;letter-spacing:.015em;line-height:1.45;word-break:break-all;color:var(--ink,#191713)}',
    '.gw-ph{font-family:var(--sans,"PingFang SC","Microsoft YaHei",sans-serif);font-size:12px;color:var(--ink-3,#8a8375)}',
    '.gw-caret{display:inline-block;width:1px;height:1.12em;margin-left:1px;vertical-align:-2px;background:var(--seal,#a33228);animation:gw-blink 1s steps(1) infinite}',
    '.gw-tok-num{color:var(--ink,#191713)}',
    '.gw-tok-op{color:var(--seal,#a33228);font-weight:700}',
    '.gw-tok-fn{color:var(--jade,#2c6a5b);font-weight:700}',
    '.gw-tok-var{color:var(--gold,#a9873f);font-weight:700}',
    '.gw-tok-const{color:var(--gold,#a9873f);font-weight:600}',
    '.gw-tok-paren{color:var(--ink-2,#4b463c);font-weight:600}',
    '.gw-tok-paren.gw-pair-0{color:var(--jade,#2c6a5b);background:rgba(44,106,91,.11)}',
    '.gw-tok-paren.gw-pair-1{color:var(--seal,#a33228);background:rgba(163,50,40,.09)}',
    '.gw-tok-paren.gw-pair-2{color:var(--gold,#a9873f);background:rgba(169,135,63,.11)}',
    '.gw-tok-bad{color:var(--seal,#a33228);text-decoration:underline wavy var(--seal,#a33228);text-underline-offset:2px}',
    '.gw-err{min-height:17px;margin:4px 1px 0;font-family:var(--sans,"PingFang SC",sans-serif);font-size:11.5px;line-height:1.45;color:var(--seal,#a33228)}',
    '.gw-const{margin:2px 1px 0;font-family:var(--mono,monospace);font-size:10.5px;line-height:1.45;color:var(--ink-3,#8a8375);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.gw-tip{margin:0 1px 7px;font-size:11px;line-height:1.55;color:var(--ink-3,#8a8375)}',
    '.gw-tip b{font-family:var(--mono,monospace);color:var(--jade,#2c6a5b);font-weight:700}',
    '.gw-keys{display:flex;flex-direction:column;gap:5px}',
    '.gw-keyrow{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:5px}',
    '.gw-keyrow.is-wide{grid-template-columns:repeat(3,minmax(0,1fr))}',
    '.gw-key{min-height:35px;padding:4px 2px;border:1px solid var(--line-2,#cfc3ab);border-radius:var(--radius,4px);background:var(--card,#fffdf7);color:var(--ink,#191713);font-family:var(--mono,monospace);font-size:13px;line-height:1.2;cursor:pointer;touch-action:manipulation;transition:background .12s ease,transform .06s ease}',
    '.gw-key:hover:not(:disabled){background:var(--card-2,#fbf6ea);border-color:var(--ink-3,#8a8375)}',
    '.gw-key:active:not(:disabled){transform:translateY(1px)}',
    '.gw-key.is-fn{color:var(--jade,#2c6a5b);font-weight:700}',
    '.gw-key.is-op{color:var(--seal,#a33228);font-weight:700}',
    '.gw-key.is-const{color:var(--gold,#a9873f);font-weight:700}',
    '.gw-key:disabled{opacity:.34;cursor:not-allowed}',
    '.gw-key.is-wide{font-family:var(--sans,"PingFang SC",sans-serif);font-size:12px}',
    '.gw-foot{display:flex;align-items:center;gap:12px;margin-top:9px}',
    '.gw-status{min-width:0;flex:1;font-size:11.5px;line-height:1.5;color:var(--ink-3,#8a8375)}',
    '.gw-status b{color:var(--ink,#191713);font-weight:600}',
    '.gw-status .gw-watch{display:inline-block;margin-right:5px;padding:1px 5px;border:1px solid var(--line-2,#cfc3ab);border-radius:2px;font-family:var(--mono,monospace);font-size:9px;color:var(--ink-2,#4b463c)}',
    '.gw-fire{flex:0 0 auto;min-width:112px;min-height:42px;padding:8px 19px;border:1px solid var(--seal,#a33228);border-radius:var(--radius,4px);background:var(--seal,#a33228);color:#fff;font-family:var(--serif,serif);font-size:15px;font-weight:700;letter-spacing:.18em;line-height:1.3;cursor:pointer;transition:background .15s,opacity .15s}',
    '.gw-fire:hover:not(:disabled){background:var(--seal-2,#c04a3b);border-color:var(--seal-2,#c04a3b)}',
    '.gw-fire:disabled{background:var(--ink-3,#8a8375);border-color:var(--ink-3,#8a8375);opacity:.42;cursor:not-allowed}',
    '.gw-fire.is-busy{letter-spacing:.1em}',
    '@media (max-width:640px){',
    '.gw-head{align-items:flex-start}.gw-title{font-size:18px}.gw-title span{display:none}.gw-players{grid-template-columns:repeat(auto-fit,minmax(104px,1fr))}.gw-canvas{height:clamp(275px,46vh,430px)}.gw-panel{padding:9px 9px 10px}.gw-key{min-height:36px;font-size:12px}.gw-fire{min-width:96px;padding:8px 14px;font-size:14px}.gw-clock{font-size:9.5px}.gw-expr{font-size:15px}.gw-result{padding:11px}.gw-result-card{padding:15px 14px 12px}',
    '}',
    '@media (max-width:460px){',
    '.gw-players{grid-template-columns:repeat(2,minmax(0,1fr))}.gw-keyrow{gap:4px}.gw-keys{gap:4px}.gw-angle{order:5}.gw-clock{order:4;width:100%;justify-content:flex-end;min-height:19px}.gw-foot{flex-wrap:wrap}.gw-status{flex:1 1 100%}.gw-fire{width:100%;min-width:0}.gw-chip{padding:4px 7px;font-size:11px}.gw-modebadge{display:none}',
    '}',
    'html[data-mode="night"] .gw-shell{color:var(--ink,#ece9f2)}',
    'html[data-mode="night"] .gw-title,html[data-mode="night"] .gw-pname,html[data-mode="night"] .gw-expr,html[data-mode="night"] .gw-angle b,html[data-mode="night"] .gw-status b,html[data-mode="night"] .gw-result-title,html[data-mode="night"] .gw-rank-main{color:var(--ink,#ece9f2)}',
    'html[data-mode="night"] .gw-player{background:var(--card,#1b1b23);border-color:var(--line,#2b2b36)}',
    'html[data-mode="night"] .gw-pname em{background:var(--card,#1b1b23)}',
    'html[data-mode="night"] .gw-modebadge{background:rgba(27,27,35,.88);border-color:var(--line-2,#3b3b49);color:var(--ink-2,#b6b2c2)}',
    'html[data-mode="night"] .gw-stage,html[data-mode="night"] .gw-canvas{background:#101218}',
    'html[data-mode="night"] .gw-overlay{background:rgba(12,13,19,.82)}',
    'html[data-mode="night"] .gw-overlay b{color:var(--ink,#ece9f2)}',
    'html[data-mode="night"] .gw-overlay .gw-wait-seal{background:var(--card,#1b1b23);border-color:var(--line-2,#3b3b49);color:var(--seal,#a48bdb)}',
    'html[data-mode="night"] .gw-zbtn{background:rgba(27,27,35,.92);border-color:var(--line-2,#3b3b49);color:var(--ink,#ece9f2)}',
    'html[data-mode="night"] .gw-zbtn:hover{color:var(--seal,#a48bdb)}',
    'html[data-mode="night"] .gw-panel,html[data-mode="night"] .gw-result-card{background:var(--card,#1b1b23);border-color:var(--line,#2b2b36)}',
    'html[data-mode="night"] .gw-chip,html[data-mode="night"] .gw-key,html[data-mode="night"] .gw-zbtn,html[data-mode="night"] .gw-angle button,html[data-mode="night"] .gw-result-close{background:var(--card-2,#22222c);border-color:var(--line-2,#3b3b49);color:var(--ink,#ece9f2)}',
    'html[data-mode="night"] .gw-key:hover:not(:disabled),html[data-mode="night"] .gw-chip:hover:not(:disabled){background:#2b2c38;border-color:var(--ink-3,#7d7a8c)}',
    'html[data-mode="night"] .gw-exprline{background:#161720;border-color:var(--line-2,#3b3b49)}',
    'html[data-mode="night"] .gw-angle{background:#161720;border-color:var(--line,#2b2b36)}',
    'html[data-mode="night"] .gw-rank-row{background:var(--card-2,#22222c);border-color:var(--line,#2b2b36)}',
    'html[data-mode="night"] .gw-rank-row.is-win{border-color:var(--gold,#c9a86a);background:rgba(201,168,106,.08)}',
    'html[data-mode="night"] .gw-result{background:rgba(5,6,10,.76)}',
    'html[data-mode="night"] .gw-hp{background:var(--line,#2b2b36)}',
    'html[data-mode="night"] .gw-tok-num{color:var(--ink,#ece9f2)}',
    'html[data-mode="night"] .gw-tok-paren.gw-pair-0{background:rgba(111,168,179,.14)}',
    'html[data-mode="night"] .gw-tok-paren.gw-pair-1{background:rgba(164,139,219,.15)}',
    'html[data-mode="night"] .gw-tok-paren.gw-pair-2{background:rgba(201,168,106,.13)}',
    'html[data-mode="night"] .gw-fire{background:var(--seal,#a48bdb);border-color:var(--seal,#a48bdb);color:#15131b}',
    'html[data-mode="night"] .gw-fire:hover:not(:disabled){background:var(--seal-2,#bda6ec);border-color:var(--seal-2,#bda6ec)}',
    'html[data-mode="night"] .gw-fire:disabled{background:var(--ink-3,#7d7a8c);border-color:var(--ink-3,#7d7a8c);color:#15131b}'
  ].join('\n');

  var view = {
    root: null, ctx: null, mounted: false,
    dom: {}, bound: [], unsub: null,
    cam: { cx: 0, cy: 0, scale: 1 },
    cssW: 0, cssH: 0, dpr: 1,
    expr: '', mode: 'y', angle: 20, flipped: false,
    parseRes: { ok: false, error: '' },
    preview: null, previewTimer: 0,
    clockTimer: 0, turnKey: '', turnDeadline: 0, timeoutSent: false,
    submitted: false, anim: null, raf: 0,
    resultDismissed: '', lastStatus: '',
    initialized: false, initSent: false,
    statusText: '', resizeObs: null
  };

  var KEY_ROWS = [
    [
      { text: '7', add: '7', cls: 'num' }, { text: '8', add: '8', cls: 'num' },
      { text: '9', add: '9', cls: 'num' }, { text: '+', add: '+', cls: 'op' },
      { text: '−', add: '-', cls: 'op' }, { text: '(', add: '(', cls: 'paren' },
      { text: ')', add: ')', cls: 'paren' }
    ],
    [
      { text: '4', add: '4', cls: 'num' }, { text: '5', add: '5', cls: 'num' },
      { text: '6', add: '6', cls: 'num' }, { text: '*', add: '*', cls: 'op' },
      { text: '/', add: '/', cls: 'op' }, { text: '^', add: '^', cls: 'op' },
      { text: 'x', add: 'x', cls: 'var' }
    ],
    [
      { text: '1', add: '1', cls: 'num' }, { text: '2', add: '2', cls: 'num' },
      { text: '3', add: '3', cls: 'num' }, { text: 'sin', add: 'sin(', cls: 'fn' },
      { text: 'cos', add: 'cos(', cls: 'fn' }, { text: 'tan', add: 'tan(', cls: 'fn' },
      { text: 'sqrt', add: 'sqrt(', cls: 'fn' }
    ],
    [
      { text: '0', add: '0', cls: 'num' }, { text: '.', add: '.', cls: 'num' },
      { text: 'e', add: 'e', cls: 'const' }, { text: 'pi', add: 'pi', cls: 'const' },
      { text: 'log', add: 'log(', cls: 'fn' }, { text: 'ln', add: 'ln(', cls: 'fn' },
      { text: 'exp', add: 'exp(', cls: 'fn' }
    ]
  ];

  function gwEl(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = String(text);
    return e;
  }

  function injectStyle() {
    if (!document.getElementById) return;
    if (document.getElementById('gw-style')) return;
    var s = document.createElement('style');
    s.id = 'gw-style';
    s.textContent = GW_CSS;
    (document.head || document.getElementsByTagName('head')[0] || document.body).appendChild(s);
  }

  function bind(target, ev, fn, opt) {
    if (!target || !target.addEventListener) return;
    target.addEventListener(ev, fn, opt || false);
    view.bound.push([target, ev, fn, opt || false]);
  }

  function ctxToast(msg) {
    try {
      if (view.ctx && typeof view.ctx.toast === 'function') view.ctx.toast(msg);
      else if (window.B8 && typeof window.B8.toast === 'function') window.B8.toast(msg);
      else if (window.console && console.log) console.log(msg);
    } catch (e) {}
  }

  function ctxStatus(msg) {
    if (view.lastStatus === msg) return;
    view.lastStatus = msg;
    try {
      if (view.ctx && typeof view.ctx.setStatus === 'function') view.ctx.setStatus(msg);
    } catch (e) {}
  }

  function mySeat() {
    var n = Number(view.ctx && view.ctx.seat);
    return isFinite(n) ? n : 0;
  }

  /* v2.152：回看模式（外壳传 ctx.replay = {index,total}） */
  function replayOf() {
    var rp = view.ctx && view.ctx.replay;
    return rp && rp.on ? rp : null;
  }

  function isReplay() {
    return !!replayOf();
  }

  function replayText() {
    var rp = replayOf();
    if (!rp) return '';
    return rp.total ? ('回看 · 第 ' + rp.index + ' / ' + rp.total + ' 手') : '回看 · 只有终局';
  }

  function room() {
    return view.ctx && view.ctx.room ? view.ctx.room : null;
  }

  function roomStatus() {
    var r = room();
    return r && r.status ? String(r.status) : '';
  }

  function isWaiting() {
    return roomStatus() === 'wait';
  }

  function gameState() {
    var a = view.ctx ? view.ctx.state : null;
    if (a && Array.isArray(a.soldiers) && a.soldiers.length) return a;
    var b = room() ? room().state : null;
    if (b && Array.isArray(b.soldiers) && b.soldiers.length) return b;
    return null;
  }

  function displayedState() {
    if (view.anim && view.anim.base) return view.anim.base;
    return gameState();
  }

  function gameOver(st) {
    if (isReplay()) return !!(st && st.finished);
    if (roomStatus() === 'over') return true;
    return !!(st && st.finished);
  }

  function winnerSeat(st) {
    var r = room();
    var w = r && r.winner != null ? Number(r.winner) : 0;
    if (w > 0) return w;
    w = st && st.winner != null ? Number(st.winner) : 0;
    return w > 0 ? w : 0;
  }

  function playerName(seat) {
    var list = (view.ctx && view.ctx.players) || [];
    for (var i = 0; i < list.length; i++) {
      if (Number(list[i].seat) === Number(seat) && list[i].name) return String(list[i].name);
    }
    var r = room();
    var seats = (r && r.seats) || [];
    for (var j = 0; j < seats.length; j++) {
      if (Number(seats[j].seat) === Number(seat) && seats[j].name) return String(seats[j].name);
    }
    if (view.ctx && view.ctx.me && Number(view.ctx.me.seat) === Number(seat) && view.ctx.me.name) {
      return String(view.ctx.me.name);
    }
    return '座位 ' + seat;
  }

  function initialOf(seat) {
    var n = playerName(seat).replace(/^\s+/, '');
    return n ? n.charAt(0) : String(seat);
  }

  function colorClassFor(st, seat) {
    if (st && st.mode === 'team') return seat % 2 === 1 ? 'gw-c-red' : 'gw-c-blue';
    if (mySeat() > 0) return Number(seat) === mySeat() ? 'gw-c-jade' : 'gw-c-seal';
    return seat % 2 === 1 ? 'gw-c-gold' : 'gw-c-jade';
  }

  function teamNameOf(st, seat) {
    if (!st || st.mode !== 'team') return '';
    return seat % 2 === 1 ? TEAM_RED : TEAM_BLUE;
  }

  function statusActive() {
    var s = roomStatus();
    return s !== 'wait' && s !== 'over';
  }

  function canEdit() {
    if (!view.mounted || !view.ctx || view.anim || view.submitted) return false;
    var seat = mySeat();
    if (seat < 1) return false;
    var st = gameState();
    var r = room();
    if (!st || !r || isWaiting() || gameOver(st)) return false;
    if (Number(st.turn) !== seat) return false;
    return aliveSoldier(st, seat);
  }

  function stateIsMine(st) {
    return !!st && mySeat() > 0 && Number(st.turn) === mySeat();
  }

  function currentSoldier(st) {
    return st ? soldierOf(st, mySeat()) : null;
  }

  function activeDir(st) {
    var sd = currentSoldier(st);
    if (!sd) return 1;
    var base = facingDir(st, sd);
    return view.flipped ? -base : base;
  }

  function namesForDamage(st) {
    var map = {};
    var shots = (st && st.shots) || [];
    for (var i = 0; i < shots.length; i++) {
      var hits = shots[i].hits || [];
      for (var j = 0; j < hits.length; j++) {
        var seat = Number(hits[j].seat);
        map[seat] = (map[seat] || 0) + (Number(hits[j].dmg) || DAMAGE);
      }
    }
    return map;
  }

  /* ---------- DOM ---------- */
  function buildDom(root) {
    var shell = gwEl('div', 'gw-shell');
    shell.innerHTML = [
      '<div class="gw-head">',
      '  <div>',
      '    <div class="gw-kicker">B8 ARCADE · GRAPHWAR</div>',
      '    <h3 class="gw-title">ƒ 函数大战 <span>输入函数，让炮弹沿曲线飞</span></h3>',
      '  </div>',
      '  <div class="gw-round" data-ref="round">等待开局</div>',
      '</div>',
      '<div class="gw-players" data-ref="players"></div>',
      '<div class="gw-stage" data-ref="stage">',
      '  <canvas class="gw-canvas" data-ref="canvas"></canvas>',
      '  <div class="gw-modebadge" data-ref="badge">y = f(x)</div>',
      '  <div class="gw-zoombar">',
      '    <button type="button" class="gw-zbtn" data-ref="zoomout" aria-label="缩小" title="缩小">−</button>',
      '    <button type="button" class="gw-zbtn" data-ref="zoomin" aria-label="放大" title="放大">+</button>',
      '    <button type="button" class="gw-zbtn" data-ref="zoomreset" aria-label="复位视野" title="复位视野">⌂</button>',
      '  </div>',
      '  <div class="gw-canvas-tip">拖拽平移 · +/− 缩放</div>',
      '  <div class="gw-overlay" data-ref="wait" hidden>',
      '    <div class="gw-wait-seal">ƒ</div>',
      '    <b data-ref="waitTitle">等房主开局</b>',
      '    <p data-ref="waitSub">房主按下开始后，会自动生成战场、随机出生点和四五个可以炸穿的障碍球。</p>',
      '  </div>',
      '  <div class="gw-result" data-ref="result" hidden>',
      '    <div class="gw-result-card">',
      '      <div class="gw-result-top">',
      '        <div><div class="gw-result-kicker">BATTLE REPORT</div><h4 class="gw-result-title" data-ref="resultTitle">战斗结束</h4></div>',
      '        <button type="button" class="gw-result-close" data-ref="resultClose" aria-label="关闭战绩">×</button>',
      '      </div>',
      '      <p class="gw-result-sub" data-ref="resultSub"></p>',
      '      <div class="gw-rank" data-ref="rank"></div>',
      '    </div>',
      '  </div>',
      '</div>',
      '<div class="gw-panel">',
      '  <div class="gw-toolrow">',
      '    <button type="button" class="gw-chip gw-modebtn" data-ref="mode" title="切换普通 / 二阶模式">y = f(x) ⇄</button>',
      '    <button type="button" class="gw-chip gw-flip" data-ref="flip" title="掉头，改变曲线前进方向">掉头 <b data-ref="dir">→</b></button>',
      '    <span class="gw-angle" data-ref="angleWrap" hidden>发射角度 <button type="button" data-ref="angleDown" aria-label="发射角度减小 3 度">↓</button><b data-ref="angleVal">20°</b><button type="button" data-ref="angleUp" aria-label="发射角度增加 3 度">↑</button></span>',
      '    <span class="gw-clock" data-ref="clock">等房主开局</span>',
      '  </div>',
      '  <div class="gw-exprline" data-ref="exprLine">',
      '    <span class="gw-prefix" data-ref="prefix">y =</span>',
      '    <div class="gw-expr" data-ref="expr" role="textbox" aria-readonly="true" aria-label="函数表达式，只读；请使用屏幕键盘输入"></div>',
      '  </div>',
      '  <div class="gw-const" data-ref="constHint" hidden></div>',
      '  <div class="gw-err" data-ref="err"></div>',
      '  <div class="gw-tip" data-ref="tip"></div>',
      '  <div class="gw-keys" data-ref="keys"></div>',
      '  <div class="gw-foot">',
      '    <div class="gw-status" data-ref="status"></div>',
      '    <button type="button" class="gw-fire" data-ref="fire" disabled>发 射</button>',
      '  </div>',
      '</div>'
    ].join('');
    root.innerHTML = '';
    root.appendChild(shell);

    var refs = {};
    var nodes = shell.querySelectorAll('[data-ref]');
    for (var i = 0; i < nodes.length; i++) {
      refs[nodes[i].getAttribute('data-ref')] = nodes[i];
    }
    view.dom = refs;
    view.dom.shell = shell;

    buildKeys(refs.keys);
  }

  function buildKeys(keys) {
    keys.innerHTML = '';
    for (var r = 0; r < KEY_ROWS.length; r++) {
      var row = gwEl('div', 'gw-keyrow');
      for (var c = 0; c < KEY_ROWS[r].length; c++) {
        var k = KEY_ROWS[r][c];
        var btn = gwEl('button', 'gw-key' + (k.cls === 'fn' ? ' is-fn' : (k.cls === 'op' ? ' is-op' : (k.cls === 'const' ? ' is-const' : ''))), k.text);
        btn.type = 'button';
        btn.setAttribute('data-add', k.add);
        btn.setAttribute('data-kind', k.cls);
        btn.setAttribute('aria-label', k.cls === 'fn' ? k.text + ' 函数，自动补左括号' : k.text);
        bind(btn, 'click', onKeyClick);
        row.appendChild(btn);
      }
      keys.appendChild(row);
    }
    var wide = gwEl('div', 'gw-keyrow is-wide');
    var ab = gwEl('button', 'gw-key is-fn is-wide', 'abs');
    ab.type = 'button';
    ab.setAttribute('data-add', 'abs(');
    ab.setAttribute('data-kind', 'fn');
    ab.setAttribute('aria-label', 'abs 函数，自动补左括号');
    bind(ab, 'click', onKeyClick);
    var wb = gwEl('button', 'gw-key is-wide', '⌫ 删除');
    wb.type = 'button';
    wb.setAttribute('data-act', 'backspace');
    bind(wb, 'click', onSpecialKey);
    var cb = gwEl('button', 'gw-key is-wide', '清空');
    cb.type = 'button';
    cb.setAttribute('data-act', 'clear');
    bind(cb, 'click', onSpecialKey);
    wide.appendChild(ab);
    wide.appendChild(wb);
    wide.appendChild(cb);
    keys.appendChild(wide);
  }

  function keyButtonOf(el) {
    while (el && el !== view.dom.keys) {
      if (el.getAttribute && el.getAttribute('data-add') != null) return el;
      if (el.getAttribute && el.getAttribute('data-act')) return el;
      el = el.parentNode;
    }
    return null;
  }

  function onKeyClick(ev) {
    var btn = ev.currentTarget;
    if (!canEdit()) {
      if (gameState() && !gameOver(gameState()) && mySeat() > 0) {
        var st = gameState();
        if (stateIsMine(st)) ctxToast('炮弹飞行中，稍等一下');
        else ctxToast('还没轮到你');
      }
      return;
    }
    appendKey(btn.getAttribute('data-add'), btn.getAttribute('data-kind'));
  }

  function onSpecialKey(ev) {
    if (!canEdit()) return;
    if (ev.currentTarget.getAttribute('data-act') === 'backspace') {
      if (view.expr.length) {
        view.expr = view.expr.slice(0, -1);
        afterInput();
      }
    } else {
      if (view.expr) {
        view.expr = '';
        afterInput();
      }
    }
  }

  function endsWithValue(s) {
    return /(?:[0-9x)])$/.test(s) || /(?:pi|e)$/.test(s);
  }

  function appendKey(add, kind) {
    if (!add) return;
    if (view.expr.length + add.length > 200) {
      ctxToast('函数太长了，最多 200 个字符');
      return;
    }
    var s = view.expr;
    var needsMul = false;
    if (s && endsWithValue(s)) {
      if (kind === 'fn' || add === 'x' || add === 'pi' || add === 'e' || add === '(') {
        needsMul = true;
      } else if (/^[0-9]$/.test(add) && !/[0-9.]$/.test(s)) {
        needsMul = true;
      }
    }
    view.expr += (needsMul ? '*' : '') + add;
    afterInput();
  }

  function afterInput() {
    revalidate();
    if (!view.parseRes.ok) view.preview = null;
    updateExprView();
    updateControls();
    schedulePreview();
    drawStatic();
  }

  function revalidate() {
    if (!view.expr) {
      view.parseRes = { ok: false, error: '', empty: true };
      return;
    }
    view.parseRes = parse(view.expr);
  }

  function updateExprView() {
    var box = view.dom.expr;
    if (!box) return;
    box.innerHTML = '';
    var src = view.expr;
    if (!src) {
      box.appendChild(gwEl('span', 'gw-ph', canEdit()
        ? '点下面的屏幕键输入函数…'
        : (isReplay() ? '回看中，不能操作' : (mySeat() === 0 ? '观战中，不能输入' : '等待你的回合…'))));
      var c0 = gwEl('span', 'gw-caret');
      c0.setAttribute('aria-hidden', 'true');
      box.appendChild(c0);
      box.setAttribute('aria-label', '函数表达式：空');
      return;
    }
    var toks = scanHighlight(src);
    var stack = [];
    var i;
    for (i = 0; i < toks.length; i++) {
      if (toks[i].kind === 'paren' && toks[i].text === '(') {
        stack.push(i);
      } else if (toks[i].kind === 'paren' && toks[i].text === ')') {
        if (stack.length) {
          var open = stack.pop();
          var depth = stack.length % 3;
          toks[open].pair = depth;
          toks[i].pair = depth;
        } else {
          toks[i].bad = true;
        }
      }
    }
    while (stack.length) toks[stack.pop()].bad = true;
    var frag = document.createDocumentFragment();
    for (i = 0; i < toks.length; i++) {
      var t = toks[i];
      var sp = gwEl('span');
      var cls = 'gw-tok-' + t.kind;
      if (t.kind === 'paren' && t.pair != null) cls += ' gw-pair-' + t.pair;
      if (t.bad) cls += ' gw-tok-bad';
      sp.className = cls;
      sp.textContent = t.text;
      frag.appendChild(sp);
    }
    var caret = gwEl('span', 'gw-caret');
    caret.setAttribute('aria-hidden', 'true');
    frag.appendChild(caret);
    box.appendChild(frag);
    box.setAttribute('aria-label', '函数表达式：' + src);
  }

  function scanHighlight(src) {
    var out = [];
    var i = 0;
    while (i < src.length) {
      var c = src.charAt(i);
      if (isDigit(c) || (c === '.' && isDigit(src.charAt(i + 1)))) {
        var st = i;
        while (i < src.length && isDigit(src.charAt(i))) i++;
        if (src.charAt(i) === '.') {
          i++;
          while (i < src.length && isDigit(src.charAt(i))) i++;
        }
        if (src.charAt(i) === 'e' || src.charAt(i) === 'E') {
          var j = i + 1;
          if (src.charAt(j) === '+' || src.charAt(j) === '-') j++;
          if (isDigit(src.charAt(j))) {
            i = j;
            while (i < src.length && isDigit(src.charAt(i))) i++;
          }
        }
        out.push({ text: src.slice(st, i), kind: 'num' });
        continue;
      }
      if (isAlpha(c)) {
        var a = i;
        while (i < src.length && isAlpha(src.charAt(i))) i++;
        var word = src.slice(a, i);
        if (FUNCS[word]) out.push({ text: word, kind: 'fn' });
        else if (word === 'x') out.push({ text: word, kind: 'var' });
        else if (word === 'pi' || word === 'e') out.push({ text: word, kind: 'const' });
        else out.push({ text: word, kind: 'bad' });
        continue;
      }
      if ('+-*/^'.indexOf(c) >= 0) {
        out.push({ text: c, kind: 'op' });
        i++;
        continue;
      }
      if (c === '(' || c === ')') {
        out.push({ text: c, kind: 'paren', pair: null });
        i++;
        continue;
      }
      out.push({ text: c, kind: 'bad' });
      i++;
    }
    return out;
  }

  function updateError() {
    if (!view.dom.exprLine) return;
    var bad = !!(view.expr && view.parseRes && !view.parseRes.ok);
    view.dom.exprLine.classList[bad ? 'add' : 'remove']('is-bad');
    view.dom.err.textContent = bad ? (view.parseRes.error || '函数有语法错误') : '';
  }

  function fmtConst(v) {
    if (!isNum(v)) return '—';
    var a = Math.abs(v);
    if (a >= 10000 || (a > 0 && a < 0.001)) return Number(v).toExponential(2);
    return String(Math.round(v * 100) / 100);
  }

  // 每次改函数都提示：常数项 f(0)，以及为了穿过自己会自动上下平移多少
  function updateConstHint() {
    var el = view.dom && view.dom.constHint;
    if (!el) return;
    var st = gameState();
    var sd = st ? currentSoldier(st) : null;
    var res = view.parseRes;
    if (isReplay() || !sd || !res || !res.ok || !view.expr) {
      el.hidden = true;
      el.textContent = '';
      return;
    }
    var c0 = null, shift = null;
    try { c0 = res.fn(0); } catch (e) { c0 = null; }
    if (view.mode === 'y2') {
      el.textContent = '常数 f(0) = ' + fmtConst(c0);
    } else {
      var f0 = null;
      try { f0 = res.fn(sd.x); } catch (e) { f0 = null; }
      if (isNum(f0)) shift = sd.y - f0;
      el.textContent = '常数 f(0) = ' + fmtConst(c0) + ' · 自动平移 ' + fmtConst(shift);
    }
    el.hidden = false;
  }

  /* ---------- 玩家栏、战绩、状态 ---------- */
  function renderPlayers(st) {
    var box = view.dom.players;
    if (!box) return;
    box.innerHTML = '';
    if (!st) {
      box.appendChild(gwEl('div', 'gw-emptyplayers', isWaiting() ? '等房主开局，玩家就位后会显示在这里' : '正在同步玩家状态…'));
      return;
    }
    var list = (st.soldiers || []).slice().sort(function (a, b) { return a.seat - b.seat; });
    for (var i = 0; i < list.length; i++) {
      var sd = list[i];
      var hp = Number(sd.hp);
      if (!isFinite(hp)) hp = 0;
      var dead = sd.alive === false || hp <= 0;
      var current = Number(st.turn) === Number(sd.seat) && !gameOver(st);
      var self = mySeat() === Number(sd.seat);
      var card = gwEl('div', 'gw-player ' + colorClassFor(st, sd.seat) +
        (current ? ' is-current' : '') + (dead ? ' is-dead' : '') + (hp <= 35 ? ' is-low' : '') +
        (self ? ' is-self' : ''));
      card.setAttribute('data-seat', String(sd.seat));
      card.title = playerName(sd.seat) + ' · ' + (dead ? '已淘汰' : ('HP ' + hp + ' / ' + HP_MAX)) +
        (teamNameOf(st, sd.seat) ? ' · ' + teamNameOf(st, sd.seat) : '');
      var av = gwEl('div', 'gw-av', dead ? '×' : initialOf(sd.seat));
      av.setAttribute('aria-hidden', 'true');
      var main = gwEl('div', 'gw-pmain');
      var pname = gwEl('div', 'gw-pname');
      var nm = gwEl('span', '', playerName(sd.seat));
      nm.style.overflow = 'hidden';
      nm.style.textOverflow = 'ellipsis';
      pname.appendChild(nm);
      if (self) pname.appendChild(gwEl('em', '', '你'));
      var subText = '#' + sd.seat;
      if (st.mode === 'team') subText += ' · ' + teamNameOf(st, sd.seat);
      else subText += ' · ' + (dead ? '淘汰' : '混战');
      var psub = gwEl('div', 'gw-psub');
      var sub = gwEl('span', '', subText);
      psub.appendChild(sub);
      if (current) {
        var turnFlag = gwEl('i', '', '● 行动');
        psub.appendChild(turnFlag);
      }
      var hpBox = gwEl('div', 'gw-hp');
      var bar = gwEl('u');
      bar.style.width = clamp(hp, 0, HP_MAX) + '%';
      hpBox.appendChild(bar);
      main.appendChild(pname);
      main.appendChild(psub);
      main.appendChild(hpBox);
      var hpNum = gwEl('div', 'gw-hpnum', dead ? '×' : String(Math.round(hp)));
      card.appendChild(av);
      card.appendChild(main);
      card.appendChild(hpNum);
      box.appendChild(card);
    }
    if (!list.length) box.appendChild(gwEl('div', 'gw-emptyplayers', '等待玩家就位…'));
  }

  function resultSignature(st) {
    return [room() && room().id || '', winnerSeat(st), st && st.round, st && st.shots ? st.shots.length : 0].join('|');
  }

  function renderResult(st) {
    var box = view.dom.result;
    if (!box) return;
    if (isReplay() || !st || !gameOver(st) || view.anim) {
      box.hidden = true;
      return;
    }
    var sig = resultSignature(st);
    if (view.resultDismissed === sig) {
      box.hidden = true;
      return;
    }
    var win = winnerSeat(st);
    var title = '战斗结束';
    var sub = '第 ' + (st.round || 1) + ' 轮结束。';
    if (win) {
      if (st.mode === 'team') {
        title = teamNameOf(st, win) + '获胜';
      } else {
        title = playerName(win) + ' 获胜';
      }
      sub += ' 冠军是座位 ' + win + '「' + playerName(win) + '」';
      if (st.mode === 'team') sub += '（' + teamNameOf(st, win) + '）';
      sub += '。';
    } else {
      sub += ' 没有人生还。';
    }
    if (mySeat() > 0 && win) {
      var mine = st.mode === 'team' ? (mySeat() % 2 === win % 2) : (mySeat() === win);
      sub += mine ? ' 你赢了，漂亮。' : ' 下次再来。';
    } else if (mySeat() === 0) {
      sub += ' 观战结束。';
    }
    view.dom.resultTitle.textContent = title;
    view.dom.resultSub.textContent = sub;

    var dmg = namesForDamage(st);
    var rows = (st.soldiers || []).slice().sort(function (a, b) {
      var aa = a.alive !== false && Number(a.hp) > 0 ? 0 : 1;
      var bb = b.alive !== false && Number(b.hp) > 0 ? 0 : 1;
      if (aa !== bb) return aa - bb;
      var hpDiff = (Number(b.hp) || 0) - (Number(a.hp) || 0);
      if (hpDiff) return hpDiff;
      return (dmg[b.seat] || 0) - (dmg[a.seat] || 0);
    });
    view.dom.rank.innerHTML = '';
    for (var i = 0; i < rows.length; i++) {
      var sd = rows[i];
      var dead = sd.alive === false || Number(sd.hp) <= 0;
      var isWin = win > 0 && (st.mode === 'team' ? (sd.seat % 2 === win % 2) : (sd.seat === win));
      var row = gwEl('div', 'gw-rank-row ' + colorClassFor(st, sd.seat) + (isWin ? ' is-win' : ''));
      row.appendChild(gwEl('div', 'gw-rank-no', (i + 1) < 10 ? '0' + (i + 1) : String(i + 1)));
      row.appendChild(gwEl('div', 'gw-rank-av', dead ? '×' : initialOf(sd.seat)));
      var main = gwEl('div', 'gw-rank-main');
      main.appendChild(document.createTextNode(playerName(sd.seat)));
      var meta = '座位 ' + sd.seat + (teamNameOf(st, sd.seat) ? ' · ' + teamNameOf(st, sd.seat) : '') +
        ' · 伤害 ' + (dmg[sd.seat] || 0);
      main.appendChild(gwEl('span', 'gw-rank-meta', meta));
      row.appendChild(main);
      row.appendChild(gwEl('div', 'gw-rank-hp', dead ? '淘汰' : (Number(sd.hp) || 0) + ' HP'));
      view.dom.rank.appendChild(row);
    }
    box.hidden = false;
  }

  function updateRound(st) {
    if (!view.dom.round) return;
    if (!st) {
      view.dom.round.textContent = isWaiting() ? '等房主开局' : '同步中';
      return;
    }
    var modeName = st.mode === 'team' ? '红蓝组队' : '混战';
    view.dom.round.textContent = '第 ' + (st.round || 1) + ' 轮 · ' + modeName + ' · ' + (st.n || (st.soldiers || []).length) + ' 人';
  }

  function updateControls() {
    if (!view.dom.mode) return;
    var st = displayedState();
    var editable = canEdit();
    var modeTxt = view.mode === 'y2' ? "y'' = f(x)" : 'y = f(x)';
    view.dom.mode.textContent = modeTxt + ' ⇄';
    view.dom.mode.setAttribute('aria-label', '当前为 ' + (view.mode === 'y2' ? '二阶微分方程' : '普通函数') + '模式，点击切换');
    view.dom.prefix.textContent = view.mode === 'y2' ? "y'' =" : 'y =';
    view.dom.badge.textContent = view.mode === 'y2' ? "y'' = f(x) · 二阶" : 'y = f(x) · 普通';
    view.dom.angleWrap.hidden = view.mode !== 'y2';
    view.dom.angleVal.textContent = view.angle + '°';
    var showDir = st && stateIsMine(st) ? activeDir(st) : (st && currentSoldier(st) ? (currentSoldier(st).dir || 1) : 1);
    if (mySeat() < 1 && st && Number(st.turn) > 0) {
      var cs = soldierOf(st, st.turn);
      showDir = cs && cs.dir < 0 ? -1 : 1;
    }
    view.dom.dir.textContent = showDir < 0 ? '←' : '→';
    view.dom.flip.disabled = !editable;
    view.dom.mode.disabled = !editable;
    view.dom.angleUp.disabled = !editable || view.mode !== 'y2';
    view.dom.angleDown.disabled = !editable || view.mode !== 'y2';
    view.dom.fire.disabled = !(editable && view.expr && view.parseRes && view.parseRes.ok);
    view.dom.fire.classList[view.anim || view.submitted ? 'add' : 'remove']('is-busy');
    if (view.anim) view.dom.fire.textContent = '飞行中';
    else if (view.submitted) view.dom.fire.textContent = '同步中';
    else view.dom.fire.textContent = '发 射';
    if (view.mode === 'y2') {
      view.dom.tip.textContent = "二阶模式：输入 y'' = f(x)。从士兵位置按 0.05 步长积分，角度用 ↑ ↓ 调（-80° ~ 80°）。已经发射过的函数不能重复使用。";
    } else {
      view.dom.tip.textContent = '普通模式：输入 y = f(x)。曲线会自动上下平移经过你的士兵，沿面朝方向飞。已经发射过的函数不能重复使用。';
    }
    var keys = view.dom.keys ? view.dom.keys.querySelectorAll('.gw-key') : [];
    for (var i = 0; i < keys.length; i++) keys[i].disabled = !editable;
    updateExprView();
    updateError();
    updateConstHint();
  }

  function updateStatus(st) {
    if (!view.dom.status) return;
    if (isReplay()) {
      var rst = displayedState();
      var extra = rst ? shotOutcomeText(rst) : '';
      var rtxt = replayText() + (extra ? ' · ' + extra : '');
      view.dom.status.textContent = rtxt + ' · 只读';
      ctxStatus(rtxt);
      return;
    }
    var text = '';
    var summary = '';
    if (!st) {
      if (isWaiting()) {
        text = '等房主开局';
        summary = '等房主开局';
      } else if (gameOver(null) || roomStatus() === 'over') {
        text = '本局已结束';
        summary = '本局已结束';
      } else {
        text = mySeat() === 0 ? '正在同步战场…' : '正在同步开局，马上就好…';
        summary = text;
      }
    } else if (isWaiting()) {
      text = '等房主开局';
      summary = text;
    } else if (gameOver(st)) {
      var w = winnerSeat(st);
      text = '本局结束' + (w ? ' · ' + (st.mode === 'team' ? teamNameOf(st, w) : playerName(w)) + ' 获胜' : '');
      summary = '本局结束';
    } else if (view.anim) {
      text = '炮弹飞行中…';
      summary = '炮弹飞行中';
    } else if (view.submitted) {
      text = '发射已提交，等待房间同步…';
      summary = '等待同步';
    } else if (mySeat() === 0) {
      text = '观战中 · 第 ' + (st.round || 1) + ' 轮 · 座位 ' + st.turn + '「' + playerName(st.turn) + '」正在行动';
      summary = '观战中 · 座位 ' + st.turn + ' 行动';
    } else if (!aliveSoldier(st, mySeat())) {
      text = '你已淘汰 · 继续观战中';
      summary = '已淘汰 · 观战中';
    } else if (Number(st.turn) === mySeat()) {
      text = '轮到你了 · 用屏幕键输入函数，再点「发射」';
      summary = '第 ' + (st.round || 1) + ' 轮 · 轮到你';
    } else {
      text = '第 ' + (st.round || 1) + ' 轮 · 等 座位 ' + st.turn + '「' + playerName(st.turn) + '」开炮';
      summary = '第 ' + (st.round || 1) + ' 轮 · 座位 ' + st.turn + ' 行动';
    }
    view.dom.status.textContent = text;
    ctxStatus(summary);
  }

  function updateClock() {
    var el = view.dom.clock;
    if (!el) return;
    if (isReplay()) {
      el.textContent = '回看 · 只读';
      el.classList.remove('is-live');
      el.classList.remove('is-low');
      return;
    }
    var st = displayedState();
    var text = '';
    var live = false, low = false;
    if (!st) {
      text = isWaiting() ? '等房主开局' : (gameOver(null) ? '本局结束' : '同步中');
    } else if (isWaiting()) {
      text = '等房主开局';
    } else if (gameOver(st)) {
      text = '本局结束';
    } else if (view.anim) {
      text = '弹道飞行中';
      live = true;
    } else if (view.submitted) {
      text = '同步中';
    } else if (mySeat() === 0) {
      text = '观战中 · 只读';
    } else if (!aliveSoldier(st, mySeat())) {
      text = '已淘汰 · 观战';
    } else if (Number(st.turn) === mySeat()) {
      var remain = view.turnDeadline ? Math.max(0, view.turnDeadline - Date.now()) : TURN_MS;
      var sec = Math.ceil(remain / 1000);
      text = '你的回合 · ' + sec + 's';
      live = true;
      low = sec <= 10;
    } else {
      text = '等 座位 ' + st.turn + ' …';
    }
    el.textContent = text;
    el.classList[live ? 'add' : 'remove']('is-live');
    el.classList[low ? 'add' : 'remove']('is-low');
  }

  function syncTurnClock(st) {
    if (!st || isWaiting() || gameOver(st)) {
      view.turnKey = '';
      view.turnDeadline = 0;
      return;
    }
    var r = room();
    var key = [r && r.id || '', st.turn, st.round || 1, st.mode || 'ffa'].join('|');
    if (key !== view.turnKey) {
      view.turnKey = key;
      view.turnDeadline = Date.now() + TURN_MS;
      view.timeoutSent = false;
      view.flipped = false;
      view.preview = null;
      view.submitted = false;
    }
    // 动画超过 2.2 秒还没结束（切后台、RAF 被挂起等）就直接收掉，
    // 否则它会一直挡住「轮到你」和键盘。
    if (!isReplay() && view.anim && view.anim.startedAt &&
        Date.now() - view.anim.startedAt > 2200 &&
        mySeat() > 0 && Number(st.turn) === mySeat() && !gameOver(st)) {
      if (view.raf) cancelAnimationFrame(view.raf);
      view.raf = 0;
      view.anim = null;
      view.submitted = false;
    }
    // v2.165：只要现在轮到本端，就强制解除上一炮留下的 submitted 状态。
    // 联机时对手的弹道不再在本端播放（见 onChange），避免动画把回合提示和输入卡住。
    if (!isReplay() && mySeat() > 0 && Number(st.turn) === mySeat() && !gameOver(st)) {
      view.submitted = false;
      view.timeoutSent = false;
    }
  }

  function tickClock() {
    if (!view.mounted) return;
    updateClock();
    if (canTimeout()) sendTimeout();
  }

  function canTimeout() {
    var st = gameState();
    if (!view.mounted || !st || isWaiting() || gameOver(st) || view.anim || view.submitted) return false;
    if (mySeat() < 1 || view.timeoutSent || !view.turnDeadline) return false;
    if (Number(st.turn) !== mySeat() || !aliveSoldier(st, mySeat())) return false;
    return Date.now() >= view.turnDeadline;
  }

  function render() {
    if (!view.mounted) return;
    var st = displayedState();
    updateRound(st);
    renderPlayers(st);
    syncTurnClock(st);
    updateControls();
    updateStatus(st);
    updateClock();
    var overNow = !!st && gameOver(st);
    var wait = view.dom.wait;
    if (wait) {
      if (st && !isWaiting()) {
        wait.hidden = true;
      } else {
        wait.hidden = false;
        view.dom.waitTitle.textContent = isWaiting() ? '等房主开局' : (gameOver(null) ? '本局已结束' : '正在同步开局');
        view.dom.waitSub.textContent = isWaiting()
          ? '房主按下开始后，会自动生成战场、随机出生点和四五个可以炸穿的障碍球。'
          : (gameOver(null) ? '这一局已经结束啦。' : (mySeat() === 0
            ? '观战中，房主开局后就能看到战场。'
            : '房主正在发牌，马上就好。'));
      }
    }
    renderResult(st);
    if (st && !isWaiting() && !overNow && canEdit()) schedulePreview();
    if (!canEdit()) view.preview = null;
    if (!view.anim) drawStatic();
  }

  function closeResult() {
    var st = displayedState();
    if (st) view.resultDismissed = resultSignature(st);
    if (view.dom.result) view.dom.result.hidden = true;
  }

  /* ---------- 输入 / 预览 ---------- */
  function schedulePreview() {
    if (view.previewTimer) {
      clearTimeout(view.previewTimer);
      view.previewTimer = 0;
    }
    if (!canEdit()) {
      view.preview = null;
      return;
    }
    view.previewTimer = setTimeout(function () {
      view.previewTimer = 0;
      if (!view.mounted || !canEdit()) return;
      computePreview();
      drawStatic();
    }, 150);
  }

  function computePreview() {
    var st = gameState();
    if (!st || !canEdit() || !view.parseRes.ok || !view.expr) {
      view.preview = null;
      return;
    }
    var sd = currentSoldier(st);
    if (!sd) {
      view.preview = null;
      return;
    }
    var r = room();
    var tr = trajectory({
      fnText: view.expr,
      mode: view.mode,
      angle: view.angle,
      x0: sd.x,
      y0: sd.y,
      dir: activeDir(st),
      bounds: WORLD,
      obstacles: st.obstacles || []
    });
    if (!tr.points || tr.points.length < 2) {
      view.preview = { points: [], hitObstacle: false, blockedAt: null, error: tr.error || '轨迹为空' };
      return;
    }
    var pts = tr.points;
    if (pts.length > PREVIEW_MAX) {
      var thin = [];
      var step = (pts.length - 1) / (PREVIEW_MAX - 1);
      for (var i = 0; i < PREVIEW_MAX; i++) thin.push(pts[Math.round(i * step)]);
      pts = thin;
    }
    view.preview = {
      points: pts,
      hitObstacle: !!tr.hitObstacle,
      blockedAt: tr.blockedAt || null,
      error: tr.error || ''
    };
  }

  /* ---------- Canvas：调色、坐标与绘制 ---------- */
  function cssVar(name, fallback) {
    try {
      var cs = window.getComputedStyle(view.root);
      var v = cs && cs.getPropertyValue(name);
      if (v && v.replace(/^\s+|\s+$/g, '')) return v.replace(/^\s+|\s+$/g, '');
    } catch (e) {}
    return fallback;
  }

  function nightMode() {
    try {
      return document.documentElement.getAttribute('data-mode') === 'night';
    } catch (e) {
      return false;
    }
  }

  function palette() {
    var night = nightMode();
    if (view.paletteCache && view.paletteCache.night === night) return view.paletteCache;
    var p = {
      night: night,
      bg: night ? '#101218' : '#fbf7ec',
      grid: night ? 'rgba(236,233,242,.055)' : 'rgba(25,23,19,.055)',
      gridMajor: night ? 'rgba(236,233,242,.12)' : 'rgba(25,23,19,.11)',
      axis: night ? '#9b97a8' : '#6f685b',
      ink: night ? '#ece9f2' : cssVar('--ink', '#191713'),
      ink2: night ? '#c2becd' : cssVar('--ink-2', '#4b463c'),
      ink3: night ? '#7f7c8c' : cssVar('--ink-3', '#8a8375'),
      line: night ? '#2b2b36' : cssVar('--line', '#e2d9c7'),
      line2: night ? '#3b3b49' : cssVar('--line-2', '#cfc3ab'),
      card: night ? '#1b1b23' : cssVar('--card', '#fffdf7'),
      seal: night ? '#b08fdd' : cssVar('--seal', '#a33228'),
      gold: night ? '#c9a86a' : cssVar('--gold', '#a9873f'),
      jade: night ? '#79b1b7' : cssVar('--jade', '#2c6a5b'),
      red: night ? '#c88c82' : (cssVar('--seal', '#a33228')),
      blue: night ? '#8fa6c4' : '#4f6f99',
      obstacle: night ? '#07090d' : '#26231e',
      obstacleRim: night ? '#6f7480' : '#171512',
      mono: cssVar('--mono', 'Menlo, Consolas, monospace'),
      serif: cssVar('--serif', 'serif')
    };
    view.paletteCache = p;
    return p;
  }

  function baseScale() {
    var w = view.cssW || 760, h = view.cssH || 420;
    var s = Math.min((w - 30) / 50, (h - 30) / 30);
    return s > 0 ? s : 16;
  }

  function viewScale() {
    return baseScale() * view.cam.scale;
  }

  function toSX(x) {
    return view.cssW / 2 + (Number(x) - view.cam.cx) * viewScale();
  }

  function toSY(y) {
    return view.cssH / 2 - (Number(y) - view.cam.cy) * viewScale();
  }

  function colorOf(st, seat, p) {
    if (st && st.mode === 'team') return seat % 2 === 1 ? p.red : p.blue;
    if (mySeat() > 0) return Number(seat) === mySeat() ? p.jade : p.seal;
    return seat % 2 === 1 ? p.gold : p.jade;
  }

  function resizeCanvas() {
    if (!view.mounted || !view.dom.canvas) return;
    var c = view.dom.canvas;
    var w = c.clientWidth || (view.dom.stage && view.dom.stage.clientWidth) || 760;
    var h = c.clientHeight || 420;
    if (w < 80) w = 760;
    if (h < 80) h = 420;
    var dpr = Math.min(3, window.devicePixelRatio || 1);
    var bw = Math.round(w * dpr), bh = Math.round(h * dpr);
    if (c.width !== bw) c.width = bw;
    if (c.height !== bh) c.height = bh;
    view.cssW = w;
    view.cssH = h;
    view.dpr = dpr;
    var g = c.getContext && c.getContext('2d');
    if (g) g.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawStatic();
  }

  function drawStatic() {
    if (!view.mounted || view.anim) return;
    drawScene(displayedState(), null);
  }

  function drawGrid(g, p) {
    var w = view.cssW, h = view.cssH;
    var ppu = viewScale();
    var halfW = (w / 2) / ppu;
    var halfH = (h / 2) / ppu;
    var wx0 = view.cam.cx - halfW;
    var wx1 = view.cam.cx + halfW;
    var wy0 = view.cam.cy - halfH;
    var wy1 = view.cam.cy + halfH;
    var minor = ppu < 10 ? 5 : 1;
    if (ppu < 3) minor = 10;
    var labelStep = ppu < 6 ? 10 : 5;
    if (ppu < 2) labelStep = 20;

    var x, sx, sy, start;
    g.save();
    g.lineWidth = 1;
    g.strokeStyle = p.grid;
    g.beginPath();
    start = Math.ceil(wx0 / minor) * minor;
    for (x = start; x <= wx1 + 1e-9; x += minor) {
      sx = Math.round(toSX(x)) + 0.5;
      g.moveTo(sx, 0);
      g.lineTo(sx, h);
    }
    start = Math.ceil(wy0 / minor) * minor;
    for (x = start; x <= wy1 + 1e-9; x += minor) {
      sy = Math.round(toSY(x)) + 0.5;
      g.moveTo(0, sy);
      g.lineTo(w, sy);
    }
    g.stroke();

    g.strokeStyle = p.gridMajor;
    g.beginPath();
    start = Math.ceil(wx0 / labelStep) * labelStep;
    for (x = start; x <= wx1 + 1e-9; x += labelStep) {
      if (Math.abs(x) < 1e-9) continue;
      sx = Math.round(toSX(x)) + 0.5;
      g.moveTo(sx, 0);
      g.lineTo(sx, h);
    }
    start = Math.ceil(wy0 / labelStep) * labelStep;
    for (x = start; x <= wy1 + 1e-9; x += labelStep) {
      if (Math.abs(x) < 1e-9) continue;
      sy = Math.round(toSY(x)) + 0.5;
      g.moveTo(0, sy);
      g.lineTo(w, sy);
    }
    g.stroke();

    var ax = toSX(0);
    var ay = toSY(0);
    var axisXVisible = ax >= 0 && ax <= w;
    var axisYVisible = ay >= 0 && ay <= h;
    if (axisXVisible) {
      g.strokeStyle = p.axis;
      g.lineWidth = 1.2;
      g.beginPath();
      g.moveTo(ax, 0);
      g.lineTo(ax, h);
      g.stroke();
    }
    if (axisYVisible) {
      g.strokeStyle = p.axis;
      g.lineWidth = 1.2;
      g.beginPath();
      g.moveTo(0, ay);
      g.lineTo(w, ay);
      g.stroke();
    }

    g.fillStyle = p.ink3;
    g.font = '9px ' + p.mono;
    g.textAlign = 'center';
    g.textBaseline = 'top';
    var labelY = axisYVisible ? Math.min(h - 12, ay + 4) : h - 13;
    for (x = Math.ceil(wx0 / labelStep) * labelStep; x <= wx1 + 1e-9; x += labelStep) {
      if (Math.abs(x) < 1e-9) continue;
      sx = toSX(x);
      if (sx < 12 || sx > w - 12) continue;
      if (axisYVisible) {
        g.strokeStyle = p.axis;
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(sx, ay);
        g.lineTo(sx, ay + 4);
        g.stroke();
      }
      g.fillStyle = p.ink3;
      g.fillText(String(Math.round(x)), sx, labelY);
    }
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    var labelX = axisXVisible ? Math.max(24, Math.min(w - 18, ax - 5)) : w - 7;
    for (x = Math.ceil(wy0 / labelStep) * labelStep; x <= wy1 + 1e-9; x += labelStep) {
      if (Math.abs(x) < 1e-9) continue;
      sy = toSY(x);
      if (sy < 10 || sy > h - 10) continue;
      if (axisXVisible) {
        g.strokeStyle = p.axis;
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(ax, sy);
        g.lineTo(ax - 4, sy);
        g.stroke();
      }
      g.fillStyle = p.ink3;
      g.fillText(String(Math.round(x)), labelX, sy);
    }
    if (axisXVisible && axisYVisible) {
      g.textAlign = 'right';
      g.textBaseline = 'top';
      g.fillStyle = p.ink3;
      g.fillText('0', ax - 4, ay + 4);
    }
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.fillStyle = p.ink3;
    g.font = '10px ' + p.mono;
    if (axisYVisible) g.fillText('x', w - 13, ay - 8);
    if (axisXVisible) g.fillText('y', ax + 7, 11);
    g.restore();
  }

  function drawWorldFrame(g, p) {
    var x1 = toSX(WORLD.x0), y1 = toSY(WORLD.y1);
    var x2 = toSX(WORLD.x1), y2 = toSY(WORLD.y0);
    g.save();
    g.strokeStyle = p.line2;
    g.globalAlpha = 0.8;
    g.lineWidth = 1;
    g.setLineDash([5, 4]);
    g.strokeRect(Math.round(x1) + 0.5, Math.round(y1) + 0.5, Math.round(x2 - x1), Math.round(y2 - y1));
    g.restore();
  }

  function drawPreview(g, st, p) {
    if (!view.preview || !view.preview.points || view.preview.points.length < 2) return;
    if (!canEdit()) return;
    var pts = view.preview.points;
    g.save();
    g.strokeStyle = p.jade;
    g.globalAlpha = 0.55;
    g.lineWidth = 1.5;
    g.setLineDash([4, 5]);
    g.beginPath();
    g.moveTo(toSX(pts[0][0]), toSY(pts[0][1]));
    for (var i = 1; i < pts.length; i++) g.lineTo(toSX(pts[i][0]), toSY(pts[i][1]));
    g.stroke();
    var last = pts[pts.length - 1];
    g.setLineDash([]);
    g.globalAlpha = 0.65;
    g.fillStyle = p.jade;
    g.beginPath();
    g.arc(toSX(last[0]), toSY(last[1]), 3, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }

  function drawObstacle(g, ob, p) {
    if (!obstacleAlive(ob)) return;
    var scale = viewScale();
    var x = toSX(ob.x), y = toSY(ob.y);
    var r = Math.max(2, obstacleRadius(ob) * scale);
    var holes = Array.isArray(ob.holes) ? ob.holes : [];
    g.save();
    // 只允许画在障碍圆内，再把洞用 evenodd 规则挖掉：
    // 洞是真的透过去（能看到后面的网格），不是盖一块背景色。
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.clip();
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    for (var i = 0; i < holes.length; i++) {
      var h = holes[i];
      var hr = Math.max(1, Number(h.r) * scale);
      if (!isFinite(hr) || hr <= 0) continue;
      var hx = toSX(h.x), hy = toSY(h.y);
      g.moveTo(hx + hr, hy);
      g.arc(hx, hy, hr, 0, Math.PI * 2, true);
    }
    g.fillStyle = p.obstacle;
    g.fill('evenodd');
    g.strokeStyle = p.obstacleRim;
    g.lineWidth = 1.4;
    g.stroke();
    // 洞不是盖一块背景色：边缘加一圈亮口 + 内侧暗影 + 四道裂纹，
    // 这样球被炸掉一块之后，外轮廓会真的缺一角，里面也像个坑。
    for (var h = 0; h < holes.length; h++) {
      var hole = holes[h];
      var hr = Math.max(1, Number(hole.r) * scale);
      if (!isFinite(hr) || hr <= 0) continue;
      var hx = toSX(hole.x), hy = toSY(hole.y);
      // 洞口内侧压一圈淡淡的暗影，看起来像坑，而不是贴了一张白纸
      var grad = g.createRadialGradient(hx, hy, hr * 0.35, hx, hy, hr);
      grad.addColorStop(0, 'rgba(0,0,0,0)');
      grad.addColorStop(0.72, 'rgba(0,0,0,.06)');
      grad.addColorStop(1, 'rgba(0,0,0,.34)');
      g.fillStyle = grad;
      g.beginPath();
      g.arc(hx, hy, hr, 0, Math.PI * 2);
      g.fill();
      g.beginPath();
      g.arc(hx, hy, hr, 0, Math.PI * 2);
      g.strokeStyle = p.gold;
      g.lineWidth = 1.6;
      g.globalAlpha = 0.75;
      g.stroke();
      g.beginPath();
      g.arc(hx, hy, Math.max(1, hr - 1.2), 0, Math.PI * 2);
      g.strokeStyle = 'rgba(0,0,0,.38)';
      g.lineWidth = 1;
      g.globalAlpha = 1;
      g.stroke();
      // 四道短裂纹，从洞口往外裂
      g.beginPath();
      for (var c = 0; c < 4; c++) {
        var ang = Math.PI * 0.25 + c * Math.PI * 0.5;
        var x1 = hx + Math.cos(ang) * hr;
        var y1 = hy + Math.sin(ang) * hr;
        var x2 = hx + Math.cos(ang) * (hr + Math.max(3, 0.5 * scale));
        var y2 = hy + Math.sin(ang) * (hr + Math.max(3, 0.5 * scale));
        g.moveTo(x1, y1);
        g.lineTo(x2, y2);
      }
      g.strokeStyle = p.gold;
      g.globalAlpha = 0.45;
      g.lineWidth = 1;
      g.stroke();
      g.globalAlpha = 1;
    }
    g.restore();
  }

  function drawSoldier(g, st, sd, p, anim) {
    var x = toSX(sd.x), y = toSY(sd.y);
    var r = clamp(SOLDIER_R * viewScale(), 8, 27);
    var dead = sd.alive === false || Number(sd.hp) <= 0;
    var color = colorOf(st, sd.seat, p);
    var current = Number(st.turn) === Number(sd.seat) && !gameOver(st);
    var dir = Number(sd.dir) < 0 ? -1 : 1;
    if (!anim && stateIsMine(st) && Number(sd.seat) === mySeat() && !dead) dir = activeDir(st);
    g.save();
    if (current && !dead) {
      g.strokeStyle = p.gold;
      g.lineWidth = 1.4;
      g.setLineDash([3, 3]);
      g.beginPath();
      g.arc(x, y, r + 5.5, 0, Math.PI * 2);
      g.stroke();
      g.setLineDash([]);
    }
    if (dead) {
      g.globalAlpha = 0.28;
      g.fillStyle = p.ink3;
      g.strokeStyle = p.ink3;
      g.lineWidth = 1.3;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
      g.globalAlpha = 0.6;
      g.beginPath();
      g.moveTo(x - r * 0.45, y - r * 0.45);
      g.lineTo(x + r * 0.45, y + r * 0.45);
      g.moveTo(x + r * 0.45, y - r * 0.45);
      g.lineTo(x - r * 0.45, y + r * 0.45);
      g.stroke();
      g.restore();
      return;
    }
    g.fillStyle = color;
    g.strokeStyle = p.night ? '#0c0d13' : '#fffaf0';
    g.lineWidth = Math.max(1.2, r * 0.08);
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    g.fillStyle = '#fffaf0';
    g.font = '700 ' + Math.max(9, r * 0.95) + 'px ' + p.serif;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(initialOf(sd.seat), x, y + 1);
    var tipX = x + dir * (r + 9);
    g.strokeStyle = p.gold;
    g.fillStyle = p.gold;
    g.lineWidth = Math.max(1.2, r * 0.08);
    g.beginPath();
    g.moveTo(x + dir * (r + 1), y);
    g.lineTo(tipX, y);
    g.stroke();
    g.beginPath();
    g.moveTo(tipX, y);
    g.lineTo(tipX - dir * 5, y - 4);
    g.lineTo(tipX - dir * 5, y + 4);
    g.closePath();
    g.fill();
    var hw = Math.max(27, r * 2.25);
    var hh = 4;
    var hx = x - hw / 2;
    var hy = y - r - 12;
    g.fillStyle = p.line;
    g.fillRect(hx, hy, hw, hh);
    var frac = clamp(Number(sd.hp) / HP_MAX, 0, 1);
    g.fillStyle = frac <= 0.35 ? p.seal : p.jade;
    g.fillRect(hx, hy, hw * frac, hh);
    g.font = '8px ' + p.mono;
    g.fillStyle = p.ink3;
    g.textAlign = 'center';
    g.textBaseline = 'bottom';
    g.fillText('#' + sd.seat, x, y + r + 11);
    g.restore();
  }

  function drawAnimPath(g, anim, p) {
    if (!anim || !anim.points || anim.points.length < 2) return;
    var i;
    g.save();
    g.strokeStyle = p.gold;
    g.globalAlpha = 0.16;
    g.lineWidth = 1;
    g.setLineDash([3, 5]);
    g.beginPath();
    g.moveTo(toSX(anim.points[0][0]), toSY(anim.points[0][1]));
    for (i = 1; i < anim.points.length; i++) g.lineTo(toSX(anim.points[i][0]), toSY(anim.points[i][1]));
    g.stroke();
    g.setLineDash([]);
    g.globalAlpha = 1;

    var trail = anim.trail || [];
    for (i = 1; i < trail.length; i++) {
      var a = i / Math.max(2, trail.length - 1);
      g.globalAlpha = 0.08 + a * 0.62;
      g.strokeStyle = p.gold;
      g.lineWidth = 0.8 + a * 2.4;
      g.beginPath();
      g.moveTo(toSX(trail[i - 1][0]), toSY(trail[i - 1][1]));
      g.lineTo(toSX(trail[i][0]), toSY(trail[i][1]));
      g.stroke();
    }
    if (anim.head) {
      var hx = toSX(anim.head[0]), hy = toSY(anim.head[1]);
      g.globalAlpha = 0.22;
      g.fillStyle = p.gold;
      g.beginPath();
      g.arc(hx, hy, 8.5, 0, Math.PI * 2);
      g.fill();
      g.globalAlpha = 1;
      g.fillStyle = p.gold;
      g.beginPath();
      g.arc(hx, hy, 3.6, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#fffaf0';
      g.beginPath();
      g.arc(hx - 0.7, hy - 0.7, 1.35, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
  }

  function drawEffects(g, anim, p) {
    if (!anim) return;
    var i;
    g.save();
    for (i = 0; i < anim.flashes.length; i++) {
      var fl = anim.flashes[i];
      var life = clamp(fl.life / fl.max, 0, 1);
      g.globalAlpha = life * 0.7;
      g.strokeStyle = fl.seal ? p.seal : p.gold;
      g.lineWidth = 1.5 + (1 - life) * 2;
      g.beginPath();
      g.arc(toSX(fl.x), toSY(fl.y), (1 - life) * 20 + 4, 0, Math.PI * 2);
      g.stroke();
    }
    for (i = 0; i < anim.particles.length; i++) {
      var pt = anim.particles[i];
      var lf = clamp(pt.life / pt.max, 0, 1);
      g.globalAlpha = lf;
      g.fillStyle = pt.color === 'seal' ? p.seal : (pt.color === 'ink' ? p.ink2 : p.gold);
      var rad = Math.max(0.8, pt.size * (0.4 + lf * 0.8));
      g.beginPath();
      g.arc(toSX(pt.x), toSY(pt.y), rad, 0, Math.PI * 2);
      g.fill();
    }
    for (i = 0; i < anim.floats.length; i++) {
      var fb = anim.floats[i];
      var fa = clamp(fb.life / fb.max, 0, 1);
      g.globalAlpha = fa;
      g.fillStyle = fb.color === 'gold' ? p.gold : p.seal;
      g.font = '700 13px ' + p.mono;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(fb.text, toSX(fb.x), toSY(fb.y));
    }
    g.restore();
  }

  function lastShotRec(st) {
    var list = st && Array.isArray(st.shots) ? st.shots : [];
    return list.length ? list[list.length - 1] : null;
  }

  // 回放时明确告诉用户这一炮打没打中（实况有动画，回放只有静态画面）
  function shotOutcomeText(st) {
    var rec = lastShotRec(st);
    if (!rec) return '';
    var hits = Array.isArray(rec.hits) ? rec.hits : [];
    if (hits.length) {
      return '命中 ' + hits.map(function (h) { return '座位 ' + h.seat; }).join('、');
    }
    if (rec.hitObstacle) return '击中障碍 · 炸出洞';
    return '未命中';
  }

  function drawReplayShot(g, st, p) {
    var rec = lastShotRec(st);
    if (!rec) return;
    var pts = Array.isArray(rec.points) ? rec.points : [];
    if (pts.length < 2) return;

    var color = colorOf(st, Number(rec.seat) || 1, p);
    var i, x, y;
    g.save();
    g.globalAlpha = 0.9;
    g.strokeStyle = color;
    g.lineWidth = 2;
    g.lineJoin = 'round';
    g.lineCap = 'round';
    g.beginPath();
    for (i = 0; i < pts.length; i++) {
      x = toSX(pts[i][0]);
      y = toSY(pts[i][1]);
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();

    // 起点
    x = toSX(pts[0][0]);
    y = toSY(pts[0][1]);
    g.fillStyle = color;
    g.beginPath();
    g.arc(x, y, 2.6, 0, Math.PI * 2);
    g.fill();

    // 落点 / 命中标记
    var ex = toSX(pts[pts.length - 1][0]);
    var ey = toSY(pts[pts.length - 1][1]);
    g.globalAlpha = 1;
    g.strokeStyle = p.gold;
    g.lineWidth = 1.8;
    g.beginPath();
    g.moveTo(ex - 5, ey - 5); g.lineTo(ex + 5, ey + 5);
    g.moveTo(ex + 5, ey - 5); g.lineTo(ex - 5, ey + 5);
    g.stroke();

    var hits = Array.isArray(rec.hits) ? rec.hits : [];
    for (i = 0; i < hits.length; i++) {
      var target = soldierOf(st, Number(hits[i].seat));
      if (!target) continue;
      x = toSX(target.x);
      y = toSY(target.y);
      g.strokeStyle = p.seal;
      g.lineWidth = 2;
      g.beginPath();
      g.arc(x, y, Math.max(10, 1.05 * viewScale()), 0, Math.PI * 2);
      g.stroke();
      g.fillStyle = p.seal;
      g.font = '700 11px ' + p.mono;
      g.fillText('-' + DAMAGE, x - 8, y - Math.max(14, 1.3 * viewScale()));
    }
    if (rec.hitObstacle && rec.blockedAt) {
      x = toSX(rec.blockedAt[0]);
      y = toSY(rec.blockedAt[1]);
      g.strokeStyle = p.gold;
      g.lineWidth = 2;
      g.beginPath();
      g.arc(x, y, Math.max(8, HOLE_R * viewScale()), 0, Math.PI * 2);
      g.stroke();
    }

    // 左上角：函数式 + 结果
    var formula = (rec.mode === 'y2' ? "y'' = " : 'y = ') + String(rec.fnText || '');
    if (formula.length > 44) formula = formula.slice(0, 44) + '…';
    var outcome = shotOutcomeText(st);
    g.font = '700 12px ' + p.mono;
    var tw = Math.max(g.measureText(formula).width, g.measureText(outcome).width) + 14;
    g.fillStyle = p.card;
    g.globalAlpha = 0.92;
    g.fillRect(10, 42, tw, 38);
    g.globalAlpha = 1;
    g.fillStyle = p.ink;
    g.fillText(formula, 17, 56);
    g.fillStyle = hits.length || rec.hitObstacle ? p.seal : p.ink3;
    g.fillText(outcome, 17, 73);
    g.restore();
  }

  function drawScene(st, anim) {
    if (!view.mounted || !view.dom.canvas) return;
    var g = view.dom.canvas.getContext && view.dom.canvas.getContext('2d');
    if (!g) return;
    var p = palette();
    var w = view.cssW, h = view.cssH;
    if (!w || !h) return;
    g.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    g.fillStyle = p.bg;
    g.fillRect(0, 0, w, h);
    drawGrid(g, p);
    drawWorldFrame(g, p);
    if (st) {
      var obstacles = st.obstacles || [];
      var i;
      for (i = 0; i < obstacles.length; i++) drawObstacle(g, obstacles[i], p);
      drawPreview(g, st, p);
      var soldiers = (st.soldiers || []).slice().sort(function (a, b) {
        var da = a.alive === false || Number(a.hp) <= 0 ? 0 : 1;
        var db = b.alive === false || Number(b.hp) <= 0 ? 0 : 1;
        return da - db || a.seat - b.seat;
      });
      for (i = 0; i < soldiers.length; i++) drawSoldier(g, st, soldiers[i], p, anim);
      if (isReplay() && !anim) drawReplayShot(g, st, p);
    }
    if (anim) {
      drawAnimPath(g, anim, p);
      drawEffects(g, anim, p);
    }
  }

  /* ---------- 缩放 / 拖拽 ---------- */
  function zoomBy(mult) {
    var next = clamp(view.cam.scale * mult, 0.4, 4);
    if (Math.abs(next - view.cam.scale) < 1e-6) return;
    view.cam.scale = next;
    drawStatic();
  }

  function resetCamera() {
    view.cam.cx = 0;
    view.cam.cy = 0;
    view.cam.scale = 1;
    drawStatic();
  }

  function onPointerDown(ev) {
    if (ev.button != null && ev.button !== 0) return;
    view.drag = {
      x: ev.clientX, y: ev.clientY,
      cx: view.cam.cx, cy: view.cam.cy
    };
    if (view.dom.canvas.classList) view.dom.canvas.classList.add('is-drag');
    if (view.dom.canvas.setPointerCapture && ev.pointerId != null) {
      try { view.dom.canvas.setPointerCapture(ev.pointerId); } catch (e) {}
    }
    if (ev.preventDefault) ev.preventDefault();
  }

  function onPointerMove(ev) {
    if (!view.drag) return;
    var ppu = viewScale();
    if (!ppu) return;
    view.cam.cx = clamp(view.drag.cx - (ev.clientX - view.drag.x) / ppu, -60, 60);
    view.cam.cy = clamp(view.drag.cy + (ev.clientY - view.drag.y) / ppu, -40, 40);
    drawStatic();
    if (ev.preventDefault) ev.preventDefault();
  }

  function onPointerUp() {
    view.drag = null;
    if (view.dom.canvas && view.dom.canvas.classList) view.dom.canvas.classList.remove('is-drag');
  }

  /* ---------- 发射、超时与动画 ---------- */
  function sendAction(action, nextState, opts) {
    if (!view.ctx || typeof view.ctx.send !== 'function') {
      ctxToast('页面没有提供发送接口');
      return null;
    }
    try {
      return view.ctx.send(action, nextState, opts || {});
    } catch (e) {
      failSend(e);
      return null;
    }
  }

  function failSend(err) {
    var msg = err && err.message ? err.message : '网络好像开小差了';
    ctxToast('操作失败：' + msg);
    view.submitted = false;
    view.timeoutSent = false;
    if (view.turnDeadline) view.turnDeadline = Date.now() + 10000;
    render();
  }

  function clearExpr() {
    if (!view.mounted) return;
    view.expr = '';
    view.parseRes = { ok: false, error: '', empty: true };
    view.preview = null;
    updateControls();
    drawStatic();
  }

  function watchSend(p) {
    if (p && typeof p.then === 'function') {
      p.then(function () { clearExpr(); }, function (err) { failSend(err); });
    }
  }

  function autoFaceAll(st) {
    return autoFace(st);
  }

  function advanceStateTurn(st, next) {
    var cur = Number(st.turn);
    if (next !== cur && next < cur) st.round = (Number(st.round) || 1) + 1;
    st.turn = next;
    autoFaceAll(st);
    return st;
  }

  function sendTimeout() {
    if (!canTimeout()) return;
    var st = gameState();
    if (!st) return;
    view.timeoutSent = true;
    view.submitted = true;
    var draft = copyState(st);
    var next = nextTurn(draft);
    if (!next) {
      view.submitted = false;
      return;
    }
    draft.log = capLog((draft.log || []).concat(['座位 ' + mySeat() + ' 超时，跳过']));
    draft = advanceStateTurn(draft, next);
    var ret = sendAction({ type: 'timeout' }, draft, { turn: next });
    if (ret) watchSend(ret);
    render();
  }

  function makeShot(st) {
    var sd = currentSoldier(st);
    if (!sd) return null;
    var dir = activeDir(st);
    var tr = trajectory({
      fnText: view.expr,
      mode: view.mode,
      angle: view.angle,
      x0: sd.x,
      y0: sd.y,
      dir: dir,
      bounds: WORLD,
      obstacles: st.obstacles || []
    });
    if (!tr.points || tr.points.length < 2) return { error: tr.error || '这条曲线走不出有效弹道' };
    var hits = pathHitList(st, mySeat(), tr.points).map(function (h) {
      var target = soldierOf(st, h.seat);
      return {
        seat: h.seat, dmg: DAMAGE,
        at: target ? [target.x, target.y] : h.at
      };
    });
    return {
      seat: mySeat(),
      fnText: view.expr,
      mode: view.mode,
      angle: view.angle,
      dir: dir,
      points: tr.points,
      hits: hits,
      hitObstacle: !!tr.hitObstacle,
      obstacleIndex: tr.obstacleIndex,
      blockedAt: tr.blockedAt
    };
  }

  function fireShot() {
    if (!canEdit()) return;
    if (!view.expr) {
      ctxToast('先输入一个函数');
      return;
    }
    if (!view.parseRes.ok) {
      ctxToast(view.parseRes.error || '函数有语法错误');
      return;
    }
    var st = gameState();
    var fnNorm = normFunction(view.expr);
    if (!fnNorm || usedFunctions(st).indexOf(fnNorm) >= 0) {
      ctxToast('这个函数已经发射过了，换一个');
      return;
    }
    var shot = makeShot(st);
    if (!shot || shot.error) {
      ctxToast((shot && shot.error) || '这条曲线走不出有效弹道');
      return;
    }
    if (view.anim) return;
    var draft = applyShot(st, mySeat(), shot);
    var win = draft.finished ? (draft.winner || 0) : 0;
    var next = 0;
    var opts;
    var action;
    if (draft.finished) {
      draft.turn = win || draft.turn;
      opts = { status: 'over', winner: win, turn: win || draft.turn };
      action = {
        type: 'shot', seat: mySeat(), expr: view.expr, mode: view.mode,
        angle: view.angle, dir: shot.dir, winner: win
      };
    } else {
      next = nextTurn(draft);
      if (!next) {
        draft.finished = true;
        draft.winner = 0;
        opts = { status: 'over', winner: 0 };
        action = { type: 'shot', seat: mySeat(), expr: view.expr, mode: view.mode, angle: view.angle, dir: shot.dir };
      } else {
        draft = advanceStateTurn(draft, next);
        opts = { turn: next };
        action = {
          type: 'shot', seat: mySeat(), expr: view.expr, mode: view.mode,
          angle: view.angle, dir: shot.dir
        };
      }
    }
    view.submitted = true;
    view.preview = null;
    startShotAnim(st, shot);
    render();
    var ret = sendAction(action, draft, opts);
    if (ret) watchSend(ret);
  }

  function pDist(a, b) {
    var dx = b[0] - a[0], dy = b[1] - a[1];
    return Math.sqrt(dx * dx + dy * dy);
  }

  function buildCumulative(pts) {
    var cum = [0];
    var total = 0;
    for (var i = 1; i < pts.length; i++) {
      total += pDist(pts[i - 1], pts[i]);
      cum.push(total);
    }
    return { cum: cum, total: total };
  }

  function pointAtRatio(points, cum, total, ratio) {
    if (!points.length) return [0, 0];
    if (points.length === 1 || total <= 1e-9) return points[0];
    var target = clamp(ratio, 0, 1) * total;
    var lo = 0, hi = cum.length - 1;
    while (lo + 1 < hi) {
      var mid = (lo + hi) >> 1;
      if (cum[mid] < target) lo = mid;
      else hi = mid;
    }
    var segLen = cum[hi] - cum[lo];
    var t = segLen > 1e-9 ? (target - cum[lo]) / segLen : 0;
    return [
      points[lo][0] + (points[hi][0] - points[lo][0]) * t,
      points[lo][1] + (points[hi][1] - points[lo][1]) * t
    ];
  }

  function nearestProgress(points, cum, total, at) {
    if (!at || !points.length) return 0.85;
    var best = Infinity, bi = 0;
    for (var i = 0; i < points.length; i++) {
      var dx = points[i][0] - at[0], dy = points[i][1] - at[1];
      var d = dx * dx + dy * dy;
      if (d < best) {
        best = d;
        bi = i;
      }
    }
    return total > 1e-9 ? clamp(cum[bi] / total, 0.03, 0.985) : 0.85;
  }

  function makeBurst(anim, x, y, count, seal) {
    for (var i = 0; i < count; i++) {
      var a = Math.random() * Math.PI * 2;
      var sp = 1.5 + Math.random() * 5.5;
      var life = 0.45 + Math.random() * 0.55;
      anim.particles.push({
        x: x, y: y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp + 1.2,
        life: life,
        max: life,
        size: 2 + Math.random() * 3.2,
        color: seal ? 'seal' : (Math.random() < 0.3 ? 'ink' : 'gold')
      });
    }
  }

  function startShotAnim(st, shot) {
    var info = buildCumulative(shot.points);
    var total = info.total;
    var duration = clamp(total / 48, 0.65, 1.18);
    var hitEvents = [];
    for (var i = 0; i < shot.hits.length; i++) {
      var h = shot.hits[i];
      var target = soldierOf(st, h.seat);
      var at = h.at || (target ? [target.x, target.y] : shot.points[shot.points.length - 1]);
      hitEvents.push({
        p: nearestProgress(shot.points, info.cum, total, at),
        at: at,
        seat: h.seat,
        done: false
      });
    }
    hitEvents.sort(function (a, b) { return a.p - b.p; });
    var anim = {
      base: copyState(st),
      shot: shot,
      points: shot.points,
      cum: info.cum,
      total: total,
      durationMs: duration * 1000,
      startedAt: Date.now(),
      started: 0,
      last: 0,
      progress: 0,
      head: shot.points[0].slice(),
      trail: [shot.points[0].slice()],
      hitEvents: hitEvents,
      obstacleDone: false,
      particles: [],
      floats: [],
      flashes: [],
      endedAt: 0
    };
    view.anim = anim;
    view.preview = null;
    if (view.raf) cancelAnimationFrame(view.raf);
    view.raf = requestAnimationFrame(animFrame);
  }

  function animFrame(ts) {
    if (!view.mounted || !view.anim) return;
    var a = view.anim;
    if (!a.started) {
      a.started = ts;
      a.last = ts;
    }
    var dt = Math.min(0.06, Math.max(0.001, (ts - a.last) / 1000));
    a.last = ts;
    var elapsed = ts - a.started;
    var progress = clamp(elapsed / a.durationMs, 0, 1);
    a.progress = progress;
    var head = pointAtRatio(a.points, a.cum, a.total, progress);
    a.head = head;
    if (!a.trail.length || pDist(a.trail[a.trail.length - 1], head) > 0.015) {
      a.trail.push([head[0], head[1]]);
      if (a.trail.length > 34) a.trail.shift();
    }

    var i;
    for (i = 0; i < a.hitEvents.length; i++) {
      var he = a.hitEvents[i];
      if (!he.done && progress >= he.p) {
        he.done = true;
        makeBurst(a, he.at[0], he.at[1], 8, false);
        a.floats.push({
          x: he.at[0], y: he.at[1] + 1.2, text: '-' + DAMAGE,
          life: 0.95, max: 0.95, color: 'seal'
        });
        a.flashes.push({ x: he.at[0], y: he.at[1], life: 0.3, max: 0.3, seal: true });
      }
    }
    if (a.shot.hitObstacle && !a.obstacleDone && progress >= 0.985) {
      a.obstacleDone = true;
      var at = a.shot.blockedAt || a.points[a.points.length - 1];
      var count = 24 + Math.floor(Math.random() * 7);
      makeBurst(a, at[0], at[1], count, true);
      a.floats.push({
        x: at[0], y: at[1] + 1.2, text: '炸出一个洞',
        life: 0.9, max: 0.9, color: 'gold'
      });
      a.flashes.push({ x: at[0], y: at[1], life: 0.42, max: 0.42, seal: false });
    }

    for (i = a.particles.length - 1; i >= 0; i--) {
      var pt = a.particles[i];
      pt.life -= dt;
      if (pt.life <= 0) {
        a.particles.splice(i, 1);
        continue;
      }
      pt.x += pt.vx * dt;
      pt.y += pt.vy * dt;
      pt.vy -= 6.2 * dt;
      pt.vx *= 0.985;
    }
    for (i = a.floats.length - 1; i >= 0; i--) {
      var fb = a.floats[i];
      fb.life -= dt;
      if (fb.life <= 0) {
        a.floats.splice(i, 1);
        continue;
      }
      fb.y += 0.9 * dt;
    }
    for (i = a.flashes.length - 1; i >= 0; i--) {
      var fl = a.flashes[i];
      fl.life -= dt;
      if (fl.life <= 0) a.flashes.splice(i, 1);
    }

    drawScene(a.base, a);

    if (progress >= 1 && elapsed > a.durationMs + 460) {
      if (view.raf) cancelAnimationFrame(view.raf);
      view.raf = 0;
      view.anim = null;
      render();
      return;
    }
    view.raf = requestAnimationFrame(animFrame);
  }

  /* ---------- 事件、开局与生命周期 ---------- */
  function onModeClick() {
    if (!canEdit()) return;
    view.mode = view.mode === 'y' ? 'y2' : 'y';
    revalidate();
    updateControls();
    schedulePreview();
    drawStatic();
  }

  function onFlipClick() {
    if (!canEdit()) return;
    view.flipped = !view.flipped;
    updateControls();
    drawStatic();
    schedulePreview();
  }

  function bumpAngle(delta) {
    if (!canEdit() || view.mode !== 'y2') return;
    view.angle = clamp(view.angle + delta, -80, 80);
    updateControls();
    schedulePreview();
    drawStatic();
  }

  function makeReplayShot(rec) {
    if (!rec || !rec.points || rec.points.length < 2) return null;
    var pts = rec.points;
    return {
      seat: Number(rec.seat),
      fnText: String(rec.fnText == null ? '' : rec.fnText),
      mode: rec.mode === 'y2' ? 'y2' : 'y',
      angle: Number(rec.angle) || 0,
      dir: Number(rec.dir) < 0 ? -1 : 1,
      points: pts,
      hits: (rec.hits || []).map(function (h) {
        return { seat: Number(h.seat), dmg: DAMAGE };
      }),
      hitObstacle: !!(rec.hitObstacle || (rec.destroyed && rec.destroyed.length)),
      obstacleIndex: rec.obstacleIndex != null ? Number(rec.obstacleIndex) : -1,
      blockedAt: rec.blockedAt || null
    };
  }

  function onChange(next) {
    if (!view.mounted) return;
    // 外壳每次 notify 都会传一份新的 ctx；以前这里忽略了参数，
    // view.ctx.state 一直指着发射前的旧局面，于是第一炮之后永远「同步中」。
    if (next) view.ctx = next;
    if (isWaiting()) view.initSent = false;
    var st = gameState();
    // 联机对手的炮弹不在本端播飞行动画：直接落终态，
    // 避免 1 秒动画把「轮到你」和键盘输入挡住（v2.165）。
    view.lastState = st ? copyState(st) : null;
    render();
    maybeStart();
  }

  function maybeStart() {
    if (isReplay()) return;
    if (!view.mounted || view.initSent) return;
    var r = room();
    if (!r || isWaiting() || roomStatus() === 'over') return;
    if (gameState()) return;
    if (!view.ctx.isHost) return;
    var seats = (r.seats || []).filter(function (s) { return s && Number(s.seat) > 0; });
    var n = seats.length;
    if (n < 2) n = ((view.ctx.players || []).length || n);
    if (n < 2) return;
    n = clamp(n, 2, 8);
    var mode = r.team_mode === 'team' ? 'team' : 'ffa';
    var st = newState(n, mode);
    view.initSent = true;
    ctxStatus('正在发牌');
    var p = sendAction({ type: 'init' }, st, { turn: st.turn });
    if (!p) {
      view.initSent = false;
      return;
    }
    if (typeof p.then === 'function') {
      p.then(function () {}, function (err) {
        view.initSent = false;
        failSend(err);
      });
    }
  }

  function startClock() {
    if (view.clockTimer) clearInterval(view.clockTimer);
    view.clockTimer = setInterval(tickClock, 250);
  }

  function bindEvents() {
    var d = view.dom;
    bind(d.zoomin, 'click', function () { zoomBy(1.28); });
    bind(d.zoomout, 'click', function () { zoomBy(0.78); });
    bind(d.zoomreset, 'click', resetCamera);
    bind(d.mode, 'click', onModeClick);
    bind(d.flip, 'click', onFlipClick);
    bind(d.angleUp, 'click', function () { bumpAngle(3); });
    bind(d.angleDown, 'click', function () { bumpAngle(-3); });
    bind(d.fire, 'click', fireShot);
    bind(d.resultClose, 'click', closeResult);
    bind(d.canvas, 'pointerdown', onPointerDown);
    bind(d.canvas, 'dblclick', resetCamera);
    bind(window, 'pointermove', onPointerMove);
    bind(window, 'pointerup', onPointerUp);
    bind(window, 'pointercancel', onPointerUp);
    bind(window, 'blur', onPointerUp);
    bind(window, 'resize', resizeCanvas);
    bind(window, 'orientationchange', resizeCanvas);
  }

  function mount(root, ctx) {
    if (!root || !ctx) return;
    if (view.mounted) destroy();

    view.root = root;
    view.ctx = ctx;
    view.mounted = true;
    view.dom = {};
    view.bound = [];
    view.unsub = null;
    view.cam = { cx: 0, cy: 0, scale: 1 };
    view.cssW = 0;
    view.cssH = 0;
    view.dpr = 1;
    view.expr = '';
    view.mode = 'y';
    view.angle = 20;
    view.flipped = false;
    view.parseRes = { ok: false, error: '' };
    view.preview = null;
    view.previewTimer = 0;
    view.clockTimer = 0;
    view.turnKey = '';
    view.turnDeadline = 0;
    view.timeoutSent = false;
    view.submitted = false;
    view.anim = null;
    view.raf = 0;
    view.resultDismissed = '';
    view.lastStatus = '';
    view.initSent = false;
    view.initTimer = 0;
    view.drag = null;
    view.resizeObs = null;
    view.themeObs = null;
    view.paletteCache = null;
    view.lastState = gameState() ? copyState(gameState()) : null;

    injectStyle();
    buildDom(root);
    bindEvents();

    try {
      if (view.ctx.onChange) {
        view.unsub = view.ctx.onChange(onChange);
      }
    } catch (e) {
      view.unsub = null;
    }

    if (window.ResizeObserver) {
      try {
        view.resizeObs = new window.ResizeObserver(function () { resizeCanvas(); });
        view.resizeObs.observe(view.dom.stage);
      } catch (e) {
        view.resizeObs = null;
      }
    }
    if (window.MutationObserver) {
      try {
        view.themeObs = new window.MutationObserver(function () {
          view.paletteCache = null;
          if (view.mounted) drawStatic();
        });
        view.themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode'] });
      } catch (e) {
        view.themeObs = null;
      }
    }

    revalidate();
    updateControls();
    startClock();
    resizeCanvas();
    setTimeout(function () {
      if (view.mounted) {
        resizeCanvas();
        maybeStart();
      }
    }, 180);
    view.initTimer = setTimeout(function () {
      if (view.mounted) maybeStart();
    }, 700);

    render();
    updateClock();
  }

  function destroy() {
    if (!view.mounted && !view.root) return;
    view.mounted = false;
    if (view.raf) {
      try { cancelAnimationFrame(view.raf); } catch (e) {}
      view.raf = 0;
    }
    if (view.clockTimer) {
      clearInterval(view.clockTimer);
      view.clockTimer = 0;
    }
    if (view.previewTimer) {
      clearTimeout(view.previewTimer);
      view.previewTimer = 0;
    }
    if (view.initTimer) {
      clearTimeout(view.initTimer);
      view.initTimer = 0;
    }
    if (view.resizeObs && view.resizeObs.disconnect) {
      try { view.resizeObs.disconnect(); } catch (e) {}
      view.resizeObs = null;
    }
    if (view.themeObs && view.themeObs.disconnect) {
      try { view.themeObs.disconnect(); } catch (e) {}
      view.themeObs = null;
    }
    if (view.unsub && typeof view.unsub === 'function') {
      try { view.unsub(); } catch (e) {}
      view.unsub = null;
    }
    for (var i = 0; i < view.bound.length; i++) {
      var b = view.bound[i];
      try { b[0].removeEventListener(b[1], b[2], b[3]); } catch (e) {}
    }
    view.bound = [];
    view.anim = null;
    view.submitted = false;
    view.drag = null;
    view.lastState = null;
    var root = view.root;
    if (root) {
      try { root.innerHTML = ''; } catch (e) {}
    }
    view.root = null;
    view.ctx = null;
    view.dom = {};
  }

  var game = {
    key: 'graphwar',
    title: '函数大战',
    icon: 'ƒ',
    sub: '2-8 人 · 输入函数打炮',
    mode: 'multi',
    seats: [2, 8],
    minSeats: 2,
    maxSeats: 8,
    mount: mount,
    destroy: destroy,
    _test: {
      parse: parse,
      evalAt: evalAt,
      trajectory: trajectory,
      distToObstacle: distToObstacle,
      solidAt: solidAt,
      hasSolid: hasSolid,
      addHole: addHole,
      firstObstacleOnPath: firstObstacleOnPath,
      newState: newState,
      applyShot: applyShot,
      shotFromAction: shotFromAction,
      applyAction: applyAction,
      nextTurn: nextTurn,
      teams: teams,
      normFunction: normFunction,
      usedFunctions: usedFunctions,
      ctxTurn: function () {
        return view.ctx && view.ctx.state ? Number(view.ctx.state.turn) || 0 : 0;
      },
      submitted: function () { return !!view.submitted; },
      animating: function () { return !!view.anim; }
    }
  };
  A.games.graphwar = game;
})();
