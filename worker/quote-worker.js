// 結印物語 台股即時報價代理（Cloudflare Worker）
// 部署後把網址填進 index.html 最上面的 QUOTE_API，例如 https://seal-quote.<你的帳號>.workers.dev
// /q?ids=2330,2603  → 即時成交價（來源：臺灣證券交易所基本市況報導網站）
// /k?id=2330        → 當日一分鐘走勢（來源：Yahoo Finance，可能延遲）
const H={'access-control-allow-origin':'*','content-type':'application/json; charset=utf-8','cache-control':'max-age=3'};
const num=x=>{const n=parseFloat(x);return isFinite(n)?n:null};
export default{async fetch(req){const u=new URL(req.url);
 try{
  if(u.pathname==='/q'){
   const ids=(u.searchParams.get('ids')||'').toUpperCase().split(',').filter(x=>/^[0-9A-Z]{4,6}$/.test(x)).slice(0,40);
   const ch=ids.flatMap(i=>['tse_'+i+'.tw','otc_'+i+'.tw']).join('|');
   const r=await fetch('https://mis.twse.com.tw/stock/api/getStockInfo.jsp?json=1&delay=0&ex_ch='+encodeURIComponent(ch),{headers:{'user-agent':'Mozilla/5.0','referer':'https://mis.twse.com.tw/stock/fibest.jsp'}});
   const j=await r.json(),o={};
   for(const m of j.msgArray||[]){let z=num(m.z);if(z==null)z=num((m.b||'').split('_')[0])||num((m.a||'').split('_')[0])||num(m.y);
    o[m.c]={n:m.n,z,y:num(m.y),o:num(m.o),h:num(m.h),l:num(m.l),v:num(m.v),t:m.t}}
   return new Response(JSON.stringify(o),{headers:H})}
  if(u.pathname==='/k'){
   const id=(u.searchParams.get('id')||'').toUpperCase();if(!/^[0-9A-Z]{4,6}$/.test(id))return new Response('{}',{headers:H});
   for(const sfx of ['.TW','.TWO']){
    const r=await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${id}${sfx}?interval=1m&range=1d`,{headers:{'user-agent':'Mozilla/5.0'}});
    if(!r.ok)continue;const j=await r.json(),res=j.chart&&j.chart.result&&j.chart.result[0];
    if(res&&res.timestamp)return new Response(JSON.stringify({t:res.timestamp,c:res.indicators.quote[0].close,pc:res.meta.chartPreviousClose}),{headers:{...H,'cache-control':'max-age=30'}})}
   return new Response('{}',{headers:H})}
 }catch(e){return new Response(JSON.stringify({error:String(e)}),{status:502,headers:H})}
 return new Response(JSON.stringify({ok:true,use:'/q?ids=2330  /k?id=2330'}),{headers:H})}};
