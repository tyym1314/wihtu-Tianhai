/** Offline association of real draw records with authority. No FRAME gate writes. */
import {createTroopProjection,pointOnRoad} from '../arena/towerlink/troop-presentation.mjs';
import {createTowerClock} from '../arena/towerlink/presentation-clock.mjs';

const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
const inc=(counts,key)=>counts[key]=(counts[key]||0)+1;
function continuity(rows,epsilon){
 let previous=null,held=null;const spans=[],deltas=[];
 for(const row of rows){
  if(!row.eligible){previous=null;held=null;continue;}
  if(previous&&row.key===previous.key){
   const dt=row.at-previous.at,delta=distance(row,previous);deltas.push({at:row.at,dt,delta,sameSnapshot:row.snapshot===previous.snapshot});
   if(delta<=epsilon){held??={start:previous.at,end:row.at,key:row.key};held.end=row.at;}else{if(held){spans.push({...held,ms:held.end-held.start});held=null;}}
  }else if(held){spans.push({...held,ms:held.end-held.start});held=null;}
  previous=row;
 }
 if(held)spans.push({...held,ms:held.end-held.start});
 return {eligible_samples:rows.filter(r=>r.eligible).length,moving_steps:deltas.filter(d=>d.delta>epsilon).length,within_snapshot_moving_steps:deltas.filter(d=>d.sameSnapshot&&d.delta>epsilon).length,longest_stationary_ms:Math.max(0,...spans.map(s=>s.ms)),stationary_spans_over_100ms:spans.filter(s=>s.ms>=100),draw_gaps_over_100ms:deltas.filter(d=>d.dt>100),note:'Hooked draw submission intervals only; not FRAME timing or compositor presentation.'};
}
function runSignedMotion(rows){
 const deltas=[];let previous=null;
 for(const row of rows){
  if(previous&&row.key===previous.key&&row.authorityExpectsMovement&&previous.authorityExpectsMovement){
   const authorityDelta=row.baseDistance-previous.baseDistance,steps=row.sceneTick-previous.sceneTick;
   const plain=row.speed>0&&row.speed===previous.speed&&row.stunUntilTick<=row.sceneTick&&previous.stunUntilTick<=previous.sceneTick;
   const correction=steps>=0?authorityDelta-row.speed*steps/60:null;
   const ordinary=plain&&steps>=0&&Math.abs(correction)<1e-5;
   deltas.push({at:row.at,dt:row.at-previous.at,distance_delta_m:row.x-previous.x,visual_tick_delta:row.visualTick!==null&&previous.visualTick!==null?row.visualTick-previous.visualTick:null,snapshot_changed:row.sceneTick!==previous.sceneTick,from_tick:previous.sceneTick,to_tick:row.sceneTick,authority_delta_m:authorityDelta,authority_correction_m:correction,ordinary_uniform_motion:ordinary});
  }
  previous=row;
 }
 const reversals=deltas.filter(d=>d.distance_delta_m<-.03),ordinary=reversals.filter(d=>d.ordinary_uniform_motion);
 return {deltas,reversals_over_3cm:reversals,ordinary_uniform_reversals_over_3cm:ordinary,ordinary_uniform_reverse_count:ordinary.length,ordinary_uniform_reverse_total_m:ordinary.reduce((sum,d)=>sum-d.distance_delta_m,0),note:'Signed displacement comes from native camera matrices. visualTick is distance-derived only for ordinary positive-speed snapshots; authoritative corrections remain visible and are not clamped.'};
}
export function analyseRunMotion(raw){
 const reasons={},snapshots=raw.snapshots.filter(s=>s.room.game_id==='run'),byIndex=new Map(snapshots.map(s=>[s.index,s])),firstTick=new Map();
 for(const s of snapshots){const key=s.room.id+':'+s.room.game.snapshotTick;if(!firstTick.has(key))firstTick.set(key,s.at);}
 const rows=raw.run.map(row=>{
  let s=byIndex.get(row.snapshot);if(s&&s.room.game.snapshotTick!==row.sceneTick)s=[...snapshots].reverse().find(v=>v.at<=row.at&&v.room.game.snapshotTick===row.sceneTick&&v.room.id===s.room.id);
  const r=s?.room,g=r?.game,p=g?.players?.find(p=>p.key===r.me),age=s?row.at-firstTick.get(r.id+':'+g.snapshotTick):NaN;
  const profile=['pvp-run-v1.0.0','pvp-run-v2.0.0'].includes(g?.ruleVersion)&&g?.physicsVersion==='run-60hz-v1.0.0';
  const renderedDistance=8.8-row.camera[2],knownStun=profile&&p?.speed===0&&Number.isSafeInteger(p.stunUntilTick)&&p.stunUntilTick>g.snapshotTick&&p.stunUntilTick<=g.snapshotTick+39;
  const expiry=knownStun&&Number.isFinite(g.startedAt)?g.startedAt+p.stunUntilTick*1000/60:Infinity;
  const recovered=knownStun&&(renderedDistance>p.distance+.01||Number.isFinite(raw.timeOrigin)&&raw.timeOrigin+row.at>=expiry);
  let reason=!s||!p?'authority-unmatched':!profile?'unknown-physics-profile':row.visibility!=='visible'?'hidden':row.conflictingCamera?'ambiguous-camera':row.cinematic!=='race'?'finish-camera':r.status!=='active'||g.status!=='active'?'not-active':p.forfeited||p.finishTick!=null?'finished-or-forfeited':p.fallUntilTick!=null?'fall-recovery':age>650?'snapshot-projection-cap':p.speed===0&&knownStun&&!recovered?'hit-recovery':!(p.speed>0)&&!recovered?'authority-stationary':'moving';
  // Phase can predate this snapshot's receipt. Check the independently known
  // maximum 39-tick travel envelope, never synthesize positions as evidence.
  const envelope=p?[p.distance,Math.min(480,p.distance+9.6*.650)]:null;
  if(reason==='moving'&&(renderedDistance<envelope[0]-.8||renderedDistance>envelope[1]+.8))reason='camera-authority-mismatch';
  const visualTick=p?.speed>0&&p.stunUntilTick<=g.snapshotTick?g.snapshotTick+(renderedDistance-p.distance)*60/p.speed:null;
  inc(reasons,reason);return{at:row.at,key:r?.id,sceneTick:row.sceneTick,snapshot:s?.index,x:renderedDistance,y:0,envelope,visualTick,baseDistance:p?.distance,speed:p?.speed,stunUntilTick:p?.stunUntilTick,ruleVersion:g?.ruleVersion,physicsVersion:g?.physicsVersion,age,reason,knownStunRecovery:!!recovered,eligible:reason==='moving',authorityExpectsMovement:['moving','camera-authority-mismatch'].includes(reason)};
 });
 const stats=continuity(rows,.0005),suspectedStalls=continuity(rows.map(r=>({...r,eligible:r.authorityExpectsMovement})),.0005),observed=!raw.errors.length&&!raw.dropped&&stats.within_snapshot_moving_steps>=10&&stats.eligible_samples>=20;
 return{game:'run',status:observed?'motion-observed':'unmeasured',reasons,association:'actual main-canvas default-framebuffer perspective viewMatrix, rigid camera inverse; race z=8.8-distance; v1/v2 run-60hz-v1.0.0 authority bounds include carried clock phase',...stats,signed_motion:runSignedMotion(rows),suspected_stalls_including_position_mismatch:suspectedStalls,recovery_tails:analyseRunRecoveryTails(raw),rows,raw_errors:raw.errors,truncated:raw.dropped>0,automatic_performance_acceptance:false};
}
/** Does not exclude speed=0. A hit's known expiry is compared to actual draws. */
export function analyseRunRecoveryTails(raw){
 const snapshots=raw.snapshots.filter(s=>s.room.game_id==='run'),events=new Map(),tails=[];
 for(const s of snapshots){const r=s.room,g=r.game,p=g.players?.find(p=>p.key===r.me),event=p?.lastEvent;if(!['pvp-run-v1.0.0','pvp-run-v2.0.0'].includes(g.ruleVersion)||event?.type!=='hit'||!(g.snapshotTick<p.stunUntilTick)||p.speed!==0||p.fallUntilTick!=null)continue;const key=r.id+':'+event.id+':'+p.stunUntilTick;if(!events.has(key))events.set(key,{key,s,p,event});}
 for(const {key,s,p,event}of events.values()){
  const r=s.room,g=r.game,expiry=g.startedAt+p.stunUntilTick*1000/60;
  const interrupted=snapshots.find(v=>v.at>s.at&&v.room.id===r.id&&(()=>{const player=v.room.game.players.find(p=>p.key===r.me);return v.room.status!=='active'||player?.forfeited||player?.finishTick!=null||player?.fallUntilTick!=null||player?.lastEvent?.type==='hit'&&player.lastEvent.id!==event.id;})());
  const frames=raw.run.filter(f=>f.at>=s.at&&f.at<(interrupted?.at??Infinity)&&f.sceneTick>=event.tick&&f.visibility==='visible'&&f.cinematic==='race'&&!f.conflictingCamera);
  const first=frames.find(f=>Math.abs(8.8-f.camera[2]-p.distance)<.02);if(!first){tails.push({key,status:'stop-not-captured',rule_version:g.ruleVersion});continue;}
  const last=frames.at(-1),resume=frames.find(f=>f.at>first.at&&8.8-f.camera[2]>p.distance+.01),end=resume||last,endEpoch=raw.timeOrigin+end.at;
  const atResume=snapshots.filter(v=>v.at<=end.at&&v.room.id===r.id).at(-1),player=atResume?.room.game.players.find(p=>p.key===r.me);
  tails.push({key,rule_version:g.ruleVersion,hit_tick:event.tick,stun_until_tick:p.stunUntilTick,theoretical_expiry_epoch_ms:expiry,first_stationary_draw_ms:first.at,observed_until_ms:end.at,observed_stationary_ms:end.at-first.at,resumed:!!resume,right_censored:!resume,interrupted:!!interrupted&&!resume,forward_delay_after_theoretical_expiry_ms:resume?endEpoch-expiry:null,remaining_stationary_after_expiry_lower_bound_ms:resume?null:Math.max(0,endEpoch-expiry),authority_at_end:{snapshotTick:atResume?.room.game.snapshotTick,stunUntilTick:player?.stunUntilTick,speed:player?.speed,server_now:atResume?.room.server_now},note:'Wall-clock hit expiry versus actual camera advance, including zero-speed snapshots. A censored interval has no observed resume and cannot be treated as a completed normal penalty.'});
 }
 return{method:'known 60 Hz v1/v2 authoritative stunUntilTick + startedAt; actual GL camera distance, no speed=0 exclusion',tails};
}
function control(a,b,from,to,towers,width,height){if(towers[from]?.ring!=='outer'||towers[to]?.ring!=='outer')return null;const x=(a.x+b.x)/2,y=(a.y+b.y)/2,dx=x-width/2,dy=y-height/2,len=Math.hypot(dx,dy)||1,offset=Math.min(width,height)*.12;return{x:x+dx/len*offset,y:y+dy/len*offset};}
export function analyseTowerMotion(raw){
 const snapshots=raw.snapshots.filter(s=>s.room.game_id==='towerlink'),byIndex=new Map(snapshots.map(s=>[s.index,s])),clocks=new Map(),reasons={},tracks=new Map();let next=0;
 const process=s=>{const r=s.room,g=r.game,server=r.server_now??g.serverNow;if(!Number.isFinite(server))return;let c=clocks.get(r.id);if(!c){c=createTowerClock(server,s.at);clocks.set(r.id,c);}c.receive(server,g.simulationAt,s.at);};
 for(const row of raw.tower){
  while(next<snapshots.length&&snapshots[next].at<=row.at)process(snapshots[next++]);
  const s=byIndex.get(row.snapshot),r=s?.room,g=r?.game,c=r&&clocks.get(r.id),age=s?row.at-s.at:Infinity;
  let reason=!s||!c?'authority-unmatched':row.visibility!=='visible'?'hidden':r.status!=='active'||g.status!=='active'?'not-active':age>1400?'snapshot-projection-cap':age<80?'snapshot-react-boundary':'moving';
  if(reason!=='moving'){inc(reasons,reason);for(const track of tracks.values())track.push({at:row.at,eligible:false});continue;}
  const now=Math.max(g.simulationAt??-Infinity,Math.min(c.now(row.at),c.serverAt+1400));
  if(now<g.startedAt){inc(reasons,'countdown');continue;}
  const armies=createTroopProjection(g).at(now).armies,points=new Map(row.nodes.map(n=>[n.id,n]));
  if(!armies.length){inc(reasons,'no-travelling-army');continue;}
  const expected=[];
  for(const army of armies){const a=points.get(army.from),b=points.get(army.to);if(!a||!b)continue;const f=(now-army.departedAt)/(army.arrivesAt-army.departedAt);if(f<=.02||f>=.98)continue;const curve=control(a,b,army.from,army.to,g.towers,row.width,row.height),p=pointOnRoad(a,b,curve,f),p2=pointOnRoad(a,b,curve,Math.min(1,f+.01)),angle=Math.atan2(p2.y-p.y,p2.x-p.x),glyphs=armies.length>80?1:Math.min(army.count,2);for(let j=0;j<glyphs;j++)expected.push({key:r.id+':'+army.id+':'+j,army:army.id,glyph:j,team:g.players.findIndex(p=>p.key===army.ownerKey),x:p.x-Math.cos(angle)*j*8,y:p.y-Math.sin(angle)*j*8});}
  const matches=[];
  for(const draw of row.soldiers){const candidates=expected.filter(e=>e.team===draw.team).map(e=>({...e,error:distance(e,draw)})).filter(e=>e.error<=3).sort((a,b)=>a.error-b.error);if(candidates.length!==1){inc(reasons,candidates.length?'ambiguous-entity':'unmatched-draw');continue;}matches.push({draw,e:candidates[0]});}
  const multiplicity=new Map();for(const m of matches)multiplicity.set(m.e.key,(multiplicity.get(m.e.key)||0)+1);
  const matchedKeys=new Set();
  for(const {draw,e}of matches){if(multiplicity.get(e.key)!==1){inc(reasons,'duplicate-entity');continue;}inc(reasons,'matched');matchedKeys.add(e.key);if(!tracks.has(e.key))tracks.set(e.key,[]);tracks.get(e.key).push({at:row.at,key:e.key,snapshot:s.index,x:draw.x,y:draw.y,error:e.error,eligible:true});}
  for(const [key,track]of tracks)if(!matchedKeys.has(key))track.push({at:row.at,eligible:false});
 }
 const summaries=[...tracks].map(([key,rows])=>({key,...continuity(rows,.01),rows})),observed=summaries.filter(t=>t.within_snapshot_moving_steps>=5);
 return{game:'towerlink',status:observed.length&&!raw.errors.length&&!raw.dropped?'motion-observed':'unmeasured',association:'actual soldiers-atlas drawImage translation; unique same-team authority army/glyph within 3 CSS px; ambiguous draws excluded',reasons,tracks:summaries,observed_entity_count:observed.length,raw_errors:raw.errors,truncated:raw.dropped>0,automatic_performance_acceptance:false};
}
