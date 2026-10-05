import fs from 'node:fs';
import {chromium} from 'playwright';
const base='http://127.0.0.1:8795',out=new URL('../review/phase-d/',import.meta.url).pathname;
fs.mkdirSync(out+'videos',{recursive:true});
const credentials=JSON.parse(fs.readFileSync(new URL('../.local/development-credentials.json',import.meta.url)));
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const ctx=await browser.newContext({viewport:{width:1440,height:1000},recordVideo:{dir:out+'videos/raw',size:{width:390,height:844}}}),host=await ctx.newPage();
const report={at:new Date().toISOString(),checks:[],games:[],teams:[],errors:[],failedAssets:[]},open=[];
const assert=(v,m)=>{if(!v)throw Error(m);};
await ctx.addInitScript(()=>{const Native=window.AudioContext||window.webkitAudioContext;if(Native)window.AudioContext=class extends Native{constructor(...args){super(...args);window.__qaAudio=this;this.__qaCount=0;}createGain(){const g=super.createGain();if(!this.__qaMaster){this.__qaMaster=g;this.__qaAnalyser=this.createAnalyser();g.connect(this.__qaAnalyser);}return g;}createOscillator(){this.__qaCount++;return super.createOscillator();}};});
async function waitFor(fn,label,ms=20000){const until=Date.now()+ms;while(Date.now()<until){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error('Timeout: '+label);}
function track(page){page.on('pageerror',e=>report.errors.push(e.message));page.on('response',r=>{if(r.status()>=400&&/\.(png|css|js)(\?|$)/.test(r.url()))report.failedAssets.push({url:r.url(),status:r.status()});});}
track(host);
async function launch(game,user){
 await host.locator('.sandbox-launcher select').last().selectOption(game);await host.getByLabel('测试用户 ID',{exact:true}).fill(user);
 const promise=host.waitForEvent('popup');await host.getByRole('button',{name:'打开沙箱游戏',exact:true}).click();const page=await promise;await page.setViewportSize({width:390,height:844});track(page);
 const s={game,page,room:null,actions:[],requests:[]};open.push(s);page.on('response',async r=>{if(r.url().includes('/api/pvp/rooms')&&r.status()<300)try{const d=await r.json();if(d.id&&(!s.room||d.id!==s.room.id||d.version>=s.room.version))s.room=d;if(r.request().method()==='POST'&&r.url().endsWith('/action')){s.actions.push(d);s.requests.push(r.request().postDataJSON().action);}}catch{}});
 await page.locator('.lobby-settings').waitFor({timeout:25000});await host.waitForFunction(()=>!document.querySelector('.sandbox-launcher .button-primary').disabled);return s;
}
const selector={carrom:'.oc-game',darts:'.da-scene',ludo:'.ludo-scene',jackaroo:'.jack-scene',domino:'.do-scene'};
async function shot(s){const p=s.page,g=s.room?.game;if(!g||s.room.status!=='active')return false;
 if(s.game==='carrom'){const b=p.getByTestId('carrom-shoot');if(await b.isEnabled()){await b.click();return true;}}
 if(s.game==='darts'&&g.turnKey===s.room.me&&Date.now()>g.busyUntil+100){const b=await p.locator('.da-board').boundingBox(),x=b.x+b.width/2,y=b.y+b.height*.43;await p.mouse.move(x,y+35);await p.mouse.down();for(let i=1;i<=6;i++){await p.mouse.move(x,y+35-i*4);await p.waitForTimeout(35);}await p.mouse.up();return true;}
 if(s.game==='ludo'){if(await p.locator('.ludo-dice').isEnabled()){await p.locator('.ludo-dice').click();return true;}const action=g.legalActions?.find(a=>a.type==='move');if(action){const pawn=p.locator(`[data-pawn="${s.room.me}:${action.piece}"]`);if(await pawn.getAttribute('aria-disabled')==='false'){await pawn.click();await p.locator('.ludo-move-button').click();return true;}}}
 if(s.game==='jackaroo')return await jackarooAction(s);
 if(s.game==='domino')return await dominoAction(s);
 return false;
}
async function jackarooAction(s){const p=s.page,g=s.room.game;if(Date.now()<g.busyUntil+120)return false;const legal=g.legalActions||[],action=legal.find(a=>a.type==='pass')||legal.find(a=>a.type==='play'&&a.effect!=='split'&&a.effect!=='swap')||legal.find(a=>a.type==='discard')||legal[0];if(!action)return false;
 const card=p.locator(`[data-card="${action.cardId}"]`);if(!await card.isEnabled())return false;await card.click();
 if(action.type==='play'){const effect=action.effect==='move'?'move:'+action.steps:action.effect;await p.locator(`[data-effect="${effect}"]`).click();
  if(action.effect==='split'){for(const part of action.segments){await p.locator(`[data-marble="${part.pieceId}"]`).click();await p.locator(`[data-split-step="${part.steps}"]`).click();}}
  else{await p.locator(`[data-marble="${action.pieceId}"]`).click();if(action.effect==='swap')await p.locator(`[data-marble="${action.targetId}"]`).click();}
 }
 const confirm=p.locator('[data-action="jack-confirm"]');if(await confirm.isEnabled()){await confirm.click();return true;}return false;
}
async function dominoAction(s){const p=s.page,g=s.room.game;if(g.turnKey!==s.room.me||Date.now()<g.busyUntil+120)return false;const action=g.legalMoves?.[0];if(action){const tile=p.getByTestId('domino-tile-'+action.tileId);if(!await tile.isEnabled())return false;await tile.click();await p.getByTestId('domino-'+action.end).click();return true;}const type=g.canDraw?'draw':g.canPass?'pass':null;if(type){await p.getByTestId('domino-'+type).click();return true;}return false;}
async function leave(s){if(!s.room||['settled','voided','cancelled'].includes(s.room.status))return;const exit=s.page.locator('header button').first();await exit.click();await s.page.getByRole('button',{name:'确认离开',exact:true}).click();await waitFor(()=>['settled','voided','cancelled'].includes(s.room?.status),'exit '+s.game);}
async function screenshot(s,name){assert(await s.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),name+' horizontal overflow');await s.page.screenshot({path:out+name+'.png',fullPage:true});}
try{
 assert((await ctx.request.post(base+'/api/admin/login',{data:credentials,headers:{origin:base}})).ok(),'admin login');
 const apps=(await(await ctx.request.get(base+'/api/admin/apps')).json()).apps,app=apps.find(a=>a.name==='QA UI');assert(app,'QA App missing');assert(app.game_ids.length===9,'Phase D migration did not enable default app');
 await host.goto(base+'/#/partners');await host.locator('.sandbox-launcher').waitFor();await host.locator('.portal-app-card').filter({hasText:app.name}).click();
 for(const game of (process.env.OASIS_QA_GAMES||'carrom,darts,ludo,jackaroo,domino').split(',')){
  const s=await launch(game,'demo_player_3'),p=s.page;await screenshot(s,game+'-lobby-390');const balance=await p.locator('.arena-footer>span').innerText();
  if(game==='carrom')await p.getByRole('button',{name:'4 人',exact:true}).click();await p.getByRole('button',{name:'免费练习',exact:false}).click();await waitFor(()=>s.room?.status==='waiting','practice waiting');await screenshot(s,game+'-waiting-390');await p.getByRole('button',{name:'确认规则 · 准备开局',exact:true}).click();await waitFor(()=>s.room?.status==='active','practice active');await p.locator(selector[game]).waitFor();
  const minUntil=Date.now()+(game==='domino'?5000:15000),until=Date.now()+(game==='jackaroo'?90000:45000);while(s.room.status==='active'&&Date.now()<until&&(Date.now()<minUntil||s.actions.length<2||game==='ludo'&&!s.requests.some(a=>a.type==='move')||game==='jackaroo'&&!s.requests.some(a=>a.type==='play'))){await shot(s);await p.waitForTimeout(600);}
  assert(s.actions.length>0,game+' no real UI action accepted');if(game==='ludo')assert(s.requests.some(a=>a.type==='move'),'Ludo pawn never moved');if(game==='jackaroo')assert(s.requests.some(a=>a.type==='play'),'Jackaroo marble never played');
  for(const width of [360,390,430]){await p.setViewportSize({width,height:width===360?800:width===390?844:932});await p.waitForTimeout(180);await screenshot(s,game+'-active-'+width);}
  await p.waitForTimeout(300);const sound=await p.evaluate(()=>{const c=window.__qaAudio,a=new Float32Array(c.__qaAnalyser.fftSize);c.__qaAnalyser.getFloatTimeDomainData(a);return{state:c.state,tones:c.__qaCount,rms:Math.sqrt(a.reduce((sum,v)=>sum+v*v,0)/a.length)};});assert(sound.state==='running'&&sound.rms>0,game+' audio signal missing');
  const toggle=p.locator('header button').last();await toggle.click();await p.waitForTimeout(250);const silent=await p.evaluate(()=>{const c=window.__qaAudio,a=new Float32Array(c.__qaAnalyser.fftSize);c.__qaAnalyser.getFloatTimeDomainData(a);return Math.sqrt(a.reduce((sum,v)=>sum+v*v,0)/a.length);});assert(silent<.00001,game+' mute not silent');await toggle.click();
  const history=[...s.requests],roomId=s.room.id,beforeExit=s.room.status;await leave(s);
  if(beforeExit==='active')assert(s.room.status==='cancelled','active practice must cancel');
  else assert(s.room.status==='settled'&&s.room.result.resolution==='completed'&&s.room.result.pool_minor==='0'&&s.room.result.fee_minor==='0'&&s.room.result.payouts.every(x=>x.payout_minor==='0'),'naturally completed practice must have zero money');
  await p.getByRole('button',{name:'再来一局',exact:true}).click();await p.locator('.lobby-settings').waitFor();assert(await p.locator('.arena-footer>span').innerText()===balance,'practice altered wallet');
  report.games.push({game,roomId,acceptedActions:history,sound,silentRms:silent,exit:s.room.status,naturalCompletion:beforeExit==='settled',balanceUnchanged:true,video:game+'-motion.webm'});await p.close();await p.video().saveAs(out+'videos/'+game+'-motion.webm');await p.video().delete();console.log(game+' browser QA passed');
 }
 if(!process.env.OASIS_QA_GAMES||process.env.OASIS_QA_TEAMS==='1')for(const game of ['carrom','jackaroo']){
  const seats=[];for(const user of ['demo_player','demo_player_2','demo_player_3','demo_player_4'])seats.push(await launch(game,user));
  const leader=seats[0];if(game==='carrom')await leader.page.getByRole('button',{name:'4 人',exact:true}).click();await leader.page.getByRole('button',{name:'创建好友房',exact:false}).click();await waitFor(()=>leader.room?.status==='waiting','paid create');
  for(const s of seats.slice(1)){await s.page.getByLabel('房间码',{exact:true}).fill(leader.room.code);await s.page.getByRole('button',{name:'加入房间',exact:true}).click();await waitFor(()=>s.room?.status==='waiting','paid join');}
  await screenshot(leader,game+'-paid-team-390');assert((await leader.page.locator('.ready-card').innerText()).includes('全队弃权'),'team forfeiture missing before payment');
  for(const s of seats)await s.page.getByRole('button',{name:'确认规则 · 准备开局',exact:true}).click();for(const s of seats)await waitFor(()=>s.room?.status==='active','four active');
  for(const s of seats)await s.page.locator(selector[game]).waitFor();
  if(game==='jackaroo'){for(const s of seats){await waitFor(()=>s.room?.game?.legalActions?.some(a=>a.type==='pass'),'paid pass available');await shot(s);}await waitFor(()=>seats.every(s=>s.room?.game?.phase==='play'),'all secret passes');}
  const actor=seats.find(s=>s.room.me===leader.room.game.turnKey);assert(actor,'paid current actor');await shot(actor);await waitFor(()=>actor.requests.some(a=>a.type==='shot'||a.type==='play'||a.type==='discard'),'paid real game input');await leader.page.waitForTimeout(350);await screenshot(leader,game+'-paid-active-390');await leave(seats[1]);await waitFor(()=>leader.room?.status==='settled','team settlement');assert(leader.room.players.find(p=>p.external_user_id==='demo_player').payout_minor==='19000','team winner1 payout');assert(leader.room.players.find(p=>p.external_user_id==='demo_player_3').payout_minor==='19000','team winner2 payout');assert(leader.room.result.fee_minor==='2000','team fee');await screenshot(leader,game+'-paid-result-390');report.teams.push({game,roomId:leader.room.id,status:leader.room.status,feeMinor:leader.room.result.fee_minor,payouts:leader.room.result.payouts,actions:seats.map(s=>({user:s.room.me,actions:s.requests}))});for(const s of seats){await s.page.close();await s.page.video().delete();}console.log(game+' four-real-user team QA passed');
 }
 await host.goto(base+'/#/games');await host.screenshot({path:out+'platform-games.png',fullPage:true});await host.goto(base+'/#/partners');await host.screenshot({path:out+'platform-partners.png',fullPage:true});
 assert(!report.errors.length,'Browser errors: '+report.errors.join(';'));assert(!report.failedAssets.length,'Failed assets');report.checks.push('Real mobile UI actions reach authoritative service; free practice preserves balance; 360/390/430 widths; audio signal and mute verified');
}catch(e){report.failure=e.stack;for(const s of open)if(!s.page.isClosed())try{await s.page.screenshot({path:out+s.game+'-failure.png',fullPage:true});await leave(s);}catch{}throw e;}
finally{fs.writeFileSync(out+'ui-validation'+(process.env.OASIS_QA_GAMES?'-partial':'')+'.json',JSON.stringify(report,null,2));await ctx.close();for(const page of [host,...open.map(s=>s.page)])try{await page.video()?.delete();}catch{}await browser.close();}
console.log(JSON.stringify({games:report.games.map(g=>g.game),teams:report.teams,checks:report.checks,errors:report.errors}));
