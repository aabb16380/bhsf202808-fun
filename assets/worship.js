/* ============================================================
   膜宙金 · 八班游乐场
   ------------------------------------------------------------
   点「膜宙金」：
     · 班徽上先弹一次数字，然后班徽淡出；
     · 动画人每点一下弯一次腰，本机计数 +1；
     · 下面显示「共已膜 / 本机已膜」；
     · 「超级模式」进入全屏宇宙：班徽平滑移到中间、化成「宙金」，
       周围三圈膜拜动画，一圈顺时针、一圈逆时针。

   全局计数走 Supabase RPC b8_worship_get / b8_worship_bump；
   短时间内的连点合并成一次 p_n，避免每一下都发一个请求。
   数据库没接 / SQL 没跑时，本机计数照常，全站计数显示 — 并给提示。
   ============================================================ */
(function () {
  'use strict';

  var B8 = window.B8;
  if (!B8) return;

  var KEY_LOCAL = 'b8.worship.local';
  var KEY_TOTAL = 'b8.worship.total';

  var local = readNum(KEY_LOCAL);
  var total = readNum(KEY_TOTAL);
  var totalKnown = total > 0;
  var pending = 0;
  var bumpTimer = 0;
  var flushing = false;
  var bumpBroken = false;

  var modal = null;
  var space = null;
  var els = {};
  var badgeRect = null;
  var bowed = false;
  var bowTimer = 0;
  var popTimer = 0;
  var plusTimer = 0;

  var starRaf = 0;
  var starRunning = false;
  var starCanvas = null;
  var starCtx = null;
  var stars = [];
  var starW = 0;
  var starH = 0;
  var starDpr = 1;

  var reduced = false;
  try {
    reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch (e) {}

  function $(id) { return document.getElementById(id); }

  function readNum(key) {
    try { return Math.max(0, Number(localStorage.getItem(key) || 0) || 0); } catch (e) { return 0; }
  }

  function store(key, val) {
    try { localStorage.setItem(key, String(val)); } catch (e) {}
  }

  function fmt(n) {
    return Number(n || 0).toLocaleString('zh-CN');
  }

  function iconSrc() {
    return 'assets/icon.png?v=' + encodeURIComponent(window.B8_BUILD || '0');
  }

  function personHTML() {
    return '<span class="mo-upper">' +
        '<span class="mo-head"></span>' +
        '<span class="mo-torso"></span>' +
        '<span class="mo-arm a"></span>' +
        '<span class="mo-arm b"></span>' +
      '</span>' +
      '<span class="mo-leg a"></span>' +
      '<span class="mo-leg b"></span>';
  }

  function ringPersonHTML() {
    return '<span class="mo-ring-head"></span>' +
      '<span class="mo-ring-body"></span>' +
      '<span class="mo-ring-hands"></span>';
  }

  function whenReady(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  /* ============================================================
     面板
     ============================================================ */

  function build() {
    if (modal) return;

    var wrap = document.createElement('div');
    wrap.className = 'worship-modal';
    wrap.id = 'mo-modal';
    wrap.hidden = true;
    wrap.innerHTML =
      '<div class="mo-backdrop" data-mo-close></div>' +
      '<section class="mo-card" role="dialog" aria-modal="true" aria-labelledby="mo-title">' +
        '<button class="mo-x" type="button" data-mo-close aria-label="关闭">×</button>' +
        '<div class="mo-badge" id="mo-badge">' +
          '<img src="' + iconSrc() + '" alt="八班班徽" width="96" height="96">' +
          '<span class="mo-badge-num" id="mo-badge-num">0</span>' +
        '</div>' +
        '<h2 class="mo-title" id="mo-title">膜宙金</h2>' +
        '<p class="mo-sub">点一下 · 膜拜一次</p>' +
        '<div class="mo-stage" id="mo-stage" role="button" tabindex="0" aria-label="点一下膜拜一次">' +
          '<span class="mo-halo" aria-hidden="true"></span>' +
          '<span class="mo-person" id="mo-person">' + personHTML() + '</span>' +
          '<span class="mo-plus" id="mo-plus" aria-hidden="true">+1</span>' +
        '</div>' +
        '<div class="mo-counts">' +
          '<p>共已膜<b id="mo-total">—</b>次</p>' +
          '<p>本机已膜<b id="mo-local">0</b>次</p>' +
        '</div>' +
        '<button class="mo-super" id="mo-super" type="button">超级模式</button>' +
        '<p class="mo-note" id="mo-note"></p>' +
      '</section>';

    document.body.appendChild(wrap);
    modal = wrap;

    var sp = document.createElement('div');
    sp.className = 'mo-space';
    sp.id = 'mo-space';
    sp.hidden = true;
    sp.innerHTML =
      '<canvas id="mo-stars" aria-hidden="true"></canvas>' +
      '<div class="mo-space-badge" id="mo-space-badge">' +
        '<img src="' + iconSrc() + '" alt="" width="96" height="96">' +
        '<span class="mo-badge-num" id="mo-space-num">0</span>' +
      '</div>' +
      '<div class="mo-zhoujin" id="mo-zhoujin">宙金</div>' +
      '<div class="mo-rings" id="mo-rings" aria-hidden="true"></div>' +
      '<p class="mo-space-foot">' +
        '<span>共已膜 <b id="mo-space-total">—</b> 次</span>' +
        '<span>本机 <b id="mo-space-local">0</b> 次</span>' +
      '</p>' +
      '<button class="mo-exit" id="mo-exit" type="button">离开宇宙</button>';

    document.body.appendChild(sp);
    space = sp;

    els = {
      badge: $('mo-badge'),
      badgeNum: $('mo-badge-num'),
      stage: $('mo-stage'),
      person: $('mo-person'),
      plus: $('mo-plus'),
      total: $('mo-total'),
      local: $('mo-local'),
      note: $('mo-note'),
      super: $('mo-super'),
      spaceBadge: $('mo-space-badge'),
      spaceNum: $('mo-space-num'),
      zhoujin: $('mo-zhoujin'),
      rings: $('mo-rings'),
      spaceTotal: $('mo-space-total'),
      spaceLocal: $('mo-space-local'),
      exit: $('mo-exit')
    };

    B8.qsa('[data-mo-close]', modal).forEach(function (el) {
      B8.on(el, 'click', closeModal);
    });
    B8.on(els.stage, 'click', worship);
    B8.on(els.stage, 'keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        worship();
      }
    });
    B8.on(els.badge, 'click', worship);
    B8.on(els.super, 'click', openSpace);
    B8.on(els.exit, 'click', closeSpace);
    B8.on(space, 'click', function (ev) {
      if (ev.target === space) closeSpace();
    });

    B8.on(document, 'keydown', function (ev) {
      if (ev.key !== 'Escape') return;
      if (space && !space.hidden) { closeSpace(); return; }
      if (modal && !modal.hidden) closeModal();
    });

    B8.on(window, 'resize', function () {
      if (space && !space.hidden) resizeStars();
    });
  }

  function setNote(msg) {
    if (els.note) els.note.textContent = msg || '';
  }

  function render() {
    if (!els.local) return;
    els.local.textContent = fmt(local);
    els.badgeNum.textContent = fmt(local);
    els.total.textContent = totalKnown ? fmt(total) : (total > 0 ? fmt(total) : '—');
    if (els.spaceLocal) els.spaceLocal.textContent = fmt(local);
    if (els.spaceTotal) els.spaceTotal.textContent = totalKnown ? fmt(total) : (total > 0 ? fmt(total) : '—');
    if (els.spaceNum) els.spaceNum.textContent = fmt(local);
  }

  function openModal() {
    build();
    bowed = false;
    els.badge.classList.remove('is-gone');
    modal.hidden = false;
    document.body.classList.add('mo-lock');
    render();

    // 量一下班徽位置，超级模式从它现在的位置飞到中间
    requestAnimationFrame(function () {
      var r = els.badge.getBoundingClientRect();
      if (r.width > 0) {
        badgeRect = { left: r.left, top: r.top, width: r.width, height: r.height };
      }
    });

    if (!B8.sb || !B8.sb.ready) {
      setNote('数据库没接，全站计数暂不可用；本机计数正常。');
    } else {
      loadTotal();
    }

    if (pending) scheduleBump(0);
  }

  function closeModal() {
    if (!modal) return;
    modal.hidden = true;
    document.body.classList.remove('mo-lock');
    if (pending) flushBump();
  }

  function worship() {
    if (!modal || modal.hidden) return;

    local += 1;
    pending += 1;
    store(KEY_LOCAL, local);
    render();

    if (els.badgeNum) {
      els.badgeNum.classList.remove('is-pop');
      void els.badgeNum.offsetWidth;
      els.badgeNum.classList.add('is-pop');
      clearTimeout(popTimer);
      popTimer = setTimeout(function () { els.badgeNum.classList.remove('is-pop'); }, 320);
    }

    if (!bowed) {
      bowed = true;
      setTimeout(function () {
        if (modal && !modal.hidden) els.badge.classList.add('is-gone');
      }, 260);
    }

    if (els.person) {
      els.person.classList.remove('is-bow');
      void els.person.offsetWidth;
      els.person.classList.add('is-bow');
      clearTimeout(bowTimer);
      bowTimer = setTimeout(function () {
        if (els.person) els.person.classList.remove('is-bow');
      }, 430);
    }

    if (els.plus) {
      els.plus.classList.remove('is-on');
      void els.plus.offsetWidth;
      els.plus.classList.add('is-on');
      clearTimeout(plusTimer);
      plusTimer = setTimeout(function () { els.plus.classList.remove('is-on'); }, 600);
    }

    scheduleBump(450);
  }

  /* ---------- 全站计数 ---------- */
  function loadTotal() {
    if (!B8.sb || !B8.sb.ready) return;
    B8.sb.rpc('b8_worship_get', {}).then(function (v) {
      var n = Number(v);
      // 全站计数只会涨；如果 bump 的响应比 get 先回来，别让旧值把它盖回去
      if (!isNaN(n) && n >= total) {
        total = n;
        totalKnown = true;
        store(KEY_TOTAL, total);
        render();
      }
      setNote('');
    }).catch(function (err) {
      var msg = err && err.message ? err.message : '网络异常';
      if (/Could not find the function|schema cache|does not exist/i.test(msg)) {
        bumpBroken = true;
        setNote('全站计数要更新数据库：请在 Supabase SQL Editor 跑一遍 supabase/install-all.sql。');
      } else {
        setNote('全站计数暂时没连上，本机计数正常。');
      }
    });
  }

  function scheduleBump(delay) {
    if (bumpBroken || !pending || bumpTimer) return;
    bumpTimer = setTimeout(flushBump, typeof delay === 'number' ? delay : 450);
  }

  function flushBump() {
    bumpTimer = 0;
    if (flushing || !pending || bumpBroken) return;
    if (!B8.sb || !B8.sb.ready) {
      setNote('数据库没接，全站计数暂不可用；本机计数正常。');
      return;
    }

    flushing = true;
    var n = Math.min(pending, 1000);
    pending -= n;

    B8.sb.rpc('b8_worship_bump', { p_n: n }).then(function (res) {
      var v = res && res.total != null ? res.total : res;
      var num = Number(v);
      if (!isNaN(num)) {
        total = num;
        totalKnown = true;
        store(KEY_TOTAL, total);
        render();
      }
      setNote('');
    }).catch(function (err) {
      pending += n;
      var msg = err && err.message ? err.message : '网络异常';
      if (/Could not find the function|schema cache|does not exist/i.test(msg)) {
        bumpBroken = true;
        setNote('全站计数要更新数据库：请在 Supabase SQL Editor 跑一遍 supabase/install-all.sql。');
      } else {
        setNote('全站计数暂时没连上，本机计数正常；本机次数已经记下。');
      }
    }).then(function () {
      flushing = false;
      if (pending && !bumpBroken) scheduleBump(700);
    });
  }

  /* ============================================================
     超级模式
     ============================================================ */

  function openSpace() {
    build();
    if (!space) return;
    modal.hidden = true;
    space.hidden = false;
    document.body.classList.add('mo-lock', 'mo-space-open');
    render();

    els.spaceBadge.classList.remove('is-vanish');
    els.zhoujin.classList.remove('is-on');
    els.rings.classList.remove('is-on');
    buildRings();
    startStars();

    var r = badgeRect || {
      left: window.innerWidth / 2 - 48,
      top: window.innerHeight / 2 - 120,
      width: 96,
      height: 96
    };

    els.spaceBadge.style.transition = 'none';
    els.spaceBadge.style.left = r.left + 'px';
    els.spaceBadge.style.top = r.top + 'px';
    els.spaceBadge.style.width = r.width + 'px';
    els.spaceBadge.style.height = r.height + 'px';
    els.spaceBadge.style.transform = 'translate(0, 0) scale(1)';
    els.spaceBadge.style.opacity = '1';
    void els.spaceBadge.offsetWidth;
    els.spaceBadge.style.transition = '';

    requestAnimationFrame(function () {
      var cx = window.innerWidth / 2;
      var cy = window.innerHeight / 2;
      var dx = cx - (r.left + r.width / 2);
      var dy = cy - (r.top + r.height / 2);
      els.spaceBadge.style.transform = 'translate(' + dx + 'px,' + dy + 'px) scale(1.15)';
    });

    var delay = reduced ? 30 : 980;
    setTimeout(function () {
      els.spaceBadge.style.opacity = '';
      els.spaceBadge.classList.add('is-vanish');
      els.zhoujin.classList.add('is-on');
    }, delay);
    setTimeout(function () {
      els.rings.classList.add('is-on');
    }, delay + (reduced ? 20 : 180));
  }

  function closeSpace() {
    if (!space || space.hidden) return;
    space.hidden = true;
    document.body.classList.remove('mo-space-open');
    stopStars();
    if (modal) {
      modal.hidden = false;
      document.body.classList.add('mo-lock');
      bowed = false;
      if (els.badge) els.badge.classList.remove('is-gone');
      render();
    }
  }

  function addRing(count, radius, dir, duration) {
    var ring = document.createElement('div');
    ring.className = 'mo-ring ' + dir;
    ring.style.animationDuration = duration + 's';
    ring.style.setProperty('--r', radius + 'vmin');

    for (var i = 0; i < count; i++) {
      var item = document.createElement('span');
      item.className = 'mo-ring-item';
      item.style.setProperty('--a', (360 / count * i) + 'deg');
      item.style.setProperty('--r', radius + 'vmin');
      item.style.setProperty('--d', (-(i * 0.37)).toFixed(2) + 's');
      item.innerHTML = '<span class="mo-ring-person">' + ringPersonHTML() + '</span>';
      ring.appendChild(item);
    }
    els.rings.appendChild(ring);
  }

  function buildRings() {
    if (!els.rings || els.rings.childNodes.length) return;
    addRing(6, 20, 'cw', 46);
    addRing(9, 33, 'ccw', 62);
    addRing(12, 45, 'cw', 78);
  }

  /* ---------- 星空 canvas ---------- */
  function makeStars() {
    stars = [];
    var n = window.innerWidth < 600 ? 150 : 240;
    for (var i = 0; i < n; i++) {
      stars.push({
        x: Math.random(),
        y: Math.random(),
        r: Math.random() * 1.5 + 0.35,
        p: Math.random() * Math.PI * 2,
        s: Math.random() * 0.8 + 0.35,
        warm: Math.random() < 0.12
      });
    }
  }

  function resizeStars() {
    if (!starCanvas) return;
    starW = window.innerWidth;
    starH = window.innerHeight;
    starDpr = Math.min(2, window.devicePixelRatio || 1);
    starCanvas.width = Math.round(starW * starDpr);
    starCanvas.height = Math.round(starH * starDpr);
    starCtx.setTransform(starDpr, 0, 0, starDpr, 0, 0);
  }

  function startStars() {
    if (!starCanvas) starCanvas = $('mo-stars');
    if (!starCanvas) return;
    starCtx = starCanvas.getContext('2d');
    if (!starCtx) return;
    if (!stars.length) makeStars();
    resizeStars();
    starRunning = true;
    drawStars(0);
  }

  function stopStars() {
    starRunning = false;
    if (starRaf) { cancelAnimationFrame(starRaf); starRaf = 0; }
  }

  function drawStars(ts) {
    if (!starRunning || !starCtx) return;
    var t = (ts || 0) / 1000;
    starCtx.clearRect(0, 0, starW, starH);
    for (var i = 0; i < stars.length; i++) {
      var s = stars[i];
      var a = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * s.s + s.p));
      starCtx.beginPath();
      starCtx.fillStyle = s.warm
        ? 'rgba(246, 217, 143, ' + a.toFixed(3) + ')'
        : 'rgba(224, 232, 255, ' + a.toFixed(3) + ')';
      starCtx.arc(s.x * starW, s.y * starH, s.r, 0, Math.PI * 2);
      starCtx.fill();
    }
    if (reduced) return;
    starRaf = requestAnimationFrame(drawStars);
  }

  /* ============================================================
     启动
     ============================================================ */

  function boot() {
    var btn = document.getElementById('mo-open');
    if (!btn) return;
    build();
    render();
    B8.on(btn, 'click', openModal);

    B8.worship = {
      open: openModal,
      close: closeModal,
      superMode: openSpace,
      leave: closeSpace
    };

    if (window.B8_TEST) {
      // 截图 / 自检入口：?t=1&mo=open 或 ?t=1&mo=space
      if (/[?&]mo=open\b/.test(location.search)) openModal();
      if (/[?&]mo=space\b/.test(location.search)) {
        openModal();
        openSpace();
      }
      B8.worship.state = function () {
        return {
          local: local, total: total, totalKnown: totalKnown,
          pending: pending, modalOpen: !!(modal && !modal.hidden),
          spaceOpen: !!(space && !space.hidden), bowed: bowed,
          rings: els.rings ? els.rings.querySelectorAll('.mo-ring-item').length : 0
        };
      };
      B8.worship.click = worship;
      B8.worship.flush = function () {
        if (bumpTimer) { clearTimeout(bumpTimer); bumpTimer = 0; }
        flushBump();
      };
    }
  }

  whenReady(boot);
})();
