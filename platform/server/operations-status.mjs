import {readFile} from 'node:fs/promises';
import {basename,isAbsolute,normalize} from 'node:path';
import {runtime} from './runtime-mode.mjs';
import {enginePoolStats} from './pvp/engine-pool.mjs';

async function report(path){try{const raw=await readFile(path,'utf8');if(raw.length>262144)return null;return JSON.parse(raw);}catch{return null;}}
const names=new Set(['database','api','wallet','ingress','demo','systemd','backup','disks','certificate','report_history']);
export function monitorStatusPath(env=process.env,environment=runtime.environment){
 const value=env.OASIS_MONITOR_STATUS_FILE,legacy='/opt/oasis/private/monitor/status.json';
 if(environment==='sandbox')return value||legacy;
 if(environment!=='production'||typeof value!=='string'||!isAbsolute(value)||normalize(value)!==value||value===legacy)return null;
 return value;
}
export function publicMonitorReport(monitor,now=Date.now(),environment='sandbox'){
 if(!monitor||!Array.isArray(monitor.checks)||!['sandbox','production'].includes(environment)||
   (monitor.environment!==environment&&!(environment==='sandbox'&&monitor.environment===undefined)))return {status:'unavailable',checks:[]};
 if(environment==='production'){
  const required=['database','api','wallet','ingress','systemd','backup','disks','certificate'];
  if(required.some(name=>monitor.checks.filter(c=>c?.name===name).length!==1)||
    monitor.checks.some(c=>!c||!names.has(c.name)||!['ok','failed'].includes(c.status))||
    !['ok','failed'].includes(monitor.status)||(monitor.status==='ok'&&monitor.checks.some(c=>c.status!=='ok')))return {status:'unavailable',checks:[]};
 }
 const age=now-Date.parse(monitor.checked_at),stale=!Number.isFinite(age)||age<0||age>180000;
 return {checked_at:Number.isFinite(Date.parse(monitor.checked_at))?new Date(monitor.checked_at).toISOString():null,
  status:stale?'stale':monitor.status==='ok'?'ok':'failed',
  checks:monitor.checks.filter(c=>c&&names.has(c.name)).map(c=>({name:c.name,status:stale?'stale':c.status==='ok'?'ok':'failed',
   codes:Array.isArray(c.codes)?c.codes.filter(code=>typeof code==='string'&&/^[A-Z_]+(?::oasis-[a-z-]+\.(?:service|timer))?$/.test(code)).slice(0,16):[],
   metrics:Object.fromEntries(Object.entries(c.metrics||{}).filter(([k,v])=>/^[A-Za-z_]{1,64}$/.test(k)&&typeof v==='number'&&Number.isFinite(v)&&v>=0))}))};
}
export function publicCapacityReport(capacity,currentVersion){
 if(!capacity||!Number.isInteger(capacity.users)||capacity.users<1||!Number.isInteger(capacity.duration_seconds)||capacity.duration_seconds<1)return null;
 const testedVersion=typeof capacity.tested_version==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(capacity.tested_version)?capacity.tested_version:null;
 const matches=Boolean(testedVersion&&testedVersion===currentVersion);
 return{checked_at:capacity.checked_at,tested_version:testedVersion,matches_current_release:matches,users:capacity.users,duration_seconds:capacity.duration_seconds,
  status:matches&&['passed','failed'].includes(capacity.status)?capacity.status:'unavailable',scope:typeof capacity.scope==='string'?capacity.scope.slice(0,1000):''};
}
const androidActions={carrom:['shot'],match:['swap'],golf:['shot'],towerlink:['link','unlink','stop','upgrade'],darts:['throw'],ludo:['roll','move'],pool:['shot','place','call'],bowling:['roll'],jackaroo:['pass','play','discard'],domino:['play','draw','pass'],run:['jump']};
const androidCatalog=new Set([...Object.keys(androidActions),'thunder','tiger']);
const fullAndroidCatalog=games=>Array.isArray(games)&&games.length===androidCatalog.size&&new Set(games).size===androidCatalog.size&&games.every(game=>androidCatalog.has(game));
const evidenceId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
const httpSuccess=value=>Number.isInteger(value)&&value>=200&&value<300;
function acceptedAndroidGame(game){
 if(!game||!androidCatalog.has(game.game)||game.launch_exchange!==true||game.native_back_returned!==true||!evidenceId(game.session_id))return false;
 if(androidActions[game.game]){
  const action=game.action;
  return Boolean(action&&action.game===game.game&&evidenceId(game.room_id)&&action.roomId===game.room_id&&androidActions[game.game].includes(action.actionType)&&httpSuccess(action.httpStatus)&&Number.isSafeInteger(action.sequenceBefore)&&action.sequenceBefore>=0&&Number.isSafeInteger(action.sequenceAfter)&&action.sequenceAfter===action.sequenceBefore+1);
 }
 return Array.isArray(game.spins)&&game.spins.length>0&&new Set(game.spins.map(spin=>spin?.round_id)).size===game.spins.length&&Array.isArray(game.ack_records)&&game.spins.every(spin=>spin&&spin.status==='SETTLED'&&httpSuccess(spin.request_status)&&evidenceId(spin.round_id)&&evidenceId(spin.cycle_id)&&game.ack_records.some(ack=>ack&&ack.round_id===spin.round_id&&httpSuccess(ack.request_status)&&ack.pending_cleared===true&&ack.session_matches===true));
}
export function publicAndroidReport(device,currentVersion){
 if(!device||typeof device.tested_release!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(device.tested_release))return null;
 const matches=device.tested_release===currentVersion,games=Array.isArray(device.games)?device.games:[];
 const passedGames=new Set(games.filter(acceptedAndroidGame).map(game=>game.game));
 const started=typeof device.started_at==='string'?Date.parse(device.started_at):NaN,finished=typeof device.finished_at==='string'?Date.parse(device.finished_at):NaN;
 const verification=device.release_verification,before=verification?.before,after=verification?.after;
 const releaseVerified=verification?.unchanged===true&&before?.version===device.tested_release&&after?.version===device.tested_release&&typeof before?.activated_at==='string'&&Number.isFinite(Date.parse(before.activated_at))&&before.activated_at===after?.activated_at;
 // Read the original report, not a caller-supplied count or a merged subset.
 const complete=device.passed===true&&releaseVerified&&device.full_catalog===true&&fullAndroidCatalog(device.requested_games)&&fullAndroidCatalog(games.map(game=>game?.game))&&passedGames.size===androidCatalog.size&&Array.isArray(device.page_errors)&&device.page_errors.length===0&&Array.isArray(device.asset_failures)&&device.asset_failures.length===0&&Number.isFinite(started)&&Number.isFinite(finished)&&finished>=started;
 return{tested_release:device.tested_release,checked_at:Number.isFinite(finished)?new Date(finished).toISOString():null,
  status:matches&&complete?'passed':matches?'failed':'unavailable',
  games_passed:passedGames.size,
  model:typeof device.device?.model==='string'?device.device.model.slice(0,80):'',android:typeof device.device?.android==='string'?device.device.android.slice(0,20):'',
  scope:'单台 Android 真机基础接入；不代表全机型、iPhone、完整帧率或真实主钱包验收'};
}
export async function operationsStatus(){
 const [monitor,release,capacity,android]=await Promise.all([
  report(monitorStatusPath()),
  report(process.env.OASIS_RELEASE_STATUS_FILE||'/opt/oasis/private/last-release.json'),
  report(process.env.OASIS_CAPACITY_STATUS_FILE||'/opt/oasis/private/capacity-summary.json'),
  report(process.env.OASIS_ANDROID_STATUS_FILE||'/opt/oasis/private/android-validation.json'),
 ]);
 const androidReport=publicAndroidReport(android,basename(release?.current||''));
 return {environment:runtime.environment,production_admission_enabled:runtime.production&&runtime.admissionEnabled,
  monitor:publicMonitorReport(monitor,Date.now(),runtime.environment),
  release:release?{version:basename(release.current||''),previous:basename(release.previous||''),activated_at:release.activated_at,health:release.health}:null,
  engine_pool:enginePoolStats(),capacity:publicCapacityReport(capacity,basename(release?.current||'')),
  android:androidReport,
  acceptance:{partner_wallet:'awaiting_first_partner',mobile_webview:androidReport?.status==='passed'?'android_basic_passed_ios_pending':'pending_physical_devices',probability_math:'sandbox_only'}};
}
