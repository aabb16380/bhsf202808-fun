# 八班游乐场 · bhsf202808.fun

北京四中 2028 届 8 班的第三个站：**九个小游戏 + 一面合影墙 + 一个排行榜**。
需要班级口令才能进；数据库没接的时候，点登录门上的「先看看界面」可以用示例数据看完整版式。

三个站共用一套设计系统和同一个 Supabase 项目：

| 站 | 域名 | 目录 | 主题 | 登录 |
|---|---|---|---|---|
| 八班纪事 | bhsf202808.homes | `homes/` | 纸 · 墨 · 印 | 公开 |
| 八班游乐场 | bhsf202808.fun | `fun/` | 赭石橙 + 青 | 班级口令 |
| 八班树洞 | bhsf202808.site | `site/` | 紫 + 夜色 | 班级口令 |

---

## 1. 目录里有什么

```
fun/
├─ index.html              单页：首屏 + 登录门 + 小游戏 + 合影墙 + 排行榜
├─ changelog.html          更新日志页：读取 更新日志.md 现场渲染
├─ 更新日志.md             每个版本改了什么（新的在最上面，唯一来源）
├─ piano.html              钢琴辉：独立全屏音游（四道，十首曲子，四档难度）
├─ suika.html              合成小辉辉：独立全屏合成游戏（物理堆叠）
├─ memorynum.html          记忆数字：11 级 × 5 轮，等级系数折算标准分
├─ reaction.html           反应速度：等屏幕变红，5 轮全部计入平均
├─ clickspeed.html         手速测试：10 秒点击区
├─ sudoku.html             数独：四档难度 + 屏幕 1–9 按键 + 提示推演
├─ 404.html                找不到页面时的落地页
├─ robots.txt              允许全站抓取
├─ .nojekyll               GitHub Pages 别走 Jekyll
├─ CNAME                   bhsf202808.fun
├─ README.md               本文件
└─ assets/
   ├─ site-config.js       ★ 唯一配置点（Supabase URL / anon key / 站外链接）
   ├─ site.css             本站专用样式（会和 _shared/base.css 拼成 styles.css）
   ├─ styles.css           ✗ 生成物，别手改（sync.ps1 拼出来的）
   ├─ main.js / sb.js / auth.js  ✗ 共用件副本，别手改
   ├─ photos.js            合影墙 + 排行榜 + 页面装配
   ├─ games/2048.js
   ├─ games/memory.js
   ├─ games/reaction.js    专注方格（文件名是历史遗留，内容是 schulte）
   ├─ games/piano.js       钢琴辉的全部逻辑（Phi+Mil 计分 / 四档难度 / 十首曲子）
   ├─ games/suika.js       合成小辉辉的全部逻辑（物理 + 绘制 + 计分）
   ├─ games/memnum.js      记忆数字
   ├─ games/reflex.js      反应速度
   ├─ games/clickspeed.js  手速测试
   ├─ games/sudoku.js      数独（题池 + 笔记 / 候选 / 提示 + 按难度计分）
   ├─ games/lab.css        独立游戏页的公共样式
   ├─ theme.js / theme.css 夜间模式（自动 / 常开 / 常关）
   ├─ games/hui/1–12.jpg   辉辉的十二张脸：合成的水果、钢琴琴块用完整图
   ├─ games/hui/t1–t8.jpg  256px 缩略图：记忆翻牌、2048 牌面用（省 ~240 KB）
   ├─ games/hui.jpg        最早那张脸（v2.46 起不再被页面引用，留着当素材）
   ├─ logo.webp            页面用的 logo（54 KB；logo.png 是旧引用兜底）
   ├─ icon.png / favicon.png
   └─ ...
```

**只有两个地方该手改**：`assets/site-config.js`（配置）和 `assets/site.css`（样式）。
共用件在仓库根的 `_shared/` 里，改完跑同步脚本。

---

## 2. 本地预览

在仓库根（`bhsf202808/` 的上一级）执行：

```powershell
# 1) 把 base.css + assets/site.css 拼成 styles.css，并复制共用 JS
powershell -NoProfile -ExecutionPolicy Bypass -File bhsf202808\_shared\sync.ps1

# 2) 起一个静态服务（file:// 会挡住部分能力，别用）
python -m http.server 8802 -d bhsf202808/fun

# 3) 打开
# http://127.0.0.1:8802/
```

没配 Supabase 时：

- 登录表单会变成一段说明，下面出现「先看看界面」；
- 点进去是 `preview` 身份：合影墙、排行榜显示 **3 条示例数据**（带「示例」标签），
  上传 / 点赞 / 删除 / 成绩上传全部 `disabled`；
- 九个小游戏本身可以正常玩，最高分只存在浏览器 `localStorage` 里。

---

## 3. 接数据库

三站共用 **一个** Supabase 项目。

1. 在 [supabase.com](https://supabase.com) 建项目。
2. 打开 **SQL Editor**，把 `bhsf202808/supabase/schema.sql` 整段粘进去 Run。
   这个脚本是幂等的，改完可以再跑。
   它会建好 `b8_*` 表 / 函数、打开 RLS（匿名 key 只读，写操作只能走 RPC），
   以及 `b8-photos` 这个公开读取、10 MB 上限的 Storage 桶。
3. 到 **Project Settings → API** 抄两个值，填进 `assets/site-config.js`：

```js
supabase: {
  url: 'https://xxxxxxxxxxxx.supabase.co',
  anonKey: 'eyJhbGciOi...'   // anon public key，可以公开
}
```

> 填 `service_role` key 会出事：那是绕过 RLS 的钥匙，绝对不能进前端。

刷新页面，登录门就会变成正常的口令表单。

### 页面里的数据接口

| 用途 | RPC |
|---|---|
| 合影列表 | `b8_photos_list(p_token, p_limit)` |
| 新增合影 | `b8_photo_add(p_token, p_path, p_url, p_caption, p_taken_on)` |
| 点赞 | `b8_photo_like(p_token, p_id)` |
| 删自己的 / 管理员删任意 | `b8_photo_del(p_token, p_id)`（会写 `b8_photo_deleted` 删除记录） |
| 超管看最近删除 | `b8_super_photo_deletions(p_token, p_limit)` |
| 交成绩 | `b8_score_add(p_token, p_game, p_score)` |
| 排行榜 | `b8_score_top(p_token, p_game, p_limit)` |
| 数独排行（四档取最高） | `b8_sudoku_top(p_token, p_limit)` |
| 钢琴辉排行（三首加权） | `b8_piano_top(p_token, p_limit)` |
| 钢琴辉我的每首歌成绩 | `b8_piano_mine(p_token)` |

上传路径固定为 `photos/<时间戳>-<随机>.jpg`，桶名 `b8-photos`。

---

## 4. 口令管理（都在 SQL Editor 里做）

口令只存 sha256，**看不到明文**；忘了就换一条。

```sql
-- 新增 / 重置一条班级口令（改 '把口令写这里'）
insert into public.b8_keys (kind, label, hash)
values ('class', '八班通用', public.b8_sha('把口令写这里'))
on conflict (hash) do update set active = true, label = excluded.label;

-- 管理员密钥（能删任何人的合影；有效期 1 天，普通口令 30 天）
insert into public.b8_keys (kind, label, hash)
values ('admin', '班委', public.b8_sha('换一个更长的口令'))
on conflict (hash) do update set active = true, label = excluded.label;

-- 停用一条口令（不会注销已经登录的人）
update public.b8_keys set active = false where label = '八班通用';

-- 踢掉所有人，下次要重新输口令
delete from public.b8_sessions;

-- 看有哪些口令（只有标签和时间，没有明文）
select id, kind, label, active, created_at, used_at
  from public.b8_keys order by kind, id;
```

前端只校验「至少 4 位」，建议班级口令长一点（8 位以上、和班级有关的短语）。
**注意：静态站的口令门只挡路过的人，真正的数据边界在数据库的 RPC 里**——
所有读写都带令牌，由 `b8_verify()` 在服务端校验。

---

## 5. 九个游戏怎么记分

| 游戏 | 本地最高分 | 上传分数 | 排行榜显示 |
|---|---|---|---|
| 2048 | `b8.2048.best`（最高分） | 实际分数 | 分数（分） |
| 记忆翻牌 | `b8.memory.best`（最少步数） | `1000 − 步数` | `1000 − 分数`（步，越少越好） |
| 专注方格 | `b8.reaction.best`（最快毫秒） | `60000 − 毫秒` | `60000 − 分数`（秒） |
| 钢琴辉 | `b8.piano.songs.<学号>`（每首歌最高一档） | 每首歌单独传 `piano:<song>:<diff>`，服务器取较大值 | 三首最高「成绩 ×（该曲该档 Lv ÷ 8）」之和（不足三首按实际首数） |
| 合成小辉辉 | `b8.suika.best`（最高分） | 实际分数 | 分数（分） |
| 记忆数字 | `b8.memnum.best`（最高标准分） | `平均准确率 × 等级系数 × 400000` | 标准分 ÷10000（满分 100.00） |
| 反应速度 | `b8.reflex.best`（最高分） | `1000000 − 五次平均毫秒 × 1000` | `1000000 − 分数`（ms） |
| 手速测试 | `b8.clickspeed.best.v2`（最高点击数） | `点击数`（1 次 = 1 分，上限 100000） | 点击数（次） |
| 数独 | `b8.sudoku.best.<难度>`（每档最高分，只有干净局才记） | `sudoku:<easy/normal/hard/expert>`，服务端取较大值 | 每人四档里最高的一行（分 + 难度） |

排行榜的数据库列是「越大越好」，所以中间几个游戏做了换算，界面上也写清楚了。
手速 v2.68 起改用新键 `clickspeed2`，旧版按「点击数 ×1000」存的成绩不会混进新榜。
v2.70 修了高点击率下的计时器卡顿：结算看绝对 deadline，10 秒后排队到达的 pointerdown 不再计数，
切后台回来也会立刻结算。
2048 在每次刷新本机最高分后（停手 1.4 秒）上传一次，重开或结束时再补一次；
其余游戏都在一局结束时上传一次。

**专注方格点错一次 +1 秒**（罚时直接算进最终成绩），所以手滑会实打实掉分。

记忆翻牌有**图片版（默认）和文字版**两种牌面，`b8.memory.mode` 记着上次的选择，
切换会重开一局；两种版本共用同一个成绩。

数独的题池在 `assets/games/sudoku.js` 的 `POOL`（离线生成，`_shared/gen-sudoku.py`），
运行时只做数字置换和行 / 列 / 宫互换。**每一道底题和变换后的题都经过唯一解校验**，
脚本是 `_shared/verify-sudoku.py`（16 道底题 × 20 次随机同构变换）。
计时从点「开始」/ 新局就立刻走，计分：
`最终 =（5000 − 秒数）× 难度系数`（1.00 / 1.50 / 2.20 / 3.00）；
填满 81 格时只要有一格答案错，整局 0 分。
提示优先找裸单 / 隐性唯一，找不到才直接给答案；**每局第一次点提示会弹确认框**，
用了提示的局不加入排行榜，也不刷本机最高。每人四档取最高一行进 `b8_sudoku_top`。

2048 的牌面也换成了这八张脸：每块牌一张照片，上面压暗角、白字压在上面；
512 / 1024 / 2048 / 4096+ 分别多一层红 / 金 / 朱印 / 玄色罩，数字越大越"压手"。
右上角「**有图版 / 无图版**」一键切（默认有图，选择记在 `b8.2048.mode`）；
无图版走 `.b2048.is-plain`，回到最早那套暖色阶，数字用深色。
2048 牌面用 256px 缩略图 `assets/games/hui/tN.jpg`（记忆翻牌也一样），完整 640px 图留给合成和钢琴辉。
照片写在 `assets/site.css` 的 `.b2048-in.vN` 里——**注意 `url()` 要相对 `assets/` 写**（`url("games/hui/t1.jpg")`），
写成 `url("assets/games/hui/t1.jpg")` 会 404 且不报错。

**作弊模式会把这整局作废**：只要开过一次，之后即使关掉作弊，这一局也不再更新排行榜、
也不再刷本机最高分（`cheated` 标记粘在局内，`reset()` 才清）；开作弊之前已经传上去的分数保留。
想重新上榜，点「重开」开一局干净的。

钢琴辉从 v2.59 起改用 **Phi+Mil 计分**（满分 1000000，只有全 PERFECT 才拿满）：
判定分 900000 按音符总数平分（PERFECT 100%、GOOD 65%），连击分 100000 × 最大连击 / 音符数，
空击每个 −5000；判定窗口固定 ±70ms / ±140ms。难度不再乘分数，而是靠谱面密度、
滚动速度和和弦区分：简单档保留原谱并放慢，极难档把音符拆成连打并叠和弦。
等级是 EX+ / EX / S / A / B / C / F。

v2.63 起钢琴辉**每人、每首歌、每一档分别存成绩**（`piano:<song>:<diff>`）：
每首歌只取最高的一档；v2.70 起排行系数**和谱面定数 Lv 成正比**：
`coef = Lv ÷ 8`（Lv 8 → ×1.00，Lv 16 → ×2.00，不再按四档固定），
取最高的 **三首歌**相加；不足三首按实际首数进榜。游戏菜单里的「我的成绩」会显示每首歌最高的一档，
登录后从 `b8_piano_mine` 同步；排行由 `b8_piano_top` 聚合，Lv 表是 `b8_piano_levels`（40 行）。
加歌 / 改定数时 `piano.js` 和 SQL 必须一起改。需要把 `supabase/install-all.sql`
重新在 Supabase 跑一遍（幂等，不会清旧数据）。

记忆数字的公平性靠**等级系数**：`单轮得分 = 按位正确的比例`，
`最终分 = 五轮平均 × 等级系数 × 400000`，系数从 1.00（Lv1）到 2.50（Lv11）。
低等级全对也只有 400000，最高等级全对才是 1000000；高等级更难，但同样准确率得分更高，
这样排行榜不会变成「只敢玩低等级」的游戏。每个等级的位数、闪现时间、系数、满分都在页面里列表格。
**页面和排行榜显示成百分制**：内部标准分 ÷ 10000，保留两位小数（400000 → 40.00，1000000 → 100.00），
内部标准分和排序不变；
结算时每一轮的答案 / 作答分两行逐位对照，作答里错的数字标红。

合成小辉辉的等级表在 `assets/games/suika.js` 的 `FRUITS`：
**十二级**，1–12 级各一张 `assets/games/hui/N.jpg`（10–12 级是后来加的三张，其中 11、12 是双人照）。
合到第 11 级就算完成（`WIN_LEVEL = 11`）；第 12 级只是给 11+11 一个去处，它自己不再合（`MAX_LEVEL = 12`）。
**要换图**：保持正方形（圆形裁切是运行时做的），改 `FRUITS[i].img` 就行；
换了图之后数字会自动不画。

v2.59 起整条尺寸阶梯**往上提三级**（1 级 45、……、12 级 199 逻辑像素），脸更大更好认。
半径全部写在逻辑坐标里，画布固定 600×900，`fit()` 只做等比缩放——
所以任何屏幕尺寸下「球半径 / 容器宽度」都恒等于 `r / 600`，不会出现小屏球变小、大屏球变大的比例漂移。

合成小辉辉的成绩**一局只传一次**：结束时先写进本机 `b8.suika.pending`，再尝试上传；
网络不好就留在本机，下次进页面自动补传（带着学号，换人登录不会串号）。
**中途点暂停会先把当前分数存一份**（同样走这条队列），所以关掉页面也不至于白打；
接着打到结束时再按更高的分传一次。
服务端 `b8_score_add` 是「一人一个游戏一行、取较大值」，所以补传、重传都盖不掉最高分。

> 小提示：`b8_scores` 是「一人一个游戏一行、取较大值」（`b8_score_add` 里 upsert），
> 同一个人的成绩不会刷屏。

### 更新日志（每次发布必做）

- 唯一来源是 **`更新日志.md`**，新的写在最上面。
- 页头 `⋯` 菜单和页脚都有「更新日志」，打开 `changelog.html` 现场读取 md 渲染；
  不要另外维护一份 HTML。
- 流程：改完代码 → 在 `更新日志.md` 顶部加一节（版本号 / 日期 / 构建号 / 改了什么）→
  升 `assets/site-config.js` 的 `version` 和 HTML 的 `window.B8_BUILD` → 发布。
- 没有写更新日志的版本不算发完。

### 夜间模式

- 页头 `⋯` 菜单里的「夜间：自动 / 常开 / 常关」循环切换，选择存在 `b8.fun.theme`。
- **自动**：跟随 `prefers-color-scheme`；另外 **21:00–04:00 一律算夜间**，到点自动切。
- 实现：`assets/theme.js` 在 `<head>` 里先给 `<html>` 打 `data-mode="night"`，
  `assets/theme.css` 在所有页面样式之后覆盖颜色；系统主题变化和跨 21:00 / 04:00 会重算。
- 独立页也都加载了这两个文件；合成小辉辉的 canvas 颜色在 `suika.js` 里按 `data-mode` 切换。

---

## 6. 发布到 GitHub Pages

`fun/` 是**独立仓库** `aabb16380/bhsf202808-fun` 的根目录，没有构建步骤，
推上去就是最终形态。

```powershell
# 0) 发布前先把共用件同步进来（styles.css / main.js / sb.js / auth.js）
powershell -NoProfile -ExecutionPolicy Bypass -File bhsf202808\_shared\sync.ps1

# 1) 把 fun/ 里的内容复制到独立仓库的根目录，提交、推送
#    （CNAME 已经在目录里，内容是 bhsf202808.fun）
git add -A
git commit -m "fun: v1.0"
git push origin main
```

GitHub 仓库 → **Settings → Pages**：

- Source 选 **Deploy from a branch**；
- Branch 选 `main`，目录选 **/ (root)**；
- Custom domain 填 `bhsf202808.fun`，等 DNS 生效后勾上 **Enforce HTTPS**。

DNS（域名商那边）：`bhsf202808.fun` 一条 `CNAME` 指到 `aabb16380.github.io`。
仓库里的 `CNAME` 文件不要删，否则自定义域名会掉。

---

## 7. 改完代码怎么保证同学看到新的

静态站最烦的是缓存。两层措施：

1. 构建号：`index.html` / `404.html` 里的 `?v=20261101a1` 与 `window.B8_BUILD`。
   每次改动**递增构建号**（例：`20261101a2`），所有资源 URL 一起换，缓存自然失效。
2. 绕缓存：在任意页面 URL 后面加 `?t=<当前时间戳>`，页面里所有资源都会继承这个时间戳。
   手机上和同学说「打开这个链接」即可；有 `?t=` 时页头会出现红色 `TEST` 角标。

改了 `assets/site.css` 一定要重新跑 `_shared/sync.ps1`，
否则 `styles.css` 还是旧的（这是最常见的「改了没生效」）。

---

## 8. 几个已知边界

- **合影排序在客户端做**（`photos.js` 的 `sortPhotos`），规则：
  - 评分：平均星级 ↓ → 评分人数 ↓ → 点赞数 ↓
  - 点赞：点赞数 ↓ → 平均星级 ↓ → 评分人数 ↓
  - 综合：`平均星级 × 2 + ln(1+点赞)` ↓（同分再按评分 → 人数 → 点赞）
  - 最新：按上传时间倒序
  服务端 `b8_photos_list` 的 `p_sort` 只用来取数，最终顺序以本地重排为准；
  照片墙上限 200 张，超过这个数才需要把同样的规则写进 SQL 的 `ORDER BY`。
- **HEIC 不收**：浏览器解不了 iPhone 的默认格式，上传前会提示「请在相册里导出为 JPG」。
- **单张 > 10 MB 会先压缩**：canvas 缩到最长边 1600px、JPEG 0.82，再上传。
- **合影先预检再渲染**：每张图用离屏 `Image()` 加载成功后才挂进 DOM，
  所以不会出现半截破图；加载失败的会被跳过并提示。
- **大图弹层**：左右切换、Esc 关闭、点背景关闭，挂载在 `document.body` 上。
- **手机优先**：窄屏下合影墙从三列变两列（≤380px 变一列），游戏棋盘不会横向溢出，
  按钮和格子都不小于 44×44。
- 页面不引任何第三方库 / CDN / 字体 / 框架，断网也能开（示例数据是内联 SVG）。

---

## 9. 相关文件

- 总规格：`bhsf202808/_shared/BUILD-SPEC.md`
- 共用设计系统：`bhsf202808/_shared/base.css`
- 数据库：`bhsf202808/supabase/schema.sql`
- 姊妹站：`bhsf202808/homes/`、`bhsf202808/site/`

© 北京四中 2028 届 8 班 · 由 GitHub Pages 托管
