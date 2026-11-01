/* ============================================================
   八班游乐场 · 唯一配置点
   ------------------------------------------------------------
   在 supabase.com 建一个项目，先跑 supabase/schema.sql，
   再把 Project URL 与 anon public key 填进来（三站用的是同一个项目）。
   没填之前站点能打开，但登录门会提示「本站还没接数据库」。
   ============================================================ */
window.B8_CONFIG = {
  site: {
    name: '八班游乐场',
    domain: 'bhsf202808.fun',
    github: 'aabb16380',
    version: 'v1.0'
  },

  supabase: {
    url: '',
    anonKey: ''
  },

  links: {
    homes: 'https://bhsf202808.homes/',
    fun: 'https://bhsf202808.fun/',
    site: 'https://bhsf202808.site/'
  },

  features: {
    photos: true,
    games: true,
    rank: true
  }
};
