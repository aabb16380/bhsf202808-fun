/* ============================================================
   B8 · Supabase 极简客户端
   ------------------------------------------------------------
   只做三件事：REST 查询、RPC 调用、Storage 上传。
   不引 supabase-js（省 100 KB，国内打开更快）。
   配置写在 assets/site-config.js 里；没配就整体降级，页面不报错。
   ============================================================ */
(function () {
  'use strict';

  var B8 = window.B8 = window.B8 || {};
  var cfg = window.B8_CONFIG || {};
  var sbCfg = cfg.supabase || {};

  var URL_ = (sbCfg.url || '').replace(/\/+$/, '');
  var KEY = sbCfg.anonKey || '';

  var sb = B8.sb = {
    ready: !!(URL_ && KEY),
    url: URL_,
    lastError: null
  };

  function headers(extra) {
    var h = {
      apikey: KEY,
      Authorization: 'Bearer ' + KEY
    };
    if (extra) for (var k in extra) h[k] = extra[k];
    return h;
  }

  function parse(text) {
    if (!text) return null;
    try { return JSON.parse(text); } catch (e) { return text; }
  }

  /**
   * 底层请求。失败时抛出带可读信息的 Error，
   * 前端要把它原样显示给用户（别只说「失败了」）。
   */
  function request(method, url, body, extraHeaders, ms) {
    if (!sb.ready) return Promise.reject(new Error('未配置 Supabase'));

    var ctrl = null;
    var opts = {
      method: method,
      headers: headers(extraHeaders)
    };
    if (body !== undefined && body !== null) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    if (window.AbortController) {
      ctrl = new AbortController();
      opts.signal = ctrl.signal;
    }

    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, ms || 15000);

    return fetch(url, opts).then(function (res) {
      clearTimeout(timer);
      return res.text().then(function (text) {
        var data = parse(text);
        if (!res.ok) {
          var msg = (data && (data.message || data.error_description || data.error)) || ('HTTP ' + res.status);
          var err = new Error(msg);
          err.status = res.status;
          err.detail = data;
          sb.lastError = err;
          if (res.status === 404 && /relation|does not exist|schema/i.test(msg)) {
            err.message = '数据表还没建好（' + msg + '）。请先执行 supabase/schema.sql。';
          } else if (res.status === 404 && /function|schema cache/i.test(msg)) {
            err.message = 'RPC 函数还没建好（' + msg + '）。请先执行 supabase/schema.sql。';
          }
          throw err;
        }
        sb.lastError = null;
        return data;
      });
    }, function (e) {
      clearTimeout(timer);
      var err = new Error(e && e.name === 'AbortError' ? '请求超时，请检查网络' : '网络不通：' + (e && e.message ? e.message : '未知错误'));
      sb.lastError = err;
      throw err;
    });
  }

  sb.request = request;

  /** 查询：B8.sb.select('b8_photos', 'select=*&order=id.desc&limit=20') */
  sb.select = function (table, query) {
    return request('GET', URL_ + '/rest/v1/' + table + (query ? '?' + query : ''));
  };

  /** 插入（受 RLS 约束）。失败返回错误对象。 */
  sb.insert = function (table, row, prefer) {
    return request('POST', URL_ + '/rest/v1/' + table, row, {
      Prefer: prefer || 'return=representation'
    });
  };

  /** 补丁 */
  sb.patch = function (table, query, patch) {
    return request('PATCH', URL_ + '/rest/v1/' + table + (query ? '?' + query : ''), patch, {
      Prefer: 'return=representation'
    });
  };

  /** 删除 */
  sb.remove = function (table, query) {
    return request('DELETE', URL_ + '/rest/v1/' + table + (query ? '?' + query : ''), null, {
      Prefer: 'return=representation'
    });
  };

  /** RPC：B8.sb.rpc('b8_login', {p_secret:'...'}) */
  sb.rpc = function (fn, args) {
    return request('POST', URL_ + '/rest/v1/rpc/' + fn, args || {});
  };

  /** Storage 上传，返回 public URL */
  sb.upload = function (bucket, path, file) {
    var url = URL_ + '/storage/v1/object/' + bucket + '/' + path.split('/').map(encodeURIComponent).join('/');
    return request('POST', url, undefined, {
      'x-upsert': 'false',
      'Content-Type': file.type || 'application/octet-stream'
    }, 60000).then(function () {
      return URL_ + '/storage/v1/object/public/' + bucket + '/' + path.split('/').map(encodeURIComponent).join('/');
    });
  };

  /** Storage 删除（需要策略允许） */
  sb.unlink = function (bucket, path) {
    return request('DELETE', URL_ + '/storage/v1/object/' + bucket + '/' + path.split('/').map(encodeURIComponent).join('/'));
  };

  B8.publicUrl = function (bucket, path) {
    return URL_ + '/storage/v1/object/public/' + bucket + '/' + String(path).split('/').map(encodeURIComponent).join('/');
  };
})();
