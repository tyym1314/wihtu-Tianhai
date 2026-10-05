/** Node-side observation only: admit a fresh child game document per entry. */
export function createProfileEntryGate({origin,game,now=()=>Date.now()}={}){
 const target=new URL('/play/'+game,origin).href,tickets=new WeakMap(),rows=[];
 let generation=0,startedAt=null,mainFrame=null,priorFrames=new Set(),gameFrame=null,room=null,roomId=null,nextId=0;
 const frameDetached=frame=>{try{return !frame||frame.isDetached();}catch{return true;}};
 const decision=request=>{
  const row=tickets.get(request);
  if(!row||row.orphan)return {accepted:false,reason:'no-request-ticket'};
  if(startedAt===null||row.generation!==generation||row.observed_at<startedAt)return {accepted:false,reason:'outside-entry-generation'};
  if(!row.frame)return {accepted:false,reason:'no-frame'};
  if(row.frame===mainFrame)return {accepted:false,reason:'host-main-frame'};
  if(priorFrames.has(row.frame))return {accepted:false,reason:'frame-existed-before-entry'};
  if(!gameFrame)return {accepted:false,reason:'game-frame-not-bound'};
  if(row.frame!==gameFrame)return {accepted:false,reason:'different-frame'};
  if(frameDetached(row.frame))return {accepted:false,reason:'game-frame-detached'};
  return {accepted:true,reason:'current-game-frame'};
 };
 const describe=row=>({request_id:row.id,url:row.url,type:row.type,method:row.method,is_static:row.is_static,is_navigation:row.is_navigation,observed_at:row.observed_at,age_ms:Math.max(0,now()-row.observed_at),entry_generation:row.generation,frame_role:row.frame===gameFrame?'current-game':row.frame===mainFrame?'host-main':priorFrames.has(row.frame)?'prior-frame':'other-or-unknown',...decision(row.request),terminal:row.terminal,observer_stage:row.observer_stage});
 return {
  begin({at=now(),mainFrame:main,existingFrames=[]}={}){generation++;startedAt=at;mainFrame=main;priorFrames=new Set(existingFrames);gameFrame=null;room=null;roomId=null;},
  request(request,{frame=null,url,type,method,isStatic=false,isNavigation=false,observedAt=now()}={}){
   const safe=new URL(url);safe.search='';safe.hash='';
   const row={id:++nextId,request,frame,url:safe.href,type,method,is_static:isStatic,is_navigation:isNavigation,observed_at:observedAt,generation,terminal:null,observer_stage:null};tickets.set(request,row);rows.push(row);
   // Both demo and native host mount a new child /play/game iframe. Binding
   // uses its actual navigation Request.frame identity, never cached timing.
   if(startedAt!==null&&observedAt>=startedAt&&!gameFrame&&isNavigation&&safe.href===target&&frame&&frame!==mainFrame&&!priorFrames.has(frame)&&!frameDetached(frame))gameFrame=frame;
   return decision(request);
  },
  finish(request,kind){const row=tickets.get(request);if(row)row.terminal={kind,at:now()};},
  observer(request,stage,descriptor={}){let row=tickets.get(request);if(!row){row={id:++nextId,request,frame:null,url:descriptor.url||'[unknown]',type:descriptor.type||null,method:descriptor.method||null,is_static:false,is_navigation:false,observed_at:now(),generation:null,orphan:true,terminal:null};tickets.set(request,row);rows.push(row);}row.observer_stage=stage;},
  decision,
  pendingCount(){return rows.filter(row=>row.is_static&&!row.terminal&&decision(row.request).accepted).length;},
  resetRoom(){room=null;roomId=null;},
  receiveRoom(request,incoming,{created=false}={}){
   if(!decision(request).accepted)return {accepted:false,reason:decision(request).reason};
   if(!incoming?.id||incoming.game_id!==game)return {accepted:false,reason:'wrong-game-or-missing-room'};
   if(created){if(roomId&&roomId!==incoming.id)return {accepted:false,reason:'additional-room-in-entry'};roomId=incoming.id;}
   if(!roomId||incoming.id!==roomId)return {accepted:false,reason:'different-or-unbound-room'};
   if(room&&incoming.version<room.version)return {accepted:false,reason:'older-version'};
   room=incoming;return {accepted:true,reason:'current-room',room};
  },
  snapshot(){const requests=rows.map(describe),g=room?.game||{};return {schema:'profile-entry-isolation-v1',entry_started_at:startedAt,entry_generation:generation,target,game_frame_bound:!!gameFrame,game_frame_detached:gameFrame?frameDetached(gameFrame):null,pending:requests.filter(row=>row.accepted&&row.is_static&&!row.terminal),requests,room:room?{id:room.id,version:room.version,status:room.status,server_now:room.server_now,game_status:g.status,phase:g.phase,forfeited:g.forfeited,startedAt:g.startedAt,busyUntil:g.busyUntil}:null};}
 };
}
