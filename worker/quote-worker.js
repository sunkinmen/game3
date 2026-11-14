// 封印物語 台股即時報價代理（Cloudflare Worker）— 來源：富果 Fugle MarketData API
// 金鑰放在 Worker 的加密變數 FUGLE_KEY（Settings → Variables → Secret），不要寫進程式碼或 GitHub。
// GET /?ids=2330,2603  或 /q?ids=…  → {代號:{n,z,y,o,h,l,v,t}}
// GET /k?id=2330                     → {t:[秒], c:[收盤價], pc:昨收}  當日 1 分 K
// 所有玩家共用快取：同一檔股票在快取期間只會向富果查一次。
const API = 'https://api.fugle.tw/marketdata/v1.0/stock';
const H = { 'access-control-allow-origin': '*', 'content-type': 'application/json; charset=utf-8' };
const ok = x => /^[0-9A-Z]{4,6}$/.test(x);

// 台北時間是否在盤中（週一到週五 08:55–13:35）
function open() {
  const t = new Date(Date.now() + 8 * 3600e3), d = t.getUTCDay(), m = t.getUTCHours() * 60 + t.getUTCMinutes();
  return d >= 1 && d <= 5 && m >= 535 && m <= 815;
}

async function cached(key, ttl, make) {
  const cache = caches.default, req = new Request('https://cache.local/' + key);
  const hit = await cache.match(req);
  if (hit) return hit.json();
  const data = await make();
  if (data) await cache.put(req, new Response(JSON.stringify(data), { headers: { 'cache-control': 'max-age=' + ttl } }));
  return data;
}

async function fugle(env, path) {
  const r = await fetch(API + path, { headers: { 'X-API-KEY': env.FUGLE_KEY } });
  if (!r.ok) throw new Error('fugle ' + r.status);
  return r.json();
}

async function quote(env, id) {
  return cached('q/' + id, open() ? 15 : 600, async () => {
    try {
      const q = await fugle(env, '/intraday/quote/' + id);
      const z = q.closePrice ?? q.lastPrice ?? null, y = q.previousClose ?? q.referencePrice ?? null;
      return { n: q.name, z, y, o: q.openPrice ?? null, h: q.highPrice ?? null, l: q.lowPrice ?? null,
        v: q.total ? q.total.tradeVolume : null, t: q.lastUpdated ? Math.floor(q.lastUpdated / 1000) : Date.now() };
    } catch (e) { return null; }
  });
}

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: { ...H, 'access-control-allow-headers': '*' } });
    try {
      if (u.pathname === '/k') {
        const id = (u.searchParams.get('id') || '').toUpperCase();
        if (!ok(id)) return new Response('{}', { headers: H });
        const k = await cached('k/' + id, open() ? 60 : 900, async () => {
          try {
            const [c, q] = await Promise.all([fugle(env, '/intraday/candles/' + id + '?timeframe=1'), quote(env, id)]);
            const d = c.data || [];
            return { t: d.map(x => Math.floor(new Date(x.date).getTime() / 1000)), c: d.map(x => x.close), pc: q ? q.y : null };
          } catch (e) { return null; }
        });
        return new Response(JSON.stringify(k || {}), { headers: { ...H, 'cache-control': 'max-age=30' } });
      }
      const ids = [...new Set((u.searchParams.get('ids') || '').toUpperCase().split(',').filter(ok))].slice(0, 20);
      if (!ids.length) return new Response(JSON.stringify({ ok: true, use: '/?ids=2330  /k?id=2330' }), { headers: H });
      const out = {};
      await Promise.all(ids.map(async id => { const q = await quote(env, id); if (q) out[id] = q; }));
      return new Response(JSON.stringify(out), { headers: { ...H, 'cache-control': 'max-age=5' } });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e) }), { status: 502, headers: H });
    }
  }
};
