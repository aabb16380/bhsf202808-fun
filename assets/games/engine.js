/* ============================================================
   八班游乐场 · 棋类引擎分析（浏览器 WASM）
   ------------------------------------------------------------
   支持：国际象棋（Stockfish 10）、中国象棋（Pikafish）
   用法：B8Engine.analyze('chess' | 'xiangqi', S.state, { movetime: 900 })
   返回：Promise<{ p1, cp, mate, depth, bestmove, ms }>
   ============================================================ */
(function () {
  'use strict';

  var CHESS_MAP = {
    1: 'P', 2: 'N', 3: 'B', 4: 'R', 5: 'Q', 6: 'K',
    9: 'p', 10: 'n', 11: 'b', 12: 'r', 13: 'q', 14: 'k'
  };
  var XQ_MAP = {
    1: 'K', 2: 'A', 3: 'B', 4: 'N', 5: 'R', 6: 'C', 7: 'P',
    9: 'k', 10: 'a', 11: 'b', 12: 'n', 13: 'r', 14: 'c', 15: 'p'
  };

  function rowsToFen(board, height, width, map) {
    var rows = [];
    for (var y = 0; y < height; y++) {
      var row = '';
      var empty = 0;
      for (var x = 0; x < width; x++) {
        var p = board[y * width + x];
        if (!p) { empty++; continue; }
        if (empty) { row += empty; empty = 0; }
        row += map[p] || '';
      }
      if (empty) row += empty;
      rows.push(row);
    }
    return rows.join('/');
  }

  function fenChess(st) {
    var turn = st.turn === 2 ? 'b' : 'w';
    var c = st.castle || {};
    var cast = (c.wk ? 'K' : '') + (c.wq ? 'Q' : '') +
               (c.bk ? 'k' : '') + (c.bq ? 'q' : '');
    if (!cast) cast = '-';

    var ep = '-';
    if (typeof st.ep === 'number' && st.ep >= 0) {
      ep = 'abcdefgh'[st.ep % 8] + (8 - Math.floor(st.ep / 8));
    }

    return rowsToFen(st.board, 8, 8, CHESS_MAP) + ' ' + turn + ' ' + cast + ' ' + ep +
      ' ' + (st.half || 0) + ' ' + (Math.floor((st.seq || 0) / 2) + 1);
  }

  function fenXiangqi(st) {
    var turn = st.turn === 2 ? 'b' : 'w';
    return rowsToFen(st.board, 10, 9, XQ_MAP) + ' ' + turn + ' - - ' +
      (st.half || 0) + ' ' + (Math.floor((st.seq || 0) / 2) + 1);
  }

  function makeEngine(kind) {
    var url = kind === 'chess'
      ? 'assets/engines/stockfish/stockfish.js'
      : 'assets/engines/pikafish/worker.js';

    var worker = null;
    var ready = false;
    var booting = null;
    var pending = null;

    function lineOf(ev) {
      var d = ev.data;
      if (typeof d === 'string') return d;
      if (d && d.type === 'line') return String(d.line || '');
      if (d && d.type === 'err') {
        if (pending) fail(new Error(d.line || '引擎错误'));
        return '';
      }
      return '';
    }

    function finish(result) {
      if (!pending) return;
      var p = pending;
      pending = null;
      clearTimeout(p.timer);
      p.resolve(result);
    }

    function fail(err) {
      if (!pending) return;
      var p = pending;
      pending = null;
      clearTimeout(p.timer);
      p.reject(err);
    }

    function onLine(line) {
      if (!line) return;

      if (!ready) {
        if (line === 'uciok') {
          worker.postMessage('isready');
          return;
        }
        if (line === 'readyok') {
          ready = true;
          if (booting) booting.resolve();
          return;
        }
      }

      if (!pending) return;

      if (line.indexOf('info ') === 0) {
        var m = line.match(/^info .*?depth (\d+).*?score (cp|mate) (-?\d+).*?(?: pv (.+))?$/);
        if (m) {
          pending.depth = Number(m[1]) || pending.depth;
          pending.kind = m[2];
          pending.score = Number(m[3]) || 0;
          if (m[4]) pending.pv = m[4].trim().split(/\s+/).slice(0, 4).join(' ');
        }
        return;
      }

      if (line.indexOf('bestmove') === 0) {
        var p = pending;
        var bm = line.split(/\s+/)[1] || '';
        var raw = p.score || 0;
        var mate = p.kind === 'mate';
        var white = p.turn === 2 ? -raw : raw;
        var p1;

        if (mate) {
          p1 = white > 0 ? 100 : 0;
        } else {
          var capped = Math.max(-2000, Math.min(2000, white));
          p1 = 100 / (1 + Math.pow(10, -capped / 400));
        }

        finish({
          p1: Math.round(p1 * 10) / 10,
          cp: white,
          mate: mate ? white : null,
          depth: p.depth || 0,
          bestmove: bm,
          ms: Date.now() - p.started,
          fen: p.fen
        });
      }
    }

    function boot() {
      if (worker && ready) return Promise.resolve();
      if (booting) return booting.promise;

      booting = {};
      booting.promise = new Promise(function (resolve, reject) {
        booting.resolve = resolve;
        booting.reject = reject;
      });

      try {
        worker = new Worker(url);
      } catch (e) {
        booting = null;
        return Promise.reject(e);
      }

      var timer = setTimeout(function () {
        if (!ready) {
          booting = null;
          reject(new Error('引擎启动超时'));
        }
      }, 15000);

      function good() {
        clearTimeout(timer);
      }
      var oldResolve = booting.resolve;
      booting.resolve = function () {
        good();
        oldResolve();
      };

      worker.onerror = function (e) {
        clearTimeout(timer);
        if (!ready && booting) booting.reject(new Error('引擎加载失败：' + (e.message || 'unknown')));
        fail(new Error('引擎加载失败'));
      };

      worker.onmessage = function (ev) {
        var d = ev.data;
        if (d && d.type === 'ready') {
          worker.postMessage('uci');
          return;
        }
        onLine(lineOf(ev));
      };

      if (kind === 'chess') worker.postMessage('uci');
      return booting.promise;
    }

    function analyze(st, opts) {
      opts = opts || {};
      var movetime = Math.max(200, Math.min(2500, Number(opts.movetime) || 900));
      var fen = kind === 'chess' ? fenChess(st) : fenXiangqi(st);

      return boot().then(function () {
        if (pending) {
          try { worker.postMessage('stop'); } catch (e) {}
          fail(new Error('新的分析已开始'));
        }

        return new Promise(function (resolve, reject) {
          pending = {
            fen: fen,
            turn: st.turn,
            depth: 0,
            score: 0,
            kind: 'cp',
            started: Date.now(),
            resolve: resolve,
            reject: reject,
            timer: setTimeout(function () {
              try { worker.postMessage('stop'); } catch (e) {}
              fail(new Error('引擎分析超时'));
            }, movetime + 7000)
          };

          worker.postMessage('position fen ' + fen);
          worker.postMessage('go movetime ' + movetime);
        });
      });
    }

    return { analyze: analyze };
  }

  var engines = {};

  window.B8Engine = {
    fenChess: fenChess,
    fenXiangqi: fenXiangqi,
    analyze: function (game, st, opts) {
      if (game !== 'chess' && game !== 'xiangqi') {
        return Promise.reject(new Error('这个棋类暂未接入引擎'));
      }
      if (!engines[game]) engines[game] = makeEngine(game);
      return engines[game].analyze(st, opts);
    }
  };
})();
