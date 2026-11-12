// 封印物語 台股即時報價代理（Google Apps Script 網頁應用程式）
// 部署：部署 → 新增部署作業 → 網頁應用程式 → 執行身分「我」、存取權「所有人」
function doGet(e){
  var p=(e&&e.parameter)||{},out={};
  try{
    if(p.ids){
      var ids=String(p.ids).toUpperCase().split(',').filter(function(x){return /^[0-9A-Z]{4,6}$/.test(x)}).slice(0,40);
      var key='q_'+ids.join('_'),cache=CacheService.getScriptCache(),hit=cache.get(key);
      if(hit)return ContentService.createTextOutput(hit).setMimeType(ContentService.MimeType.JSON);
      var ch=[];ids.forEach(function(i){ch.push('tse_'+i+'.tw');ch.push('otc_'+i+'.tw')});
      var r=UrlFetchApp.fetch('https://mis.twse.com.tw/stock/api/getStockInfo.jsp?json=1&delay=0&ex_ch='+encodeURIComponent(ch.join('|')),{muteHttpExceptions:true});
      var j=JSON.parse(r.getContentText());
      var num=function(x){var n=parseFloat(x);return isFinite(n)?n:null};
      (j.msgArray||[]).forEach(function(m){var z=num(m.z);if(z==null)z=num((m.b||'').split('_')[0])||num((m.a||'').split('_')[0])||num(m.y);out[m.c]={n:m.n,z:z,y:num(m.y),o:num(m.o),h:num(m.h),l:num(m.l),v:num(m.v),t:m.t}});
      cache.put(key,JSON.stringify(out),3);
    }
  }catch(err){out={error:String(err)}}
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}
