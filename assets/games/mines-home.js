/* ============================================================
   B8 · 首页「扫雷」挂载器
   ------------------------------------------------------------
   扫雷游戏本体在 assets/games/arcade-mines.js（B8Arcade.games.mines），
   这里只负责：面板第一次露出来时 mount、把分数写进排行榜、显示该难度前五。

   排行榜键：mines:easy / mines:medium / mines:hard
   （模块里的 beginner / intermediate / expert 对应到这三档）
   ============================================================ */
(function () {
  'use strict';

  var B8 = window.B8;
  if (!B8) return;

  var mounted = false;
  var last = 'beginner';
  var KEY = { beginner: 'easy', intermediate: 'medium', expert: 'hard', easy: 'easy', medium: 'medium', hard: 'hard' };
  var NAME = { beginner: '初级', intermediate: '中级', expert: '高级' };

  function $id(id) { return document.getElementById(id); }
  function txt(id, s) { var n = $id(id); if (n) n.textContent = s; }
  function logged() { return !!(B8.auth && B8.auth.isLogged && B8.auth.isLogged()); }
  function token() { return (B8.auth && B8.auth.memberToken && B8.auth.memberToken()) || ''; }
  function rpcReady() { return !!(B8.sb && B8.sb.ready && B8.sb.rpc); }
  function scoreKey(level) { return 'mines:' + (KEY[level] || 'easy'); }

  // 用时（百分之一秒）→ 0:12.34
  function fmtCs(cs) {
    var v = Math.max(0, Math.round(Number(cs) || 0));
    var m = Math.floor(v / 6000), r = v % 6000;
    var s = Math.floor(r / 100), c = r % 100;
    return m + ':' + (s < 10 ? '0' + s : s) + '.' + (c < 10 ? '0' + c : c);
  }

  function submit(score, detail) {
    if (!logged() || !rpcReady()) return Promise.resolve(null);
    // 榜上存的是用时（百分之一秒），越小越好
    var raw = (detail && detail.centis != null) ? Number(detail.centis) : Number(score) * 100;
    var v = Math.max(1, Math.round(raw || 0));
    var key = scoreKey((detail && detail.level) || last);
    return B8.sb.rpc('b8_score_add', { p_token: token(), p_game: key, p_score: v })
      .catch(function (err) {
        if (window.console) console.warn('[mines] 上榜失败', err);
        return null;
      });
  }

  function loadBest(level, cb) {
    if (typeof cb !== 'function') return;
    if (!logged() || !rpcReady()) { cb([]); return; }
    var lv = KEY[level || last] || 'easy';
    B8.sb.rpc('b8_mines_top', { p_token: token(), p_level: lv, p_limit: 5 })
      .then(function (rows) {
        cb((rows || []).map(function (r) {
          return { nick: r.nick, level: r.level, time: fmtCs(r.centis), centis: r.centis, created_at: r.at };
        }));
      })
      .catch(function () { cb([]); });
  }

  function onFinish(res) {
    res = res || {};
    if (res.level) last = res.level;
    txt('gmines-level', NAME[last] || '扫雷');
    txt('gmines-score', res.won ? fmtCs(res.centis) : '踩雷');
    if (!res.won) {
      if (B8.toast) B8.toast('踩到雷了，再来一局');
      return;
    }
    if (!logged()) {
      if (B8.toast) B8.toast('这局 ' + fmtCs(res.centis) + '；登录后能上榜');
      return;
    }
    submit(res.score, res).then(function (r) {
      if (r && B8.toast) B8.toast('上榜：' + (NAME[last] || '扫雷') + ' ' + fmtCs(res.centis));
    });
  }

  function mountNow() {
    if (mounted) return;
    var stage = $id('mines-stage');
    var game = window.B8Arcade && window.B8Arcade.games && window.B8Arcade.games.mines;
    if (!stage || !game) return;
    mounted = true;
    try {
      game.mount(stage, {
        game: 'mines',
        toast: function (m) { if (B8.toast) B8.toast(m); },
        setStatus: function (m) { txt('gmines-note', m || '无猜棋盘 · 逻辑可解'); },
        onFinish: onFinish,
        submitScore: submit,
        best: loadBest
      });
    } catch (e) {
      mounted = false;
      stage.innerHTML = '<p class="game-hint is-warn">扫雷加载失败：' +
        String((e && e.message) || e) + '</p>';
      if (window.console) console.warn('[mines] mount', e);
    }
  }

  function watch() {
    var panel = $id('game-panel-mines');
    if (!panel) return;
    // 面板第一次显示出来再挂载，避免在 hidden 容器里量到 0 宽度
    if (window.IntersectionObserver) {
      var io = new window.IntersectionObserver(function (list) {
        for (var i = 0; i < list.length; i++) {
          if (list[i].isIntersecting) { mountNow(); io.disconnect(); return; }
        }
      }, { threshold: 0.02 });
      io.observe(panel);
    }
    var tab = document.querySelector('.game-tab[data-game="mines"]');
    if (tab) tab.addEventListener('click', function () { setTimeout(mountNow, 40); });
    // 带 #mines 直接打开：别等 photos.js 绑 tab，自己把面板亮出来
    if ((location.hash || '') === '#mines') {
      var panels = document.querySelectorAll('.game-panel');
      for (var i = 0; i < panels.length; i++) {
        panels[i].hidden = panels[i].getAttribute('data-game') !== 'mines';
      }
      var tabs = document.querySelectorAll('.game-tab');
      for (var k = 0; k < tabs.length; k++) {
        if (tabs[k].getAttribute('data-game')) {
          tabs[k].setAttribute('aria-pressed',
            tabs[k].getAttribute('data-game') === 'mines' ? 'true' : 'false');
        }
      }
      setTimeout(mountNow, 60);
    }
    // 兜底：面板已经可见（比如直接带 hash 打开）就立刻挂
    if (!panel.hidden) setTimeout(mountNow, 60);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watch);
  else watch();
})();
