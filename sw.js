const C='seal-v52',F=['./','index.html','lib/three.min.js','lib/GLTFLoader.js','lib/BufferGeometryUtils.js','manifest.json','icon-192.png','icon-512.png','apple-touch-icon.png','art/species.webp','art/sky.webp','art/equip.webp','art/cut.webp','art/comic.webp','art/hands.webp','art/home.webp','art/battle.webp','art/plaza.webp','art/wood.webp','art/bubble.webp','art/dock.webp','art/sky3d.jpg','art/logo.webp','art/ui_buddy.webp','art/ui_shop.webp','art/ui_arena.webp','art/ui_rank.webp','art/ui_music.webp','art/ui_coin.webp','art/field.webp','art/frame.webp','art/frame_rank.webp','art/frame_shop.webp','art/frame_arena.webp','art/act_feed.webp','art/act_train.webp','art/act_praise.webp','art/act_punish.webp','art/act_equip.webp','art/act_info.webp','art/food.webp','art/medals.webp','art/t_list.webp','art/t_cr.webp','art/t_shop.webp','art/t_arena.webp','art/t_rank.webp','art/t_stock.webp'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(F)));self.skipWaiting()});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))));self.clients.claim()});
// 頁面：網路優先（2.5 秒逾時改用快取）；靜態資源：快取優先、背景更新；伺服器 API 與第三方不經手
const put=(q,r)=>{if(r&&r.ok){const cp=r.clone();caches.open(C).then(c=>c.put(q,cp)).catch(()=>{})}return r};
self.addEventListener('fetch',e=>{const q=e.request;if(q.method!=='GET')return;const u=new URL(q.url);
 if(u.origin===location.origin){
  if(q.mode==='navigate'||/\/(index\.html)?$/.test(u.pathname)||u.pathname.endsWith('sw.js')){e.respondWith(new Promise(res=>{let done=false;const t=setTimeout(()=>caches.match(q,{ignoreSearch:true}).then(m=>{if(m&&!done){done=true;res(m)}}),2500);
   fetch(q).then(r=>{clearTimeout(t);put(q,r);if(!done){done=true;res(r)}}).catch(()=>caches.match(q,{ignoreSearch:true}).then(m=>{if(!done){done=true;res(m||Response.error())}}))}));return}
  e.respondWith(caches.match(q).then(m=>{const net=fetch(q).then(r=>put(q,r)).catch(()=>m);return m||net}));return}
 if(/fonts\.(googleapis|gstatic)\.com|cdn\.jsdelivr\.net/.test(u.host))e.respondWith(caches.match(q).then(m=>m||fetch(q).then(r=>put(q,r))));
});
