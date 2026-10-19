/** Game-side channel only. The host is never given a Bearer or a settlement authority. */
export const HOST_PROTOCOL_VERSION=1;
const ownObject=v=>v&&typeof v==='object'&&!Array.isArray(v);
const safeId=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{8,128}$/.test(v);
export function normalizeHostState(value={}){if(!ownObject(value))value={};const safe={};for(const key of['muted','voiceActive','visible'])if(typeof value[key]==='boolean')safe[key]=value[key];if(ownObject(value.safeArea)){safe.safeArea={};for(const side of['top','right','bottom','left']){const v=value.safeArea[side];if(Number.isFinite(v))safe.safeArea[side]=Math.max(0,Math.min(160,Math.round(v)));}}return safe;}
export function createGameHostBridge({game,onLaunch,onState=()=>{},onBack=()=>{},onBalanceRefresh=()=>{},onError=()=>{},timeoutMs=90000}){
 const host=window.opener||(window.parent!==window?window.parent:null);if(!host)throw new Error('Open this game from your App or the platform sandbox launcher.');
 const nonce=crypto.randomUUID().replaceAll('-',''),instanceId=crypto.randomUUID().replaceAll('-','');let phase='waiting',pinnedOrigin=null,modern=false,disposed=false,state={muted:false,voiceActive:false,visible:true,safeArea:{top:0,right:0,bottom:0,left:0}},timer,readyTimer;
 const envelope=(type,data={})=>({type,protocol_version:1,game_id:game,bridge_nonce:nonce,...data});
 function post(type,data={},target=pinnedOrigin){if(!disposed&&target)host.postMessage(envelope(type,data),target);}
 function armTimeout(){clearTimeout(timer);timer=setTimeout(()=>{if(['waiting','exchanging','reauth'].includes(phase)){onError(Object.assign(new Error('Game launch timed out. Request a fresh launch code from your App.'),{code:'LAUNCH_TIMEOUT'}));dispose();}},timeoutMs);}
 function ready(){if(phase==='waiting')host.postMessage(envelope('oasis.ready'),'*');}
 function applyState(value){const next=normalizeHostState(value);state={...state,...next,safeArea:{...state.safeArea,...next.safeArea}};for(const side of['top','right','bottom','left'])document.documentElement.style.setProperty('--oasis-host-inset-'+side,state.safeArea[side]+'px');window.dispatchEvent(new CustomEvent('oasis:host-state',{detail:{...state,safeArea:{...state.safeArea}}}));onState(state);}
 async function receive(event){
  if(disposed||event.source!==host||!ownObject(event.data)||event.origin==='null')return;const data=event.data;
  const v1=data.protocol_version===1&&data.game_id===game&&data.bridge_nonce===nonce;
  const legacy=event.origin===location.origin&&data.protocol_version===undefined&&data.bridge_nonce===undefined&&(!data.game_id||data.game_id===game);
  if(data.type==='oasis.launch'){
   if(!v1&&!legacy||!['waiting','reauth'].includes(phase)||pinnedOrigin&&event.origin!==pinnedOrigin||typeof data.launch_code!=='string'||data.launch_code.length<8||data.launch_code.length>512)return;
   phase='exchanging';clearInterval(readyTimer);
   try{const result=await onLaunch({launch_code:data.launch_code,client_instance_id:instanceId,host_origin:event.origin,game_id:game});if(disposed)return;if(result?.host_origin&&result.host_origin!==event.origin)throw new Error('Server host binding mismatch');if(result?.game_id&&result.game_id!==game)throw new Error('Server game binding mismatch');pinnedOrigin=event.origin;modern=v1;phase='loaded';clearTimeout(timer);applyState(data.host_state);post('oasis.loaded',{capabilities:['host-state','return','reauthorize'],...(typeof result?.session_id==='string'?{session_id:result.session_id}:{})});}
   catch(error){if(disposed)return;phase=pinnedOrigin?'reauth':'waiting';onError(error);post('oasis.error',{code:typeof error.code==='string'?error.code:'LAUNCH_FAILED',message:String(error.message||'Launch failed').slice(0,300)},event.origin);if(!pinnedOrigin)readyTimer=setInterval(ready,1000);}
   return;
  }
  if(phase!=='loaded'||event.origin!==pinnedOrigin||!modern||!v1)return;
  if(data.type==='oasis.host_state'){applyState(data.state);post('oasis.host_state_applied',{request_id:safeId(data.request_id)?data.request_id:undefined});}
  else if(data.type==='oasis.back'){onBack();}
  else if(data.type==='oasis.balance_refresh'){onBalanceRefresh?.();}
 }
 function dispose(){disposed=true;clearTimeout(timer);clearInterval(readyTimer);window.removeEventListener('message',receive);window.removeEventListener('pagehide',dispose);}
 window.addEventListener('message',receive);window.addEventListener('pagehide',dispose,{once:true});ready();readyTimer=setInterval(ready,1000);armTimeout();
 return{get state(){return{...state,safeArea:{...state.safeArea}};},get origin(){return pinnedOrigin;},get modern(){return modern;},get phase(){return phase;},dispose,
  // Loading-screen signals for the host: asset progress (0-1) and the first rendered frame.
  progress(value){if(phase==='loaded'&&modern&&Number.isFinite(value))post('oasis.progress',{value:Math.max(0,Math.min(1,value))});},
  shown(){if(phase==='loaded'&&modern)post('oasis.shown');},
  // Ask the host App to open its own top-up page (balance tapped or not enough coins).
  requestRecharge(reason='user'){if(phase==='loaded'&&modern)post('oasis.recharge_requested',{reason:reason==='insufficient'?'insufficient':'user'});},
  requestReauth(){if(phase==='loaded'&&modern){phase='reauth';armTimeout();post('oasis.reauth_required');return true;}return false;},
  // This confirms dispatch to the pinned host, not host navigation or an ACK.
  completeReturn(details={}){if(disposed||phase!=='loaded'||!pinnedOrigin)return false;try{post('oasis.return_requested',{reason:['user','completed'].includes(details.reason)?details.reason:'user',...(typeof details.room_id==='string'?{room_id:details.room_id}:{}),...(typeof details.status==='string'?{status:details.status}:{}),presentation_only:true});return true;}catch{return false;}},
 };
}
