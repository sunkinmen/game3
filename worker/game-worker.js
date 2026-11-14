// 封印物語 線上伺服器（Cloudflare Worker + D1）
// 綁定：D1 資料庫 → 變數名 DB；加密變數 FUGLE_KEY（富果行情金鑰）；排程 */10 * * * *（更新財產榜）
// 報價：GET /?ids=2330,2603　GET /k?id=2330
// 存檔：POST /api/save　GET /api/load　POST /api/rcode（產生引繼碼）　POST /api/recover（用引繼碼找回）
// 優惠碼：POST /api/redeem　GM：GET/POST /api/promo　暱稱檢查：GET /api/nick?name=
// 帳號：POST /api/reg　GET /api/me　POST /api/trade　POST /api/spend　POST /api/earn　POST /api/sync　GET /api/rank?type=lv|w　POST /api/name
const FAPI = 'https://api.fugle.tw/marketdata/v1.0/stock';
const H = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type,authorization', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'content-type': 'application/json; charset=utf-8' };
const J = (o, st = 200, extra = {}) => new Response(JSON.stringify(o), { status: st, headers: { ...H, ...extra } });
const okCode = x => /^[0-9A-Z]{4,6}$/.test(x);
const GMZ = 999999999; // GM 帳號（players.gm=1）：zeny 固定、不上排行榜、暱稱 GM 保留
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
  if (p.gm && p.zeny !== GMZ) { p.zeny = GMZ; await env.DB.prepare('UPDATE players SET zeny=? WHERE id=?').bind(GMZ, p.id).run(); }
  const { results } = await env.DB.prepare('SELECT code,q,cost FROM holdings WHERE pid=?').bind(p.id).all();
  let mv = 0; const port = {};
  for (const h of results) { const q = await quote(env, h.code); const v = px(q) || h.cost / h.q; mv += h.q * v; port[h.code] = { q: h.q, cost: h.cost, n: q ? q.n : null }; }
  const w = Math.round(p.zeny + mv);
  await env.DB.prepare('UPDATE players SET wealth=?,wts=? WHERE id=?').bind(w, Date.now(), p.id).run();
  return { id: p.id, name: p.name, zeny: Math.round(p.zeny), port, wealth: w, open: marketOpen(), gm: p.gm ? 1 : 0 };
}
let READY = false;
async function ensure(db) {
  if (READY) return;
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS saves(pid INTEGER PRIMARY KEY, data TEXT, ts INTEGER)'),
    db.prepare('CREATE TABLE IF NOT EXISTS recov(hash TEXT PRIMARY KEY, pid INTEGER)'),
    db.prepare('CREATE INDEX IF NOT EXISTS recov_pid ON recov(pid)'),
    db.prepare('CREATE TABLE IF NOT EXISTS promo(code TEXT PRIMARY KEY, zeny INTEGER DEFAULT 0, items TEXT, uses INTEGER DEFAULT 0, used INTEGER DEFAULT 0, exp INTEGER DEFAULT 0, note TEXT, created INTEGER)'),
    db.prepare('CREATE TABLE IF NOT EXISTS redeem(pid INTEGER, code TEXT, ts INTEGER, PRIMARY KEY(pid, code))')
  ]);
  try { await db.prepare('ALTER TABLE players ADD COLUMN seen INTEGER DEFAULT 0').run(); } catch (e) {}
  try { await db.prepare('ALTER TABLE players ADD COLUMN gm INTEGER DEFAULT 0').run(); } catch (e) {}
  READY = true;
}
const RC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const normCode = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
async function sha(t) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('seal:' + t)))].map(x => x.toString(16).padStart(2, '0')).join(''); }
// 在線人數：3 分鐘內有回報的玩家
async function stats(db) {
  const now = Date.now(), day = Date.parse(today() + 'T00:00:00+08:00');
  const r = await db.prepare('SELECT SUM(seen>?) online, SUM(seen>?) today, SUM(created>?) newToday, COUNT(*) total FROM players').bind(now - 180000, day, day).first();
  return { online: r.online || 0, today: r.today || 0, newToday: r.newToday || 0, total: r.total || 0, t: now };
}
// 暱稱：2–12 字、不可空白開頭結尾、不可用 GM、全服不重複（不分大小寫）
function cleanName(n) { return String(n || '').replace(/[\u0000-\u001f<>"'`]/g, '').trim().slice(0, 12); }
async function nameErr(db, n, selfId) {
  if ([...n].length < 2) return '暱稱至少 2 個字';
  if (/^gm$/i.test(n)) return '這個暱稱已保留';
  const hit = await db.prepare('SELECT id FROM players WHERE lower(name)=lower(?) AND id!=? LIMIT 1').bind(n, selfId || 0).first();
  return hit ? '這個暱稱已經有人使用' : null;
}
async function body(req) { try { return await req.json(); } catch (e) { return {}; } }

async function api(req, env, path) {
  const db = env.DB; await ensure(db);
  if (path === '/api/recover' && req.method === 'POST') {
    const b = await body(req), c = normCode(b.code);
    if (c.length !== 12) return J({ error: '引繼碼格式錯誤' }, 400);
    const r = await db.prepare('SELECT pid FROM recov WHERE hash=?').bind(await sha(c)).first();
    if (!r) { await new Promise(ok => setTimeout(ok, 800)); return J({ error: '找不到這組引繼碼' }, 404); }
    const pl = await db.prepare('SELECT * FROM players WHERE id=?').bind(r.pid).first();
    const sv = await db.prepare('SELECT data,ts FROM saves WHERE pid=?').bind(r.pid).first();
    return J({ token: pl.token, save: sv ? sv.data : null, ts: sv ? sv.ts : 0, ...(await wallet(env, pl)) });
  }
  if (path === '/api/reg' && req.method === 'POST') {
    const b = await body(req), tok = [...crypto.getRandomValues(new Uint8Array(24))].map(x => x.toString(16).padStart(2, '0')).join('');
    let name = cleanName(b.name);
    if (name) { const e = await nameErr(db, name); if (e) return J({ error: e, nameTaken: 1 }, 409); }
    else { for (let i = 0; i < 20; i++) { name = '玩家' + Math.floor(1000 + Math.random() * 90000); if (!(await nameErr(db, name))) break; } }
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
  if (path === '/api/stats') return J(await stats(db));
  if (path === '/api/nick') { const n = cleanName(new URL(req.url).searchParams.get('name')); const e = await nameErr(db, n); return J({ ok: !e, error: e }); }
  const p = await auth(req, env);
  if (!p) return J({ error: '未登入' }, 401);
  if (Date.now() - (p.seen || 0) > 30000) await db.prepare('UPDATE players SET seen=? WHERE id=?').bind(Date.now(), p.id).run();
  if (path === '/api/me') return J(await wallet(env, p));
  if (path === '/api/redeem' && req.method === 'POST') {
    const b = await body(req), c = String(b.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const pr = c && await db.prepare('SELECT * FROM promo WHERE code=?').bind(c).first();
    if (!pr) return J({ error: '優惠碼不存在' }, 404);
    if (pr.exp && Date.now() > pr.exp) return J({ error: '優惠碼已過期' }, 400);
    if (pr.uses && pr.used >= pr.uses) return J({ error: '優惠碼已被領完' }, 400);
    if (await db.prepare('SELECT 1 FROM redeem WHERE pid=? AND code=?').bind(p.id, c).first()) return J({ error: '你已經領過這組優惠碼' }, 400);
    const r = await db.prepare('INSERT OR IGNORE INTO redeem(pid,code,ts) VALUES(?,?,?)').bind(p.id, c, Date.now()).run();
    if (!r.meta.changes) return J({ error: '你已經領過這組優惠碼' }, 400);
    await db.batch([db.prepare('UPDATE promo SET used=used+1 WHERE code=?').bind(c), db.prepare('UPDATE players SET zeny=zeny+? WHERE id=?').bind(Math.max(0, pr.zeny || 0), p.id)]);
    const np = await db.prepare('SELECT * FROM players WHERE id=?').bind(p.id).first();
    let items = {}; try { items = JSON.parse(pr.items || '{}'); } catch (e) {}
    return J({ ok: true, code: c, zenyGot: pr.zeny || 0, items, note: pr.note || '', ...(await wallet(env, np)) });
  }
  if (path === '/api/promo') {
    if (!p.gm) return J({ error: '沒有權限' }, 403);
    if (req.method === 'POST') {
      const b = await body(req), c = String(b.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20);
      if (c.length < 4) return J({ error: '優惠碼至少 4 碼（英數）' }, 400);
      if (b.del) { await db.prepare('DELETE FROM promo WHERE code=?').bind(c).run(); return J({ ok: true }); }
      const z = Math.max(0, Math.min(10000000, Math.floor(+b.zeny || 0))), uses = Math.max(0, Math.floor(+b.uses || 0)), days = Math.max(0, +b.days || 0);
      const items = JSON.stringify(b.items && typeof b.items === 'object' ? b.items : {}).slice(0, 2000);
      await db.prepare('INSERT INTO promo(code,zeny,items,uses,used,exp,note,created) VALUES(?,?,?,?,0,?,?,?) ON CONFLICT(code) DO UPDATE SET zeny=excluded.zeny,items=excluded.items,uses=excluded.uses,exp=excluded.exp,note=excluded.note')
        .bind(c, z, items, uses, days ? Date.now() + days * 864e5 : 0, String(b.note || '').slice(0, 40), Date.now()).run();
    }
    const { results } = await db.prepare('SELECT code,zeny,items,uses,used,exp,note FROM promo ORDER BY created DESC LIMIT 50').all();
    return J({ list: results });
  }
  if (path === '/api/save' && req.method === 'POST') {
    const b = await body(req), d = typeof b.data === 'string' ? b.data : '';
    if (!d || d.length > 1800000) return J({ error: '存檔太大或空白' }, 400);
    const ts = Math.min(Date.now(), +b.ts || Date.now());
    await db.prepare('INSERT INTO saves(pid,data,ts) VALUES(?,?,?) ON CONFLICT(pid) DO UPDATE SET data=excluded.data,ts=excluded.ts').bind(p.id, d, ts).run();
    return J({ ok: true, ts });
  }
  if (path === '/api/load') {
    const sv = await db.prepare('SELECT data,ts FROM saves WHERE pid=?').bind(p.id).first();
    return J({ save: sv ? sv.data : null, ts: sv ? sv.ts : 0 });
  }
  if (path === '/api/rcode' && req.method === 'POST') {
    const c = [...crypto.getRandomValues(new Uint8Array(12))].map(x => RC[x % RC.length]).join('');
    await db.batch([db.prepare('DELETE FROM recov WHERE pid=?').bind(p.id), db.prepare('INSERT INTO recov(hash,pid) VALUES(?,?)').bind(await sha(c), p.id)]);
    return J({ code: c.replace(/(.{4})(?=.)/g, '$1-') });
  }
  if (path === '/api/name' && req.method === 'POST') {
    const b = await body(req), n = cleanName(b.name);
    if (!(p.gm && /^gm$/i.test(n))) { const e = await nameErr(db, n, p.id); if (e) return J({ error: e, nameTaken: 1 }, 409); }
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
    const { results } = await db.prepare(`SELECT id,name,sp,lv,rb,wealth FROM players WHERE COALESCE(gm,0)=0 ORDER BY ${order} LIMIT 100`).all();
    const me = type === 'w'
      ? await db.prepare('SELECT COUNT(*) c FROM players WHERE COALESCE(gm,0)=0 AND wealth>?').bind(p.wealth).first()
      : await db.prepare('SELECT COUNT(*) c FROM players WHERE COALESCE(gm,0)=0 AND (rb>? OR (rb=? AND lv>?))').bind(p.rb, p.rb, p.lv).first();
    const tot = await db.prepare('SELECT COUNT(*) c FROM players WHERE COALESCE(gm,0)=0').first();
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
      if (u.pathname === '/stats') { await ensure(env.DB); const s = await stats(env.DB);
        return new Response(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width"><meta http-equiv=refresh content=30><title>封印物語 即時人數</title><body style="font:16px system-ui;background:#1b1730;color:#fff;display:grid;place-items:center;min-height:90vh;margin:0"><div style="text-align:center"><div style="font-size:15px;opacity:.7">封印物語 · 同時在線</div><div style="font:900 88px system-ui;color:#7CFC9A">${s.online}</div><div style="display:flex;gap:28px;justify-content:center;margin-top:8px"><div>今日活躍<br><b style="font-size:26px">${s.today}</b></div><div>今日新玩家<br><b style="font-size:26px">${s.newToday}</b></div><div>總玩家<br><b style="font-size:26px">${s.total}</b></div></div><div style="opacity:.5;font-size:12px;margin-top:14px">每 30 秒自動更新 · ${new Date(s.t + 8 * 3600e3).toISOString().slice(11, 19)}</div></div>`, { headers: { 'content-type': 'text/html; charset=utf-8' } }); }
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
