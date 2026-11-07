/* ============================================================
   八班游乐场 · 服务器引擎 API（可选）
   ------------------------------------------------------------
   配置：site-config.js 的 engineApi
     engineApi: 'https://api.bhsf202808.fun'
   没有配置时，所有函数返回 null，页面继续用本地 P1 / WASM。
   ============================================================ */
(function () {
  'use strict';

  function base() {
    var cfg = window.B8_CONFIG || {};
    return String(cfg.engineApi || '').replace(/\/+$/, '');
  }

  function enabled() {
    return !!base();
  }

  function post(path, body, timeoutMs) {
    var url = base() + path;
    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = 0;
    var opts = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    };
    if (ctrl) {
      opts.signal = ctrl.signal;
      timer = setTimeout(function () { ctrl.abort(); }, timeoutMs || 25000);
    }
    return fetch(url, opts).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (txt) {
          throw new Error('引擎服务 ' + res.status + '：' + (txt || '').slice(0, 120));
        });
      }
      return res.json();
    }).finally(function () {
      if (timer) clearTimeout(timer);
    });
  }

  function scoreToP1(cp, mate, turn) {
    var raw = mate != null ? (mate > 0 ? 10000 : -10000) : Number(cp || 0);
    var white = turn === 'b' ? -raw : raw;
    if (mate != null) return white > 0 ? 100 : 0;
    var capped = Math.max(-2000, Math.min(2000, white));
    return Math.round((100 / (1 + Math.pow(10, -capped / 400))) * 10) / 10;
  }

  function evalOne(game, fen, movetime) {
    if (!enabled()) return Promise.resolve(null);
    return post('/eval', {
      game: game,
      fen: fen,
      movetime_ms: movetime || 120
    }, 6000).then(function (r) {
      return {
        p1: scoreToP1(r.cp, r.mate, r.turn),
        cp: r.cp,
        mate: r.mate,
        depth: r.depth,
        bestmove: r.bestmove,
        ms: r.ms
      };
    });
  }

  function evalGo(size, moves, visits) {
    if (!enabled()) return Promise.resolve(null);
    return post('/go/eval', {
      size: size,
      moves: moves || [],
      komi: 7.5,
      rules: 'chinese',
      visits: visits || 100
    }, 8000).then(function (r) {
      return {
        p1: Number(r.winrate || 50),
        scoreLead: r.score_lead,
        bestmove: r.bestmove,
        visits: r.visits,
        ms: r.ms
      };
    });
  }

  function evalBatch(game, fens, movetime) {
    if (!enabled()) return Promise.resolve(null);
    return post('/eval-batch', {
      game: game,
      fens: fens,
      movetime_ms: movetime || 80
    }, 120000).then(function (r) {
      return (r.results || []).map(function (x) {
        return {
          p1: scoreToP1(x.cp, x.mate, x.turn),
          cp: x.cp,
          mate: x.mate,
          depth: x.depth,
          bestmove: x.bestmove,
          ms: x.ms
        };
      });
    });
  }

  function createAnalysis(game, fens, movetime) {
    if (!enabled()) return Promise.resolve(null);
    return post('/analysis', {
      game: game,
      fens: fens,
      movetime_ms: movetime || 600
    }, 30000);
  }

  function getAnalysis(id) {
    if (!enabled()) return Promise.resolve(null);
    return fetch(base() + '/analysis/' + encodeURIComponent(id)).then(function (res) {
      if (!res.ok) throw new Error('查任务失败 ' + res.status);
      return res.json();
    });
  }

  window.B8Server = {
    enabled: enabled,
    evalOne: evalOne,
    evalGo: evalGo,
    evalBatch: evalBatch,
    createAnalysis: createAnalysis,
    getAnalysis: getAnalysis,
    scoreToP1: scoreToP1
  };
})();
