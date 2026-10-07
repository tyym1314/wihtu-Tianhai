/** Android WebView smoke on an explicitly selected USB or remote device. Own test APK and sandbox wallets only. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {basename} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {chromium} from 'playwright';
import {RELEASED_IDS} from '../shared/games.mjs';
import {playOneArenaAction} from './android-game-actions.mjs';
const run=promisify(execFile),serial=process.env.OASIS_ANDROID_SERIAL||'46dcfd25';
const origin='https://game.tianyahuyu.com',pkg='com.tianyahuyu.oasis.smoke',port=19220;
const remoteDevice=process.env.OASIS_ANDROID_ALLOW_REMOTE==='1';
const expectedApkVersion=JSON.parse(await fs.readFile(new URL('../public/downloads/android-smoke-build.json',import.meta.url),'utf8')).version;
const catalog=RELEASED_IDS;
const selected=process.env.OASIS_ANDROID_GAMES?process.env.OASIS_ANDROID_GAMES.split(','):catalog;
assert.ok(selected.length&&selected.every(g=>catalog.includes(g))&&new Set(selected).size===selected.length);
const lifecycle=process.env.OASIS_ANDROID_LIFECYCLE!=='0';
const out=new URL('../review/android/',import.meta.url);await fs.mkdir(out,{recursive:true});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const adb=async(...args)=>(await run('adb',['-s',serial,...args],{timeout:45000,maxBuffer:4*1024*1024})).stdout.trim();
async function deployedRelease(){
 const {stdout}=await run('ssh',['-i','/Users/tyym/Downloads/server-rsa(2).pem','-o','BatchMode=yes','root@43.98.202.236','cat /opt/oasis/private/last-release.json'],{timeout:30000,maxBuffer:16384});
 const state=JSON.parse(stdout),version=basename(state.current||'');
 assert.match(version,/^[A-Za-z0-9_-]{1,64}$/);assert.equal(state.health,'passed');
 if(process.env.OASIS_ANDROID_RELEASE)assert.equal(version,process.env.OASIS_ANDROID_RELEASE,'Unexpected deployed release');
 return{version,activated_at:state.activated_at};
}
const until=async(fn,label,timeout=45000)=>{const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await sleep(120);}throw Error('Timeout: '+label);};
const report={started_at:new Date().toISOString(),origin,requested_games:selected,full_catalog:selected.length===catalog.length,scope:remoteDevice?'Remote Android WebView native game buttons and fullscreen single-game flow; not physical USB proof. Existing sandbox/test wallets.':'Physical USB Android native game buttons and fullscreen single-game WebView; existing sandbox/test wallets.',physical_device:!remoteDevice,mock_app_service:true,network_origins:[],external_asset_origins:[],games:[],lifecycle:{},negative_checks:[],page_errors:[],asset_failures:[],expected_network_failures:[],passed:false};
let browser,context,page,current,cdp,injectingOffline=false;
const tokens=new Map(),tasks=new Set();
function watch(p){
 p.on('request',request=>{
  try{
   const url=new URL(request.url());
   if(url.protocol==='http:'||url.protocol==='https:'){
    const origins=report.network_origins;
    if(!origins.includes(url.origin))origins.push(url.origin);
    if(url.origin!==origin){
     // These two origins are browser-hosted font assets referenced by the
     // retained visual themes; they are static assets, never App/game APIs.
     if(['https://fonts.googleapis.com','https://fonts.gstatic.com'].includes(url.origin)){
      if(!report.external_asset_origins.includes(url.origin))report.external_asset_origins.push(url.origin);
      if(url.pathname.startsWith('/api/'))report.page_errors.push('External asset origin used for API: '+url.origin+url.pathname);
     }else report.page_errors.push('Unexpected network origin: '+url.origin);
    }
   }
  }catch{}
 });
 p.on('pageerror',e=>{(injectingOffline?report.expected_network_failures:report.page_errors).push(e.message.slice(0,500));});
 p.on('response',response=>{
  const subject=current;
  const task=(async()=>{try{
   const u=new URL(response.url());if(u.origin!==origin)return;
   if(response.status()>=400&&/\.(?:mjs|js|css|webp|png|glb|wasm|mp3|ogg)$/.test(u.pathname))report.asset_failures.push({path:u.pathname,status:response.status()});
   if(u.pathname==='/v1/launch/exchange'&&response.ok()){
    const d=await response.json();tokens.set(d.game_id,d.access_token);if(subject?.game===d.game_id){subject.session_id=d.session_id;subject.guest=d.external_user_id;}
   }
   if(!subject)return;
   if(u.pathname.startsWith('/api/pvp/rooms')&&response.request().method()==='POST'&&u.pathname.endsWith('/action')&&!response.ok()){
    const d=await response.json();subject.action_rejections??=[];subject.action_rejections.push({status:response.status(),code:d.error?.code});
   }
   if(u.pathname.startsWith('/api/pvp/rooms')&&response.ok()){
    const d=await response.json();if(d.id&&d.game_id===subject.game&&(!subject.room||subject.room.id!==d.id||d.version>=subject.room.version)){subject.room=d;subject.lastRoomResponseAt=Date.now();}
   }
   if(u.pathname===`/api/play/${subject.game}/spin`&&response.ok()){
    const d=await response.json();subject.spins.push({round_id:d.round.id,cycle_id:d.round.cycleId,status:d.round.settlementStatus,request_status:response.status()});
   }
   if(u.pathname===`/api/play/${subject.game}/ack`&&response.ok()){
    const body=response.request().postDataJSON(),d=await response.json();
    const record={round_id:body.roundId,request_status:response.status(),pending_cleared:d.session?.pendingRound===null,session_matches:d.session?.sessionId===subject.session_id};
    subject.ack_records.push(record);if(record.pending_cleared&&record.session_matches)subject.acks++;
   }
  }catch(e){if(!/No data found|No resource with given|navigated away|Target.*closed|body.*unavailable/i.test(e.message))report.page_errors.push('Observer: '+e.message.slice(0,400));}})();
  tasks.add(task);task.finally(()=>tasks.delete(task));
 });
}
async function connect(){
 await until(async()=>/^[0-9]+$/.test(await adb('shell','pidof',pkg).catch(()=>'')),'APK process');
 const pid=await adb('shell','pidof',pkg);
 await until(async()=>(await adb('shell','cat','/proc/net/unix')).includes('@webview_devtools_remote_'+pid),'WebView debug socket');
 await adb('forward',`tcp:${port}`,`localabstract:webview_devtools_remote_${pid}`);
 browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`,{isWebView:true,noDefaults:true});context=browser.contexts()[0];
 await until(()=>context.pages().length>0,'native WebView page');page=context.pages()[0];page.setDefaultTimeout(45000);watch(page);
 cdp=await context.newCDPSession(page);
 return page;
}
async function nativeTap(locator){
 await locator.scrollIntoViewIfNeeded();const b=await locator.boundingBox();assert.ok(b);
 const targets=await fetch(`http://127.0.0.1:${port}/json/list`).then(r=>r.json());
 const target=targets.find(t=>t.url===page.url());assert.ok(target);const box=JSON.parse(target.description);
 const viewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio}));
 assert.ok(Math.abs(box.width/viewport.width-viewport.dpr)<.1,'Unexpected WebView scale');
 const x=Math.round(box.screenX+(b.x+b.width/2)*viewport.dpr),y=Math.round(box.screenY+(b.y+b.height/2)*viewport.dpr);
 assert.ok(x>=box.screenX&&x<box.screenX+box.width&&y>=box.screenY&&y<box.screenY+box.height,'Tap outside WebView');
 await adb('shell','input','tap',String(x),String(y));
}
async function nativeXml(){
 // Android 16 occasionally kills the uiautomator shell after it has already
 // written a usable dump (exit 137). Treat that as a transient read and
 // retry instead of aborting the WebView test before the native lobby can be
 // observed.
 for(let attempt=0;attempt<5;attempt++){
  try{
   await adb('shell','uiautomator','dump','/data/local/tmp/oasis-smoke-ui.xml');
   return await adb('shell','cat','/data/local/tmp/oasis-smoke-ui.xml');
  }catch(error){
   if(attempt===4)throw error;
   await sleep(450);
  }
 }
 throw new Error('Native UI dump unavailable');
}
async function lobby(){
 await until(async()=>{const xml=await nativeXml();return xml.includes('content-desc="game:')&&!xml.includes('class="android.webkit.WebView"');},'native lobby without WebView');
}
async function nativeGameTap(game){
 let xml=await nativeXml();
 for(let attempt=0;attempt<8;attempt++){
  const node=xml.match(new RegExp('<node\\b[^>]*content-desc="game:'+game+'"[^>]*>'))?.[0];
  const b=node?.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
  if(b&&+b[4]- +b[2]>=120){await adb('shell','input','tap',String(Math.round((+b[1]+ +b[3])/2)),String(Math.round((+b[2]+ +b[4])/2)));return;}
  const size=await adb('shell','wm','size'),m=size.match(/(?:Override|Physical) size: (\d+)x(\d+)/);assert.ok(m);
  await adb('shell','input','swipe',String(Math.round(+m[1]*.5)),String(Math.round(+m[2]*.75)),String(Math.round(+m[1]*.5)),String(Math.round(+m[2]*.3)),'350');
  xml=await nativeXml();
 }
 throw Error('Native game button not found: '+game);
}
async function openGame(game){
 current={game,spins:[],acks:0,ack_records:[]};
 // A card click first tears down the native lobby and then creates the
 // WebView. Android 16 can occasionally return the lobby XML during the
 // click transition; retry the native tap only while the WebView is absent.
 let webViewCreated=false;
 for(let attempt=0;attempt<3&&!webViewCreated;attempt++){
  const xml=await nativeXml();
  if(xml.includes('class="android.webkit.WebView"')){webViewCreated=true;break;}
  await nativeGameTap(game);
  try{await until(async()=>{const next=await nativeXml();return next.includes('class="android.webkit.WebView"');},'native WebView creation '+game,5000);webViewCreated=true;}catch{await sleep(500);}
 }
 assert(webViewCreated,'native WebView creation '+game);
 await connect();
 await until(()=>page.url()===origin+'/demo/native/'+game,'native single-game host');
 // Reload only the newly opened test game so CDP observes the whole launch
 // exchange rather than attaching after the native navigation already began.
 current={game,spins:[],acks:0,ack_records:[]};await page.reload();
 await until(()=>!!current.session_id,'launch exchange '+game);
 await until(()=>page.frames().some(f=>f.url()===origin+'/play/'+game),'single-game iframe');
 assert.equal(await page.locator('iframe').count(),1);assert.equal(await page.locator('button[data-game]').count(),0,'Web lobby must not exist inside the APK');
 const frame=page.frames().find(f=>f.url()===origin+'/play/'+game);assert.ok(frame);return frame;
}
async function startPractice(frame){
 const settings=frame.locator('.lobby-settings');
 // Launch exchange can restore a durable active room left by an interrupted
 // device run.  In that case the lobby controls are intentionally absent;
 // continue against the recovered room instead of waiting 45s for controls
 // that cannot appear.
 if(!await settings.isVisible().catch(()=>false)){
  if(current?.room?.status==='active')return;
  await settings.waitFor();
 }
 await frame.getByRole('button',{name:'免费练习',exact:false}).click();
 await frame.getByRole('button',{name:'确认规则 · 准备开局',exact:true}).click();
 await until(()=>current.room?.status==='active','practice active');
 await frame.locator('.arena-loading').waitFor({state:'hidden'});await sleep(600);
}
async function back(frame){
 await adb('shell','input','keyevent','4');
 await sleep(350);
 const leave=frame.getByRole('button',{name:'确认离开',exact:true});
 if(await leave.isVisible().catch(()=>false))await leave.click();
 const confirm=frame.locator('[data-return="confirm"]');if(await confirm.isVisible().catch(()=>false))await confirm.click();
 await lobby();await browser?.close();browser=null;page=null;context=null;cdp=null;
 // Let the Activity finish destroying the previous WebView before the next
 // native card is tapped. This is a device lifecycle barrier, not a game
 // retry or an API wait.
 await sleep(500);
}
async function frameSample(frame){
 return frame.evaluate(()=>new Promise(resolve=>{
  const start=performance.now(),gaps=[];let last=start;
  function tick(now){gaps.push(now-last);last=now;if(now-start<1800)requestAnimationFrame(tick);else{gaps.sort((a,b)=>a-b);resolve({scope:'WebView requestAnimationFrame cadence only; not a full GPU/FPS acceptance',callbacks:gaps.length,duration_ms:Math.round(now-start),p95_gap_ms:Math.round(gaps[Math.ceil(gaps.length*.95)-1]*100)/100});}}
  requestAnimationFrame(tick);
 }));
}
// Run's authoritative engine can enter a short hit/fall recovery window
// between the WebView's enabled-button check and the POST reaching the API.
// A rejected BUSY/STALE_INPUT request has no sequence effect, so wait for a
// newer public snapshot and let the real UI choose a fresh action.  This is a
// bounded recovery of a rejected request, never a replay of an accepted one.
async function arenaAction(frame,game){
 const retryable=new Set(['BUSY','STALE_INPUT','INPUT_PENDING','RATE_LIMIT']);
 for(let attempt=0;attempt<4;attempt++){
  try{return await playOneArenaAction(frame,game,()=>current.room);}
  catch(error){
   if(game!=='run'||error.status!==409||!retryable.has(error.code)||attempt===3)throw error;
   const failedTick=Number(current.room?.game?.snapshotTick??-1);
   await until(async()=>{
    const room=current.room,mine=room?.game?.players?.find(p=>p.key===room.me);
    if(!room||room.status!=='active'||!mine||Number(room.game?.snapshotTick??-1)<=failedTick)return false;
    const next=Number(room.game.snapshotTick)+1;
    const recovered=mine.fallUntilTick===null&&next>=Number(mine.stunUntilTick||0)&&next>=Number(mine.slideUntilTick||0)&&next>=Number(mine.jumpStartTick??-Infinity)+48;
    return recovered&&await frame.locator('[data-testid="run-scene"][data-input-ready="true"]').count()>0&&await frame.locator('[data-testid="run-jump"]').isEnabled().catch(()=>false);
   },`run recovery after ${error.code}`,10000);
  }
 }
 throw new Error('run action retry loop exhausted');
}
try{
 const releaseBefore=await deployedRelease();report.tested_release=releaseBefore.version;
 const devices=(await run('adb',['devices','-l'])).stdout;assert.ok(devices.split('\n').some(line=>line.startsWith(serial+' ')&&line.includes(' device')&&(remoteDevice||line.includes('usb:'))),remoteDevice?'Expected explicitly selected remote device':'Expected explicitly selected USB device');
 report.device={model:await adb('shell','getprop','ro.product.model'),android:await adb('shell','getprop','ro.build.version.release'),api:await adb('shell','getprop','ro.build.version.sdk')};
 // A previous failed smoke run may have left the APK on a single-game page;
 // start each independent report from the native card lobby.
 await adb('shell','am','force-stop',pkg);await sleep(400);await adb('shell','am','start','-n',pkg+'/.MainActivity');await lobby();report.native_lobby_without_webview=true;
 await run('adb',['-s',serial,'exec-out','screencap','-p'],{encoding:'buffer',maxBuffer:20*1024*1024}).then(r=>fs.writeFile(new URL('lobby-device.png',out),r.stdout));
  {
  const frame=await openGame('match');await frame.locator('.lobby-settings').waitFor();
  await frame.getByRole('button',{name:'返回',exact:true}).click();
  const lobbyLeave=frame.getByRole('button',{name:'确认离开',exact:true});
  if(await lobbyLeave.isVisible().catch(()=>false))await lobbyLeave.click();
  await lobby();
  await browser.close();browser=null;page=null;context=null;cdp=null;report.game_lobby_back_to_native=true;
 }
 for(const game of selected){
  const frame=await openGame(game);let result={game,session_id:current.session_id,guest:current.guest,launch_exchange:true,native_button:true,reloaded_for_network_observation:true};
  report.webview=await page.evaluate(()=>({user_agent:navigator.userAgent,width:innerWidth,height:innerHeight,dpr:devicePixelRatio,secure:isSecureContext}));assert.ok(report.webview.secure&&report.webview.user_agent.includes('OASISSmoke/'+expectedApkVersion));
  if(!['thunder','tiger'].includes(game)){
   await startPractice(frame);result.room_id=current.room.id;result.entry_minor=current.room.entry_minor;assert.equal(result.entry_minor,'0');
   if(game==='carrom'){
    await adb('shell','input','keyevent','4');await frame.getByRole('button',{name:'继续游戏',exact:true}).click();
    await frame.locator('.arena-modal-backdrop').waitFor({state:'hidden'});assert.equal(current.room.id,result.room_id);assert.equal(current.room.status,'active');result.cancel_back_kept_game=true;
   }
   result.action=await arenaAction(frame,game);
   result.render_sample=await frameSample(frame);
  }else{
   await frame.locator('#spin').waitFor();await until(()=>frame.locator('#spin').isEnabled(),'spin enabled');
   if(await frame.locator('[data-action="turbo"]').count())await frame.locator('[data-action="turbo"]').click();
   await nativeTap(frame.locator('#spin'));
   await until(async()=>{const close=frame.locator(game==='tiger'?'#continue':'.celebration-close');if(await close.isVisible())await close.click();return current.acks>0;},'settlement and ACK '+game,120000);
   assert.equal(current.spins[0]?.status,'SETTLED');
   assert.ok(current.spins.every(spin=>current.ack_records.some(ack=>ack.round_id===spin.round_id&&ack.pending_cleared&&ack.session_matches)),'ACK must match each settled round');
   result.spins=current.spins;result.acks=current.acks;result.ack_records=current.ack_records;
  }
  await page.screenshot({path:new URL(`${game}-webview.png`,out).pathname});
  result.viewport=await frame.evaluate(()=>({width:innerWidth,height:innerHeight,scroll_width:document.documentElement.scrollWidth,scroll_height:document.documentElement.scrollHeight,body_height:document.body.scrollHeight}));
  current.layout={viewport:result.viewport,outside:await frame.evaluate(()=>Array.from(document.querySelectorAll('body *')).map(el=>{const r=el.getBoundingClientRect();return{tag:el.tagName,class:typeof el.className==='string'?el.className:'',top:r.top,bottom:r.bottom,height:r.height,font:getComputedStyle(el).font};}).filter(r=>r.height>0&&r.bottom>innerHeight+1).slice(0,45))};
  assert.ok(Math.abs(result.viewport.width-report.webview.width)<=1&&Math.abs(result.viewport.height-report.webview.height)<=1,'Game iframe must fill the entire WebView');
  assert.ok(result.viewport.scroll_width<=result.viewport.width+1,'Game overflows WebView horizontally');
  assert.ok(result.viewport.scroll_height<=result.viewport.height+1&&result.viewport.body_height<=result.viewport.height+1,'Active game does not fit in one screen');
  result.single_screen=true;
  if(['carrom','run','tiger'].includes(game))await run('adb',['-s',serial,'exec-out','screencap','-p'],{encoding:'buffer',maxBuffer:20*1024*1024}).then(r=>fs.writeFile(new URL(`${game}-device.png`,out),r.stdout));
  if(game==='run'){
   result.scene_ready=await frame.locator('[data-testid="run-track"]').evaluate(el=>({...el.dataset}));
   assert.equal(result.scene_ready.ready,'true');assert.equal(result.scene_ready.rendered,'true');
  }
  // The normal full-catalog order starts with tiger, so wait until both
  // probability sessions have been exchanged before checking token scope.
  // This keeps the negative assertion real instead of silently skipping it.
  if((game==='tiger'||game==='thunder')&&tokens.has('thunder')&&tokens.has('tiger')){
   const negative=await page.evaluate(async({thunderToken})=>{
    const a=await fetch('/api/arena/session',{headers:{authorization:'Bearer invalid-test-token'}});
    const b=await fetch('/api/play/tiger/session',{headers:{authorization:'Bearer '+thunderToken}});
    return [{case:'invalid session rejected',status:a.status},{case:'cross-game session rejected',status:b.status}];
   },{thunderToken:tokens.get('thunder')});assert.equal(negative[0].status,401);assert.equal(negative[1].status,403);report.negative_checks=negative;
  }
  await back(frame);result.native_back_returned=true;report.games.push(result);
  await fs.writeFile(new URL('device-smoke-progress.json',out),JSON.stringify(report,null,2));
  console.log(`${game}: native WebView launch / real UI action / API response / Android back passed`);
 }
 // Representative lifecycle checks: same signed guest and durable room survive.
 if(lifecycle){
 let frame=await openGame('match');await startPractice(frame);const original={room:current.room.id,guest:current.guest,session:current.session_id};
 await playOneArenaAction(frame,'match',()=>current.room);
 const before=current.room.version;injectingOffline=true;
 await cdp.send('Network.enable');await cdp.send('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:-1,uploadThroughput:-1});
 await until(()=>frame.locator('.arena-network').isVisible(),'offline UI');await sleep(1800);
 await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});
 await until(async()=>current.room.id===original.room&&current.room.version>before&&!await frame.locator('.arena-network').isVisible(),'network recovery');injectingOffline=false;
 report.lifecycle.network_recovery={same_room:true,mode:'CDP network outage in this WebView only'};
 await adb('shell','input','keyevent','3');await sleep(2200);const resumeAt=Date.now();await adb('shell','am','start','-n',pkg+'/.MainActivity');
 await until(()=>page.evaluate(()=>!document.hidden),'foreground');await until(()=>current.room.id===original.room&&current.room.status==='active'&&current.lastRoomResponseAt>resumeAt,'fresh foreground room response');
 report.lifecycle.background_foreground={same_room:true,fresh_response_after_resume:true};
 await browser.close();browser=null;await adb('shell','am','force-stop',pkg);await sleep(500);await adb('shell','am','start','-n',pkg+'/.MainActivity');
 await lobby();frame=await openGame('match');
 await until(()=>current.room?.id===original.room&&current.room.status==='active','persisted room after process restart');assert.equal(current.guest,original.guest);
 report.lifecycle.process_restart={same_guest:true,same_room:true,new_session:current.session_id!==original.session};
 await playOneArenaAction(frame,'match',()=>current.room);await back(frame);
 }
 await Promise.allSettled([...tasks]);assert.equal(report.games.length,selected.length);assert.deepEqual(report.page_errors,[]);assert.deepEqual(report.asset_failures,[]);
 assert.deepEqual(report.network_origins.filter(value=>value===origin),[origin],'Android game WebView must reach the configured platform origin');
 assert.deepEqual(report.network_origins.filter(value=>value!==origin).sort(),report.external_asset_origins.slice().sort(),'All non-platform requests must be classified static external assets');
 const releaseAfter=await deployedRelease();assert.deepEqual(releaseAfter,releaseBefore,'Deployment changed during device test');
 report.release_verification={before:releaseBefore,after:releaseAfter,unchanged:true};report.passed=true;
}catch(error){
 report.failure=error.stack;report.failed_game=current?.game;report.action_rejections=current?.action_rejections;
 report.failure_action=error.status||error.code||error.responseBody||error.requestBody?{status:error.status||null,code:error.code||null,response_body:error.responseBody||null,request_body:error.requestBody||null}:null;
 report.failure_layout=current?.layout;
 // Response observers consume bodies asynchronously.  Drain them before
 // persisting a failure so rejected action codes are not lost in a race with
 // the harness exception path.
 await Promise.allSettled([...tasks]);
 report.action_rejections=current?.action_rejections;
 console.error(error.message);process.exitCode=1;await page?.screenshot({path:new URL('failure-webview.png',out).pathname}).catch(()=>{});
}
finally{
 if(injectingOffline)await cdp?.send('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1}).catch(()=>{});
 if(current?.room&&!['settled','cancelled','voided'].includes(current.room.status)&&page){
  try{const cleanup=await page.evaluate(async({room,token})=>{const r=await fetch('/api/pvp/rooms/'+room+'/leave',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({request_id:'android_cleanup_'+crypto.randomUUID().replaceAll('-','')})});const b=await r.json();return{status:r.status,room_status:b.status};},{room:current.room.id,token:tokens.get(current.game)});report.cleanup=cleanup;}catch{report.cleanup={status:'unconfirmed'};}
 }
 report.finished_at=new Date().toISOString();await fs.writeFile(new URL('device-smoke.json',out),JSON.stringify(report,null,2));await browser?.close();
}
console.log(JSON.stringify({passed:report.passed,games:report.games.length,lifecycle:report.lifecycle,failure:report.failure?.split('\n')[0]}));
