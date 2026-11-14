// 封印物語 線上伺服器（Cloudflare Worker + D1）
// 綁定：D1 資料庫 → 變數名 DB；加密變數 FUGLE_KEY（富果行情金鑰）；排程 */10 * * * *（更新財產榜）
// 報價：GET /?ids=2330,2603　GET /k?id=2330
// 帳號：POST /api/reg　GET /api/me　POST /api/trade　POST /api/spend　POST /api/earn　POST /api/sync　GET /api/rank?type=lv|w　POST /api/name
const FAPI = 'https://api.fugle.tw/marketdata/v1.0/stock';
const H = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type,authorization', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'content-type': 'application/json; charset=utf-8' };
const J = (o, st = 200, extra = {}) => new Response(JSON.stringify(o), { status: st, headers: { ...H, ...extra } });
const okCode = x => /^[0-9A-Z]{4,6}$/.test(x);
const START = 1000000, FEE = .001425, TAX = .003;

function marketOpen() {
  const t = new Date(Date.now() + 8 * 3600e3), d = t.getUTCDay(), m = t.getUTCHours() * 60 + t.getUTCMinutes();
  return d >= 1 && d <= 5 && m >= 540 && m <= 810;
}
const today = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);

async function cached(key, ttl, make) {
  const cache = caches.default, req = new Request('https://cache.local/' + key);
  const hit = await cache.match(req);
  if (hit) return hit.json();
  const data = await make();
  if (data) await cache.put(req, new Response(JSON.stringify(data), { headers: { 'cache-control': 'max-age=' + ttl } }));
  return data;
}
async function fugle(env, path) {
  const r = await fetch(FAPI + path, { headers: { 'X-API-KEY': env.FUGLE_KEY } });
  if (!r.ok) throw new Error('fugle ' + r.status);
  return r.json();
}
async function quote(env, id) {
  return cached('q/' + id, marketOpen() ? 15 : 600, async () => {
    try {
      const q = await fugle(env, '/intraday/quote/' + id);
      const z = q.closePrice ?? q.lastPrice ?? null, y = q.previousClose ?? q.referencePrice ?? null;
      return { n: q.name, z, y, o: q.openPrice ?? null, h: q.highPrice ?? null, l: q.lowPrice ?? null,
        v: q.total ? q.total.tradeVolume : null, t: q.lastUpdated ? Math.floor(q.lastUpdated / 1000) : Date.now() };
    } catch (e) { return null; }
  });
}
const px = q => q ? (q.z ?? q.y) : null;

async function auth(req, env) {
  const t = (req.headers.get('authorization') || '').replace(/^Bearer /, '');
  if (!/^[0-9a-f]{32,64}$/.test(t)) return null;
  return env.DB.prepare('SELECT * FROM players WHERE token=?').bind(t).first();
}
async function wallet(env, p) {
  const { results } = await env.DB.prepare('SELECT code,q,cost FROM holdings WHERE pid=?').bind(p.id).all();
  let mv = 0; const port = {};
  for (const h of results) { const q = await quote(env, h.code); const v = px(q) || h.cost / h.q; mv += h.q * v; port[h.code] = { q: h.q, cost: h.cost, n: q ? q.n : null }; }
  const w = Math.round(p.zeny + mv);
  await env.DB.prepare('UPDATE players SET wealth=?,wts=? WHERE id=?').bind(w, Date.now(), p.id).run();
  return { id: p.id, name: p.name, zeny: Math.round(p.zeny), port, wealth: w, open: marketOpen() };
}
async function body(req) { try { return await req.json(); } catch (e) { return {}; } }

async function api(req, env, path) {
  const db = env.DB;
  if (path === '/api/reg' && req.method === 'POST') {
    const b = await body(req), tok = [...crypto.getRandomValues(new Uint8Array(24))].map(x => x.toString(16).padStart(2, '0')).join('');
    const name = String(b.name || '').slice(0, 12) || '玩家';
    // 首次上線可匯入本機錢包（現金上限 200 萬）
    const z = Math.max(0, Math.min(2000000, +b.zeny || START));
    const r = await db.prepare('INSERT INTO players(token,name,zeny,created,lv,rb,sp,wealth,wts) VALUES(?,?,?,?,0,0,?,?,?)').bind(tok, name, z, Date.now(), String(b.sp || 'shiba').slice(0, 10), z, Date.now()).run();
    const id = r.meta.last_row_id;
    if (b.port && typeof b.port === 'object') {
      let n = 0;
      for (const [code, h] of Object.entries(b.port)) {
        if (!okCode(code) || n++ > 30) continue; const q = Math.floor(+h.q || 0); if (q <= 0 || q > 1e6) continue;
        const p = px(await quote(env, code)); if (!p || q * p > 2000000) continue;
        await db.prepare('INSERT INTO holdings(pid,code,q,cost) VALUES(?,?,?,?)').bind(id, code, q, Math.max(0, +h.cost || q * p)).run();
      }
    }
    return J({ token: tok, ...(await wallet(env, await db.prepare('SELECT * FROM players WHERE id=?').bind(id).first())) });
  }
  const p = await auth(req, env);
  if (!p) return J({ error: '未登入' }, 401);
  if (path === '/api/me') return J(await wallet(env, p));
  if (path === '/api/name' && req.method === 'POST') {
    const b = await body(req), n = String(b.name || '').trim().slice(0, 12);
    if (n) await db.prepare('UPDATE players SET name=? WHERE id=?').bind(n, p.id).run();
    return J({ ok: true, name: n || p.name });
  }
  if (path === '/api/trade' && req.method === 'POST') {
    const b = await body(req), code = String(b.code || '').toUpperCase(), q = Math.floor(+b.q || 0), dir = +b.dir;
    if (!okCode(code) || q < 1 || q > 1e6 || (dir !== 1 && dir !== -1)) return J({ error: '參數錯誤' }, 400);
    if (!marketOpen()) return J({ error: '休市中（週一至週五 09:00–13:30）' }, 400);
    const qt = await quote(env, code), price = px(qt);
    if (!price) return J({ error: '查無報價' }, 400);
    const a = q * price, fee = Math.max(1, Math.ceil(a * FEE));
    const h = await db.prepare('SELECT * FROM holdings WHERE pid=? AND code=?').bind(p.id, code).first();
    let msg;
    if (dir > 0) {
      const cost = Math.ceil(a) + fee; if (p.zeny < cost) return J({ error: 'zeny 不夠' }, 400);
      await db.batch([
        db.prepare('UPDATE players SET zeny=zeny-? WHERE id=?').bind(cost, p.id),
        h ? db.prepare('UPDATE holdings SET q=q+?,cost=cost+? WHERE pid=? AND code=?').bind(q, cost, p.id, code)
          : db.prepare('INSERT INTO holdings(pid,code,q,cost) VALUES(?,?,?,?)').bind(p.id, code, q, cost)
      ]);
      msg = `買進 ${qt.n} ${q} 股 @${price}，花費 ${cost}`;
    } else {
      if (!h || h.q < q) return J({ error: '持股不足' }, 400);
      const get = Math.floor(a) - fee - Math.ceil(a * TAX), part = h.cost * q / h.q;
      await db.batch([
        db.prepare('UPDATE players SET zeny=zeny+? WHERE id=?').bind(get, p.id),
        h.q === q ? db.prepare('DELETE FROM holdings WHERE pid=? AND code=?').bind(p.id, code)
          : db.prepare('UPDATE holdings SET q=q-?,cost=cost-? WHERE pid=? AND code=?').bind(q, part, p.id, code)
      ]);
      msg = `賣出 ${qt.n} ${q} 股 @${price}，${get - part >= 0 ? '賺' : '賠'} ${Math.round(Math.abs(get - part))}`;
    }
    const np = await db.prepare('SELECT * FROM players WHERE id=?').bind(p.id).first();
    return J({ msg, price, ...(await wallet(env, np)) });
  }
  if (path === '/api/spend' && req.method === 'POST') {
    const b = await body(req), n = Math.floor(+b.n || 0);
    if (n <= 0 || n > 1e8) return J({ error: '參數錯誤' }, 400);
    if (p.zeny < n) return J({ error: 'zeny 不夠' }, 400);
    await db.prepare('UPDATE players SET zeny=zeny-? WHERE id=?').bind(n, p.id).run();
    p.zeny -= n; const w = await wallet(env, p);
    return J({ zeny: w.zeny, wealth: w.wealth });
  }
  if (path === '/api/earn' && req.method === 'POST') {
    // 戰鬥獎金：每場上限 60,000，間隔至少 15 秒，每日上限 600,000
    const b = await body(req); let n = Math.floor(+b.n || 0);
    const d = today(), used = p.earn_day === d ? p.earn_amt : 0;
    if (Date.now() - (p.last_earn || 0) < 15000) return J({ error: '太頻繁', zeny: Math.round(p.zeny) }, 429);
    n = Math.max(0, Math.min(n, 60000, 600000 - used));
    await db.prepare('UPDATE players SET zeny=zeny+?,earn_day=?,earn_amt=?,last_earn=? WHERE id=?').bind(n, d, used + n, Date.now(), p.id).run();
    p.zeny += n; const w = await wallet(env, p);
    return J({ got: n, zeny: w.zeny, wealth: w.wealth });
  }
  if (path === '/api/sync' && req.method === 'POST') {
    const b = await body(req), lv = Math.max(0, Math.min(100, Math.floor(+b.lv || 0))), rb = b.rb ? 1 : 0;
    // 等級合理性：建立後每小時最多升 12 級
    const cap = Math.floor((Date.now() - p.created) / 3600e3 * 12) + 10;
    await db.prepare('UPDATE players SET lv=?,rb=?,sp=? WHERE id=?').bind(Math.min(lv, cap), rb && lv >= 1 ? rb : p.rb, String(b.sp || p.sp).slice(0, 10), p.id).run();
    return J({ ok: true });
  }
  if (path === '/api/rank') {
    const type = new URL(req.url).searchParams.get('type') === 'w' ? 'w' : 'lv';
    p.wealth = (await wallet(env, p)).wealth;
    const order = type === 'w' ? 'wealth DESC' : 'rb DESC, lv DESC, wealth DESC';
    const { results } = await db.prepare(`SELECT id,name,sp,lv,rb,wealth FROM players ORDER BY ${order} LIMIT 100`).all();
    const me = type === 'w'
      ? await db.prepare('SELECT COUNT(*) c FROM players WHERE wealth>?').bind(p.wealth).first()
      : await db.prepare('SELECT COUNT(*) c FROM players WHERE rb>? OR (rb=? AND lv>?)').bind(p.rb, p.rb, p.lv).first();
    const tot = await db.prepare('SELECT COUNT(*) c FROM players').first();
    return J({ type, list: results.map(r => ({ ...r, me: r.id === p.id ? 1 : 0, id: undefined })), mine: me.c + 1, total: tot.c });
  }
  return J({ error: 'not found' }, 404);
}

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: H });
    try {
      if (u.pathname.startsWith('/api/')) return await api(req, env, u.pathname);
      if (u.pathname === '/k') {
        const id = (u.searchParams.get('id') || '').toUpperCase();
        if (!okCode(id)) return J({});
        const k = await cached('k/' + id, marketOpen() ? 60 : 900, async () => {
          try {
            const [c, q] = await Promise.all([fugle(env, '/intraday/candles/' + id + '?timeframe=1'), quote(env, id)]);
            const d = c.data || [];
            return { t: d.map(x => Math.floor(new Date(x.date).getTime() / 1000)), c: d.map(x => x.close), pc: q ? q.y : null };
          } catch (e) { return null; }
        });
        return J(k || {}, 200, { 'cache-control': 'max-age=30' });
      }
      const ids = [...new Set((u.searchParams.get('ids') || '').toUpperCase().split(',').filter(okCode))].slice(0, 20);
      if (!ids.length) return J({ ok: true, open: marketOpen() });
      const out = {};
      await Promise.all(ids.map(async id => { const q = await quote(env, id); if (q) out[id] = q; }));
      return J(out, 200, { 'cache-control': 'max-age=5' });
    } catch (e) { return J({ error: String(e) }, 500); }
  },
  // 每 10 分鐘重新計算最近有活動玩家的財產（財產榜用）
  async scheduled(ev, env) {
    const { results } = await env.DB.prepare('SELECT * FROM players ORDER BY wts ASC LIMIT 40').all();
    for (const p of results) await wallet(env, p);
  }
};
