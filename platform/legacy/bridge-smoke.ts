import {createServer} from 'node:http';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
import {getProfile,playCycle} from '../server/math/index.js';
const out=path.resolve('platform/legacy/dist');
const states:Record<string,any>={};const requests:any[]=[];let exchanges=0;let tier='99';
const session=(game:string)=>states[game]??=( {mode:'platform',sessionId:`fixture_${game}`,epoch:0,stateVersion:0,balance:12000,betChoices:[10,50,100,200,500],mathVersion:getProfile(game,tier).version,pendingRound:null,freeSpins:0,freeMultiplier:0,lockedBet:null,history:[]} );
async function body(req:any){let s='';for await(const chunk of req)s+=chunk;return s?JSON.parse(s):{};}
const server=createServer(async(req,res)=>{try{
 const url=new URL(req.url!,'http://localhost');const json=(value:any,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
 if(url.pathname==='/'){res.writeHead(200,{'content-type':'text/html'});res.end(`<button onclick="window.gameWindow=window.open('/play/thunder')">thunder</button><button onclick="window.gameWindow=window.open('/play/tiger')">tiger</button><script>window.messages=[];addEventListener('message',e=>{if(e.origin===location.origin)messages.push(e.data)});</script>`);return;}
 if(url.pathname==='/v1/launch/exchange'){exchanges++;const b=await body(req);assert.equal(b.launch_code,'fixture_launch_code');assert.equal(typeof b.client_instance_id,'string');return json({access_token:'fixture_token_only'});}
 const api=url.pathname.match(/^\/api\/play\/(thunder|tiger)\/(config|session|spin|ack|history)$/);
 if(api){const [,game,action]=api;requests.push({game,action,bearer:req.headers.authorization});if(req.headers.authorization!=='Bearer fixture_token_only')return json({error:{message:'no token'}},401);
 const s=session(game);
 if(action==='config')return json(getProfile(game,tier));if(action==='session')return json(s);if(action==='history')return json({rounds:s.history});
 const b=await body(req);if(action==='ack'){s.pendingRound=null;return json({session:s});}
 let result;for(let n=0;n<1000;n++){result=playCycle(game,b.bet*100,tier,createHash('sha256').update(`smoke:${n}`).digest('hex'));if(result.grossPayoutMinor===0&&result.rounds.length===1)break;}
 assert(result&&result.grossPayoutMinor===0);const round={id:`round_fixture_${game}`,requestId:b.requestId,epoch:0,bet:b.bet,win:0,balanceBefore:s.balance,balanceAfter:s.balance-b.bet,createdAt:new Date().toISOString(),isFreeSpin:false,freeSpinsBefore:0,freeSpinsAfter:0,engine:result.rounds[0]};s.balance-=b.bet;s.stateVersion++;s.pendingRound=round;s.history.push(round);return json({session:s,round});
 }
 let file;if(url.pathname.startsWith('/play/'))file=path.join(out,url.pathname.endsWith('tiger')?'tiger.html':'thunder.html');else if(url.pathname.startsWith('/legacy/'))file=path.resolve(out,url.pathname.slice('/legacy/'.length));
 if(!file||!file.startsWith(out+path.sep)){res.writeHead(404).end();return;}const data=await readFile(file);const ext=path.extname(file);res.writeHead(200,{'content-type':({'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml'} as any)[ext]||'application/octet-stream'});res.end(data);
 }catch(error){res.writeHead(500,{'content-type':'application/json'}).end(JSON.stringify({error:String(error)}));}});
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${(server.address() as any).port}`;
const browser=await chromium.launch({headless:true,channel:'chrome'});const checks:any[]=[];const errors:string[]=[];
try{
 const context=await browser.newContext({viewport:{width:430,height:932}});const parent=await context.newPage();await parent.goto(origin);
 for(const [game,profile] of [['thunder','99'],['tiger','99'],['thunder','98'],['tiger','98']]){
  tier=profile;delete states[game];
  const popupPromise=parent.waitForEvent('popup');await parent.getByRole('button',{name:game,exact:true}).click();const popup=await popupPromise;
  popup.on('pageerror',error=>errors.push(`${game}: ${error.message}`));const failedAssets:string[]=[];popup.on('response',res=>{if(res.url().includes('/legacy/')&&res.status()>=400)failedAssets.push(res.url());});
  await popup.getByText('正在连接游戏',{exact:true}).waitFor();const before=exchanges;
  await popup.evaluate(()=>window.postMessage({type:'oasis.launch',launch_code:'fixture_launch_code'},location.origin));
  await new Promise(resolve=>setTimeout(resolve,150));assert.equal(exchanges,before,'same-window forged source must not exchange');
  await parent.evaluate(()=>{(window as any).gameWindow.postMessage({type:'oasis.launch',launch_code:'fixture_launch_code'},location.origin);});
  const spin=popup.locator('#spin');await spin.waitFor({state:'visible'});await popup.waitForFunction(()=>!(document.querySelector('#spin') as HTMLButtonElement)?.disabled);
  assert((await popup.locator('.oasis-profile-note').innerText()).includes(`${game}-platform-${profile}-v1`));
  await popup.locator('[data-action="rules"]').first().click();const rules=popup.locator(game==='thunder'?'#panel-content':'#panel-body');const ruleText=await rules.innerText();
  if(game==='thunder'){assert(ruleText.includes('10,000'));assert(ruleText.includes('100 次'));assert(ruleText.includes(`目标 RTP ${profile}%`));assert(ruleText.includes(`${game}-platform-${profile}-v1`));assert(ruleText.includes('非每局中奖概率或认证值'));}
  else {const tigerAward=await rules.locator('.paytable > div > b').first().innerText();assert.equal(tigerAward,profile==='99'?'9.1×':'9.008081×');assert(ruleText.includes('统计验证不是精确理论值或认证'));}
  await popup.screenshot({path:`platform/legacy/${game}-${profile}-rules-smoke.png`,fullPage:true});
  await popup.locator(game==='thunder'?'.panel-close':'[data-action="close"]').click();
  const tokenStored=await popup.evaluate(()=>[...Object.values(localStorage),...Object.values(sessionStorage)].some(v=>v.includes('fixture_token_only')));assert.equal(tokenStored,false);assert.equal(new URL(popup.url()).search,'');
  const reset=await popup.evaluate(async()=>{const r=await fetch(location.pathname.endsWith('tiger')?'/api/tiger/reset':'/api/reset',{method:'POST'});return r.status;});assert.equal(reset,403);
  await popup.locator('[data-action="turbo"]').click();await spin.click();
  const deadline=Date.now()+15000;while(states[game]?.pendingRound&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,100));
  await popup.waitForFunction(()=>!(document.querySelector('#spin') as HTMLButtonElement)?.disabled);assert.equal(states[game].stateVersion,1);assert.equal(states[game].pendingRound,null);assert.equal(states[game].balance,11900);
  assert.equal(failedAssets.length,0);await popup.screenshot({path:`platform/legacy/${game}-${profile}-platform-smoke.png`,fullPage:true});
  tier=profile==='99'?'98':'99';states[game].mathVersion=getProfile(game,tier).version;
  await popup.evaluate(async()=>{await fetch(location.pathname.endsWith('tiger')?'/api/tiger/session':'/api/session');});
  assert((await popup.locator('.oasis-profile-note').innerText()).includes(`${game}-platform-${tier}-v1`));
  await popup.locator('[data-action="rules"]').first().click();
  if(game==='thunder')assert((await rules.innerText()).includes(`目标 RTP ${tier}%`));
  else assert.equal(await rules.locator('.paytable > div > b').first().innerText(),tier==='99'?'9.1×':'9.008081×');
  checks.push({game,profile,authSourceGuard:'PASS',render:'PASS',activeProfileRules:'PASS',profileSwitchRules:'PASS',platformSpinAck:'PASS',resetDisabled:'PASS',tokenMemoryOnly:'PASS',assetFailures:failedAssets,engineFixture:'zero-win complete cycle; mock wallet only'});await popup.close();
 }
 assert.equal(errors.length,0);assert(requests.every(r=>r.bearer==='Bearer fixture_token_only'));
 await writeFile('platform/legacy/smoke-report.json',JSON.stringify({status:'PASS',scope:'Headless Chromium isolated bridge/presentation integration with mock wallet, not real partner acceptance or physical-device QA',checks,exchanges,requests,pageErrors:errors},null,2)+'\n');console.log(JSON.stringify({status:'PASS',checks,requests:requests.length},null,2));
}finally{await browser.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
