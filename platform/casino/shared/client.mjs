/** Casino client: host launch handshake, authenticated API calls and host controls. */
import {createGameHostBridge} from '../../legacy/host-bridge.mjs';

let accessToken='',bridge=null;const controls=new Set();
export const requestId=()=>crypto.randomUUID().replaceAll('-','');
export const hostState=()=>bridge?.state||{muted:false,voiceActive:false,visible:true,safeArea:{top:0,right:0,bottom:0,left:0}};
export function registerHostControls(callbacks){controls.add(callbacks);return()=>controls.delete(callbacks);}
export const reportProgress=value=>bridge?.progress?.(value);
export const reportShown=()=>bridge?.shown?.();
export function requestExit(details={}){return bridge?.completeReturn?.({reason:'user',...details})===true;}

export async function api(path,body,{signal}={}){
 const response=await fetch(path,{method:body===undefined?'GET':'POST',cache:'no-store',signal:signal||AbortSignal.timeout(12000),
  headers:{'Content-Type':'application/json',...(accessToken?{Authorization:`Bearer ${accessToken}`}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
 let data;try{data=await response.json();}catch{throw Object.assign(new Error('Connection interrupted'),{code:'NETWORK'});}
 if(!response.ok)throw Object.assign(new Error(data.error?.message||`Request failed (${response.status})`),{code:data.error?.code,status:response.status});
 return data;
}

/** Resolve once the host App hands over a launch code and the session is verified for this game. */
export function waitForLaunch(game,onStatus){
 bridge?.dispose();let resolved=false;
 return new Promise((resolve,reject)=>{try{bridge=createGameHostBridge({game,
  onLaunch:async body=>{
   onStatus?.('connecting');const r=await api('/v1/launch/exchange',body);
   if(typeof r.access_token!=='string'||r.game_id&&r.game_id!==game)throw new Error('The launch binding does not match this game.');
   accessToken=r.access_token;const state=await api('/api/casino/state?balance=1');
   if(state.game_id!==game){accessToken='';throw new Error('The launch session belongs to a different game.');}
   if(!resolved){resolved=true;resolve({state,locale:r.locale||null});}
   return{host_origin:r.host_origin||body.host_origin,game_id:game,session_id:r.session_id};
  },
  onState:s=>controls.forEach(c=>c.onState?.(s)),onBack:()=>controls.forEach(c=>c.onBack?.()),
  onError:e=>{onStatus?.(e.message);if(e.code==='LAUNCH_TIMEOUT'&&!resolved)reject(e);}});}catch(e){reject(e);}});
}
if(typeof window!=='undefined')window.addEventListener('pagehide',()=>{accessToken='';bridge?.dispose();},{once:true});
