import {LANES,TRACK_LENGTH} from './level.mjs';

// Presentation only: input ticks, collisions, ranks and settlement remain server owned.
// A 250 ms horizon freezes every ordinary 150 ms poll + 200 ms HTTP round trip.
// Cover moderate mobile jitter, then hold rather than invent seconds of gameplay.
export const RUN_PROJECTION_LIMIT_MS=650;
const mix=(a,b,t)=>a+(b-a)*t,clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
// Both pinned rule versions declare this same 60 Hz movement profile. Keep
// unknown profiles still rather than guessing how a zero speed may recover.
const knownProfile=g=>(g.ruleVersion==='pvp-run-v1.0.0'||g.ruleVersion==='pvp-run-v2.0.0')&&g.physicsVersion==='run-60hz-v1.0.0';
function travel(p,g,tick){
 const start=g.snapshotTick,stun=p.stunUntilTick,boost=p.boostUntilTick;
 if(!Number.isSafeInteger(start)||!Number.isSafeInteger(stun)||!Number.isSafeInteger(boost)||stun<0||boost<0)return 0;
 const expectedSpeed=start<stun?0:start<boost?9.6:8;
 // A stopped snapshot without an explicit future stun boundary is not a
 // licence to invent forward motion (nor is an inconsistent speed/profile).
 if(p.speed!==expectedSpeed)return 0;
 const end=Math.floor(tick),first=Math.max(start+1,stun),steps=Math.max(0,end-first+1),boosted=Math.max(0,Math.min(end,boost-1)-first+1);
 let meters=((steps-boosted)*40+boosted*48)/300;
 // step(stunUntilTick) moves once in both engines. Do not interpolate that
 // step before recovery: hold through its left boundary, then include it at
 // the exact integer tick. Subsequent active steps interpolate normally.
 if(end>=stun)meters+=(tick-end)*(end+1<boost?48:40)/300;
 return meters;
}
export function projectedPose(p,g,elapsed){
 const active=knownProfile(g)&&g.status==='active'&&!p.forfeited&&p.finishTick==null&&!(Number.isFinite(g.serverNow)&&Number.isFinite(g.startedAt)&&g.serverNow<g.startedAt);
 const ahead=active?clamp(elapsed,0,RUN_PROJECTION_LIMIT_MS):0,tick=g.snapshotTick+ahead*.06;
 const lt=p.changeEndTick>p.changeStartTick?clamp((tick-p.changeStartTick)/(p.changeEndTick-p.changeStartTick),0,1):1;
 const jt=p.jumpStartTick===null?1:(tick-p.jumpStartTick)/48;
 let y=jt>=0&&jt<1?4*1.2*jt*(1-jt):0;
 let distance=Math.min(TRACK_LENGTH,p.distance+(active?travel(p,g,tick):0)),scale=1;
 if(p.fallUntilTick!==null){const ft=clamp((tick-p.fallStartTick)/90,0,1);y=-Math.min(2.4,ft*5);scale=Math.max(.15,1-ft*.9);distance=p.distance;}
 return{x:mix(LANES[p.fromLane],LANES[p.lane],lt),y,distance,tick,scale};
}

export function createRunSnapshotClock(){
 let tick=-1,received=0;
 return{
  receive(game,at){
   if(!Number.isSafeInteger(game?.snapshotTick)||!Number.isFinite(at)||game.snapshotTick<tick)return false;
   if(game.snapshotTick>tick){
    // A 150 ms poll can receive a 250 ms publication after its predecessor
    // has already been projected further. Carry only that consumed phase;
    // resetting to zero would rewind a normally moving camera every few polls.
    // The new authority's distance (including hits/respawn) is never clamped.
    const predicted=tick<0?game.snapshotTick:tick+clamp(at-received,0,RUN_PROJECTION_LIMIT_MS)*.06;
    const aheadTicks=clamp(predicted-game.snapshotTick,0,RUN_PROJECTION_LIMIT_MS*.06);
    tick=game.snapshotTick;received=at-aheadTicks/.06;
   }
   return true;
  },
  elapsed(at){return Math.max(0,at-received);},
 };
}
