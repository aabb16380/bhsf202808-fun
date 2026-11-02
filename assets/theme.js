/* ============================================================
   八班游乐场 · 夜间模式
   ------------------------------------------------------------
   三种状态：
     auto  （默认）跟随系统；另外 21:00–04:00 一律算夜间
     dark  常开
     light 常关
   选择的优先级高于系统/时段；auto 才看系统与时间。
   ------------------------------------------------------------ */
(function () {
  'use strict';

  var KEY = 'b8.fun.theme';
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  var lastNight = null;

  function read() {
    try {
      var v = localStorage.getItem(KEY);
      return (v === 'dark' || v === 'light') ? v : 'auto';
    } catch (e) {
      return 'auto';
    }
  }

  var mode = read();

  function systemNight() {
    return !!(mq && mq.matches);
  }

  function hourNight() {
    var h = new Date().getHours();
    // 晚上九点到第二天凌晨四点，默认开
    return h >= 21 || h < 4;
  }

  function isNight() {
    if (mode === 'dark') return true;
    if (mode === 'light') return false;
    return systemNight() || hourNight();
  }

  function apply() {
    var night = isNight();
    document.documentElement.setAttribute('data-mode', night ? 'night' : 'day');
    document.documentElement.style.colorScheme = night ? 'dark' : 'light';

    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', night ? '#101014' : '#f8f4e9');

    // 同一个状态不重复广播
    if (lastNight !== night) {
      lastNight = night;
      try {
        document.dispatchEvent(new CustomEvent('b8:theme', {
          detail: { mode: mode, night: night }
        }));
      } catch (e) {}
    }
  }

  function set(next) {
    mode = (next === 'dark' || next === 'light') ? next : 'auto';
    try { localStorage.setItem(KEY, mode); } catch (e) {}
    apply();
    return mode;
  }

  function cycle() {
    set(mode === 'auto' ? 'dark' : (mode === 'dark' ? 'light' : 'auto'));
    return label();
  }

  function label() {
    if (mode === 'dark') return '夜间：常开';
    if (mode === 'light') return '夜间：常关';
    return '夜间：自动（' + (isNight() ? '开' : '关') + '）';
  }

  function paintButton() {
    var btn = document.getElementById('theme-btn');
    if (!btn) return;
    btn.textContent = label();
    btn.setAttribute('aria-pressed', isNight() ? 'true' : 'false');
    btn.title = '自动会跟随系统；21:00–04:00 默认开。点一下切换。';
  }

  window.B8Theme = {
    get: function () { return mode; },
    set: set,
    cycle: cycle,
    isNight: isNight,
    label: label,
    apply: apply
  };

  // 系统主题变化时，只有 auto 跟着变
  if (mq) {
    var onChange = function () { if (mode === 'auto') apply(); };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }

  // 跨过 21:00 / 04:00 时自动切
  setInterval(function () { if (mode === 'auto') apply(); }, 60 * 1000);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      paintButton();
      var btn = document.getElementById('theme-btn');
      if (btn) {
        btn.addEventListener('click', function () {
          cycle();
          paintButton();
        });
      }
    });
  } else {
    paintButton();
    var btn2 = document.getElementById('theme-btn');
    if (btn2) {
      btn2.addEventListener('click', function () {
        cycle();
        paintButton();
      });
    }
  }

  document.addEventListener('b8:theme', paintButton);

  apply();
})();
