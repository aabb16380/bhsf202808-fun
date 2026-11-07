/* ============================================================
   八班游乐场 · 唯一配置点
   ------------------------------------------------------------
   Supabase 项目：zcfdtfmxtsxacsklqlhe（Singapore · free）
   三站共用这一个库；合影走 storage 桶 b8-photos。
   ============================================================ */
window.B8_CONFIG = {
  site: {
    name: '八班游乐场',
    domain: 'bhsf202808.fun',
    github: 'aabb16380',
    version: 'v2.122'
  },

  supabase: {
    url: 'https://zcfdtfmxtsxacsklqlhe.supabase.co',
    anonKey: 'sb_publishable_kkJAT4lA9KFJGhua2V9gjw_tr-doaVN'
  },

  // 可选：Cloudflare Worker 图片缓存代理，见 cloudflare/README.md
  // 留空则继续直连 Supabase；部署好 Worker 后填它的 workers.dev 地址，
  // 例如 'https://b8-photo-proxy.xxx.workers.dev'
  photoProxy: '',

  // 可选：棋类引擎 API（见 server/README.md）
  // 临时走 Cloudflare Quick Tunnel；正式域名 api.bhsf202808.fun 生效后替换
  engineApi: 'https://explicit-clarity-addressed-dvd.trycloudflare.com',

  links: {
    homes: '//bhsf202808.homes/',
    fun: '//bhsf202808.fun/',
    site: '//bhsf202808.site/'
  },

  features: {
    photos: true,
    games: true,
    rank: true
  }
};
