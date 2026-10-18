import {createGameHostBridge} from '../../legacy/host-bridge.mjs';
import {createSnapshotTransfer} from './snapshot-transfer.mjs';
import {createRoomResponseTiming} from './response-timing.mjs';
const snapshotTransfer=createSnapshotTransfer(),roomResponseTiming=createRoomResponseTiming();
export const readRoomResponseTiming=room=>roomResponseTiming.read(room);
let accessToken='',hostBridge=null,sessionId=null,launchPending=false;const controls=new Set();
export const requestId=()=>crypto.randomUUID().replaceAll('-','');
export function authorize(token){if(token!==accessToken){snapshotTransfer.clear();roomResponseTiming.clear();}accessToken=token;}
export function registerHostControls(callbacks){controls.add(callbacks);return()=>controls.delete(callbacks);}
export const reportProgress=value=>hostBridge?.progress?.(value);
export const reportShown=()=>hostBridge?.shown?.();
export function completeHostReturn(details={}){return hostBridge?.completeReturn(details)===true;}
export function hostState(){return hostBridge?.state||{muted:false,voiceActive:false,visible:true,safeArea:{top:0,right:0,bottom:0,left:0}};}
export async function api(path,body,{signal}={}){
 // A new token is not usable by the old UI until its identity is verified.
 if(launchPending&&path!=='/v1/launch/exchange'&&path!=='/api/arena/session'){const e=new Error('The session is changing. Retry after the current room is restored.');e.code='SESSION_CHANGED';throw e;}
 const ticket=snapshotTransfer.begin(path,body===undefined);
 const send=async transfer=>{
  const requestSignal=signal||AbortSignal.timeout(12000);
  const options={method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(accessToken?{Authorization:`Bearer ${accessToken}`} :{}),...(transfer.entry?{'X-Oasis-Known-Actions':transfer.entry.key}:{}),...(transfer.runEnabled?{'X-Oasis-Known-Run-Game':transfer.runEntry?.key||'full'}:{})},body:body===undefined?undefined:JSON.stringify(body),credentials:'same-origin',signal:requestSignal};
  // Hint that launch verification should outrank lower-urgency asset fetches.
  // This hint retains fetch's existing high priority; it does not skip work.
  if(path==='/v1/launch/exchange'||path==='/api/arena/session')options.priority='high';
  // Live room reads must bypass the HTTP cache before response headers arrive.
  // A response's no-store header arrives too late to prevent Chromium from
  // queueing a same-URL hedge behind the first read's cache transaction.
  // Retained snapshot decoding remains separate, including full GET recovery.
  if(transfer.enabled)options.cache='no-store';
  const requestStartedAtMs=performance.now(),response=await fetch(path,options);
  const headersObservedAtMs=performance.now();
  const {data,bodyParsedAtMs}=await read(response,transfer);
  return {data,requestSignal,timing:{requestStartedAtMs,headersObservedAtMs,bodyParsedAtMs}};
 };
 async function read(response,transfer){
  let data;try{data=await response.json();}catch{throw new Error('Connection interrupted. Please reconnect to recover your room.');}
  const bodyParsedAtMs=performance.now();
  snapshotTransfer.assertCurrent(transfer);
  if(!response.ok){const error=new Error(data.error?.message||data.message||`Request failed (${response.status})`);error.code=data.error?.code||data.code;error.status=response.status;const retry=response.headers.get('retry-after');if(retry){const seconds=Number(retry);error.retryAfterMs=Number.isFinite(seconds)?Math.max(0,seconds*1000):Math.max(0,Date.parse(retry)-Date.now())||0;}if(response.status===401&&path!=='/v1/launch/exchange')hostBridge?.requestReauth();throw error;}
  return {data,bodyParsedAtMs};
 }
 const response=await send(ticket);
 const restore=async(current,{data,requestSignal,timing})=>{
  requestSignal.throwIfAborted();
  const restored=await snapshotTransfer.restoreRun(current,snapshotTransfer.restore(current,data));
  snapshotTransfer.assertCurrent(current);requestSignal.throwIfAborted();
  roomResponseTiming.record(restored,{...timing,restoredAtMs:performance.now()});
  return restored;
 };
 try{return await restore(ticket,response);}catch(error){
  // Safe GET-only recovery, without a retained-action hint. Never replay POSTs.
  if(error.code!=='SNAPSHOT_REFRESH_REQUIRED'||body!==undefined)throw error;
  snapshotTransfer.assertCurrent(ticket);response.requestSignal.throwIfAborted();
  const full=snapshotTransfer.begin(path,true,{full:true});
  return restore(full,await send(full));
 }
}
export async function waitForLaunch(game,onStatus){
 hostBridge?.dispose();let resolved=false;
 return new Promise((resolve,reject)=>{try{hostBridge=createGameHostBridge({game,onLaunch:async body=>{
  launchPending=true;try{
  onStatus?.('Connecting your App wallet…');const response=await api('/v1/launch/exchange',body);if(typeof response.access_token!=='string'||response.host_origin&&response.host_origin!==body.host_origin||response.game_id&&response.game_id!==game)throw new Error('The launch binding does not match this game.');
  authorize(response.access_token);sessionId=response.session_id;const context=await api('/api/arena/session');if(context.game_id!==game){authorize('');throw new Error('The launch session belongs to a different game.');}
  // The first launch already returns this verified session to Arena. Repeating
  // that GET via the authorized event competed with critical images. Reauth
  // still refreshes once, then shares that same response with its subscriber.
  launchPending=false;
  if(!resolved){resolved=true;resolve(context);}else window.dispatchEvent(new CustomEvent('oasis:authorized',{detail:{session_id:sessionId,context}}));return{host_origin:response.host_origin||body.host_origin,game_id:game,session_id:sessionId};
  }catch(error){authorize('');throw error;}finally{launchPending=false;}
 },onState:state=>controls.forEach(c=>c.onState?.(state)),onBack:()=>{for(const c of controls)c.onBack?.();},onError:error=>{onStatus?.(error.message);if(error.code==='LAUNCH_TIMEOUT'&&!resolved)reject(error);}});}catch(error){reject(error);}});
}
if(typeof window!=='undefined')window.addEventListener('pagehide',()=>{authorize('');sessionId=null;hostBridge?.dispose();},{once:true});
export const coins=minor=>new Intl.NumberFormat('en-US',{maximumFractionDigits:2}).format(Number(minor||0)/100);
