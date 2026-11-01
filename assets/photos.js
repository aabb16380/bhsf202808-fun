/* ============================================================
   合影墙 + 排行榜 + 页面装配（.fun 的唯一页面模块）
   ------------------------------------------------------------
   为什么这个文件还管 tab：BUILD-SPEC 只给 .fun 留了 photos.js
   一个页面模块，游戏自己各自初始化，页面级的「小装配」（游戏
   tab、模式标签、数据库未接提示）就集中在这里，别再开第五个文件。

   两条硬规则（踩过坑）：
   1. 图片先离屏 new Image() 预检，全部回来再渲染，且不加
      loading="lazy"、不放进 display:none 的容器——否则永远不加载。
   2. 上传前自己校验 HEIC 与大小；>10MB 用 canvas 压到 1600px。
   ============================================================ */
(function () {
  'use strict';

  var B8 = window.B8 = window.B8 || {};

  var DB_NOTE = '数据库还没接：先跑 supabase/schema.sql，再把 URL 和 anon key 填进 assets/site-config.js';
  var EMPTY_TEXT = '还没有合影。传第一张，把今天留下来。';
  var PHOTO_LIMIT = 60;
  var PREVIEW_COUNT = 3;      // 默认只露三张
  var showAllPhotos = false;
  var curCat = '';            // '' = 全部
  var curSort = 'best';       // best | stars | likes | new
  var MAX_BYTES = 10 * 1024 * 1024;   // 与 storage 桶的 10MB 上限一致
  var MAX_EDGE = 1600;
  var ALLOWED = { 'image/jpeg': 1, 'image/png': 1, 'image/webp': 1, 'image/gif': 1 };

  var writable = false;      // 数据库可用且不是预览态，才允许写
  var photos = [];           // 当前列表（可能是示例）
  var shown = [];            // 真正渲染出来的那些（预检失败的会被跳过）
  var liked = {};            // 本次会话点过赞的 id，防止连点
  var uploading = false;
  var renderGen = 0;         // 列表渲染代数，避免旧请求覆盖新列表
  var boxItems = null;
  var boxIndex = -1;
  var lastFocus = null;
  var bodyOverflow = '';

  var grid, emptyEl, statusEl, captionEl, pickEl, fileEl;
  var statPhotos, statToday;

  /* ---------- DOM 小工具 ---------- */
  function el(tag, cls) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    return n;
  }

  function whenReady(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  function setStatus(msg, isErr) {
    if (!statusEl) return;
    statusEl.textContent = msg || '';
    statusEl.className = 'form-status' + (isErr ? ' err' : (msg ? ' ok' : ''));
  }

  /* ============================================================
     页面装配：模式标签 / 游戏 tab / 退出
     ============================================================ */

  function bindGameTabs() {
    var tabs = B8.qsa('.game-tab');
    var panels = B8.qsa('.game-panel');
    if (!tabs.length) return;

    tabs.forEach(function (btn) {
      B8.on(btn, 'click', function () {
        var g = btn.getAttribute('data-game');
        tabs.forEach(function (b) {
          b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
        });
        panels.forEach(function (p) {
          p.hidden = p.getAttribute('data-game') !== g;
        });
        // 切到 2048 时直接把键盘焦点交给棋盘，键盘玩家不用再点一次
        if (g === '2048') {
          var bd = B8.qs('#g2048-board');
          if (bd) { try { bd.focus({ preventScroll: true }); } catch (e) { try { bd.focus(); } catch (e2) {} } }
        }
      });
    });
  }

  function bindRankTabs() {
    var tabs = B8.qsa('.rank-tab');
    tabs.forEach(function (btn) {
      B8.on(btn, 'click', function () {
        var g = btn.getAttribute('data-rank');
        if (!g || g === rankGame) return;
        rankGame = g;
        tabs.forEach(function (b) {
          b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
        });
        loadRank(g);
      });
    });
  }

  function initMode(st) {
    var tag = B8.qs('#mode-tag');
    if (tag) {
      tag.hidden = false;
      if (st.kind === 'preview') {
        tag.className = 'mode-tag tag plain';
        tag.textContent = '预览';
        tag.title = '示例数据，所有写入都已禁用';
      } else if (st.kind === 'admin' || st.kind === 'super') {
        tag.className = 'mode-tag tag';
        tag.textContent = st.isSuper ? '超级管理员' : '管理员';
        tag.title = '管理员可以删除任何一张合影';
      } else {
        // 名字已经在右上角的账号按钮上，这里不重复显示
        tag.hidden = true;
        tag.textContent = '';
      }
    }

    var out = B8.qs('#fun-logout');
    if (out) {
      // 不用 #logout-btn：auth.js 只在「带着旧令牌进站」那条路径上绑它，
      // 当场登录完是不会绑的。自己绑 #fun-logout 更稳。
      out.hidden = st.kind === 'preview';
      B8.on(out, 'click', function () { B8.auth.logout(); });
    }
  }

  function showDbNotes() {
    ['#games-note', '#photos-note', '#rank-db'].forEach(function (sel) {
      var n = B8.qs(sel);
      if (!n) return;
      n.textContent = DB_NOTE;
      n.hidden = false;
    });
  }

  function lockWrites() {
    // 预览态：把上传入口换成 disabled 的按钮，连文件选择框都不给
    if (pickEl && pickEl.parentNode) {
      var b = el('button', 'btn');
      b.type = 'button';
      b.id = 'photo-pick';
      b.disabled = true;
      b.textContent = '上传合影';
      b.title = '数据库还没接，先不能上传';
      pickEl.parentNode.replaceChild(b, pickEl);
      pickEl = b;
    }
    if (captionEl) captionEl.disabled = true;
    if (fileEl) fileEl.disabled = true;
  }

  /* ============================================================
     示例数据（数据库没接 / 预览态时给设计稿看，不假装是真的）
     ============================================================ */

  var SAMPLE_TONES = [
    { bg: '#f1e6d2', ink: '#b4532a', ch: '跑', label: 'SPORTS DAY' },
    { bg: '#e7efe7', ink: '#2f6f5e', ch: '秋', label: 'AUTUMN TRIP' },
    { bg: '#f4e3d6', ink: '#a9873f', ch: '唱', label: 'NEW YEAR' }
  ];

  // 用内联 SVG 当示例照片：不引外链、不新增二进制文件，离线也能看
  function samplePhotoUri(i) {
    var t = SAMPLE_TONES[i % SAMPLE_TONES.length];
    var svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600">' +
      '<rect width="800" height="600" fill="' + t.bg + '"/>' +
      '<g stroke="' + t.ink + '" stroke-opacity="0.13" stroke-width="1">' +
      '<path d="M0 120H800M0 240H800M0 360H800M0 480H800M160 0V600M320 0V600M480 0V600M640 0V600"/>' +
      '</g>' +
      '<rect x="42" y="42" width="716" height="516" fill="none" stroke="' + t.ink +
      '" stroke-opacity="0.3" stroke-dasharray="7 9"/>' +
      '<g transform="translate(548 104) rotate(-4)">' +
      '<rect width="148" height="148" rx="5" fill="' + t.ink + '"/>' +
      '<text x="74" y="108" text-anchor="middle" font-family="Songti SC, STSong, SimSun, serif" ' +
      'font-size="88" fill="#fffdf7">八</text>' +
      '</g>' +
      '<text x="78" y="338" font-family="Songti SC, STSong, SimSun, serif" font-size="148" fill="' + t.ink + '">' +
      B8.esc(t.ch) + '</text>' +
      '<text x="82" y="404" font-family="ui-monospace, Menlo, Consolas, monospace" font-size="21" ' +
      'letter-spacing="5" fill="' + t.ink + '" fill-opacity="0.72">' + B8.esc(t.label) + '</text>' +
      '<text x="82" y="508" font-family="ui-monospace, Menlo, Consolas, monospace" font-size="17" ' +
      'letter-spacing="3" fill="#8a8375">BHSF 2028 · CLASS 08 · 示例</text>' +
      '</svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  function samplePhotos() {
    var caps = [
      '运动会那天，4×100 最后一棒',
      '秋游回来，在校门口的最后一张',
      '联欢会彩排，灯还没亮'
    ];
    var nicks = ['后排靠窗', '体委', '文艺委员'];
    var dates = ['2026-10-16', '2026-09-26', '2026-01-09'];
    var likes = [12, 9, 15];
    var list = [];
    for (var i = 0; i < 3; i++) {
      list.push({
        id: 'sample-' + i,
        path: '',
        url: samplePhotoUri(i),
        caption: caps[i],
        uploader: nicks[i],
        taken_on: dates[i],
        likes: likes[i],
        created_at: dates[i] + 'T18:2' + i + ':00+08:00',
        mine: false,
        sample: true
      });
    }
    return list;
  }

  var SAMPLE_RANK = {
    '2048': [
      { nick: '后排靠窗', score: 8420, created_at: '2026-10-28T20:12:00+08:00' },
      { nick: '数学课代表', score: 5160, created_at: '2026-10-24T12:40:00+08:00' },
      { nick: '体委', score: 3312, created_at: '2026-10-21T17:05:00+08:00' }
    ],
    memory: [
      { nick: '文艺委员', score: 986, created_at: '2026-10-26T16:30:00+08:00' },
      { nick: '后排靠窗', score: 972, created_at: '2026-10-22T12:18:00+08:00' },
      { nick: '数学课代表', score: 960, created_at: '2026-10-19T20:02:00+08:00' }
    ],
    schulte: [
      { nick: '体委', score: 38570, created_at: '2026-10-27T13:06:00+08:00' },
      { nick: '后排靠窗', score: 36210, created_at: '2026-10-23T18:44:00+08:00' },
      { nick: '数学课代表', score: 33480, created_at: '2026-10-20T11:20:00+08:00' }
    ]
  };

  /* ============================================================
     合影墙
     ============================================================ */

  function normalize(rows) {
    if (!Array.isArray(rows)) return [];
    return rows.map(function (r) {
      var path = r.path || '';
      return {
        id: r.id,
        path: path,
        url: r.url || (path && B8.publicUrl ? B8.publicUrl('b8-photos', path) : ''),
        caption: B8.trim(r.caption, 60),
        uploader: B8.trim(r.uploader, 16),
        taken_on: r.taken_on || '',
        likes: Number(r.likes || 0),
        created_at: r.created_at || '',
        mine: !!r.mine,
        category: r.category || '合影',
        avg: Number(r.avg_stars || 0),
        ratingCount: Number(r.rating_count || 0),
        myStars: Number(r.my_stars || 0),
        score: Number(r.score || 0),
        sample: false
      };
    }).filter(function (p) { return !!p.url; });
  }

  function loadPhotos() {
    renderGen++;
    var g = renderGen;
    setStatus('');

    if (!writable) {
      photos = samplePhotos();
      paintPhotos(g);
      return;
    }

    setStatus('正在读照片…');
    B8.sb.rpc('b8_photos_list', {
      p_token: B8.auth.token(),
      p_limit: PHOTO_LIMIT,
      p_cat: curCat,
      p_sort: curSort
    })
      .then(function (rows) {
        if (g !== renderGen) return;
        photos = normalize(rows);
        setStatus('');
        paintPhotos(g);
      })
      .catch(function (err) {
        if (g !== renderGen) return;
        photos = [];
        shown = [];
        grid.innerHTML = '';
        emptyEl.hidden = false;
        setStatus('合影没读到：' + (err && err.message ? err.message : '未知错误'), true);
        paintStats();
      });
  }

  /**
   * 离屏预检：全部图片都 load/error 之后再一次性挂进 DOM。
   * 为什么不用 loading="lazy"：容器如果被藏起来（display:none）或
   * 页面还没滚动到，lazy 图不会加载，预检就永远等不到结果。
   * 这里给一个 10 秒兜底，慢网也不至于一直空白。
   */
  function preloadAll(urls, cb) {
    var ok = {};
    var left = urls.length;
    var done = false;
    var timer = 0;

    function finish() {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      cb(ok);
    }

    if (!left) { finish(); return; }

    function one() {
      left--;
      if (left <= 0) finish();
    }

    urls.forEach(function (u, i) {
      var img = new Image();      // 离屏对象，不 append，不走懒加载
      img.onload = function () { ok[i] = true; one(); };
      img.onerror = function () { ok[i] = false; one(); };
      img.src = u;
    });

    timer = setTimeout(finish, 10000);
  }

  /* ---------- 评分 ---------- */
  function ratePhoto(p, stars, starsWrap, infoEl) {
    if (!writable || !B8.auth || !B8.auth.token()) return;
    var btns = starsWrap.querySelectorAll('.star');
    for (var i = 0; i < btns.length; i++) btns[i].disabled = true;

    B8.sb.rpc('b8_photo_rate', { p_token: B8.auth.token(), p_id: p.id, p_stars: stars })
      .then(function (res) {
        p.avg = Number(res.avg || 0);
        p.ratingCount = Number(res.count || 0);
        p.myStars = stars;
        for (var i = 0; i < btns.length; i++) {
          btns[i].classList.toggle('is-on', i < stars);
          btns[i].disabled = false;
        }
        if (infoEl) {
          infoEl.textContent = (p.avg * 2).toFixed(1) + ' 分 · ' + p.ratingCount + ' 人';
        }
        B8.toast('给了 ' + stars + ' 颗星（' + (stars * 2) + ' 分）');
      })
      .catch(function (err) {
        for (var i = 0; i < btns.length; i++) btns[i].disabled = false;
        B8.toast('评分没成功：' + (err && err.message ? err.message : '网络异常'));
      });
  }

  /* ---------- 分类 / 排序 / 展开 ---------- */
  function catSelect() {
    var sel = B8.qs('#photo-cat');
    return sel ? sel.value : '合影';
  }
  function bindPhotoFilters() {
    var cats = B8.qs('#photo-cats');
    var sorts = B8.qs('#photo-sorts');
    var more = B8.qs('#photo-more');

    if (cats) {
      B8.on(cats, 'click', function (ev) {
        var b = closest(ev.target, '[data-cat]');
        if (!b) return;
        curCat = b.getAttribute('data-cat') || '';
        showAllPhotos = false;
        B8.qsa('[data-cat]', cats).forEach(function (x) {
          x.setAttribute('aria-pressed', x === b ? 'true' : 'false');
        });
        loadPhotos();
      });
    }

    if (sorts) {
      B8.on(sorts, 'click', function (ev) {
        var b = closest(ev.target, '[data-sort]');
        if (!b) return;
        curSort = b.getAttribute('data-sort') || 'best';
        B8.qsa('[data-sort]', sorts).forEach(function (x) {
          x.setAttribute('aria-pressed', x === b ? 'true' : 'false');
        });
        loadPhotos();
      });
    }

    if (more) {
      B8.on(more, 'click', function () {
        showAllPhotos = !showAllPhotos;
        paintPhotos(renderGen);
      });
    }
  }

  function closest(node, sel) {
    while (node && node !== document) {
      if (node.matches && node.matches(sel)) return node;
      node = node.parentNode;
    }
    return null;
  }
  /* ---------- 改说明 / 改分类 ---------- */
  function openPhotoEditor(p, card) {
    var old = document.getElementById('ph-edit');
    if (old && old.parentNode) old.parentNode.removeChild(old);

    var wrap = document.createElement('div');
    wrap.id = 'ph-edit';
    wrap.className = 'modal';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');

    var opts = '';
    ['大合照', '合影', '辉辉', 'meme'].forEach(function (c) {
      opts += '<option value="' + c + '"' + (p.category === c ? ' selected' : '') + '>' + c + '</option>';
    });

    wrap.innerHTML =
      '<div class="modal-inner ph-edit-inner">' +
        '<h3 class="modal-title">编辑这张照片</h3>' +
        '<div class="field"><label for="ph-cap">说明（可留空）</label>' +
          '<input class="input" id="ph-cap" maxlength="60"></div>' +
        '<div class="field" style="margin-top:12px"><label for="ph-cat2">分类</label>' +
          '<select class="input" id="ph-cat2">' + opts + '</select></div>' +
        '<div class="modal-actions">' +
          '<button class="btn ghost sm" type="button" id="ph-cancel">取消</button>' +
          '<button class="btn sm" type="button" id="ph-save">保存</button>' +
        '</div>' +
        '<p class="form-status" id="ph-status"></p>' +
      '</div>';

    document.body.appendChild(wrap);

    var capEl2 = document.getElementById('ph-cap');
    var catEl2 = document.getElementById('ph-cat2');
    var st = document.getElementById('ph-status');
    var saveBtn = document.getElementById('ph-save');
    capEl2.value = p.caption || '';

    function close() { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); }
    B8.on(document.getElementById('ph-cancel'), 'click', close);
    B8.on(wrap, 'click', function (e) { if (e.target === wrap) close(); });

    B8.on(saveBtn, 'click', function () {
      saveBtn.disabled = true;
      saveBtn.textContent = '保存中…';
      st.className = 'form-status';
      st.textContent = '';

      B8.sb.rpc('b8_photo_update', {
        p_token: B8.auth.token(),
        p_id: p.id,
        p_caption: capEl2.value,
        p_category: catEl2.value
      }).then(function () {
        close();
        B8.toast('改好了');
        loadPhotos();
      }).catch(function (err) {
        saveBtn.disabled = false;
        saveBtn.textContent = '保存';
        st.className = 'form-status err';
        st.textContent = (err && err.message) ? err.message : '保存失败';
      });
    });

    setTimeout(function () { capEl2.focus(); }, 80);
  }
  function photoCard(p) {
    var card = el('article', 'photo-card');
    card.setAttribute('data-id', String(p.id));

    var open = el('button', 'photo-open');
    open.type = 'button';
    open.setAttribute('aria-label', '查看大图：' + (p.caption || '班级合影'));

    var img = el('img');
    img.alt = p.caption || (p.uploader ? p.uploader + ' 上传的合影' : '班级合影');
    img.width = 800;
    img.height = 600;
    // 故意不加 loading="lazy"：见文件头注释
    img.src = p.url;
    img.onerror = function () {
      img.alt = '这张图打不开了';
    };
    open.appendChild(img);
    card.appendChild(open);

    if (p.sample) {
      var flag = el('span', 'tag plain photo-flag');
      flag.textContent = '示例';
      card.appendChild(flag);
    }

    var body = el('div', 'photo-body');

    var cap = el('p', 'photo-cap' + (p.caption ? '' : ' is-empty'));
    cap.textContent = p.caption || '（没写说明）';
    body.appendChild(cap);

    var meta = el('div', 'photo-meta');

    // 分类标签
    var catTag = el('span', 'tag plain photo-cat-tag');
    catTag.textContent = p.category || '合影';
    meta.appendChild(catTag);

    // 上传者：只有管理员和超管看得到名字
    var isBoss = B8.auth && B8.auth.isAdmin && B8.auth.isAdmin();
    if (isBoss) {
      var who = el('span', 'photo-who');
      who.textContent = p.uploader || '同学';
      meta.appendChild(who);
    }

    var when = el('span');
    when.textContent = B8.date(p.taken_on || p.created_at) || '某一天';
    meta.appendChild(when);
    body.appendChild(meta);

    // 星级评分：1-5 颗，每颗两分，满分 10
    var rateRow = el('div', 'photo-rate');
    var stars = el('div', 'photo-stars');
    stars.setAttribute('role', 'group');
    stars.setAttribute('aria-label', '给这张照片打分，1 到 5 星');
    var score10 = Math.round((p.avg || 0) * 2 * 10) / 10;
    for (var s = 1; s <= 5; s++) {
      var star = el('button', 'star' + (p.myStars >= s ? ' is-on' : ''));
      star.type = 'button';
      star.textContent = '★';
      star.setAttribute('data-stars', String(s));
      star.setAttribute('aria-label', s + ' 星');
      if (!writable || p.sample) star.disabled = true;
      stars.appendChild(star);
    }
    rateRow.appendChild(stars);

    var rateInfo = el('span', 'photo-rate-info');
    rateInfo.textContent = (p.ratingCount
      ? (score10.toFixed(1) + ' 分 · ' + p.ratingCount + ' 人')
      : '还没人评分');
    rateRow.appendChild(rateInfo);
    body.appendChild(rateRow);

    if (writable && !p.sample) {
      B8.on(stars, 'click', function (ev) {
        var b = ev.target;
        if (!b || !b.getAttribute || !b.getAttribute('data-stars')) return;
        ratePhoto(p, Number(b.getAttribute('data-stars')), stars, rateInfo);
      });
    }

    var actions = el('div', 'photo-actions');

    var like = el('button', 'photo-act like-btn');
    like.type = 'button';
    if (liked[String(p.id)]) like.classList.add('is-liked');
    var heart = el('span', 'act-heart');
    heart.textContent = liked[String(p.id)] ? '♥' : '♡';
    heart.setAttribute('aria-hidden', 'true');
    var count = el('span');
    count.textContent = B8.num(p.likes);
    like.appendChild(heart);
    like.appendChild(count);
    like.setAttribute('aria-label', '点赞，当前 ' + p.likes + ' 个');
    like.disabled = !writable || !!p.sample;
    if (like.disabled) like.title = '数据库还没接，先不能点赞';
    B8.on(like, 'click', function () { likePhoto(p, like, count, heart); });
    actions.appendChild(like);

    if (writable && (p.mine || (B8.auth && B8.auth.isAdmin()))) {
      var edit = el('button', 'photo-act photo-edit');
      edit.type = 'button';
      edit.textContent = '编辑';
      edit.setAttribute('aria-label', '改说明和分类');
      B8.on(edit, 'click', function () { openPhotoEditor(p, card); });
      actions.appendChild(edit);

      var del = el('button', 'photo-act photo-del');
      del.type = 'button';
      del.textContent = '删除';
      del.setAttribute('aria-label', '删除这张合影');
      B8.on(del, 'click', function () { removePhoto(p, card, del); });
      actions.appendChild(del);
    }

    body.appendChild(actions);
    card.appendChild(body);
    return card;
  }

  function paintPhotos(g) {
    preloadAll(photos.map(function (p) { return p.url; }), function (ok) {
      if (g !== renderGen) return;   // 期间又刷新过，这次结果作废
      grid.innerHTML = '';
      shown = [];
      var broken = 0;

      // 默认只露三张，剩下的点「展开全部」
      var limit = showAllPhotos ? photos.length : Math.min(PREVIEW_COUNT, photos.length);

      photos.forEach(function (p, i) {
        if (!ok[i]) { broken++; return; }
        if (shown.length >= limit) return;
        var card = photoCard(p);
        var open = card.firstChild;
        // 大图浏览的索引按「真正显示出来的」这一份来，别用 photos 的下标
        (function (sidx) {
          B8.on(open, 'click', function () { lastFocus = open; openBox(sidx); });
        })(shown.length);
        shown.push(p);
        grid.appendChild(card);
      });

      if (grid) grid.classList.toggle('scroll-box', showAllPhotos);

      var more = B8.qs('#photo-more');
      if (more) {
        var extra = photos.length - limit;
        more.hidden = extra <= 0 && !showAllPhotos;
        more.textContent = showAllPhotos ? '收起' : ('展开全部（还有 ' + Math.max(extra, 0) + ' 张）');
      }

      emptyEl.hidden = shown.length > 0;
      if (!shown.length && photos.length) {
        emptyEl.textContent = '这几张图都打不开（可能已被删除）。';
        emptyEl.hidden = false;
      } else if (!photos.length) {
        emptyEl.textContent = EMPTY_TEXT;
      }
      if (broken) setStatus(broken + ' 张图打不开，已跳过。', true);
      paintStats();
    });
  }

  function paintStats() {
    if (statPhotos) statPhotos.textContent = photos.length ? photos.length + ' 张' : '0 张';
    if (statToday) {
      if (!writable) {
        statToday.textContent = '示例模式';
      } else {
        var n = 0;
        var now = new Date();
        photos.forEach(function (p) {
          if (!p.created_at) return;
          var d = new Date(p.created_at);
          if (!isNaN(d.getTime()) &&
              d.getFullYear() === now.getFullYear() &&
              d.getMonth() === now.getMonth() &&
              d.getDate() === now.getDate()) n++;
        });
        statToday.textContent = n + ' 张';
      }
    }
  }

  /* ---------- 点赞 / 删除 ---------- */

  function likePhoto(p, btn, count, heart) {
    if (!writable || btn.disabled) return;
    var key = String(p.id);
    if (liked[key]) return;
    btn.disabled = true;
    B8.sb.rpc('b8_photo_like', { p_token: B8.auth.token(), p_id: p.id })
      .then(function (n) {
        p.likes = Number(n) || (p.likes + 1);
        count.textContent = B8.num(p.likes);
        heart.textContent = '♥';
        btn.classList.add('is-liked');
        btn.setAttribute('aria-label', '已点赞，' + p.likes + ' 个');
        liked[key] = true;
        btn.disabled = false;
        B8.toast('点了个赞');
      })
      .catch(function (err) {
        btn.disabled = false;
        setStatus('点赞没成功：' + (err && err.message ? err.message : '未知错误'), true);
      });
  }

  function removePhoto(p, card, btn) {
    if (!writable) return;
    if (!window.confirm('删掉这张合影？删了就找不回来了。')) return;
    btn.disabled = true;
    B8.sb.rpc('b8_photo_del', { p_token: B8.auth.token(), p_id: p.id })
      .then(function () {
        var i;
        for (i = 0; i < photos.length; i++) if (photos[i] === p) { photos.splice(i, 1); break; }
        for (i = 0; i < shown.length; i++) if (shown[i] === p) { shown.splice(i, 1); break; }
        if (card.parentNode) card.parentNode.removeChild(card);
        emptyEl.hidden = shown.length > 0;
        paintStats();
        B8.toast('删掉了');
      })
      .catch(function (err) {
        btn.disabled = false;
        setStatus('删除没成功：' + (err && err.message ? err.message : '未知错误'), true);
      });
  }

  /* ---------- 上传 ---------- */

  function failUpload(msg) {
    setStatus(msg, true);
    B8.toast(msg);
  }

  function readType(file) {
    var type = (file.type || '').toLowerCase();
    if (type) return type;
    var name = file.name || '';
    if (/\.jpe?g$/i.test(name)) return 'image/jpeg';
    if (/\.png$/i.test(name)) return 'image/png';
    if (/\.webp$/i.test(name)) return 'image/webp';
    if (/\.gif$/i.test(name)) return 'image/gif';
    return '';
  }

  function dataUrlToBlob(dataUrl) {
    var parts = String(dataUrl).split(',');
    var mime = /:(.*?);/.exec(parts[0]);
    var bin = atob(parts[1]);
    var len = bin.length;
    var buf = new Uint8Array(len);
    for (var i = 0; i < len; i++) buf[i] = bin.charCodeAt(i);
    return new Blob([buf], { type: mime ? mime[1] : 'image/jpeg' });
  }

  // >10MB 才压：canvas 缩到最长边 1600px，JPEG 0.82。
  // SPEC 写的是 toDataURL；这里再多一步转 Blob，是为了让 fetch 直接发
  // 二进制，而不是把 base64 当成文件内容塞进请求体。
  function compress(file) {
    return new Promise(function (resolve, reject) {
      var objUrl = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var w = img.naturalWidth || img.width;
        var h = img.naturalHeight || img.height;
        var ratio = Math.min(1, MAX_EDGE / Math.max(w, h));
        var cw = Math.max(1, Math.round(w * ratio));
        var ch = Math.max(1, Math.round(h * ratio));
        var canvas = document.createElement('canvas');
        canvas.width = cw;
        canvas.height = ch;
        var ctx = canvas.getContext('2d');
        URL.revokeObjectURL(objUrl);
        if (!ctx) { reject(new Error('浏览器不支持 canvas，压不了这张图')); return; }
        ctx.fillStyle = '#fffdf7';          // PNG 透明底转 JPEG 会变黑，先铺一层纸色
        ctx.fillRect(0, 0, cw, ch);
        ctx.drawImage(img, 0, 0, cw, ch);
        try {
          resolve(dataUrlToBlob(canvas.toDataURL('image/jpeg', 0.82)));
        } catch (e) {
          reject(new Error('压缩失败，换一张试试'));
        }
      };
      img.onerror = function () {
        URL.revokeObjectURL(objUrl);
        reject(new Error('这张图浏览器打不开（HEIC？），请先导出成 JPG'));
      };
      img.src = objUrl;
    });
  }

  /**
   * 直接发文件到 Storage。
   * 为什么不用 B8.sb.upload：这一版共用件把 file 弄丢了（body 恒为
   * undefined），传上去是 0 字节。按约定不改共用件，这里按同样的地址
   * 规则补一个正确实现；等 sb.js 修好，把函数体换回去就行。
   */
  function uploadFile(bucket, path, blob) {
    var cfg = (window.B8_CONFIG && window.B8_CONFIG.supabase) || {};
    var base = String(cfg.url || '').replace(/\/+$/, '');
    var key = cfg.anonKey || '';
    var parts = String(path).split('/').map(encodeURIComponent).join('/');
    var url = base + '/storage/v1/object/' + bucket + '/' + parts;

    return fetch(url, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: 'Bearer ' + key,
        'x-upsert': 'false',
        'Content-Type': blob.type || 'image/jpeg'
      },
      body: blob
    }).then(function (res) {
      return res.text().then(function (text) {
        if (!res.ok) {
          var msg = 'HTTP ' + res.status;
          try {
            var j = JSON.parse(text);
            msg = j.message || j.error || msg;
          } catch (e) {}
          throw new Error('上传失败：' + msg);
        }
        return base + '/storage/v1/object/public/' + bucket + '/' + parts;
      });
    }, function (e) {
      throw new Error('上传失败：' + (e && e.message ? e.message : '网络不通'));
    });
  }

  /* 一次可以选多张：逐张排队上传，任何一张失败都不影响后面的 */
  function onPick() {
    if (!writable || uploading) return;
    var picked = fileEl && fileEl.files ? Array.prototype.slice.call(fileEl.files) : [];
    if (!picked.length) return;
    fileEl.value = '';   // 清掉，允许再选同一批

    var queue = [];
    var skipped = 0;

    picked.forEach(function (f) {
      var name = f.name || '';
      var type = readType(f);
      if (/heic|heif/.test(type) || /\.heic$|\.heif$/i.test(name)) { skipped++; return; }
      if (!ALLOWED[type]) { skipped++; return; }
      queue.push(f);
    });

    if (!queue.length) {
      failUpload(skipped
        ? '这几张都不支持：只收 JPG / PNG / WebP / GIF（iPhone 的 HEIC 请先导出成 JPG）。'
        : '没有可上传的图片。');
      return;
    }

    uploading = true;
    var total = queue.length;
    var done = 0;
    var failed = 0;
    var caption = B8.trim(captionEl ? captionEl.value : '', 60);

    function next() {
      if (!queue.length) {
        if (captionEl) captionEl.value = '';
        setStatus('传完 ' + done + ' 张' + (failed ? '，失败 ' + failed + ' 张' : '') +
                  (skipped ? '，跳过 ' + skipped + ' 张不支持的格式' : '') + '。', failed > 0);
        loadPhotos();
        B8.toast('合影已上传 ' + done + ' 张');
        uploading = false;
        return;
      }

      var file = queue.shift();
      setStatus('正在上传 ' + (done + failed + 1) + ' / ' + total + '…');

      var path = 'photos/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.jpg';

      (file.size > MAX_BYTES ? compress(file) : Promise.resolve(file))
        .then(function (blob) {
          return uploadFile('b8-photos', path, blob);
        })
        .then(function (url) {
          return B8.sb.rpc('b8_photo_add', {
            p_token: B8.auth.token(),
            p_path: path,
            p_url: url,
            p_caption: caption,
            p_taken_on: null,
            p_category: catSelect()
          });
        })
        .then(function () { done += 1; })
        .catch(function (err) {
          failed += 1;
          if (window.console) console.warn('[photos] 这张没传上去：', err && err.message);
        })
        .then(next);
    }

    next();
  }

  /* ---------- 大图弹层（复用 base.css 的 .lightbox） ---------- */

  function buildBox() {
    if (boxItems) return;

    var box = el('div', 'lightbox');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', '合影大图');
    box.hidden = true;

    var inner = el('div', 'lightbox-inner');

    var close = el('button', 'lightbox-close');
    close.type = 'button';
    close.setAttribute('aria-label', '关闭大图');
    close.textContent = '×';

    var prev = el('button', 'lightbox-nav prev');
    prev.type = 'button';
    prev.setAttribute('aria-label', '上一张');
    prev.textContent = '‹';

    var next = el('button', 'lightbox-nav next');
    next.type = 'button';
    next.setAttribute('aria-label', '下一张');
    next.textContent = '›';

    var img = el('img');
    img.alt = '';

    var cap = el('div', 'lightbox-caption');
    var meta = el('div', 'lightbox-meta');
    var hint = el('div', 'lightbox-open');
    hint.textContent = '← → 切换 · Esc 关闭';

    inner.appendChild(close);
    inner.appendChild(prev);
    inner.appendChild(img);
    inner.appendChild(next);
    inner.appendChild(cap);
    inner.appendChild(meta);
    inner.appendChild(hint);
    box.appendChild(inner);
    document.body.appendChild(box);

    boxItems = { box: box, img: img, cap: cap, meta: meta, prev: prev, next: next, close: close };

    B8.on(close, 'click', closeBox);
    B8.on(prev, 'click', function () { stepBox(-1); });
    B8.on(next, 'click', function () { stepBox(1); });
    B8.on(box, 'click', function (e) { if (e.target === box) closeBox(); });
    B8.on(img, 'error', function () { B8.toast('这张大图打不开'); });
    // 键盘只绑一次；弹层没开时 onBoxKey 会自己忽略
    B8.on(document, 'keydown', onBoxKey);
  }

  function showBox(i) {
    if (!shown.length) return;
    if (i < 0) i = shown.length - 1;
    if (i >= shown.length) i = 0;
    boxIndex = i;
    var p = shown[i];
    var b = boxItems;

    b.img.src = p.url;
    b.img.alt = p.caption || '班级合影';
    b.cap.textContent = p.caption || '（没写说明）';
    b.meta.textContent = (p.uploader || '同学') + ' · ' + (B8.date(p.taken_on || p.created_at) || '某一天') +
      ' · ' + (i + 1) + ' / ' + shown.length;
    b.prev.hidden = shown.length < 2;
    b.next.hidden = shown.length < 2;
    b.box.hidden = false;
    bodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    try { b.close.focus({ preventScroll: true }); } catch (e) { try { b.close.focus(); } catch (e2) {} }
  }

  function openBox(i) {
    buildBox();
    showBox(i);
  }

  function closeBox() {
    if (!boxItems || boxItems.box.hidden) return;
    boxItems.box.hidden = true;
    document.body.style.overflow = bodyOverflow || '';
    if (lastFocus) { try { lastFocus.focus({ preventScroll: true }); } catch (e) {} }
  }

  function stepBox(d) {
    if (!shown.length) return;
    showBox(boxIndex + d);
  }

  function onBoxKey(e) {
    if (!boxItems || boxItems.box.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); closeBox(); return; }
    if (e.key === 'ArrowLeft') { e.preventDefault(); stepBox(-1); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); stepBox(1); }
  }

  /* ============================================================
     排行榜
     ============================================================ */

  var rankGame = '2048';
  var rankCache = {};        // game -> 行数组（只在成功时缓存）
  var rankFailed = {};       // game -> 错误信息
  var rankSeq = 0;

  function rankAppend(tag, cls, text) {
    var n = el(tag, cls);
    if (text != null) n.textContent = text;
    return n;
  }

  function rankValue(game, score) {
    var n = Number(score) || 0;
    if (game === 'memory') {
      var steps = 1000 - n;
      return steps >= 0 ? { text: String(steps), unit: '步' } : { text: String(n), unit: '分' };
    }
    if (game === 'schulte') {
      var ms = 60000 - n;
      return ms > 0 ? { text: (ms / 1000).toFixed(2), unit: '秒' } : { text: String(n), unit: '分' };
    }
    return { text: String(n), unit: '分' };
  }

  function renderRank(game, rows, isSample) {
    var listEl = B8.qs('#rank-list');
    var empty = B8.qs('#rank-empty');
    var sampleTag = B8.qs('#rank-sample-tag');
    if (!listEl) return;

    listEl.innerHTML = '';
    if (sampleTag) sampleTag.hidden = !isSample;

    if (!rows || !rows.length) {
      if (empty) {
        empty.textContent = '这一栏还没有人上榜，去玩一局把名字留在这里。';
        empty.hidden = false;
      }
      return;
    }
    if (empty) empty.hidden = true;

    rows.forEach(function (r, i) {
      var li = el('li', 'rank-row' + (i < 3 ? ' is-podium' : ''));

      var no = rankAppend('span', 'rank-no', (i + 1 < 10 ? '0' : '') + (i + 1));
      li.appendChild(no);

      var nickWrap = el('span', 'rank-nick');
      nickWrap.appendChild(rankAppend('span', 'nick-name', r.nick || '同学'));
      if (isSample) {
        var tag = el('span', 'tag plain');
        tag.textContent = '示例';
        nickWrap.appendChild(tag);
      }
      li.appendChild(nickWrap);

      var v = rankValue(game, r.score);
      var scoreWrap = el('span', 'rank-score');
      scoreWrap.appendChild(rankAppend('span', null, v.text));
      scoreWrap.appendChild(rankAppend('span', 'rank-unit', v.unit));
      li.appendChild(scoreWrap);

      li.appendChild(rankAppend('span', 'rank-date', B8.date(r.created_at) || '—'));
      listEl.appendChild(li);
    });
  }

  function rankSkeleton() {
    var listEl = B8.qs('#rank-list');
    var empty = B8.qs('#rank-empty');
    if (!listEl) return;
    if (empty) empty.hidden = true;
    listEl.innerHTML = '';
    for (var i = 0; i < 3; i++) {
      var li = el('li', 'rank-row');
      li.appendChild(rankAppend('span', 'skeleton sk-line w30', ''));
      li.appendChild(rankAppend('span', 'skeleton sk-line', ''));
      li.appendChild(rankAppend('span', 'skeleton sk-line w40', ''));
      listEl.appendChild(li);
    }
  }

  function loadRank(game) {
    var seq = ++rankSeq;
    var empty = B8.qs('#rank-empty');

    if (!writable) {
      renderRank(game, SAMPLE_RANK[game] || [], true);
      return;
    }

    if (rankCache[game]) {
      renderRank(game, rankCache[game], false);
      return;
    }

    rankSkeleton();
    B8.sb.rpc('b8_score_top', { p_token: B8.auth.token(), p_game: game, p_limit: 10 })
      .then(function (rows) {
        if (seq !== rankSeq) return;   // 切了 tab，别把旧结果画上去
        rankCache[game] = Array.isArray(rows) ? rows : [];
        renderRank(game, rankCache[game], false);
      })
      .catch(function (err) {
        if (seq !== rankSeq) return;
        rankFailed[game] = err && err.message ? err.message : '未知错误';
        renderRank(game, [], false);
        if (empty) {
          empty.textContent = '排行榜没读到：' + rankFailed[game];
          empty.hidden = false;
        }
      });
  }

  /* ============================================================
     启动
     ============================================================ */

  /**
   * 共用 auth.js 在「没配数据库」这条分支里只准备了提示和「先看看界面」，
   * 但忘了调用内部的 showGate()，而 #gate 在 HTML 里是 hidden 的——
   * 结果门根本不出现，页面只剩一层模糊内容，谁也进不去。
   * 约定不改共用件，这里补一次显形（只在没配数据库时做，正常登录路径不受影响）。
   */
  function ensureGateVisible() {
    if (B8.sb.ready) return;
    var gate = B8.qs('#gate');
    if (!gate) return;
    gate.hidden = false;
    gate.classList.remove('is-done');
  }

  function init() {
    ensureGateVisible();

    grid = B8.qs('#photo-grid');
    if (!grid) return;

    emptyEl = B8.qs('#photo-empty');
    statusEl = B8.qs('#photo-status');
    captionEl = B8.qs('#photo-caption');
    pickEl = B8.qs('#photo-pick');
    fileEl = B8.qs('#photo-file');
    statPhotos = B8.qs('#stat-photos');
    statToday = B8.qs('#stat-today');

    bindGameTabs();
    bindRankTabs();
    bindPhotoFilters();

    // 开关管理员模式后要重画：上传者名字只有管理员看得见，
    // 不重画的话关掉管理员模式名字还挂在那儿。
    document.addEventListener('b8:auth', function () {
      loadPhotos();
    });

    if (fileEl) B8.on(fileEl, 'change', onPick);

    // 上传入口是真按钮：点一下就把文件框弹出来。
    // （以前是 label 套 input，微信内置浏览器里点不动。）
    if (pickEl) {
      B8.on(pickEl, 'click', function (e) {
        e.preventDefault();
        if (fileEl && !fileEl.disabled) fileEl.click();
      });
    }

    if (!B8.auth) return;

    // 本站公开：没登录也能玩游戏，但合影墙和排行榜要登录。
    function applyAuth() {
      var st = B8.auth.state();
      var preview = !!st.preview;
      var logged = B8.auth.isLogged();
      writable = !!B8.sb.ready && logged && !preview;

      initMode({
        kind: preview ? 'preview' : B8.auth.kind(),
        nick: B8.auth.nick(),
        isSuper: B8.auth.isSuper()
      });

      if (!logged) {
        guestMode();
        return;
      }

      if (!B8.sb.ready) {
        showDbNotes();
        lockWrites();
      }
      if (pickEl) pickEl.hidden = false;
      if (grid) grid.hidden = false;
      loadPhotos();
      loadRank(rankGame);
    }

    B8.auth.ready(applyAuth);
    document.addEventListener('b8:auth', applyAuth);
  }

  /** 没登录时的合影墙 + 排行榜 */
  function guestMode() {
    if (grid) {
      grid.innerHTML = '';
      grid.hidden = true;
    }
    if (emptyEl) {
      emptyEl.innerHTML = '';
      emptyEl.hidden = false;
      emptyEl.appendChild(document.createTextNode('合影墙只对八班开放，登录后才能看。 '));
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn ghost sm';
      b.textContent = '登录看合影';
      B8.on(b, 'click', function () {
        var acct = document.getElementById('acct-btn');
        if (acct) acct.click();
      });
      emptyEl.appendChild(b);
    }
    if (pickEl) pickEl.hidden = true;
    if (fileEl) fileEl.disabled = true;
    if (statusEl) statusEl.textContent = '';
    if (statPhotos) statPhotos.textContent = '—';
    if (statToday) statToday.textContent = '—';

    var rl = B8.qs('#rank-list');
    if (rl) rl.innerHTML = '';
    var re = B8.qs('#rank-empty');
    if (re) {
      re.hidden = false;
      re.textContent = '登录后才能看排行榜。游戏随便玩，登录了成绩才会计进去。';
    }
  }

  whenReady(init);
  // 给游戏模块用：有新成绩进库时清掉对应榜单缓存，下次切过去才是新的
  B8.fun = {
    reloadPhotos: loadPhotos,
    reloadRank: loadRank,
    rankSaved: function (game) {
      delete rankCache[game];
      delete rankFailed[game];
      if (game === rankGame) loadRank(game);
    }
  };
})();
