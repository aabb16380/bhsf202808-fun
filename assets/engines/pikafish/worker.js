self.postMessage({ type: 'boot' });
var queue = [];
var ready = false;
var mod = null;
var booted = false;

self.onmessage = function (e) {
  if (ready && mod && mod.send_command) {
    mod.send_command(e.data);
  } else {
    queue.push(e.data);
  }
};

importScripts('pikafish.js');

Pikafish({
  locateFile: function (f) { return f; },
  print: function (line) { self.postMessage({ type: 'line', line: String(line) }); },
  printErr: function (line) { self.postMessage({ type: 'err', line: String(line) }); },
  read_stdout: function (line) { self.postMessage({ type: 'line', line: String(line) }); },
  onRuntimeInitialized: function () {
    booted = true;
    self.postMessage({ type: 'ready' });
  }
}).then(function (m) {
  mod = m;
  ready = true;
  if (!booted) self.postMessage({ type: 'ready' });
  queue.forEach(function (c) {
    try { mod.send_command(c); } catch (e) { self.postMessage({ type: 'err', line: e.message }); }
  });
  queue = [];
}).catch(function (e) {
  self.postMessage({ type: 'err', line: 'promise: ' + (e && e.message) });
});
