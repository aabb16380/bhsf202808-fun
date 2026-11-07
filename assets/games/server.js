/* ============================================================
   八班游乐场 · 服务器引擎 API（可选）
   ------------------------------------------------------------
   配置：site-config.js 的 engineApi
     engineApi: 'https://api.bhsf202808.fun'
   没有配置时，所有函数返回 null，页面继续用本地 P1 / WASM。

   整盘分析必须分批：服务端每个请求最多 220 个局面，而且 2C2G 的
   机器一次算太多会超时。这里统一按棋种切成小批（go 一批 24 个），
   顺序发、边发边报进度，调用方拿到的还是完整结果数组。
   ============================================================ */
(function () {
  'use strict';

  var CHUNK = { eval: 100, go: 24, gomoku: 60, draughts: 40 };

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

  // 把 items 切成 batches，顺序执行 fn(batch)，把每批结果拼起来。
  // 任何一批失败都 reject —— 整盘分析宁可报错，也不要半条曲线。
  function runBatches(items, size, fn, timeoutMs, onProgress) {
    var list = items || [];
    var total = list.length;
    var out = [];
    var i = 0;
    if (!total) return Promise.resolve(out);
    function step() {
      if (i >= total) return Promise.resolve(out);
      var batch = list.slice(i, Math.min(total, i + size));
      i += batch.length;
      return fn(batch, timeoutMs).then(function (rows) {
        for (var k = 0; k < rows.length; k++) out.push(rows[k]);
        if (onProgress) {
          try { onProgress(out.length, total); } catch (e) {}
        }
        return step();
      });
    }
    return step();
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
        ownership: Array.isArray(r.ownership) ? r.ownership : [],
        bestmove: r.bestmove,
        visits: r.visits,
        ms: r.ms
      };
    });
  }

  function evalGomoku(stones, timeoutMs) {
    if (!enabled()) return Promise.resolve(null);
    return post('/gomoku/eval', {
      size: 15,
      stones: stones || [],
      timeout_ms: timeoutMs || 200
    }, 5000).then(function (r) {
      return {
        p1: Number(r.winrate || 50),
        bestmove: r.bestmove,
        ev: r.ev,
        ms: r.ms
      };
    });
  }

  function evalDraughts(fen, moves, moveTime) {
    if (!enabled()) return Promise.resolve(null);
    return post('/draughts/eval', {
      fen: fen,
      moves: moves || '',
      move_time: moveTime || 0.2
    }, 6000).then(function (r) {
      var score = Number(r.score || 0);
      var turn = String(r.turn || fen.charAt(0) || 'W').toUpperCase() === 'B' ? 'B' : 'W';
      var whiteScore = turn === 'W' ? score : -score;
      return {
        score: score,
        turn: turn,
        p1: Math.round((100 / (1 + Math.pow(10, -(whiteScore * 100) / 400))) * 10) / 10,
        bestmove: r.bestmove,
        ms: r.ms
      };
    });
  }

  function evalDraughtsBatch(positions, moveTime, onProgress) {
    if (!enabled()) return Promise.resolve(null);
    var list = positions || [];
    return runBatches(list, CHUNK.draughts, function (batch, timeoutMs) {
      return post('/draughts/batch', {
        positions: batch.map(function (p) {
          return {
            fen: p.fen,
            moves: p.moves || '',
            move_time: p.move_time || moveTime || 0.2
          };
        })
      }, timeoutMs).then(function (r) { return r.results || []; });
    }, 90000, onProgress);
  }

  function evalGoBatch(positions, visits, onProgress) {
    if (!enabled()) return Promise.resolve(null);
    var list = positions || [];
    return runBatches(list, CHUNK.go, function (batch, timeoutMs) {
      return post('/go/batch', {
        positions: batch.map(function (p) {
          return {
            size: p.size || 19,
            moves: p.moves || [],
            komi: p.komi == null ? 7.5 : p.komi,
            rules: p.rules || 'chinese',
            visits: p.visits || visits || 30
          };
        })
      }, timeoutMs).then(function (r) { return r.results || []; });
    }, 120000, onProgress);
  }

  function evalGomokuBatch(positions, timeoutMs, onProgress) {
    if (!enabled()) return Promise.resolve(null);
    var list = positions || [];
    return runBatches(list, CHUNK.gomoku, function (batch, timeout) {
      return post('/gomoku/batch', {
        positions: batch.map(function (p) {
          return {
            size: p.size || 15,
            stones: p.stones || [],
            timeout_ms: p.timeout_ms || timeoutMs || 150
          };
        })
      }, timeout).then(function (r) { return r.results || []; });
    }, 120000, onProgress);
  }

  function evalBatch(game, fens, movetime, onProgress) {
    if (!enabled()) return Promise.resolve(null);
    var list = fens || [];
    return runBatches(list, CHUNK.eval, function (batch, timeoutMs) {
      return post('/eval-batch', {
        game: game,
        fens: batch,
        movetime_ms: movetime || 80
      }, timeoutMs).then(function (r) {
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
    }, 90000, onProgress);
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
    evalGomoku: evalGomoku,
    evalDraughts: evalDraughts,
    evalGoBatch: evalGoBatch,
    evalGomokuBatch: evalGomokuBatch,
    evalDraughtsBatch: evalDraughtsBatch,
    evalBatch: evalBatch,
    createAnalysis: createAnalysis,
    getAnalysis: getAnalysis,
    scoreToP1: scoreToP1
  };
})();
