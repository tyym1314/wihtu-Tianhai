import fs from 'node:fs';
import {chromium} from 'playwright';
import {legalMoves} from '../arena/match/engine.mjs';
const base='http://127.0.0.1:8795',out=new URL('../review/phase-c/',import.meta.url).pathname;
const credentials=JSON.parse(fs.readFileSync(new URL('../.local/development-credentials.json',import.meta.url)));
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--autoplay-policy=no-user-gesture-required']});
const report={at:new Date().toISOString(),checks:[],errors:[],failedAssets:[],games:[]};
const context=await browser.newContext({viewport:{width:1440,height:1000},permissions:['clipboard-read','clipboard-write']});
const host=await context.newPage();let apps,app;
const assert=(v,m)=>{if(!v)throw Error(m);};
function track(page){page.on('pageerror',e=>report.errors.push(e.message));page.on('response',r=>{if(r.status()>=400&&/\.(png|css|js)(\?|$)/.test(r.url()))report.failedAssets.push({url:r.url(),status:r.status()});});}
track(host);
async function launch(game,user){await host.locator('.sandbox-launcher select').last().selectOption(game);await host.getByLabel('测试用户 ID',{exact:true}).fill(user);const popupPromise=host.waitForEvent('popup');await host.getByRole('button',{name:'打开沙箱游戏',exact:true}).click();const page=await popupPromise;track(page);await page.setViewportSize({width:390,height:844});const state={page,room:null,actions:[]};page.on('response',async r=>{if(r.url().includes('/api/pvp/rooms')&&r.status()<300){try{const data=await r.json();if(data?.id&&(!state.room||data.id!==state.room.id||data.version>=state.room.version))state.room=data;if(r.request().method()==='POST'&&r.url().endsWith('/action'))state.actions.push(data);}catch{}}});await page.locator('.lobby-settings').waitFor({timeout:25000});await host.getByRole('button',{name:'打开沙箱游戏',exact:true}).waitFor({state:'visible'});await host.waitForFunction(()=>!document.querySelector('.sandbox-launcher .button-primary').disabled);return state;}
async function snapshot(state,name){await state.page.screenshot({path:out+name+'.png',fullPage:true});assert(await state.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),name+' horizontal overflow');}
async function waitRoom(s,status){const until=Date.now()+20000;while(Date.now()<until){if(s.room?.status===status)return s.room;await s.page.waitForTimeout(250);}throw Error('room status timeout '+status+' actual '+s.room?.status);}
try{
 const login=await context.request.post(base+'/api/admin/login',{data:credentials,headers:{origin:base}});assert(login.ok(),'admin login');
 await host.goto(base+'/#/partners');await host.locator('.sandbox-launcher').waitFor();apps=(await (await context.request.get(base+'/api/admin/apps')).json()).apps;app=apps.find(a=>a.name==='QA UI')||apps[0];await host.locator('.portal-app-card').filter({hasText:app.name}).click();
 for(const game of ['match','golf']){
 const names={match:'三消对战',golf:'绿洲高尔夫'};const toggle=host.getByRole('switch',{name:names[game]+' 游戏授权',exact:true});if(await toggle.getAttribute('aria-checked')!=='true'){await toggle.click();await host.waitForFunction(()=>!document.querySelector('.portal-game-card button:disabled'));}
 const one=await launch(game,'demo_player'),two=await launch(game,'demo_player_2');
 await snapshot(one,game+'-lobby-390');await one.page.getByRole('button',{name:'创建好友房',exact:false}).click();await waitRoom(one,'waiting');
 await two.page.getByLabel('房间码',{exact:true}).fill(one.room.code);await two.page.getByRole('button',{name:'加入房间',exact:true}).click();await waitRoom(two,'waiting');await snapshot(one,game+'-room-390');
 await one.page.getByRole('button',{name:'确认规则 · 准备开局',exact:true}).click();await two.page.getByRole('button',{name:'确认规则 · 准备开局',exact:true}).click();await waitRoom(one,'active');await waitRoom(two,'active');
 if(game==='match'){
 await one.page.locator('.match-board').waitFor();await one.page.waitForTimeout(900);await snapshot(one,'match-active-390');
 const move=legalMoves(one.room.game.board)[0];assert(move,'No valid initial move');
 await one.page.locator(`[data-cell="${move.from}"]`).click();await one.page.locator(`[data-cell="${move.to}"]`).click();
 const until=Date.now()+10000;while(!one.actions.length&&Date.now()<until)await one.page.waitForTimeout(100);assert(one.actions.length,'No accepted match UI swap');await one.page.waitForTimeout(1200);assert(one.room.game.score>0,'match score did not advance');await snapshot(one,'match-after-move-390');
 // Let the real 90-second server clock run, while both independent tabs keep their own heartbeat.
 const deadline=Date.now()+100000;while(one.room.status!=='settled'&&Date.now()<deadline){await one.page.waitForTimeout(1000);}
 await waitRoom(one,'settled');await waitRoom(two,'settled');assert(one.room.result?.resolution==='completed','match unexpectedly voided');report.checks.push('Match: two real users, UI legal swap, real 90-second game, confirmed wallet settlement');
 }else{
 await one.page.locator('.og-canvas canvas').waitFor();await one.page.waitForTimeout(1700);await snapshot(one,'golf-active-390');assert(await one.page.locator('.og-canvas canvas').evaluate(c=>!!(c.getContext('webgl2')||c.getContext('webgl'))),'Golf WebGL unavailable');
 await one.page.getByTestId('golf-shoot').click();const until=Date.now()+10000;while(!one.actions.length&&Date.now()<until)await one.page.waitForTimeout(100);assert(one.actions.length,'No accepted golf UI shot');await one.page.waitForTimeout(1800);await snapshot(one,'golf-ball-moving-390');
 await two.page.getByRole('button',{name:'返回房间',exact:true}).click();await two.page.getByRole('button',{name:'确认离开',exact:true}).click();await waitRoom(one,'settled');await waitRoom(two,'settled');assert(one.room.players.find(p=>p.external_user_id==='demo_player').payout_minor==='19000','Golf winner payout not 190');report.checks.push('Golf: true WebGL, actual UI shot, opponent explicit forfeit, one confirmed 190 coin payout');
 }
 await snapshot(one,game+'-result-390');report.games.push({game,room_id:one.room.id,status:one.room.status,result:one.room.result,actions:one.actions.length});await one.page.close();await two.page.close();
 }
 await host.goto(base+'/#/partners');await host.screenshot({path:out+'platform-partners.png',fullPage:true});
 assert(report.errors.length===0,'Browser errors '+report.errors.join(';'));assert(report.failedAssets.length===0,'asset failures');report.checks.push('390px layouts have no horizontal overflow, zero page errors and asset failures');
}catch(e){report.failure=e.stack;try{await host.screenshot({path:out+'failure-host.png'});}catch{}throw e;}
finally{fs.writeFileSync(out+'ui-validation.json',JSON.stringify(report,null,2));await browser.close();}
console.log(JSON.stringify({checks:report.checks,games:report.games.map(g=>({game:g.game,id:g.room_id,status:g.status})),errors:report.errors}));
