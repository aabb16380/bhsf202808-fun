/* ============================================================
   膜宙金 · 八班游乐场（v2.75 首页内联版）
   ------------------------------------------------------------
   · 点「膜宙金」不弹窗：电脑右侧班徽变「宙金」，下面 6 帧猫猫动图 +
     两个计数 +「超级模式」；手机版按钮右边直接出动图和计数。
   · 猫猫每循环完一次，头顶 +1 并计数；点猫猫/按钮也 +1。
   · 超级模式分三步：先只剩宙金 → 宙金飞到中间并变色 → 再出现两圈
     反向旋转的猫猫（10 秒一圈），每个猫猫每转完一轮也 +1 计数。
   · 超级模式：点中间大圆计数，点圆外或「退出」离开。
   猫猫素材：assets/mo-cat-sprite.webp（6 帧横向雪碧图）。
   计数：本机 localStorage + RPC b8_worship_get / b8_worship_bump。
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

  var points = 0;
  var speedLv = 1;
  var catLv = 0;
  var pointLv = 1;
  var userKnown = false;
  var loggedIn = false;
  var catDur = 1.6;
  var pending = 0;
  var bumpTimer = 0;
  var flushing = false;
  var bumpBroken = false;

  var active = false;
  var superOpen = false;
  var superBuilt = false;
  var superTimers = [];
  var popTimer = 0;
  var homeTimer = 0;
  var userSyncTimer = 0;
  var homeDelay = 0;
  var catTimeouts = [];
  var catIntervals = [];
  var ringEls = [];
  var ringCatEls = [];
  var superRaf = 0;
  var ringStart = 0;

  var els = {};

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

  function authToken() {
    try {
      if (!B8.auth || !B8.auth.isLogged || !B8.auth.isLogged()) return '';
      return B8.auth.token() || '';
    } catch (e) { return ''; }
  }

  function pointGain() {
    return Math.pow(2, pointLv - 1);
  }

  function speedSeconds() {
    return Math.max(0.4, 1.6 - (speedLv - 1) * 0.1);
  }

  function applyUserState(s, soft) {
    if (!s) return;
    var oldSpeed = speedLv;
    var oldCat = catLv;

    if (s.points != null) points = Math.max(0, Number(s.points) || 0);
    if (s.speed_lv != null) speedLv = Math.max(1, Number(s.speed_lv) || 1);
    if (s.cat_lv != null) catLv = Math.max(0, Number(s.cat_lv) || 0);
    if (s.point_lv != null) pointLv = Math.max(1, Number(s.point_lv) || 1);

    catDur = speedSeconds();
    document.documentElement.style.setProperty('--cat-dur', catDur.toFixed(2) + 's');
    var plusDur = Math.min(0.36, Math.max(0.16, catDur * 0.28));
    document.documentElement.style.setProperty('--plus-dur', plusDur.toFixed(2) + 's');
    userKnown = true;

    if (active) {
      if (!soft || oldSpeed !== speedLv) {
        restartCat(els.cat);
        restartCat(els.catM);
        restartHomeAuto();
      }
      if (superOpen && (!soft || oldCat !== catLv || oldSpeed !== speedLv)) {
        buildSuperRings();
        startRings();
      }
    }
    render();
    renderShop();
  }

  function syncUserState() {
    if (!active || !loggedIn || document.hidden) return;
    var t = authToken();
    if (!t) return;
    B8.sb.rpc('b8_worship_state', { p_token: t }).then(function (s) {
      applyUserState(s, true);
      loadTotal();
    }).catch(function () {});
  }

  function loadUserState() {
    var t = authToken();
    if (!t) { loggedIn = false; renderShop(); return; }
    loggedIn = true;
    B8.sb.rpc('b8_worship_state', { p_token: t }).then(function (s) {
      applyUserState(s);
    }).catch(function (err) {
      var msg = err && err.message ? err.message : '';
      if (/Could not find the function|schema cache|does not exist/i.test(msg)) {
        setShopNote('膜宙金商店要更新数据库：请先跑一遍 supabase/install-all.sql。', true);
      }
    });
  }

  function whenReady(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  function visible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    return r.width > 4 && r.height > 4 && el.offsetParent !== null;
  }

  function restartCat(el) {
    if (!el) return;
    try {
      el.style.animation = 'none';
      void el.offsetWidth;
      el.style.animation = '';
    } catch (e) {}
  }

  function stopHomeAuto() {
    if (homeTimer) { clearInterval(homeTimer); homeTimer = 0; }
    if (homeDelay) { clearTimeout(homeDelay); homeDelay = 0; }
  }

  /* 首页猫猫：动画走到「趴下」那一帧时 +1；速度升级后 DUR 会变短 */
  function startHomeAuto() {
    if (homeTimer || homeDelay) return;
    var DUR = Math.round(catDur * 1000);
    var FLAT = Math.round(DUR * 2 / 6);   // 第 3 帧开始 = 趴下

    function tick() {
      if (!active || superOpen || document.hidden) return;
      var el = visible(els.cat) ? els.cat : (visible(els.catM) ? els.catM : null);
      if (el) worship(el);
    }

    homeDelay = setTimeout(function () {
      homeDelay = 0;
      if (!active) return;
      tick();
      homeTimer = setInterval(tick, DUR);
    }, FLAT);
  }

  function restartHomeAuto() {
    stopHomeAuto();
    if (active) startHomeAuto();
  }

  /* ============================================================
     首页内联面板
     ============================================================ */

  function render() {
    var shown = (totalKnown || total > 0) ? total + pending : null;
    var totalText = shown != null ? fmt(shown) : '—';

    if (els.total) els.total.textContent = totalText;
    if (els.local) els.local.textContent = fmt(local);
    if (els.totalM) els.totalM.textContent = totalText;
    if (els.localM) els.localM.textContent = fmt(local);
    if (els.superTotal) els.superTotal.textContent = totalText;
    if (els.superLocal) els.superLocal.textContent = fmt(local);
    if (els.superSpeed) {
      els.superSpeed.textContent = '当前速度：每 ' + catDur.toFixed(1) + ' 秒一次 · ' +
        (1 / catDur).toFixed(2) + ' 次/秒 · 每次 +' + fmt(pointGain()) + ' 点';
    }

    [els.total, els.totalM, els.superTotal].forEach(function (el) {
      if (!el) return;
      el.title = totalKnown || total > 0
        ? '全站共已膜次数'
        : '全站计数还没接上：先把 supabase/install-all.sql 在 Supabase 跑一遍';
    });
  }

  function activate(fromEl) {
    if (active) return;
    active = true;

    if (els.play) els.play.classList.add('is-on');
    if (els.catWrap) els.catWrap.hidden = false;
    if (els.inline) els.inline.hidden = false;
    if (els.open) els.open.setAttribute('aria-expanded', 'true');

    restartCat(els.cat);
    restartCat(els.catM);
    startHomeAuto();
    render();

    loggedIn = !!authToken();
    if (loggedIn) loadUserState();
    else renderShop();
    if (!userSyncTimer) userSyncTimer = setInterval(syncUserState, 6000);

    if (B8.sb && B8.sb.ready) loadTotal();
    worship(fromEl || els.cat);     // 点「膜宙金」本身也算第一次膜拜
  }

  function worship(fromEl) {
    if (!active) { activate(); return; }

    local += 1;
    pending += 1;
    store(KEY_LOCAL, local);
    if (loggedIn) {
      points += pointGain();
      renderShop();
    }
    render();

    showPlus(fromEl || els.cat);

    if (els.zj && !superOpen) {
      els.zj.classList.remove('is-pop');
      void els.zj.offsetWidth;
      els.zj.classList.add('is-pop');
      clearTimeout(popTimer);
      popTimer = setTimeout(function () { els.zj.classList.remove('is-pop'); }, 320);
    }

    scheduleBump(450);
  }

  /* 在某个元素头顶冒 +1（首页猫猫、超级模式里的猫猫、中间大圆都用这个） */
  function showPlus(el) {
    if (!el || !els.plusLayer) return;
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;

    var s = document.createElement('span');
    s.className = 'mo-float-plus';
    s.textContent = '+1';
    s.style.left = (r.left + r.width / 2) + 'px';
    s.style.top = (r.top + 2) + 'px';
    els.plusLayer.appendChild(s);
    setTimeout(function () {
      if (s.parentNode) s.parentNode.removeChild(s);
    }, Math.min(360, Math.max(160, catDur * 280)) + 40);
  }

  /* ---------- 全站计数 ---------- */
  function loadTotal() {
    if (!B8.sb || !B8.sb.ready) return;
    B8.sb.rpc('b8_worship_get', {}).then(function (v) {
      var n = Number(v);
      if (!isNaN(n) && n >= total) {
        total = n;
        totalKnown = true;
        store(KEY_TOTAL, total);
        render();
      }
    }).catch(function (err) {
      var msg = err && err.message ? err.message : '网络异常';
      if (/Could not find the function|schema cache|does not exist/i.test(msg)) {
        bumpBroken = true;
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
    if (!B8.sb || !B8.sb.ready) { scheduleBump(700); return; }

    flushing = true;
    var n = Math.min(pending, 1000);

    var args = { p_n: n };
    var t = authToken();
    if (t) args.p_token = t;

    B8.sb.rpc('b8_worship_bump', args).then(function (res) {
      pending -= n;
      var v = res && res.total != null ? res.total : res;
      var num = Number(v);
      if (!isNaN(num)) {
        total = num;
        totalKnown = true;
        store(KEY_TOTAL, total);
        render();
      }
      if (res && res.points != null) {
        points = Math.max(0, Number(res.points) || 0);
        userKnown = true;
      }
      if (res && res.point_lv != null) pointLv = Math.max(1, Number(res.point_lv) || 1);
      renderShop();
    }).catch(function (err) {
      var msg = err && err.message ? err.message : '网络异常';
      if (/Could not find the function|schema cache|does not exist/i.test(msg)) {
        bumpBroken = true;
      }
    }).then(function () {
      flushing = false;
      if (pending && !bumpBroken) scheduleBump(700);
    });
  }

  /* ============================================================
     超级模式：三步出现 + 两圈反向旋转
     ============================================================ */

  function clearSuperTimers() {
    superTimers.forEach(function (t) { clearTimeout(t); });
    superTimers = [];
  }

  function ensureSuper() {
    if (superBuilt) return;
    superBuilt = true;

    els.superLayer = $('mo-super-layer');
    els.superWord = $('mo-super-word');
    els.superCats = $('mo-super-cats');
    els.superTotal = $('mo-super-total');
    els.superLocal = $('mo-super-local');
    els.superSpeed = $('mo-super-speed');
    els.superCore = $('mo-super-core');
    els.superExit = $('mo-super-exit');
    els.plusLayer = $('mo-plus-layer');

    if (els.superLayer) B8.on(els.superLayer, 'click', closeSuper);
    if (els.superExit) {
      B8.on(els.superExit, 'click', function (ev) {
        ev.stopPropagation();
        closeSuper();
      });
    }
    if (els.superCore) {
      B8.on(els.superCore, 'click', function (ev) {
        ev.stopPropagation();
        if (superOpen) worship(els.superWord);
      });
    }

    els.shopBtn = $('mo-shop-btn');
    els.shop = $('mo-shop');
    els.shopClose = $('mo-shop-close');
    els.shopPoints = $('mo-shop-points');
    els.shopNote = $('mo-shop-note');
    els.shopSpeedDesc = $('shop-speed-desc');
    els.shopSpeedCost = $('shop-speed-cost');
    els.shopCatDesc = $('shop-cat-desc');
    els.shopCatCost = $('shop-cat-cost');
    els.shopPointDesc = $('shop-point-desc');
    els.shopPointCost = $('shop-point-cost');

    if (els.shopBtn) {
      B8.on(els.shopBtn, 'click', function (ev) {
        ev.stopPropagation();
        openShop();
      });
    }
    if (els.shopClose) B8.on(els.shopClose, 'click', closeShop);
    if (els.shop) {
      B8.on(els.shop, 'click', function (ev) {
        if (ev.target === els.shop) closeShop();
      });
    }
    B8.qsa('.mo-shop-item', els.shop || document).forEach(function (btn) {
      B8.on(btn, 'click', function () {
        buyUpgrade(btn.getAttribute('data-buy'), btn);
      });
    });
  }

  function buildSuperRings() {
    if (!els.superCats) return;
    ringEls = [];
    ringCatEls = [];
    els.superCats.innerHTML = '';

    // 基础三圈 8 / 12 / 16 只；后面买的猫从第四圈开始，最多买到第七圈。
    // 第四～七圈每圈 5 个位置，共 20 个；买满第七圈时总共 36 + 20 = 56 只。
    var rings = [
      { n: 8,  r: 24,   s: 9,   dir: 'cw' },
      { n: 12, r: 29,   s: 8,   dir: 'ccw' },
      { n: 16, r: 34,   s: 7,   dir: 'cw' }
    ];

    var outer = [
      { cap: 5, r: 38.5, s: 6 },
      { cap: 5, r: 42,   s: 5.2 },
      { cap: 5, r: 45,   s: 4.6 },
      { cap: 5, r: 47.5, s: 4.2 }
    ];
    var left = Math.max(0, Math.min(20, catLv));
    outer.forEach(function (o, oi) {
      var n = Math.min(o.cap, left);
      left -= n;
      if (n > 0) {
        var ri = rings.length;
        rings.push({
          n: n, r: o.r, s: o.s,
          dir: ri % 2 === 0 ? 'cw' : 'ccw'
        });
      }
    });

    var frag = document.createDocumentFragment();
    rings.forEach(function (ring, ri) {
      var dir = ring.dir === 'ccw' ? -1 : 1;
      var ringEl = document.createElement('div');
      ringEl.className = 'mo-ring ' + ring.dir;
      ringEls.push({ el: ringEl, dir: dir });

      for (var i = 0; i < ring.n; i++) {
        var a = (Math.PI * 2 * i / ring.n) + (ri * 0.18);
        var d = -(i * 0.27 + ri * 0.4);
        var item = document.createElement('span');
        item.className = 'mo-ring-cat';
        item.style.setProperty('--x', (Math.cos(a) * ring.r).toFixed(2) + 'vmin');
        item.style.setProperty('--y', (Math.sin(a) * ring.r).toFixed(2) + 'vmin');
        item.style.setProperty('--s', ring.s + 'vmin');
        item.style.setProperty('--d', d.toFixed(2) + 's');

        var cat = document.createElement('span');
        cat.className = 'mo-cat';
        item.appendChild(cat);
        ringEl.appendChild(item);
        ringCatEls.push({ cat: cat, dir: dir, delay: d });
      }
      frag.appendChild(ringEl);
    });
    els.superCats.appendChild(frag);
  }
  function upgradeCost(kind) {
    if (kind === 'speed') return 200 * Math.pow(2, speedLv - 1);
    if (kind === 'cat') return 1000 * Math.pow(2, catLv);
    if (kind === 'point') return 50000 * Math.pow(4, pointLv - 1);
    return 0;
  }

  function setShopNote(msg, kind) {
    if (!els.shopNote) return;
    els.shopNote.textContent = msg || '';
    els.shopNote.className = 'mo-shop-note' + (kind === 'err' ? ' is-err' : (kind === 'ok' ? ' is-ok' : ''));
  }

  function renderShop() {
    if (!els.shopPoints) return;
    els.shopPoints.textContent = fmt(points);

    var speedCost = upgradeCost('speed');
    var catCost = upgradeCost('cat');
    var pointCost = upgradeCost('point');

    if (els.shopSpeedDesc) {
      els.shopSpeedDesc.textContent = speedLv >= 13
        ? '已满级 · 每轮 ' + catDur.toFixed(1) + 's'
        : '每轮 ' + catDur.toFixed(1) + 's（升级 −0.1s）';
    }
    if (els.shopSpeedCost) els.shopSpeedCost.textContent = speedLv >= 13 ? '满级' : fmt(speedCost) + ' 点';

    if (els.shopCatDesc) els.shopCatDesc.textContent = '当前 ' + (36 + catLv) + ' 只';
    if (els.shopCatCost) els.shopCatCost.textContent = catLv >= 20 ? '满级' : fmt(catCost) + ' 点';

    if (els.shopPointDesc) els.shopPointDesc.textContent = '每次 ' + fmt(pointGain()) + ' 点';
    if (els.shopPointCost) els.shopPointCost.textContent = pointLv >= 10 ? '满级' : fmt(pointCost) + ' 点';

    var can = loggedIn && userKnown;
    B8.qsa('.mo-shop-item', els.shop || document).forEach(function (btn) {
      var kind = btn.getAttribute('data-buy');
      var maxed = (kind === 'speed' && speedLv >= 13) ||
                  (kind === 'cat' && catLv >= 20) ||
                  (kind === 'point' && pointLv >= 10);
      btn.disabled = !can || maxed || points < upgradeCost(kind);
    });

    if (!loggedIn) setShopNote('登录后才能用点数升级；现在膜拜只记全站次数。');
  }

  function openShop() {
    if (!superBuilt) ensureSuper();
    if (!els.shop) return;
    els.shop.hidden = false;
    setShopNote('');
    renderShop();
    if (els.shopClose) {
      try { els.shopClose.focus({ preventScroll: true }); } catch (e) { try { els.shopClose.focus(); } catch (e2) {} }
    }
  }

  function closeShop() {
    if (els.shop) els.shop.hidden = true;
  }

  function buyUpgrade(kind, btn) {
    if (!loggedIn) { setShopNote('登录后才能升级。', 'err'); return; }
    var t = authToken();
    if (!t) { setShopNote('登录状态失效，刷新后再试。', 'err'); return; }

    btn.disabled = true;
    setShopNote('正在升级…');
    B8.sb.rpc('b8_worship_upgrade', { p_token: t, p_kind: kind }).then(function (res) {
      applyUserState(res);
      var label = kind === 'speed' ? '膜速' : (kind === 'cat' ? '小猫数量' : '每次点数');
      setShopNote('升级成功：' + label + '。', 'ok');
      renderShop();
    }).catch(function (err) {
      var msg = err && err.message ? err.message : '升级失败';
      if (/Could not find the function|schema cache|does not exist/i.test(msg)) {
        msg = '商店要更新数据库：请先跑一遍 supabase/install-all.sql。';
      }
      setShopNote(msg, 'err');
      renderShop();
    });
  }

  function stopRings() {
    if (superRaf) {
      cancelAnimationFrame(superRaf);
      superRaf = 0;
    }
    catTimeouts.forEach(function (t) { clearTimeout(t); });
    catIntervals.forEach(function (t) { clearInterval(t); });
    catTimeouts = [];
    catIntervals = [];
  }

  function startRings() {
    stopRings();
    ringStart = (window.performance && performance.now) ? performance.now() : Date.now();

    function tick(now) {
      if (!superOpen || !els.superLayer || !els.superLayer.classList.contains('is-rings')) {
        superRaf = 0;
        return;
      }
      var t = ((now - ringStart) % 10000) / 10000;   // 10 秒一圈
      var angle = t * Math.PI * 2;

      ringEls.forEach(function (r) {
        r.el.style.transform = 'rotate(' + (r.dir * angle) + 'rad)';
      });
      ringCatEls.forEach(function (r) {
        // 猫猫自己反向转，保持头朝上
        r.cat.style.transform = 'rotate(' + (-r.dir * angle) + 'rad)';
      });

      superRaf = requestAnimationFrame(tick);
    }
    superRaf = requestAnimationFrame(tick);

    // 每只猫猫单独计时：动画走到「趴下」那一帧（每轮 2/6 处）才 +1。
    var DUR = Math.round(catDur * 1000);
    var FLAT = DUR * 2 / 6;

    if (window.B8_TEST) {
      B8.worship._firsts = ringCatEls.map(function (it) {
        var ph = ((-it.delay * 1000) % DUR + DUR) % DUR;
        var f = (FLAT - ph) % DUR;
        if (f < 0) f += DUR;
        return { d: it.delay, f: Math.round(f) };
      });
    }

    ringCatEls.forEach(function (item) {
      var phase = ((-item.delay * 1000) % DUR + DUR) % DUR;   // 负 delay = 已经走了这么远
      var first = (FLAT - phase) % DUR;
      if (first < 0) first += DUR;

      var to = setTimeout(function () {
        if (!superOpen) return;
        worship(item.cat);
        var iv = setInterval(function () {
          if (!superOpen || document.hidden) return;
          if (!els.superLayer || !els.superLayer.classList.contains('is-rings')) return;
          worship(item.cat);
        }, DUR);
        catIntervals.push(iv);
      }, first);
      catTimeouts.push(to);
    });
  }

  function openSuper() {
    if (!active) activate();
    ensureSuper();
    if (!els.superLayer) return;
    buildSuperRings();

    clearSuperTimers();
    stopRings();
    superOpen = true;
    render();

    var layer = els.superLayer;
    layer.hidden = false;
    layer.classList.remove('is-bg', 'is-center', 'is-rings');
    document.body.classList.add('mo-super-open');

    var word = els.superWord;
    var zr = els.zj ? els.zj.getBoundingClientRect() : null;
    var cx = window.innerWidth / 2;
    var cy = window.innerHeight / 2;

    if (word) {
      word.style.transition = 'none';
      word.style.opacity = '0';
      if (zr && zr.width > 0) {
        var dx = zr.left + zr.width / 2 - cx;
        var dy = zr.top + zr.height / 2 - cy;
        word.style.transform = 'translate(-50%,-50%) translate(' + dx + 'px,' + dy + 'px) scale(0.55)';
      } else {
        word.style.transform = 'translate(-50%,-50%) scale(0.55)';
      }
      void word.offsetWidth;
      word.style.transition = '';
    }

    // 第一步：背景暗下来，其他东西全没了，只剩右边那个「宙金」
    requestAnimationFrame(function () {
      if (!superOpen) return;
      layer.classList.add('is-bg');
      if (word) word.style.opacity = '1';
    });

    // 第二步：宙金平滑移到中间，同时从印章红变成金色
    superTimers.push(setTimeout(function () {
      if (!superOpen) return;
      layer.classList.add('is-center');
      if (word) word.style.transform = 'translate(-50%,-50%) scale(1)';
    }, 360));

    // 第三步：移动完成后，两圈猫猫才出现并开始旋转
    superTimers.push(setTimeout(function () {
      if (!superOpen) return;
      layer.classList.add('is-rings');
      startRings();
    }, 1500));
  }

  function closeSuper() {
    if (!superOpen) return;
    superOpen = false;
    clearSuperTimers();
    stopRings();
    closeShop();
    if (els.superLayer) {
      els.superLayer.classList.remove('is-bg', 'is-center', 'is-rings');
      els.superLayer.hidden = true;
    }
    document.body.classList.remove('mo-super-open');
  }

  /* ============================================================
     启动
     ============================================================ */

  function boot() {
    els.open = $('mo-open');
    els.play = $('mo-play');
    els.logo = $('mo-logo');
    els.zj = $('mo-zj');
    els.catWrap = $('mo-cat-wrap');
    els.cat = $('mo-cat');
    els.total = $('mo-total');
    els.local = $('mo-local');
    els.super = $('mo-super');
    els.inline = $('mo-inline');
    els.catM = $('mo-cat-m');
    els.totalM = $('mo-total-m');
    els.localM = $('mo-local-m');
    els.superM = $('mo-super-m');
    els.shopM = $('mo-shop-m');
    els.plusLayer = $('mo-plus-layer');

    if (!els.open || !els.play) return;

    B8.on(els.open, 'click', function () {
      if (!active) activate(els.open);
      else worship(els.open);
    });
    B8.on(els.cat, 'click', function () { worship(els.cat); });
    B8.on(els.catM, 'click', function () { worship(els.catM); });
    B8.on(els.super, 'click', openSuper);
    B8.on(els.superM, 'click', openSuper);
    B8.on(els.shopM, 'click', openShop);

    document.addEventListener('b8:auth', function () {
      if (!active) return;
      loggedIn = !!authToken();
      if (loggedIn) loadUserState();
      else renderShop();
    });

    B8.on(document, 'keydown', function (ev) {
      if (ev.key !== 'Escape') return;
      if (els.shop && !els.shop.hidden) {
        ev.preventDefault();
        closeShop();
        return;
      }
      if (superOpen) {
        ev.preventDefault();
        closeSuper();
      }
    });

    render();

    B8.worship = {
      activate: activate,
      worship: worship,
      superMode: openSuper,
      leave: closeSuper
    };

    if (window.B8_TEST) {
      B8.worship.applyUser = applyUserState;
      B8.worship.shop = openShop;
      B8.worship.startRings = startRings;
      B8.worship.plus = showPlus;
      B8.worship._setLogged = function (v) { loggedIn = !!v; };
      if (/[?&]mo=cat\b/.test(location.search)) activate();
      if (/[?&]mo=super\b/.test(location.search)) {
        activate();
        setTimeout(openSuper, 60);
      }
      B8.worship.state = function () {
        return {
          active: active, local: local, total: total, totalKnown: totalKnown,
          pending: pending, superOpen: superOpen,
          points: points, speedLv: speedLv, catLv: catLv, pointLv: pointLv,
          catDur: catDur, shopOpen: !!(els.shop && !els.shop.hidden),
          ringCats: ringCatEls.length, timers: catTimeouts.length,
          rings: els.superCats ? els.superCats.querySelectorAll('.mo-ring').length : 0,
          cats: els.superCats ? els.superCats.querySelectorAll('.mo-cat').length : 0
        };
      };
    }
  }

  whenReady(boot);
})();
