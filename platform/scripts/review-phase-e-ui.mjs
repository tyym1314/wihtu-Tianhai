import fs from 'node:fs';
import {chromium} from 'playwright';
const base=process.env.OASIS_REVIEW_BASE||'http://127.0.0.1:8795',out=new URL('../review/phase-e/',import.meta.url).pathname;
fs.mkdirSync(out+'videos',{recursive:true});
const credentials=JSON.parse(fs.readFileSync(new URL('../.local/development-credentials.json',import.meta.url)));
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const ctx=await browser.newContext({viewport:{width:1440,height:1000},recordVideo:{dir:out+'videos/raw',size:{width:390,height:844}}}),host=await ctx.newPage();
const report={at:new Date().toISOString(),games:[],multiplayer:[],errors:[],failedAssets:[]},open=[];
const assert=(v,m)=>{if(!v)throw Error(m);};
const RUN_INPUTS=['left','right','jump','slide'];
function observeRunInputs(s,room){
 if(s.game!=='run'||!room?.game)return;
 const mine=room.game.players?.find(p=>p.key===room.me);if(!mine)return;
 for(const receipt of s.runReceipts){
  if(receipt.roomId!==room.id||s.runEvidence.some(e=>e.roomId===room.id&&e.inputNo===receipt.inputNo))continue;
  const event=room.game.events?.find(e=>e.playerKey===room.me&&e.inputNo===receipt.inputNo&&e.type===receipt.type);
  // Applied input numbers and retained events survive the short jump/slide animation.
  if(mine.appliedInputNo>=receipt.inputNo&&event&&event.tick>receipt.acceptedSnapshotTick){
   s.runEvidence.push({...receipt,eventId:event.id,appliedTick:event.tick,observedTick:room.game.snapshotTick,appliedInputNo:mine.appliedInputNo,position:{lane:mine.lane,x:mine.x,y:mine.y,distance:mine.distance},changeStartTick:mine.changeStartTick,jumpStartTick:mine.jumpStartTick,slideUntilTick:mine.slideUntilTick});
  }
 }
}
const missingRunInputs=s=>RUN_INPUTS.filter(type=>!s.runEvidence.some(e=>e.roomId===s.room?.id&&e.type===type));
function frozenTerms(room){
 const pool=BigInt(room.entry_minor)*BigInt(room.capacity),fee=pool*BigInt(room.fee_bps)/10000n,prize=pool-fee;
 assert(pool.toString()===room.pool_minor,'room pool differs from frozen entry and capacity');
 assert(prize.toString()===room.prize_minor,'room prize differs from frozen fee');
 return{entryMinor:room.entry_minor,feeBps:room.fee_bps,capacity:room.capacity,poolMinor:pool.toString(),feeMinor:fee.toString(),prizeMinor:prize.toString()};
}
function verifySettlement(room,terms,winner){
 const current=frozenTerms(room);assert(JSON.stringify(current)===JSON.stringify(terms),'room terms changed after funding');
 const result=room.result;assert(result.fee_minor===terms.feeMinor,'service fee differs from frozen terms');
 assert(result.pool_minor===terms.poolMinor,'settlement pool differs from frozen terms');
 assert(result.payouts.length===room.players.length&&new Set(result.payouts.map(p=>p.external_user_id)).size===room.players.length,'settlement must cover each participant exactly once');
 let paid=0n;for(const row of result.payouts){assert(room.players.some(p=>p.external_user_id===row.external_user_id),'unknown payout participant');const amount=BigInt(row.payout_minor);assert(amount>=0n,'negative payout');paid+=amount;}
 assert(paid+BigInt(result.fee_minor)===BigInt(terms.poolMinor),'payouts plus fee must conserve the captured pool');
 assert(result.payouts.find(p=>p.external_user_id===winner)?.payout_minor===terms.prizeMinor,'last remaining player did not receive the frozen prize');
 assert(room.players.find(p=>p.external_user_id===winner)?.payout_minor===terms.prizeMinor,'public winner payout differs from settlement');
}
await ctx.addInitScript(()=>{const Native=window.AudioContext||window.webkitAudioContext;if(Native)window.AudioContext=class extends Native{constructor(...args){super(...args);window.__qaAudio=this;this.__qaCount=0;}createGain(){const g=super.createGain();if(!this.__qaMaster){this.__qaMaster=g;this.__qaAnalyser=this.createAnalyser();g.connect(this.__qaAnalyser);}return g;}createOscillator(){this.__qaCount++;return super.createOscillator();}};});
async function waitFor(fn,label,ms=25000){const until=Date.now()+ms;while(Date.now()<until){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error('Timeout: '+label);}
function track(page){page.on('pageerror',e=>report.errors.push(e.message));page.on('response',r=>{if(r.status()>=400&&/\.(png|webp|css|js)(\?|$)/.test(r.url()))report.failedAssets.push({url:r.url(),status:r.status()});});}
track(host);
async function launch(game,user){
 await host.locator('.sandbox-launcher select').last().selectOption(game);await host.getByLabel('测试用户 ID',{exact:true}).fill(user);
 const promise=host.waitForEvent('popup');await host.getByRole('button',{name:'打开沙箱游戏',exact:true}).click();const page=await promise;await page.setViewportSize({width:390,height:844});track(page);
 const s={game,page,room:null,actions:[],requests:[],payloadBytes:[],responseMs:[],runReceipts:[],runEvidence:[]};open.push(s);page.on('response',async r=>{if(r.url().includes('/api/pvp/rooms')&&r.status()<300)try{
  const text=await r.text(),d=JSON.parse(text);s.payloadBytes.push(Buffer.byteLength(text));if(d.id&&(!s.room||d.id!==s.room.id||d.version>=s.room.version))s.room=d;
  if(r.request().method()==='POST'&&r.url().endsWith('/action')){
   const action=r.request().postDataJSON().action;s.actions.push(d);s.requests.push(action);const timing=r.request().timing();s.responseMs.push(timing.responseEnd);
   if(game==='run'&&RUN_INPUTS.includes(action.type)){const mine=d.game?.players?.find(p=>p.key===d.me);if(Number.isSafeInteger(mine?.inputNo)&&!s.runReceipts.some(v=>v.roomId===d.id&&v.inputNo===mine.inputNo))s.runReceipts.push({roomId:d.id,type:action.type,inputNo:mine.inputNo,acceptedSnapshotTick:d.game.snapshotTick});}
  }
  observeRunInputs(s,d);observeRunInputs(s,s.room);
 }catch{}});
 await page.locator('.lobby-settings').waitFor({timeout:25000});await host.waitForFunction(()=>!document.querySelector('.sandbox-launcher .button-primary').disabled);return s;
}
const board={pool:'pool-board',bowling:'bowling-roll',run:'run-track'};
async function interact(s){if(s.room?.status!=='active')return false;const p=s.page;
 if(s.game==='pool'){
  const g=s.room.game,b=p.getByTestId('pool-shoot');
  if(g.turnKey===s.room.me&&g.phase==='aiming'&&g.ballInHand&&!g.cuePlaced){
   const point=[[-1,2],[1,2],[0,4],[-2,4],[2,4],[0,0]].find(([x,y])=>g.balls.every(q=>q.n===0||q.pocketed||Math.hypot(q.x-x,q.y-y)>.5));
   if(point){const r=await p.getByTestId('pool-board').boundingBox();await p.mouse.click(r.x+r.width*(.5+point[0]/8.1),r.y+r.height*(.5+point[1]/14.8));return true;}
  }
  if(g.turnKey===s.room.me&&g.eightEligible&&g.calledPocket===null){const r=await p.getByTestId('pool-board').boundingBox();await p.mouse.click(r.x+r.width*.1025,r.y+r.height*.0628);return true;}
  if(await b.isEnabled()){await b.click();return true;}
 }
 if(s.game==='bowling'){const b=p.getByTestId('bowling-roll');if(await b.isEnabled()){await b.click();return true;}}
 if(s.game==='run'){const steps=['run-left','run-right','run-jump','run-slide','run-item'],id=steps[(s.actionCursor=(s.actionCursor??-1)+1)%steps.length],b=p.getByTestId(id);if(await b.isEnabled()){await b.click();return true;}const fallback=p.getByTestId('run-right');if(await fallback.isEnabled()){await fallback.click();return true;}}
 return false;
}
async function leave(s){if(!s.room||['settled','voided','cancelled'].includes(s.room.status))return;await s.page.locator('header button').first().click();await s.page.getByRole('button',{name:'确认离开',exact:true}).click();await waitFor(()=>s.room?.practice?['cancelled','settled','voided'].includes(s.room?.status):s.room?.players.some(p=>p.external_user_id===s.room.me&&p.forfeited)||['settled','voided','cancelled'].includes(s.room?.status),'leave '+s.game);}
async function shot(s,name){assert(await s.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),name+' horizontal overflow');await s.page.screenshot({path:out+name+'.png',fullPage:true});}
async function sound(s){const p=s.page;await p.waitForTimeout(350);const signal=await p.evaluate(()=>{const c=window.__qaAudio,a=new Float32Array(c.__qaAnalyser.fftSize);c.__qaAnalyser.getFloatTimeDomainData(a);return{state:c.state,tones:c.__qaCount,rms:Math.sqrt(a.reduce((sum,v)=>sum+v*v,0)/a.length)};});assert(signal.state==='running'&&signal.rms>0,s.game+' missing audio');const toggle=p.locator('header button').last();await toggle.click();await p.waitForTimeout(250);const silent=await p.evaluate(()=>{const c=window.__qaAudio,a=new Float32Array(c.__qaAnalyser.fftSize);c.__qaAnalyser.getFloatTimeDomainData(a);return Math.sqrt(a.reduce((sum,v)=>sum+v*v,0)/a.length);});assert(silent<.00001,s.game+' mute failed');await toggle.click();return{...signal,silentRms:silent};}
try{
 assert((await ctx.request.post(base+'/api/admin/login',{data:credentials,headers:{origin:base}})).ok(),'admin login');
 const apps=(await(await ctx.request.get(base+'/api/admin/apps')).json()).apps,qaApps=apps.filter(a=>a.name==='QA UI');assert(qaApps.length===1,'Create exactly one dedicated sandbox App named QA UI before running this review (see specs/phase-e-local-integration.md)');const app=qaApps[0];
 const expectedGames=['thunder','tiger','match','golf','carrom','darts','ludo','jackaroo','domino','pool','bowling','run'];assert(app.status==='active'&&app.environment==='sandbox'&&app.game_ids.length===12&&expectedGames.every(id=>app.game_ids.includes(id)),'QA UI must be active in sandbox with all 12 games enabled after the Phase E migration');
 await host.goto(base+'/#/partners');await host.locator('.sandbox-launcher').waitFor();await host.locator('.portal-app-card').filter({hasText:app.name}).click();
 for(const game of (process.env.OASIS_QA_GAMES||'pool,bowling,run').split(',')){
  const s=await launch(game,'demo_player_3'),p=s.page;await shot(s,game+'-lobby-390');const balance=await p.locator('.arena-footer>span').innerText();
  if(game!=='pool')await p.getByRole('button',{name:'4 人',exact:true}).click();await p.getByRole('button',{name:'免费练习',exact:false}).click();await waitFor(()=>s.room?.status==='waiting','practice wait');await p.getByRole('button',{name:'确认规则 · 准备开局',exact:true}).click();await waitFor(()=>s.room?.status==='active','practice start');await p.getByTestId(board[game]).waitFor();
  const until=Date.now()+45000,minUntil=Date.now()+14000;while(s.room.status==='active'&&Date.now()<until&&(Date.now()<minUntil||s.actions.length<2||game==='run'&&missingRunInputs(s).length)){await interact(s);await p.waitForTimeout(game==='run'?750:600);}
  assert(s.actions.length>0,game+' no actual input accepted');if(game==='run')assert(!missingRunInputs(s).length,'Run inputs missing authoritative applied sequence + event evidence: '+missingRunInputs(s).join(', '));
  const webgl=game==='pool'?null:await p.locator('canvas').first().evaluate(c=>!!(c.getContext('webgl2')||c.getContext('webgl')));if(game!=='pool')assert(webgl,game+' missing WebGL');
  for(const width of [360,390,430]){await p.setViewportSize({width,height:width===360?800:width===390?844:932});await p.waitForTimeout(200);if(game==='run')await waitFor(()=>{const me=s.room?.game?.players?.find(v=>v.key===s.room.me);return me?.fallUntilTick===null&&me.speed>0;},'runner recovered for preview',8000);await shot(s,game+'-active-'+width);}
  const audio=await sound(s),roomId=s.room.id,actions=[...s.requests];await leave(s);assert(s.room.status==='cancelled','practice should cancel');await p.getByRole('button',{name:'再来一局',exact:true}).click();await p.locator('.lobby-settings').waitFor();assert(await p.locator('.arena-footer>span').innerText()===balance,'practice changed wallet');
  report.games.push({game,roomId,acceptedActions:actions,...(game==='run'?{appliedInputs:s.runEvidence}:{}),audio,webgl,maxResponseBytes:Math.max(...s.payloadBytes),balanceUnchanged:true,exit:s.room.status});await p.close();await p.video().saveAs(out+'videos/'+game+'-motion.webm');await p.video().delete();console.log(game+' mobile practice passed');
 }
 if(!process.env.OASIS_QA_GAMES||process.env.OASIS_QA_MULTIPLAYER==='1')for(const [game,count]of [['pool',2],['bowling',3],['run',4]]){
  const seats=[];for(const user of ['demo_player','demo_player_2','demo_player_3','demo_player_4'].slice(0,count))seats.push(await launch(game,user));
  const leader=seats[0];if(count!==2)await leader.page.getByRole('button',{name:count+' 人',exact:true}).click();await leader.page.getByRole('button',{name:'创建好友房',exact:false}).click();await waitFor(()=>leader.room?.status==='waiting','paid create');
  for(const s of seats.slice(1)){await s.page.getByLabel('房间码',{exact:true}).fill(leader.room.code);await s.page.getByRole('button',{name:'加入房间',exact:true}).click();await waitFor(()=>s.room?.status==='waiting','paid join');}
  await shot(leader,game+'-paid-waiting-390');for(const s of seats)await s.page.getByRole('button',{name:'确认规则 · 准备开局',exact:true}).click();for(const s of seats){await waitFor(()=>s.room?.status==='active','paid active');await s.page.getByTestId(board[game]).waitFor();}
  const terms=frozenTerms(leader.room),actor=game==='pool'?seats.find(s=>s.room.me===leader.room.game.turnKey):leader;assert(actor,'paid actor');await waitFor(()=>interact(actor),'perform paid input');await waitFor(()=>actor.actions.length>0,'paid action accepted');
  if(game==='run'){const until=Date.now()+45000;while(actor.room.status==='active'&&missingRunInputs(actor).length&&Date.now()<until){await interact(actor);await actor.page.waitForTimeout(750);}assert(!missingRunInputs(actor).length,'Paid Run inputs missing authoritative evidence: '+missingRunInputs(actor).join(', '));}
  await leader.page.waitForTimeout(600);await shot(leader,game+'-paid-active-390');
  for(const s of seats.slice(1))await leave(s);await waitFor(()=>leader.room?.status==='settled','paid settlement');verifySettlement(leader.room,terms,'demo_player');await shot(leader,game+'-paid-result-390');
  report.multiplayer.push({game,roomId:leader.room.id,count,status:leader.room.status,frozenTerms:terms,feeMinor:terms.feeMinor,payouts:leader.room.result.payouts,conserved:true,actions:seats.map(s=>({user:s.room.me,acceptedActions:s.requests,...(game==='run'?{appliedInputs:s.runEvidence}:{})}))});for(const s of seats){await s.page.close();await s.page.video().delete();}console.log(game+' '+count+' real-user settlement passed');
 }
 assert(!report.errors.length,'Page errors: '+report.errors.join(';'));assert(!report.failedAssets.length,'Failed assets');
}catch(e){report.failure=e.stack;for(const s of open)if(!s.page.isClosed())try{await s.page.screenshot({path:out+s.game+'-failure.png',fullPage:true});await leave(s);}catch{}throw e;}
finally{fs.writeFileSync(out+'ui-validation'+(process.env.OASIS_QA_GAMES?'-partial':'')+'.json',JSON.stringify(report,null,2));await ctx.close();for(const p of [host,...open.map(s=>s.page)])try{await p.video()?.delete();}catch{}await browser.close();}
console.log(JSON.stringify(report));
