-- ============================================================
--  北京四中 2028 届 8 班 · 三站共用数据库
--  ------------------------------------------------------------
--  bhsf202808.homes / .fun / .site 共用一个 Supabase 项目，
--  所有对象统一加 b8_ 前缀，互不干扰。
--
--  执行方式：Supabase → SQL Editor → 整段粘贴 → Run。
--  本文件可重复执行（幂等），改完再跑一遍即可。
--
--  三条铁律（来自 zhoujin.site 的踩坑记录）：
--   1. 所有函数 security definer + set search_path = public, extensions
--      —— pgcrypto 在 extensions schema，漏了 digest() 会 404，登录必挂。
--   2. 匿名 key 只读；所有写操作走 RPC，由函数校验令牌。
--   3. 表名/函数名永久带 b8_ 前缀，将来拆项目也好搬。
-- ============================================================

create extension if not exists pgcrypto with schema extensions;

-- ------------------------------------------------------------
--  0. 小工具
-- ------------------------------------------------------------

create or replace function public.b8_sha(t text)
returns text
language sql
immutable
set search_path = public, extensions
as $$
  select encode(digest(coalesce(t, ''), 'sha256'), 'hex');
$$;

-- 校验令牌的函数定义见下方「1. 口令与会话」末尾
-- （它引用 b8_sessions 的行类型，必须排在建表之后）

-- ------------------------------------------------------------
--  1. 口令与会话
-- ------------------------------------------------------------

create table if not exists public.b8_keys (
  id         bigserial primary key,
  kind       text not null check (kind in ('class', 'admin')),
  label      text not null default '',          -- 给谁用：班委 / 班主任 / 通用
  hash       text not null unique,              -- 只存 sha256
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  used_at    timestamptz
);

create table if not exists public.b8_sessions (
  token      text primary key,
  kind       text not null check (kind in ('class', 'admin')),
  nick       text not null default '',
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists b8_sessions_exp_idx on public.b8_sessions (expires_at);

-- 校验令牌；p_need = 'admin' 时要求管理员
create or replace function public.b8_verify(p_token text, p_need text default 'class')
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  s public.b8_sessions;
begin
  if p_token is null or length(p_token) < 16 then
    raise exception '请先登录' using errcode = '28000';
  end if;

  select * into s
    from public.b8_sessions
   where token = p_token and expires_at > now();

  if not found then
    raise exception '登录已过期，请重新输入班级口令' using errcode = '28000';
  end if;

  if p_need = 'admin' and s.kind <> 'admin' then
    raise exception '这个动作需要管理员密钥' using errcode = '28000';
  end if;

  return jsonb_build_object('ok', true, 'kind', s.kind, 'nick', s.nick);
end;
$$;

-- 登录：一个输入框，普通口令和管理员密钥都能进
create or replace function public.b8_login(p_secret text, p_nick text default '')
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  k    public.b8_keys;
  tok  text;
  nick text;
  days integer;
  exp  timestamptz;
begin
  if p_secret is null or length(trim(p_secret)) = 0 then
    raise exception '请输入班级口令' using errcode = '28P01';
  end if;

  select * into k
    from public.b8_keys
   where hash = public.b8_sha(trim(p_secret)) and active
   limit 1;

  if not found then
    raise exception '口令不对。请找班委要一次班级口令。' using errcode = '28P01';
  end if;

  update public.b8_keys set used_at = now() where id = k.id;

  tok  := encode(gen_random_bytes(24), 'hex');
  days := case when k.kind = 'admin' then 1 else 30 end;
  exp  := now() + (days || ' days')::interval;
  nick := coalesce(nullif(trim(coalesce(p_nick, '')), ''), k.label,
                   case when k.kind = 'admin' then '管理员' else '同学' end);
  nick := left(nick, 16);

  insert into public.b8_sessions (token, kind, nick, expires_at)
  values (tok, k.kind, nick, exp);

  -- 顺手清理过期会话
  delete from public.b8_sessions where expires_at < now() - interval '7 days';

  return jsonb_build_object(
    'token', tok, 'kind', k.kind, 'nick', nick, 'expires_at', exp
  );
end;
$$;

create or replace function public.b8_check(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  s public.b8_sessions;
begin
  select * into s from public.b8_sessions
   where token = p_token and expires_at > now();
  if not found then
    return jsonb_build_object('ok', false);
  end if;
  return jsonb_build_object('ok', true, 'kind', s.kind, 'nick', s.nick, 'expires_at', s.expires_at);
end;
$$;

create or replace function public.b8_logout(p_token text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  delete from public.b8_sessions where token = p_token;
  return true;
end;
$$;

-- 管理员：看有哪些口令在用（不返回明文，只返回标签和时间）
create or replace function public.b8_keys_list(p_token text)
returns table (id bigint, kind text, label text, active boolean, created_at timestamptz, used_at timestamptz)
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  perform public.b8_verify(p_token, 'admin');
  return query
    select k.id, k.kind, k.label, k.active, k.created_at, k.used_at
      from public.b8_keys k order by k.kind, k.id;
end;
$$;

create or replace function public.b8_key_toggle(p_token text, p_id bigint, p_active boolean)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  perform public.b8_verify(p_token, 'admin');
  update public.b8_keys set active = p_active where id = p_id;
  return true;
end;
$$;

-- ------------------------------------------------------------
--  2. .homes —— 新鲜事 / 活动
-- ------------------------------------------------------------

create table if not exists public.b8_posts (
  slug       text primary key,
  cat        text not null default 'news',       -- news 新鲜事 / activity 活动 / notice 通知
  title      text not null,
  date       date not null default current_date,
  excerpt    text not null default '',
  byline     text not null default '',
  body       text not null default '',
  views      integer not null default 0,
  sort_order integer not null default 100,
  published  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists b8_posts_feed_idx on public.b8_posts (published, cat, date desc);

-- 阅读数 +1：不存在就先建行再 +1（否则新文章永远是 0）
create or replace function public.b8_bump_views(
  p_slug text,
  p_title text default null,
  p_cat text default null,
  p_date date default null,
  p_excerpt text default null,
  p_byline text default null,
  p_body text default null
)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v integer;
begin
  insert into public.b8_posts (slug, cat, title, date, excerpt, byline, body, views, published)
  values (
    p_slug,
    coalesce(nullif(p_cat, ''), 'news'),
    coalesce(nullif(p_title, ''), p_slug),
    coalesce(p_date, current_date),
    coalesce(p_excerpt, ''),
    coalesce(p_byline, ''),
    coalesce(p_body, ''),
    1,
    true
  )
  on conflict (slug) do update
    set views = public.b8_posts.views + 1,
        updated_at = now()
  returning views into v;

  return v;
end;
$$;

create or replace function public.b8_post_save(p_token text, p_post jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_slug text := nullif(trim(coalesce(p_post->>'slug', '')), '');
begin
  perform public.b8_verify(p_token, 'admin');
  if v_slug is null then
    raise exception 'slug 不能为空' using errcode = '22023';
  end if;

  insert into public.b8_posts (slug, cat, title, date, excerpt, byline, body, sort_order, published, views)
  values (
    v_slug,
    coalesce(nullif(p_post->>'cat', ''), 'news'),
    coalesce(nullif(p_post->>'title', ''), v_slug),
    coalesce((p_post->>'date')::date, current_date),
    coalesce(p_post->>'excerpt', ''),
    coalesce(p_post->>'byline', ''),
    coalesce(p_post->>'body', ''),
    coalesce((p_post->>'sort_order')::int, 100),
    coalesce((p_post->>'published')::boolean, true),
    coalesce((p_post->>'views')::int, 0)
  )
  on conflict (slug) do update set
    cat        = excluded.cat,
    title      = excluded.title,
    date       = excluded.date,
    excerpt    = excluded.excerpt,
    byline     = excluded.byline,
    body       = excluded.body,
    sort_order = excluded.sort_order,
    published  = excluded.published,
    updated_at = now();

  return jsonb_build_object('ok', true, 'slug', v_slug);
end;
$$;

create or replace function public.b8_post_delete(p_token text, p_slug text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  perform public.b8_verify(p_token, 'admin');
  delete from public.b8_posts where slug = p_slug;
  return true;
end;
$$;

-- ------------------------------------------------------------
--  3. .homes —— 留言板（免登录，公开）
-- ------------------------------------------------------------

create table if not exists public.b8_guestbook (
  id         bigserial primary key,
  nick       text not null default '路过的人',
  body       text not null,
  hidden     boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists b8_guestbook_idx on public.b8_guestbook (hidden, created_at desc);

-- 发留言：不需要登录，但有长度、频率和重复检查
create or replace function public.b8_guest_add(
  p_nick text,
  p_body text,
  p_trap text default '',
  p_token text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_body text := trim(coalesce(p_body, ''));
  v_nick text := left(coalesce(nullif(trim(coalesce(p_nick, '')), ''), '路过的人'), 16);
  v_id   bigint;
begin
  -- 蜜罐：机器人会填，正常人是空的
  if coalesce(p_trap, '') <> '' then
    raise exception '提交被拦截' using errcode = '22023';
  end if;

  if length(v_body) < 1 then
    raise exception '写点什么再发吧' using errcode = '22023';
  end if;
  if length(v_body) > 800 then
    raise exception '太长了，800 字以内' using errcode = '22023';
  end if;

  if exists (
    select 1 from public.b8_guestbook
     where body = v_body and created_at > now() - interval '30 seconds'
  ) then
    raise exception '这句话刚发过了' using errcode = '22023';
  end if;

  insert into public.b8_guestbook (nick, body) values (v_nick, v_body)
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;

create or replace function public.b8_guest_del(p_token text, p_id bigint)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  perform public.b8_verify(p_token, 'admin');
  delete from public.b8_guestbook where id = p_id;
  return true;
end;
$$;

-- ------------------------------------------------------------
--  4. .fun —— 合影
-- ------------------------------------------------------------

create table if not exists public.b8_photos (
  id         bigserial primary key,
  path       text not null,                      -- storage 里的路径
  url        text not null default '',
  caption    text not null default '',
  uploader   text not null default '',
  taken_on   date,
  likes      integer not null default 0,
  hidden     boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists b8_photos_idx on public.b8_photos (hidden, created_at desc);

create table if not exists public.b8_scores (
  id         bigserial primary key,
  game       text not null,
  nick       text not null default '',
  score      integer not null,
  created_at timestamptz not null default now()
);

create index if not exists b8_scores_idx on public.b8_scores (game, score desc);

-- 合影列表（需要登录：数据层面的门）
create or replace function public.b8_photos_list(p_token text, p_limit integer default 60)
returns table (
  id bigint, path text, url text, caption text, uploader text,
  taken_on date, likes integer, created_at timestamptz, mine boolean
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  s jsonb := public.b8_verify(p_token, 'class');
begin
  return query
    select p.id, p.path, p.url, p.caption, p.uploader, p.taken_on,
           p.likes, p.created_at,
           (p.uploader = (s->>'nick')) as mine
      from public.b8_photos p
     where not p.hidden
     order by p.created_at desc
     limit greatest(1, least(coalesce(p_limit, 60), 200));
end;
$$;

create or replace function public.b8_photo_add(
  p_token text, p_path text, p_url text,
  p_caption text default '', p_taken_on date default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  s jsonb := public.b8_verify(p_token, 'class');
  v_id bigint;
begin
  if coalesce(p_path, '') = '' then
    raise exception '缺少文件路径' using errcode = '22023';
  end if;

  if (select count(*) from public.b8_photos where created_at > now() - interval '1 hour') > 120 then
    raise exception '一小时内传得太多了，歇一会儿' using errcode = '22023';
  end if;

  insert into public.b8_photos (path, url, caption, uploader, taken_on)
  values (p_path, coalesce(p_url, ''), left(coalesce(p_caption, ''), 60), s->>'nick', p_taken_on)
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;

create or replace function public.b8_photo_like(p_token text, p_id bigint)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v integer;
begin
  perform public.b8_verify(p_token, 'class');
  update public.b8_photos set likes = likes + 1 where id = p_id
  returning likes into v;
  return coalesce(v, 0);
end;
$$;

create or replace function public.b8_photo_del(p_token text, p_id bigint)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  s jsonb := public.b8_verify(p_token, 'class');
  p public.b8_photos;
begin
  select * into p from public.b8_photos where id = p_id;
  if not found then return false; end if;

  if (s->>'kind') <> 'admin' and p.uploader <> (s->>'nick') then
    raise exception '只能删自己传的照片' using errcode = '28000';
  end if;

  delete from public.b8_photos where id = p_id;
  return true;
end;
$$;

-- 排行榜：提交 + 前十
create or replace function public.b8_score_add(p_token text, p_game text, p_score integer)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  s jsonb := public.b8_verify(p_token, 'class');
  v_id bigint;
begin
  if p_score is null or p_score < 0 or p_score > 1000000 then
    raise exception '分数不合法' using errcode = '22023';
  end if;

  insert into public.b8_scores (game, nick, score)
  values (left(coalesce(p_game, 'unknown'), 24), coalesce(s->>'nick', ''), p_score)
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;

create or replace function public.b8_score_top(p_token text, p_game text, p_limit integer default 10)
returns table (nick text, score integer, created_at timestamptz)
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  perform public.b8_verify(p_token, 'class');
  return query
    select s.nick, s.score, s.created_at
      from public.b8_scores s
     where s.game = p_game
     order by s.score desc, s.created_at asc
     limit greatest(1, least(coalesce(p_limit, 10), 50));
end;
$$;

-- ------------------------------------------------------------
--  5. .site —— 树洞
-- ------------------------------------------------------------

-- 5.1 悄悄话
create table if not exists public.b8_whispers (
  id         bigserial primary key,
  nick       text not null default '',
  anon       boolean not null default true,
  body       text not null,
  likes      integer not null default 0,
  reply      text not null default '',
  reply_by   text not null default '',
  replied_at timestamptz,
  pinned     boolean not null default false,
  hidden     boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists b8_whispers_idx on public.b8_whispers (hidden, pinned desc, created_at desc);

create or replace function public.b8_whisper_add(
  p_token text, p_body text, p_nick text default '', p_anon boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  s jsonb := public.b8_verify(p_token, 'class');
  v_body text := trim(coalesce(p_body, ''));
  v_nick text;
  v_id bigint;
begin
  if length(v_body) < 1 then
    raise exception '悄悄话不能是空的' using errcode = '22023';
  end if;
  if length(v_body) > 1000 then
    raise exception '最多 1000 字' using errcode = '22023';
  end if;

  if exists (
    select 1 from public.b8_whispers
     where body = v_body and created_at > now() - interval '60 seconds'
  ) then
    raise exception '这一条刚发过' using errcode = '22023';
  end if;

  v_nick := case when coalesce(p_anon, true)
                 then left(coalesce(nullif(trim(coalesce(p_nick, '')), ''), '匿名'), 16)
                 else left(coalesce(nullif(trim(coalesce(p_nick, '')), ''), s->>'nick'), 16)
            end;

  insert into public.b8_whispers (nick, anon, body)
  values (v_nick, coalesce(p_anon, true), v_body)
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;

create or replace function public.b8_whisper_like(p_token text, p_id bigint, p_delta integer default 1)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v integer;
begin
  perform public.b8_verify(p_token, 'class');
  update public.b8_whispers
     set likes = greatest(0, likes + case when p_delta < 0 then -1 else 1 end)
   where id = p_id
  returning likes into v;
  return coalesce(v, 0);
end;
$$;

create or replace function public.b8_whisper_list(p_token text, p_limit integer default 80)
returns setof public.b8_whispers
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  perform public.b8_verify(p_token, 'class');
  return query
    select * from public.b8_whispers
     where not hidden
     order by pinned desc, created_at desc
     limit greatest(1, least(coalesce(p_limit, 80), 200));
end;
$$;

create or replace function public.b8_whisper_post_admin(
  p_token text, p_id bigint, p_action text, p_text text default ''
)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  s jsonb := public.b8_verify(p_token, 'admin');
begin
  if p_action = 'reply' then
    update public.b8_whispers
       set reply = left(coalesce(p_text, ''), 600),
           reply_by = s->>'nick',
           replied_at = now()
     where id = p_id;
  elsif p_action = 'hide' then
    update public.b8_whispers set hidden = true where id = p_id;
  elsif p_action = 'unhide' then
    update public.b8_whispers set hidden = false where id = p_id;
  elsif p_action = 'pin' then
    update public.b8_whispers set pinned = not pinned where id = p_id;
  elsif p_action = 'delete' then
    delete from public.b8_whispers where id = p_id;
  else
    raise exception '未知操作' using errcode = '22023';
  end if;
  return true;
end;
$$;

-- 5.2 提问箱
create table if not exists public.b8_questions (
  id          bigserial primary key,
  nick        text not null default '',
  anon        boolean not null default true,
  body        text not null,
  answer      text not null default '',
  answered_by text not null default '',
  answered_at timestamptz,
  hidden      boolean not null default false,
  created_at  timestamptz not null default now()
);

create index if not exists b8_questions_idx on public.b8_questions (hidden, created_at desc);

create or replace function public.b8_question_add(
  p_token text, p_body text, p_nick text default '', p_anon boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  s jsonb := public.b8_verify(p_token, 'class');
  v_body text := trim(coalesce(p_body, ''));
  v_nick text;
  v_id bigint;
begin
  if length(v_body) < 2 then
    raise exception '问题太短了' using errcode = '22023';
  end if;
  if length(v_body) > 1000 then
    raise exception '最多 1000 字' using errcode = '22023';
  end if;

  v_nick := case when coalesce(p_anon, true)
                 then coalesce(nullif(trim(coalesce(p_nick, '')), ''), '匿名')
                 else coalesce(nullif(trim(coalesce(p_nick, '')), ''), s->>'nick')
            end;

  insert into public.b8_questions (nick, anon, body)
  values (left(v_nick, 16), coalesce(p_anon, true), v_body)
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;

create or replace function public.b8_question_list(p_token text, p_limit integer default 80)
returns setof public.b8_questions
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  perform public.b8_verify(p_token, 'class');
  return query
    select * from public.b8_questions
     where not hidden
     order by (answer = '') asc, created_at desc
     limit greatest(1, least(coalesce(p_limit, 80), 200));
end;
$$;

create or replace function public.b8_question_answer(p_token text, p_id bigint, p_answer text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  s jsonb := public.b8_verify(p_token, 'admin');
begin
  update public.b8_questions
     set answer = left(coalesce(p_answer, ''), 1500),
         answered_by = s->>'nick',
         answered_at = case when coalesce(p_answer, '') = '' then null else now() end
   where id = p_id;
  return true;
end;
$$;

create or replace function public.b8_question_hide(p_token text, p_id bigint, p_hidden boolean)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  perform public.b8_verify(p_token, 'admin');
  update public.b8_questions set hidden = coalesce(p_hidden, true) where id = p_id;
  return true;
end;
$$;

-- 5.3 时光胶囊
create table if not exists public.b8_capsules (
  id         bigserial primary key,
  nick       text not null default '',
  anon       boolean not null default false,
  title      text not null default '',
  body       text not null,
  open_at    timestamptz not null,
  hidden     boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists b8_capsules_idx on public.b8_capsules (hidden, open_at);

create or replace function public.b8_capsule_add(
  p_token text, p_title text, p_body text, p_open_at timestamptz,
  p_anon boolean default false, p_nick text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  s jsonb := public.b8_verify(p_token, 'class');
  v_body text := trim(coalesce(p_body, ''));
  v_id bigint;
  v_nick text;
begin
  if length(v_body) < 1 then
    raise exception '胶囊里总得写点东西' using errcode = '22023';
  end if;
  if length(v_body) > 4000 then
    raise exception '最多 4000 字' using errcode = '22023';
  end if;
  if p_open_at is null or p_open_at <= now() then
    raise exception '开启时间必须在未来' using errcode = '22023';
  end if;
  if p_open_at > now() + interval '20 years' then
    raise exception '最远只能埋到 20 年后' using errcode = '22023';
  end if;

  v_nick := case when coalesce(p_anon, false)
                 then '匿名'
                 else coalesce(nullif(trim(coalesce(p_nick, '')), ''), s->>'nick')
            end;

  insert into public.b8_capsules (nick, anon, title, body, open_at)
  values (left(v_nick, 16), coalesce(p_anon, false),
          left(coalesce(nullif(trim(coalesce(p_title, '')), ''), '无题'), 40), v_body, p_open_at)
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;

-- 列表：没到点只给「信件」外观，正文一律不返回
create or replace function public.b8_capsule_list(p_token text)
returns table (
  id bigint, nick text, anon boolean, title text,
  body text, is_open boolean, open_at timestamptz,
  days_left integer, created_at timestamptz
)
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  perform public.b8_verify(p_token, 'class');
  return query
    select c.id,
           case when c.anon then '匿名' else c.nick end,
           c.anon,
           c.title,
           case when now() >= c.open_at then c.body else null end,
           (now() >= c.open_at),
           c.open_at,
           greatest(0, ceil(extract(epoch from (c.open_at - now())) / 86400.0))::integer,
           c.created_at
      from public.b8_capsules c
     where not c.hidden
     order by (now() >= c.open_at) desc, c.open_at asc;
end;
$$;

create or replace function public.b8_capsule_hide(p_token text, p_id bigint)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  perform public.b8_verify(p_token, 'admin');
  update public.b8_capsules set hidden = true where id = p_id;
  return true;
end;
$$;

-- ------------------------------------------------------------
--  6. RLS：匿名 key 一律只读，写操作只能走 RPC
-- ------------------------------------------------------------

alter table public.b8_keys      enable row level security;
alter table public.b8_sessions  enable row level security;
alter table public.b8_posts     enable row level security;
alter table public.b8_guestbook enable row level security;
alter table public.b8_photos    enable row level security;
alter table public.b8_scores    enable row level security;
alter table public.b8_whispers  enable row level security;
alter table public.b8_questions enable row level security;
alter table public.b8_capsules  enable row level security;

-- 口令表、会话表：不开放任何直读
drop policy if exists b8_keys_none on public.b8_keys;
drop policy if exists b8_sessions_none on public.b8_sessions;

-- 文章：已发布的公开可读（.homes 静态回落也靠它）
drop policy if exists b8_posts_read on public.b8_posts;
create policy b8_posts_read on public.b8_posts
  for select using (published);

-- 留言板：公开读（隐藏的不给）
drop policy if exists b8_guestbook_read on public.b8_guestbook;
create policy b8_guestbook_read on public.b8_guestbook
  for select using (not hidden);

-- 其余内容站（.fun / .site）：不开放直读，全部走带令牌的 RPC
drop policy if exists b8_photos_none on public.b8_photos;
drop policy if exists b8_scores_none on public.b8_scores;
drop policy if exists b8_whispers_none on public.b8_whispers;
drop policy if exists b8_questions_none on public.b8_questions;
drop policy if exists b8_capsules_none on public.b8_capsules;

-- ------------------------------------------------------------
--  7. Storage：b8-photos 桶（合影）
-- ------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('b8-photos', 'b8-photos', true, 10485760,
        array['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
on conflict (id) do update
  set public = true,
      file_size_limit = 10485760,
      allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

drop policy if exists b8_photos_bucket_read on storage.objects;
create policy b8_photos_bucket_read on storage.objects
  for select using (bucket_id = 'b8-photos');

drop policy if exists b8_photos_bucket_write on storage.objects;
create policy b8_photos_bucket_write on storage.objects
  for insert with check (
    bucket_id = 'b8-photos'
    and lower(storage.extension(name)) in ('jpg', 'jpeg', 'png', 'webp', 'gif')
  );

-- ------------------------------------------------------------
--  8. 自检：跑完看一眼结果
-- ------------------------------------------------------------

-- select public.b8_sha('test');                     -- 应为 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08
-- select count(*) from public.b8_keys;              -- 0（还没灌种子）
-- select * from storage.buckets where id = 'b8-photos';
