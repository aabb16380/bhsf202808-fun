/* ============================================================
   合成小辉辉（合成大西瓜）
   ------------------------------------------------------------
   物理：圆-圆冲量 + 位置修正，1/120 秒定步长，迭代 8 次。
   果子多了会互相挤，靠位置修正撑住，不靠重力——重力的堆叠一定会抖。

   画面：逻辑坐标固定 600×900，canvas 只做缩放，所以手机和电脑
   的手感、判定完全一样；水果暂用 1–5 的圆，辉辉用 hui.jpg。

   换贴图：把 FRUITS[i].img 指向 assets/games/fruit-1.png 之类，
   精灵图会自动换成照片（圆形裁切），数字就不再画了。
   ============================================================ */
(function () {
  'use strict';

  var B8 = window.B8;
  if (!B8) return;

  /* ============================================================
     常量
     ============================================================ */

  var W = 600;
  var H = 900;
  var TAU = Math.PI * 2;

  var GRAVITY = 2800;
  var STEP = 1 / 120;
  var ITER = 8;
  var REST = 0.05;
  var FRICTION = 0.32;
  var MAX_SPEED = 2400;

  var DROP_Y = 96;          // 待落水果的中心高度
  var DANGER_Y = 208;       // 红线：果子顶越过它就危险
  var DANGER_TIME = 2.2;    // 连续压线多久算输
  var DROP_CD = 0.42;       // 两次落果的间隔
  var MAX_LEVEL = 6;

  var KEY_BEST = 'b8.suika.best';

  /* 果子表：level 0 空着，方便用 level 直接取。
     r 是逻辑半径（画布宽 600），points 是合成出来的得分。
     img 一填，就把数字换成人像（圆形裁切），label 只在结算/下一颗里当编号用。 */
  var FRUITS = [
    null,
    { label: '1', r: 30, color: '#e9b949', dark: '#bf8f2a', points: 10, img: 'assets/games/hui/7.jpg' },
    { label: '2', r: 42, color: '#e2794b', dark: '#b8562e', points: 30, img: 'assets/games/hui/5.jpg' },
    { label: '3', r: 56, color: '#8fbf5f', dark: '#699840', points: 70, img: 'assets/games/hui/2.jpg' },
    { label: '4', r: 72, color: '#d9534f', dark: '#a93936', points: 130, img: 'assets/games/hui/1.jpg' },
    { label: '5', r: 90, color: '#7b6bb5', dark: '#5a4c92', points: 220, img: 'assets/games/hui/8.jpg' },
    { label: '辉', r: 116, color: '#f0d9a8', dark: '#c9a45c', points: 500, img: 'assets/games/hui/6.jpg' }
  ];

  var SPAWN = [
    { level: 1, w: 55 },
    { level: 2, w: 30 },
    { level: 3, w: 15 }
  ];

  /* ============================================================
     状态
     ============================================================ */

  var canvas, ctx, boardWrap, panel, overlay;
  var scoreEl, bestEl, nextEl, pauseBtn, soundBtn;
  var k = 1;                       // 逻辑 → 设备像素
  var dpr = 1;

  var mode = 'menu';               // menu | play | pause | over
  var clock = 0;                   // 只在 play 时走的游戏时钟（秒）
  var lastTs = 0;
  var acc = 0;
  var raf = 0;

  var balls = [];
  var particles = [];
  var pops = [];
  var banner = { t: 0, text: '' };

  var score = 0;
  var best = 0;
  var merges = 0;
  var maxLevel = 1;
  var combo = 0;
  var comboAt = -9;

  var curLevel = 1;
  var nextLevel = 1;
  var aimX = W / 2;
  var dropAt = 0;
  var dangerT = 0;
  var dragging = false;

  var writable = false;
  var submitted = 0;
  var muted = false;
  var gen = 0;
  var drawOn = true;            // 自检时关掉绘制，几千帧才跑得动

  var sprites = {};
  var imgs = {};
  var imgReady = {};

  /* ============================================================
     小工具
     ============================================================ */

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

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function readNum(key) {
    try { return Number(localStorage.getItem(key) || 0) || 0; } catch (e) { return 0; }
  }

  function store(key, val) {
    try { localStorage.setItem(key, String(val)); } catch (e) {}
  }

  function lighten(hex, amt) {
    var n = parseInt(hex.slice(1), 16);
    var r = (n >> 16) & 255;
    var g = (n >> 8) & 255;
    var b = n & 255;
    r = Math.round(r + (255 - r) * amt);
    g = Math.round(g + (255 - g) * amt);
    b = Math.round(b + (255 - b) * amt);
    return 'rgb(' + r + ',' + g + ',' + b + ')';
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
      master.gain.value = 0.85;
      master.connect(ac.destination);
    } catch (e) { ac = null; }
    return ac;
  }

  function resumeAudio() {
    var c = audioCtx();
    if (c && c.state === 'suspended') c.resume();
  }

  function tone(from, to, dur, gain, type, delay) {
    var c = audioCtx();
    if (!c || muted) return;
    var t = c.currentTime + (delay || 0);
    var osc = c.createOscillator();
    var g = c.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(from, t);
    if (to && to !== from) osc.frequency.exponentialRampToValueAtTime(to, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain || 0.18, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g);
    g.connect(master);
    osc.start(t);
    osc.stop(t + dur + 0.03);
  }

  function sfxDrop() {
    tone(240, 150, 0.12, 0.12, 'triangle');
  }

  function sfxMerge(level) {
    var base = 300 + level * 55;
    tone(base, base * 1.6, 0.16, 0.16, 'sine');
    tone(base * 2, base * 2.4, 0.1, 0.05, 'triangle', 0.02);
  }

  function sfxWin() {
    var i;
    for (i = 0; i < 5; i++) {
      tone(392 * Math.pow(1.122, i), 0, 0.22, 0.12, 'triangle', i * 0.09);
    }
  }

  function sfxOver() {
    tone(220, 70, 0.6, 0.16, 'sawtooth');
  }

  /* ============================================================
     绘图资源
     ============================================================ */

  function buildSprite(level) {
    var f = FRUITS[level];
    var pad = 5;
    var size = (f.r + pad) * 2;
    var scale = 2;
    var cvs = document.createElement('canvas');
    cvs.width = Math.round(size * scale);
    cvs.height = Math.round(size * scale);
    var c = cvs.getContext('2d');
    c.setTransform(scale, 0, 0, scale, 0, 0);
    c.translate(size / 2, size / 2);

    var im = imgs[level];
    if (im && imgReady[level]) {
      c.save();
      c.beginPath();
      c.arc(0, 0, f.r - 1, 0, TAU);
      c.clip();
      var side = Math.min(im.width, im.height);
      c.drawImage(im,
        (im.width - side) / 2, (im.height - side) / 2, side, side,
        -f.r, -f.r, f.r * 2, f.r * 2);
      c.restore();
    } else {
      // 底色
      c.beginPath();
      c.arc(0, 0, f.r, 0, TAU);
      c.fillStyle = f.dark;
      c.fill();

      // 球面渐变
      var g = c.createRadialGradient(-f.r * 0.32, -f.r * 0.36, f.r * 0.08, 0, 0, f.r * 1.04);
      g.addColorStop(0, lighten(f.color, 0.42));
      g.addColorStop(0.5, f.color);
      g.addColorStop(1, f.dark);
      c.beginPath();
      c.arc(0, 0, f.r, 0, TAU);
      c.fillStyle = g;
      c.fill();

      // 高光
      c.save();
      c.translate(-f.r * 0.3, -f.r * 0.36);
      c.rotate(-0.6);
      c.scale(1, 0.62);
      c.beginPath();
      c.arc(0, 0, f.r * 0.3, 0, TAU);
      c.fillStyle = 'rgba(255,255,255,0.42)';
      c.fill();
      c.restore();

      // 数字
      c.fillStyle = '#fffdf7';
      c.font = '700 ' + Math.round(f.r * 0.82) + 'px "SFMono-Regular", Consolas, monospace';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.shadowColor = 'rgba(0,0,0,0.22)';
      c.shadowBlur = Math.max(2, f.r * 0.08);
      c.shadowOffsetY = Math.max(1, f.r * 0.04);
      c.fillText(f.label, 0, f.r * 0.04);
      c.shadowColor = 'transparent';
      c.shadowBlur = 0;
      c.shadowOffsetY = 0;
    }

    // 白边，像一颗糖
    c.beginPath();
    c.arc(0, 0, f.r - 1.5, 0, TAU);
    c.strokeStyle = 'rgba(255,255,255,0.62)';
    c.lineWidth = 3;
    c.stroke();

    return { cvs: cvs, size: size };
  }

  function spriteOf(level) {
    if (!sprites[level]) sprites[level] = buildSprite(level);
    return sprites[level];
  }

  function loadArt(level) {
    var f = FRUITS[level];
    if (!f.img || imgs[level]) return;
    var im = new Image();
    im.onload = function () {
      imgReady[level] = true;
      imgs[level] = im;
      sprites[level] = null;
    };
    im.onerror = function () { imgReady[level] = false; };
    im.src = f.img;
  }

  /* ============================================================
     物理
     ============================================================ */

  function makeBall(level, x, y) {
    var f = FRUITS[level];
    return {
      level: level,
      x: x,
      y: y,
      r: f.r,
      vx: 0,
      vy: 0,
      ang: 0,
      w: 0,
      age: 0,
      dead: false
    };
  }

  function collide(a, b) {
    var dx = b.x - a.x;
    var dy = b.y - a.y;
    var rsum = a.r + b.r;
    var d2 = dx * dx + dy * dy;
    if (d2 >= rsum * rsum || d2 < 0.0001) return;

    var d = Math.sqrt(d2);
    var nx = dx / d;
    var ny = dy / d;
    var overlap = rsum - d;

    var ma = a.r * a.r;
    var mb = b.r * b.r;
    var tm = ma + mb;

    // 位置修正：大部分重叠直接推开，剩下的靠迭代
    var corr = overlap * 0.82;
    a.x -= nx * corr * (mb / tm);
    a.y -= ny * corr * (mb / tm);
    b.x += nx * corr * (ma / tm);
    b.y += ny * corr * (ma / tm);

    // 速度冲量
    var rvx = b.vx - a.vx;
    var rvy = b.vy - a.vy;
    var vn = rvx * nx + rvy * ny;
    if (vn >= 0) return;

    var jimp = -(1 + REST) * vn / (1 / ma + 1 / mb);
    a.vx -= nx * jimp / ma;
    a.vy -= ny * jimp / ma;
    b.vx += nx * jimp / mb;
    b.vy += ny * jimp / mb;

    // 切向冲量：带上角速度，果子才会"滚"起来，而不是贴着地面滑
    // t = n 转 90°，接触点速度 = 线速度 + ω × r；圆盘 I = ½mr²，所以 1/m + r²/I = 3/m
    var tx = ny;
    var ty = -nx;
    var vt = (b.vx - a.vx) * tx + (b.vy - a.vy) * ty + (b.w * b.r + a.w * a.r);
    var kt = 3 / ma + 3 / mb;
    var jt = -vt / kt;
    var lim = jimp * FRICTION;
    if (jt > lim) jt = lim;
    if (jt < -lim) jt = -lim;

    a.vx -= tx * jt / ma;
    a.vy -= ty * jt / ma;
    b.vx += tx * jt / mb;
    b.vy += ty * jt / mb;
    a.w += 2 * jt / (ma * a.r);
    b.w += 2 * jt / (mb * b.r);
  }

  function walls(b) {
    var m = b.r * b.r;
    var kt = 3 / m;          // 1/m + r²/I

    if (b.x - b.r < 0) {
      b.x = b.r;
      if (b.vx < 0) b.vx = -b.vx * 0.4;
      // 侧墙的竖直摩擦（贴墙往下蹭的时候会转）
      var vtl = b.vy - b.w * b.r;
      var jtl = -vtl / kt;
      b.vy += jtl / m;
      b.w += -2 * jtl / (m * b.r);
    } else if (b.x + b.r > W) {
      b.x = W - b.r;
      if (b.vx > 0) b.vx = -b.vx * 0.4;
      var vtr = b.vy + b.w * b.r;
      var jtr = -vtr / kt;
      b.vy += jtr / m;
      b.w += 2 * jtr / (m * b.r);
    }

    if (b.y + b.r > H) {
      b.y = H - b.r;
      if (b.vy > 0) b.vy = -b.vy * 0.16;
      // 地面：接触点的水平速度是 vx - ωr，把它抹平就是纯滚动
      var vtf = b.vx - b.w * b.r;
      var jtf = -vtf / kt;
      b.vx += jtf / m;
      b.w += -2 * jtf / (m * b.r);
    }
  }

  function stepPhysics(dt) {
    var i, j, b;

    for (i = 0; i < balls.length; i++) {
      b = balls[i];
      b.age += dt;
      b.vy += GRAVITY * dt;
      if (b.vy > MAX_SPEED) b.vy = MAX_SPEED;
      // 空气阻力 + 一点点滚动阻力（不然会永远滚）
      b.vx *= (1 - 0.12 * dt);
      b.vy *= (1 - 0.05 * dt);
      b.w *= (1 - 0.3 * dt);
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.ang += b.w * dt;
    }

    for (var it = 0; it < ITER; it++) {
      for (i = 0; i < balls.length; i++) {
        for (j = i + 1; j < balls.length; j++) collide(balls[i], balls[j]);
      }
      for (i = 0; i < balls.length; i++) walls(balls[i]);
    }

    // 真的停住了才归零（别把"慢慢滚"也按住，那样看起来就不像玩球了）
    for (i = 0; i < balls.length; i++) {
      b = balls[i];
      var v2 = b.vx * b.vx + b.vy * b.vy;
      if (v2 < 4 && Math.abs(b.w) < 0.12) { b.vx = 0; b.vy = 0; b.w = 0; }
    }
  }

  /* ---------- 合成 ---------- */

  function merge(a, b) {
    // 辉辉是最后一颗，跟西瓜一样不再合——两个只会一起占地方
    var lv = a.level;
    var nl = lv + 1;
    if (nl > MAX_LEVEL) return;

    a.dead = true;
    b.dead = true;

    var ma = a.r * a.r;
    var mb = b.r * b.r;
    var x = (a.x * ma + b.x * mb) / (ma + mb);
    var y = (a.y * ma + b.y * mb) / (ma + mb);
    var vx = (a.vx + b.vx) * 0.25;
    var vy = (a.vy + b.vy) * 0.25;

    if (clock - comboAt < 1.1) combo++; else combo = 1;
    comboAt = clock;
    var mult = Math.min(combo, 5);
    var pts = Math.round(FRUITS[nl].points * (1 + (mult - 1) * 0.35));
    score += pts;
    merges++;
    if (nl > maxLevel) maxLevel = nl;

    var nb = makeBall(nl, x, y);
    nb.vx = vx;
    nb.vy = vy;
    nb.w = (a.w + b.w) * 0.25;
    nb.ang = a.ang;
    balls.push(nb);

    burst(x, y, FRUITS[nl].color, 8 + lv * 2);
    popup(x, y - 8, '+' + pts + (mult > 1 ? ' ×' + mult : ''));
    sfxMerge(nl);
    paintHud();

    if (nl === MAX_LEVEL) {
      banner.t = 2;
      banner.text = '合成小辉辉！';
      burst(x, y, '#e9b949', 30);
      sfxWin();
    }
  }

  function mergePass() {
    var guard = 0;
    while (guard++ < 16) {
      var a = null;
      var t = null;
      for (var i = 0; i < balls.length && !a; i++) {
        var p = balls[i];
        if (p.dead || p.age < 0.05 || p.level >= MAX_LEVEL) continue;
        for (var j = i + 1; j < balls.length; j++) {
          var q = balls[j];
          if (q.dead || q.age < 0.05 || q.level !== p.level) continue;
          var dx = q.x - p.x;
          var dy = q.y - p.y;
          // +5 的宽容：物理会把两个球刚好推到"相切"，不留这点余量就永远差一点点
          var lim = p.r + q.r + 5;
          if (dx * dx + dy * dy <= lim * lim) { a = p; t = q; break; }
        }
      }
      if (!a) break;
      merge(a, t);
    }

    for (var kk = balls.length - 1; kk >= 0; kk--) {
      if (balls[kk].dead) balls.splice(kk, 1);
    }
  }

  /* ---------- 压线 ---------- */

  function checkDanger(dt) {
    var danger = false;
    for (var i = 0; i < balls.length; i++) {
      var b = balls[i];
      if (b.dead || b.age < 1) continue;
      if (b.y > DANGER_Y && b.y - b.r < DANGER_Y && Math.abs(b.vy) < 280) {
        danger = true;
        break;
      }
    }
    if (danger) dangerT += dt;
    else dangerT = Math.max(0, dangerT - dt * 2.5);

    if (canvas) canvas.classList.toggle('is-danger', dangerT > 0.5);
    if (dangerT >= DANGER_TIME) gameOver();
  }

  /* ============================================================
     特效
     ============================================================ */

  function burst(x, y, color, n) {
    for (var i = 0; i < n; i++) {
      var a = Math.random() * TAU;
      var s = 90 + Math.random() * 260;
      particles.push({
        x: x,
        y: y,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s - 60,
        r: 2 + Math.random() * 5,
        life: 0.5 + Math.random() * 0.4,
        max: 0.9,
        color: color
      });
    }
  }

  function popup(x, y, text) {
    pops.push({ x: x, y: y, text: text, life: 0.9, max: 0.9 });
  }

  /* ============================================================
     绘制
     ============================================================ */

  function drawBoard() {
    ctx.fillStyle = '#fffefb';
    ctx.fillRect(0, 0, W, H + 2);

    // 淡淡的方格，像草稿纸
    ctx.save();
    ctx.strokeStyle = 'rgba(35, 33, 28, 0.045)';
    ctx.lineWidth = 1;
    var step = 75;
    for (var x = step; x < W; x += step) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
    }
    for (var y = step; y < H; y += step) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }
    ctx.restore();

    // 箱底
    ctx.fillStyle = 'rgba(35, 33, 28, 0.06)';
    ctx.fillRect(0, H - 6, W, 6);
  }

  function drawDanger() {
    var hot = dangerT > 0.5;
    var pulse = hot ? 0.45 + Math.sin(clock * 12) * 0.2 : 0.16;
    ctx.save();
    ctx.setLineDash([12, 10]);
    ctx.lineWidth = hot ? 3 : 2;
    ctx.strokeStyle = 'rgba(193, 82, 47, ' + pulse.toFixed(2) + ')';
    ctx.beginPath();
    ctx.moveTo(0, DANGER_Y);
    ctx.lineTo(W, DANGER_Y);
    ctx.stroke();
    ctx.restore();

    if (hot) {
      ctx.save();
      var g = ctx.createLinearGradient(0, DANGER_Y - 40, 0, DANGER_Y + 10);
      g.addColorStop(0, 'rgba(193,82,47,0)');
      g.addColorStop(1, 'rgba(193,82,47,0.10)');
      ctx.fillStyle = g;
      ctx.fillRect(0, DANGER_Y - 40, W, 50);
      ctx.restore();
    }
  }

  function drawGuide() {
    if (mode !== 'play') return;
    var f = FRUITS[curLevel];
    ctx.save();
    ctx.setLineDash([7, 9]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(35, 33, 28, 0.14)';
    ctx.beginPath();
    ctx.moveTo(aimX, DROP_Y + f.r);
    ctx.lineTo(aimX, H - 8);
    ctx.stroke();
    ctx.restore();
  }

  function drawHeld() {
    var f = FRUITS[curLevel];
    var ready = mode === 'play' && clock >= dropAt;
    ctx.save();
    ctx.globalAlpha = ready ? 1 : 0.55;
    var s = spriteOf(curLevel);
    var half = s.size / 2;
    ctx.drawImage(s.cvs, aimX - half, DROP_Y - half, s.size, s.size);
    ctx.restore();
  }

  function drawBall(b) {
    var s = spriteOf(b.level);
    var half = s.size / 2;
    // 被挤得厉害的时候稍微压一下，看起来有重量
    var squash = 1;
    if (b.vy > 900) squash = 1 - Math.min(0.08, (b.vy - 900) / 12000);
    ctx.save();
    ctx.translate(b.x, b.y + (squash < 1 ? b.r * (1 - squash) : 0));
    if (squash < 1) ctx.scale(1 + (1 - squash) * 0.6, squash);
    if (b.ang) ctx.rotate(b.ang);
    ctx.drawImage(s.cvs, -half, -half, s.size, s.size);
    ctx.restore();
  }

  function drawParticles(dt) {
    for (var i = particles.length - 1; i >= 0; i--) {
      var p = particles[i];
      p.life -= dt;
      if (p.life <= 0) { particles.splice(i, 1); continue; }
      p.vy += 900 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      ctx.globalAlpha = Math.max(0, p.life / p.max);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawPops(dt) {
    for (var i = pops.length - 1; i >= 0; i--) {
      var p = pops[i];
      p.life -= dt;
      if (p.life <= 0) { pops.splice(i, 1); continue; }
      p.y -= 46 * dt;
      var a = Math.min(1, p.life / p.max * 1.6);
      ctx.globalAlpha = a;
      ctx.fillStyle = '#a33228';
      ctx.font = '700 26px "SFMono-Regular", Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(p.text, p.x, p.y);
    }
    ctx.globalAlpha = 1;
  }

  function drawBanner() {
    if (banner.t <= 0) return;
    var a = Math.min(1, banner.t);
    ctx.save();
    ctx.globalAlpha = a;
    ctx.fillStyle = 'rgba(253, 251, 246, 0.86)';
    var bw = W * 0.82;
    var bh = 104;
    roundRect((W - bw) / 2, H * 0.36, bw, bh, 10);
    ctx.fill();

    ctx.fillStyle = '#a33228';
    ctx.font = '700 40px "Songti SC", "Noto Serif SC", serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(banner.text, W / 2, H * 0.36 + bh / 2 + 2);
    ctx.restore();
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function draw(dt) {
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.clearRect(0, 0, W, H);

    drawBoard();
    drawDanger();
    drawGuide();

    for (var i = 0; i < balls.length; i++) drawBall(balls[i]);

    if (mode === 'play' || mode === 'pause') drawHeld();

    drawParticles(dt);
    drawPops(dt);
    drawBanner();

    if (banner.t > 0) banner.t -= dt;
  }

  /* ============================================================
     主循环
     ============================================================ */

  function frame(ts) {
    if (!lastTs) lastTs = ts;
    var dt = (ts - lastTs) / 1000;
    lastTs = ts;
    if (dt < 0) dt = 0;
    if (dt > 0.1) dt = 0.1;

    if (mode === 'play') {
      clock += dt;
      acc += dt;
      if (acc > 0.14) acc = 0.14;
      var guard = 0;
      while (acc >= STEP && guard++ < 8) {
        stepPhysics(STEP);
        acc -= STEP;
      }
      mergePass();
      checkDanger(dt);
    }

    if (drawOn) draw(dt);
    raf = requestAnimationFrame(frame);
  }
  /* ============================================================
     玩法流程
     ============================================================ */

  function randomLevel() {
    var total = 0;
    var i;
    for (i = 0; i < SPAWN.length; i++) total += SPAWN[i].w;
    var r = Math.random() * total;
    for (i = 0; i < SPAWN.length; i++) {
      r -= SPAWN[i].w;
      if (r <= 0) return SPAWN[i].level;
    }
    return 1;
  }

  function clampAim(x, r) {
    return clamp(x, r + 2, W - r - 2);
  }

  function startGame() {
    gen++;
    balls = [];
    particles = [];
    pops = [];
    banner.t = 0;
    clock = 0;
    acc = 0;
    lastTs = 0;
    score = 0;
    merges = 0;
    maxLevel = 1;
    combo = 0;
    comboAt = -9;
    dangerT = 0;
    dropAt = 0;
    submitted = 0;
    mode = 'play';
    curLevel = randomLevel();
    nextLevel = randomLevel();
    aimX = W / 2;

    if (canvas) canvas.classList.remove('is-danger');
    overlay.hidden = true;
    paintHud();
    paintNext();
    resumeAudio();

    if (!raf) {
      lastTs = 0;
      raf = requestAnimationFrame(frame);
    }
  }

  function drop() {
    if (mode !== 'play') return;
    if (clock < dropAt) return;

    var r = FRUITS[curLevel].r;
    var b = makeBall(curLevel, clampAim(aimX, r), DROP_Y);
    b.vy = 40;
    balls.push(b);

    dropAt = clock + DROP_CD;
    curLevel = nextLevel;
    nextLevel = randomLevel();
    paintNext();
    sfxDrop();
  }

  function pauseGame() {
    if (mode !== 'play') return;
    mode = 'pause';
    showPause();
  }

  function resumeGame() {
    if (mode !== 'pause') return;
    mode = 'play';
    overlay.hidden = true;
    lastTs = 0;
  }

  function gameOver() {
    if (mode === 'over') return;
    mode = 'over';
    dangerT = 0;

    var isNew = score > best;
    if (isNew) {
      best = score;
      store(KEY_BEST, best);
    }
    paintHud();
    showOver(isNew);
    sfxOver();
    submitScore(score);
  }

  /* ============================================================
     HUD / 面板
     ============================================================ */

  function paintHud() {
    if (scoreEl) scoreEl.textContent = String(score);
    if (bestEl) bestEl.textContent = String(best);
  }

  function paintNext() {
    if (!nextEl) return;
    var f = FRUITS[nextLevel];
    nextEl.textContent = f.label;
    nextEl.style.background = f.img ? ('#fff url("' + f.img + '") center/cover') : f.color;
  }

  function paintSound() {
    if (!soundBtn) return;
    soundBtn.setAttribute('aria-pressed', muted ? 'false' : 'true');
    soundBtn.textContent = '♪';
    soundBtn.setAttribute('aria-label', muted ? '声音关' : '声音开');
  }

  function ladderHtml() {
    var out = '';
    for (var i = 1; i <= MAX_LEVEL; i++) {
      var f = FRUITS[i];
      var d = Math.round(16 + i * 3.4);
      var style = 'width:' + d + 'px;height:' + d + 'px;font-size:' + Math.round(d * 0.46) + 'px;';
      if (f.img) {
        // 注意：style 属性用双引号包着，url 里必须用单引号，否则 HTML 会被截断
        style += "background:#fff url('" + f.img + "') center/cover;color:transparent;";
      } else {
        style += 'background:' + f.color + ';';
      }
      out += '<span class="dot" style="' + style + '">' + f.label + '</span>';
      if (i < MAX_LEVEL) out += '<span class="arrow">→</span>';
    }
    return out;
  }

  function showMenu() {
    mode = 'menu';
    panel.innerHTML =
      '<h1>合成小辉辉</h1>' +
      '<p class="sub">两个一样的水果撞在一起，就合成下一级。<br>' +
        '一路合上去，最后那个是辉辉。</p>' +
      '<div class="ladder">' + ladderHtml() + '</div>' +
      '<ul class="rules">' +
        '<li>拖动（或按 <b>← →</b>）选位置，松手落果；电脑上也可以直接点。</li>' +
        '<li>果子会滚，堆歪了会自己滑下来；同级的碰在一起就合成，连着合有加成。</li>' +
        '<li>辉辉是最后一颗，跟西瓜一样不会再合，两个只会一起占地方。</li>' +
        '<li>水果堆过<b>红线 2 秒</b>就结束——红线不是装饰。</li>' +
      '</ul>' +
      '<button class="btn-main" type="button" data-act="go">开始</button>' +
      '<p class="tip">本机最高 ' + best + ' 分 · ' +
        (B8.auth && B8.auth.isLogged()
          ? '成绩会记到排行榜'
          : '没登录，成绩只存在这台设备 · <a href="index.html">回游乐场登录</a>') +
      '</p>' +
      '<p class="tip"><a href="index.html">← 回游乐场</a></p>';
    overlay.hidden = false;
  }

  function showPause() {
    panel.innerHTML =
      '<h1>歇一下</h1>' +
      '<p class="sub">现在 ' + score + ' 分，合了 ' + merges + ' 次，最高到第 ' + maxLevel + ' 级。</p>' +
      '<button class="btn-main" type="button" data-act="resume">继续</button>' +
      '<button class="btn-2nd" type="button" data-act="again">重开一局</button>' +
      '<p class="tip"><a href="index.html">← 回游乐场</a></p>';
    overlay.hidden = false;
  }

  function showOver(isNew) {
    var made = maxLevel >= MAX_LEVEL;
    panel.innerHTML =
      '<h1>' + (made ? '合出辉辉了' : '这一局') + '</h1>' +
      '<p class="sub">' + (isNew ? '本机新纪录。' : '再来一局，堆得再高一点。') + '</p>' +
      '<div class="result">' +
        '<div><span class="big">' + score + '</span><span class="big-unit">分</span></div>' +
        '<p class="rank-line">' + (made ? '最高合成 <b>小辉辉</b>' : '最高合到 <b>第 ' + maxLevel + ' 级</b>') +
          ' · 合成 ' + merges + ' 次</p>' +
        '<dl>' +
          '<div><dt>本机最高</dt><dd>' + best + '</dd></div>' +
          '<div><dt>合成次数</dt><dd>' + merges + '</dd></div>' +
          '<div><dt>最高等级</dt><dd>' + maxLevel + ' / ' + MAX_LEVEL + '</dd></div>' +
        '</dl>' +
      '</div>' +
      '<p class="note-line" id="suika-note"></p>' +
      '<button class="btn-main" type="button" data-act="again">再来一局</button>' +
      '<p class="tip"><a href="index.html">← 回游乐场</a></p>';
    overlay.hidden = false;
  }

  function setNote(msg, isErr) {
    var n = $('suika-note');
    if (!n) return;
    n.textContent = msg;
    n.classList[isErr ? 'add' : 'remove']('is-err');
  }

  function submitScore(v) {
    if (!writable || !B8.auth || !B8.sb) return;
    if (!v || v <= submitted || v > 990000) return;
    submitted = v;
    B8.sb.rpc('b8_score_add', {
      p_token: B8.auth.token(),
      p_game: 'suika',
      p_score: Math.floor(v)
    }).then(function () {
      setNote('成绩已记到排行榜：' + v + ' 分。');
    }).catch(function (err) {
      submitted = 0;
      setNote('成绩没传上去：' + (err && err.message ? err.message : '网络异常'), true);
    });
  }

  /* ============================================================
     输入
     ============================================================ */

  function setAim(clientX) {
    var r = canvas.getBoundingClientRect();
    if (!r.width) return;
    var x = (clientX - r.left) / r.width * W;
    aimX = clampAim(x, FRUITS[curLevel].r);
  }

  function onDown(ev) {
    if (mode !== 'play') return;
    ev.preventDefault();
    dragging = true;
    setAim(ev.clientX);
  }

  function onMove(ev) {
    if (mode !== 'play') return;
    setAim(ev.clientX);
  }

  function onUp(ev) {
    if (!dragging) return;
    dragging = false;
    if (mode !== 'play') return;
    setAim(ev.clientX);
    drop();
  }

  function onKey(ev) {
    var k2 = String(ev.key || '').toUpperCase();
    var onPanelBtn = ev.target && ev.target.closest && ev.target.closest('#panel button');

    if (mode === 'menu' || mode === 'over') {
      if ((k2 === ' ' || k2 === 'ENTER') && !onPanelBtn) {
        ev.preventDefault();
        startGame();
      }
      return;
    }
    if (mode === 'pause') {
      if (k2 === ' ' || k2 === 'ENTER' || k2 === 'ESCAPE') {
        ev.preventDefault();
        resumeGame();
      }
      return;
    }

    if (k2 === 'ARROWLEFT' || k2 === 'A') {
      ev.preventDefault();
      aimX = clampAim(aimX - 22, FRUITS[curLevel].r);
    } else if (k2 === 'ARROWRIGHT' || k2 === 'D') {
      ev.preventDefault();
      aimX = clampAim(aimX + 22, FRUITS[curLevel].r);
    } else if (k2 === ' ' || k2 === 'ENTER' || k2 === 'ARROWDOWN' || k2 === 'S') {
      ev.preventDefault();
      drop();
    } else if (k2 === 'ESCAPE' || k2 === 'P') {
      ev.preventDefault();
      pauseGame();
    }
  }

  /* ============================================================
     尺寸
     ============================================================ */

  function fit() {
    if (!boardWrap || !canvas) return;
    var box = boardWrap.getBoundingClientRect();
    var availW = Math.max(120, box.width - 16);
    var availH = Math.max(180, box.height - 16);
    var w = Math.min(availW, availH / 1.5);
    var h = w * 1.5;

    canvas.style.width = Math.round(w) + 'px';
    canvas.style.height = Math.round(h) + 'px';

    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    k = canvas.width / W;
  }

  /* ============================================================
     启动
     ============================================================ */

  function init() {
    canvas = $('board');
    boardWrap = $('board-wrap');
    overlay = $('overlay');
    panel = $('panel');
    scoreEl = $('hud-score');
    bestEl = $('hud-best');
    nextEl = $('next-ball');
    pauseBtn = $('btn-pause');
    soundBtn = $('btn-sound');
    if (!canvas || !panel) return;

    ctx = canvas.getContext('2d');
    if (!ctx) return;

    best = readNum(KEY_BEST);
    for (var lv = 1; lv <= MAX_LEVEL; lv++) loadArt(lv);

    fit();
    paintHud();
    paintNext();
    paintSound();
    showMenu();

    B8.on(canvas, 'pointerdown', onDown, { passive: false });
    B8.on(canvas, 'pointermove', onMove, { passive: false });
    // 手指滑出画布再松开也要落果，所以 pointerup 挂在 document 上
    B8.on(document, 'pointerup', onUp);
    B8.on(canvas, 'pointercancel', function () { dragging = false; });
    B8.on(document, 'keydown', onKey);

    B8.on(pauseBtn, 'click', function () {
      if (mode === 'play') pauseGame();
      else if (mode === 'pause') resumeGame();
    });

    B8.on(soundBtn, 'click', function () {
      muted = !muted;
      paintSound();
      resumeAudio();
    });

    B8.on($('btn-exit'), 'click', function () { location.href = 'index.html'; });

    panel.addEventListener('click', function (ev) {
      var act = closest(ev.target, '[data-act]');
      if (!act) return;
      var a = act.getAttribute('data-act');
      if (a === 'go' || a === 'again') startGame();
      else if (a === 'resume') resumeGame();
    });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden && mode === 'play') pauseGame();
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

    window.addEventListener('resize', fit);
    window.addEventListener('orientationchange', function () { setTimeout(fit, 120); });

    lastTs = 0;
    raf = requestAnimationFrame(frame);
  }

  whenReady(init);

  /* ============================================================
     调试接口（?t= 才放出落果位置，正常访问拿不到）
     ============================================================ */

  B8.games = B8.games || {};
  var api = {
    start: startGame,
    drop: function (x) {
      if (typeof x === 'number') aimX = clampAim(x, FRUITS[curLevel].r);
      drop();
    },
    // 没有 rAF 的环境（部分无头浏览器）用这个手动推帧
    tick: function (ts) {
      if (!lastTs) lastTs = ts;
      frame(ts);
    },
    draw: function (on) { drawOn = !!on; },
    state: function () {
      return {
        mode: mode, score: score, merges: merges, maxLevel: maxLevel,
        balls: balls.length, danger: Number(dangerT.toFixed(2)),
        cur: curLevel, next: nextLevel, best: best
      };
    }
  };

  if (window.B8_TEST) {
    api.balls = function () {
      var out = [];
      for (var i = 0; i < balls.length; i++) {
        out.push({
          lv: balls[i].level,
          x: Math.round(balls[i].x),
          y: Math.round(balls[i].y),
          r: balls[i].r,
          w: Math.round(balls[i].w * 100) / 100,
          ang: Math.round(balls[i].ang * 100) / 100
        });
      }
      return out;
    };
    // 自检用：直接放一颗指定等级的水果
    api.spawn = function (level, x, y) {
      var b = makeBall(clamp(level, 1, MAX_LEVEL), x, y);
      b.age = 1;
      balls.push(b);
      return balls.length;
    };
    api.over = function () { gameOver(); };
  }

  B8.games.suika = api;
})();
