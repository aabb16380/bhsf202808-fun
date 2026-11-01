# 八班游乐场 · bhsf202808.fun

北京四中 2028 届 8 班的第三个站：**五个小游戏 + 一面合影墙 + 一个排行榜**。
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
├─ piano.html              钢琴辉：独立全屏音游（四道，四首曲子，三个难度）
├─ suika.html              合成小辉辉：独立全屏合成游戏（物理堆叠）
├─ 404.html                找不到页面时的落地页
├─ test/index.html         调试入口：?to=<站内路径>，自动加 ?t=<时间戳> 绕缓存
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
   ├─ games/piano.js       钢琴辉的全部逻辑（piano.html 只负责 DOM 和样式）
   ├─ games/suika.js       合成小辉辉的全部逻辑（物理 + 绘制 + 计分）
   ├─ games/hui/1–8.jpg    辉辉的八张脸：记忆翻牌（图片版）、合成的水果、钢琴琴块都用它们
   ├─ games/hui.jpg        最早那张脸（v2.46 起不再被页面引用，留着当素材）
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
- 五个游戏本身可以正常玩，最高分只存在浏览器 `localStorage` 里。

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
| 删自己的 / 管理员删任意 | `b8_photo_del(p_token, p_id)` |
| 交成绩 | `b8_score_add(p_token, p_game, p_score)` |
| 排行榜 | `b8_score_top(p_token, p_game, p_limit)` |

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

## 5. 五个游戏怎么记分

| 游戏 | 本地最高分 | 上传分数 | 排行榜显示 |
|---|---|---|---|
| 2048 | `b8.2048.best`（最高分） | 实际分数 | 分数（分） |
| 记忆翻牌 | `b8.memory.best`（最少步数） | `1000 − 步数` | `1000 − 分数`（步，越少越好） |
| 专注方格 | `b8.reaction.best`（最快毫秒） | `60000 − 毫秒` | `60000 − 分数`（秒） |
| 钢琴辉 | `b8.piano.best`（最高分，不分曲目） | 实际分数（难度有加成） | 分数（分） |
| 合成小辉辉 | `b8.suika.best`（最高分） | 实际分数 | 分数（分） |

排行榜的数据库列是「越大越好」，所以中间两个游戏做了换算，界面上也写清楚了。
2048 在每次刷新本机最高分后（停手 1.4 秒）上传一次，重开或结束时再补一次；
记忆翻牌、专注方格、钢琴辉、合成小辉辉都在一局结束时上传一次。

记忆翻牌有**图片版（默认）和文字版**两种牌面，`b8.memory.mode` 记着上次的选择，
切换会重开一局；两种版本共用同一个成绩。

2048 的牌面也换成了这八张脸：每块牌一张照片，上面压暗角、白字压在上面；
512 / 1024 / 2048 / 4096+ 分别多一层红 / 金 / 朱印 / 玄色罩，数字越大越"压手"。
照片写在 `assets/site.css` 的 `.b2048-in.vN` 里——**注意 `url()` 要相对 `assets/` 写**（`url("games/hui/1.jpg")`），
写成 `url("assets/games/hui/1.jpg")` 会 404 且不报错。

钢琴辉的分数和难度挂钩（简单 ×1 / 普通 ×1.15 / 困难 ×1.35），
四首曲子的音符数差不多，所以难度越高越占便宜——这是故意的。

合成小辉辉的等级表在 `assets/games/suika.js` 的 `FRUITS`：
1 → 2 → 3 → 4 → 5 → 辉辉，每级一张 `assets/games/hui/N.jpg`。
**要换图**：保持 640×640 正方形（圆形裁切是运行时做的），改 `FRUITS[i].img` 就行；
换了图之后数字会自动不画。

> 小提示：`b8_scores` 是「一人一个游戏一行、取较大值」（`b8_score_add` 里 upsert），
> 同一个人的成绩不会刷屏。

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
2. 调试入口：`/test/?to=/` 会在目标地址后面加 `?t=<当前时间戳>`，
   页面里所有资源都会继承这个时间戳。手机上和同学说「打开这个链接」即可。
   页头出现红色 `TEST` 角标说明当前就是绕缓存的调试模式。

改了 `assets/site.css` 一定要重新跑 `_shared/sync.ps1`，
否则 `styles.css` 还是旧的（这是最常见的「改了没生效」）。

---

## 8. 几个已知边界

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
