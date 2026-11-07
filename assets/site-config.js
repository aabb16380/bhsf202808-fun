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
    version: 'v2.171'
  },

  supabase: {
    url: 'https://zcfdtfmxtsxacsklqlhe.supabase.co',
    anonKey: 'sb_publishable_kkJAT4lA9KFJGhua2V9gjw_tr-doaVN',
    // v2.168: 国内直连 supabase.co（Cloudflare）经常超时/被拦，API 改走韩国服务器反代
    proxy: 'https://api.bhsf202808.fun/sb'
  },

  // 图片代理：旧图已搬到韩国服务器；新上传未同步时前端自动回退 Supabase
  photoProxy: 'https://api.bhsf202808.fun',

  // 新照片直接上传到韩国服务器（失败自动回退 Supabase）
  photoUpload: 'https://api.bhsf202808.fun/photos/upload',

  // 可选：棋类引擎 API（见 server/README.md）
  engineApi: 'https://api.bhsf202808.fun',

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
