// Local sandbox walkthrough of a casino game: admin launch -> /launch page -> bets -> draw -> screenshots.
// Usage: node scripts/casino-local-e2e.mjs <game> [lang] [outDir]
import {readFileSync,mkdirSync} from 'node:fs';
import {chromium,devices} from 'playwright';
import {ALL_GAME_IDS} from '../shared/games.mjs';
const [game='greedylion',lang='zh',out='/tmp/casino-e2e']=process.argv.slice(2);mkdirSync(out,{recursive:true});
const base='http://127.0.0.1:8795',creds=JSON.parse(readFileSync(new URL('../.local/development-credentials.json',import.meta.url)));
let cookie='';
async function call(path,{method='GET',body}={}){const r=await fetch(base+path,{method,headers:{'content-type':'application/json',origin:base,cookie},body:body&&JSON.stringify(body)});const set=r.headers.get('set-cookie');if(set)cookie=set.split(';')[0];const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(path+' '+r.status+' '+JSON.stringify(j));return j;}
await call('/api/admin/login',{method:'POST',body:{username:creds.username,password:creds.password}});
const app=(await call('/api/admin/apps')).apps.find(a=>a.environment==='sandbox'&&a.status==='active');
if(!app.game_ids.includes(game))await call(`/api/admin/apps/${app.id}`,{method:'PATCH',body:{game_ids:[...app.game_ids.filter(g=>ALL_GAME_IDS.includes(g)),game]}});
const launch=await call(`/api/admin/apps/${app.id}/launch`,{method:'POST',body:{game_id:game,external_user_id:'demo_player'}});
const url=`${base}/launch/index.html?game=${game}&lang=${lang}#code=${launch.launch_code}&session=${launch.session_id}`;
const b=await chromium.launch();const p=await (await b.newContext({...devices['Pixel 7']})).newPage();const errors=[];
p.on('pageerror',e=>errors.push(e.message));p.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
p.on('response',r=>{if(r.status()>=400)errors.push(r.status()+' '+r.url());});
await p.goto(url);await p.waitForTimeout(6000);console.log('early',JSON.stringify(errors.slice(0,8)),await p.evaluate(()=>document.querySelector('iframe')?.src));await p.screenshot({path:`${out}/1-lobby.png`});
const f=p.frameLocator('iframe');
if(game==='rocketstar2'){
 await f.locator('.rs-main.bet >> nth=0').click().catch(e=>errors.push('bet '+e.message.split('\n')[0]));await p.waitForTimeout(800);await p.screenshot({path:`${out}/2-bets.png`});
 await f.locator('.rs-flying').waitFor({timeout:20000}).catch(()=>{});await p.waitForTimeout(2500);await p.screenshot({path:`${out}/3-flying.png`});
 await f.locator('.rs-main.cash').click({timeout:3000,force:true}).catch(e=>errors.push('cash '+e.message.split('\n')[0]));await p.waitForTimeout(600);await p.screenshot({path:`${out}/4-cashed.png`});
 await f.locator('.rs-crashed').waitFor({timeout:90000}).catch(()=>{});await p.waitForTimeout(800);await p.screenshot({path:`${out}/5-crashed.png`});
 console.log(JSON.stringify({errors:errors.slice(0,8)}));await b.close();process.exit(0);
}
if(game==='olympus'){
 await f.locator('.ol-spin').waitFor({timeout:15000});await p.screenshot({path:`${out}/2-idle.png`});
 for(let i=0;i<4;i++){await f.locator('.ol-spin').click().catch(e=>errors.push('spin '+e.message.split('\n')[0]));await p.waitForTimeout(1500);await p.screenshot({path:`${out}/3-spin${i}.png`});
  await f.locator('.ol-spin:not(.busy)').waitFor({timeout:60000}).catch(()=>{});await p.waitForTimeout(300);}
 await p.screenshot({path:`${out}/4-after.png`});
 await f.locator('.ol-round >> nth=1').click();await f.locator('.ol-autos button >> nth=0').click();await p.waitForTimeout(4000);await p.screenshot({path:`${out}/5-auto.png`});
 await f.locator('.ol-spin').click();await f.locator('.ol-spin:not(.busy)').waitFor({timeout:90000}).catch(()=>{});
 await f.locator('.ol-buy').click();await f.locator('.ol-autos button >> nth=0').click();await p.waitForTimeout(5000);await p.screenshot({path:`${out}/6-buy.png`});
 await f.locator('.ol-spin:not(.busy)').waitFor({timeout:120000}).catch(()=>{});await p.screenshot({path:`${out}/7-after-buy.png`});
 console.log(JSON.stringify({errors:errors.slice(0,8)}));await b.close();process.exit(0);
}
if(game==='teenpatti'){
 for(const i of [0,2])await f.locator(`.tp-zone >> nth=${i}`).click().catch(e=>errors.push('zone '+e.message.split('\n')[0]));
 await p.waitForTimeout(1200);await p.screenshot({path:`${out}/2-bets.png`});
 await f.locator('.tp-drawing').waitFor({timeout:30000}).catch(()=>{});await p.waitForTimeout(3200);await p.screenshot({path:`${out}/3-drawing.png`});
 await f.locator('.tp-result').waitFor({timeout:20000}).catch(()=>{});await p.waitForTimeout(1000);await p.screenshot({path:`${out}/4-result.png`});
 console.log(JSON.stringify({errors:errors.slice(0,8)}));await b.close();process.exit(0);
}
for(const sel of ['.gl-plate >> nth=0','.gl-plate >> nth=7','.gl-plate >> nth=3'])await f.locator(sel).click().catch(e=>errors.push('click '+e.message.split('\n')[0]));
await p.waitForTimeout(1500);await p.screenshot({path:`${out}/2-bets.png`});
const deadline=Date.now()+40000;let shots=0;
while(Date.now()<deadline&&shots<3){const cls=await f.locator('.cs-stage').getAttribute('class');if(cls.includes('gl-drawing')&&shots===0){await p.waitForTimeout(2500);await p.screenshot({path:`${out}/3-drawing.png`});shots=1;}
 if(cls.includes('gl-result')&&shots<2){await p.waitForTimeout(1200);await p.screenshot({path:`${out}/4-result.png`});shots=2;break;}await p.waitForTimeout(300);}
console.log(JSON.stringify({errors:errors.slice(0,8),shots}));await b.close();
