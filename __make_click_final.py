# -*- coding: utf-8 -*-
import pathlib
root = pathlib.Path(__file__).resolve().parent
s = (root / "clickspeed.html").read_text(encoding="utf-8")
inject = r"""
<script>
window.addEventListener('load', function () {
  setTimeout(function () {
    try {
      var c = B8.games.clickspeed;
      var before = c.state();
      var f = c.feed(80);
      var after = c.state();
      document.title = 'PROBE:' + JSON.stringify({ before: before, feed: f, after: after });
    } catch (e) { document.title = 'PROBE:' + JSON.stringify({ err: String(e) }); }
  }, 400);
});
</script>
"""
(root / "__probe_click_final.html").write_text(s.replace("</body>", inject + "\n</body>", 1), encoding="utf-8")
print("wrote")
