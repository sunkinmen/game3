// 封印物語 台股報價代理（Google Apps Script 網頁應用程式）— 來源：富果 Fugle MarketData API
// 金鑰存在「專案設定 → 指令碼屬性」FUGLE_KEY，不寫在程式裡。
// ?ids=2330,2603 → {代號:{n,z,y,o,h,l,v,t}}　?k=2330 → {t,c,pc} 當日 1 分 K
// 全體玩家共用快取：盤中每檔 15 秒、盤後 10 分鐘才向富果查一次。
const API = 'https://api.fugle.tw/marketdata/v1.0/stock';
function key_() { return PropertiesService.getScriptProperties().getProperty('FUGLE_KEY'); }
function open_() { const t = new Date(Date.now() + 8 * 3600e3), d = t.getUTCDay(), m = t.getUTCHours() * 60 + t.getUTCMinutes(); return d >= 1 && d <= 5 && m >= 535 && m <= 815; }
function out_(s) { return ContentService.createTextOutput(typeof s === 'string' ? s : JSON.stringify(s)).setMimeType(ContentService.MimeType.JSON); }
const ok_ = x => /^[0-9A-Z]{4,6}$/.test(x);

function doGet(e) {
  const p = (e && e.parameter) || {};
  try {
    if (p.k) {
      const id = String(p.k).toUpperCase(); if (!ok_(id)) return out_({});
      const C = CacheService.getScriptCache(), ck = 'k_' + id, hit = C.get(ck); if (hit) return out_(hit);
      const r = UrlFetchApp.fetch(API + '/intraday/candles/' + id + '?timeframe=1', { headers: { 'X-API-KEY': key_() }, muteHttpExceptions: true });
      if (r.getResponseCode() !== 200) return out_({ error: r.getResponseCode() });
      const d = JSON.parse(r.getContentText()).data || [], q = quotes_([id])[id];
      const s = JSON.stringify({ t: d.map(x => Math.floor(new Date(x.date).getTime() / 1000)), c: d.map(x => x.close), pc: q ? q.y : null });
      if (s.length < 90000) C.put(ck, s, open_() ? 60 : 900);
      return out_(s);
    }
    const ids = [...new Set(String(p.ids || '').toUpperCase().split(',').filter(ok_))].slice(0, 20);
    if (!ids.length) return out_({ ok: true, use: '?ids=2330  ?k=2330' });
    return out_(quotes_(ids));
  } catch (err) { return out_({ error: String(err) }); }
}

function quotes_(ids) {
  const C = CacheService.getScriptCache(), got = C.getAll(ids.map(i => 'q_' + i)), o = {}, need = [];
  ids.forEach(i => { const v = got['q_' + i]; if (v) o[i] = JSON.parse(v); else need.push(i); });
  if (need.length) {
    const k = key_(), put = {};
    const rs = UrlFetchApp.fetchAll(need.map(i => ({ url: API + '/intraday/quote/' + i, headers: { 'X-API-KEY': k }, muteHttpExceptions: true })));
    rs.forEach((r, j) => {
      if (r.getResponseCode() !== 200) return;
      const q = JSON.parse(r.getContentText()), n = v => (v === undefined ? null : v);
      const v = { n: q.name, z: n(q.closePrice != null ? q.closePrice : q.lastPrice), y: n(q.previousClose != null ? q.previousClose : q.referencePrice),
        o: n(q.openPrice), h: n(q.highPrice), l: n(q.lowPrice), v: q.total ? q.total.tradeVolume : null, t: q.lastUpdated ? Math.floor(q.lastUpdated / 1000) : Date.now() };
      o[need[j]] = v; put['q_' + need[j]] = JSON.stringify(v);
    });
    if (Object.keys(put).length) C.putAll(put, open_() ? 15 : 600);
  }
  return o;
}

function test() { Logger.log(JSON.stringify(quotes_(['2330', '2603']))); }
