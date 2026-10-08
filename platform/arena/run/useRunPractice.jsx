import {useEffect,useMemo,useRef,useState} from 'react';
import {requestId} from '../shared/client.mjs';
import {RUN_PRACTICE_INPUT_RULE_VERSION} from './start-policy.mjs';
import {createRunPracticeController} from './practice-controller.mjs';
import {createRunPracticeTransport} from './practice-input-transport.mjs';

// One controller and transport per authenticated viewer/room/clock epoch.
// Room polling remains owned by Arena. Only validated, advancing authority
// may refresh the controller; HTTP retries and visibility cannot do so.
export function useRunPractice({room,me,owner,authorization,onBatch,onRoom,onError}){
 const enabled=room?.game?.ruleVersion===RUN_PRACTICE_INPUT_RULE_VERSION;
 const epoch=room?.run_inputs?.clockEpoch;
 const callbacks=useRef({onBatch,onRoom,onError});callbacks.current={onBatch,onRoom,onError};
 const controller=useMemo(()=>enabled&&owner&&room?.id&&me&&Number.isSafeInteger(epoch)&&epoch>0
  ?createRunPracticeController({roomId:room.id,playerKey:me,clockEpoch:epoch,makeRequestId:requestId}):null,
 [enabled,owner,room?.id,me,epoch]);
 const transport=useRef(null);
 const verifiedAuthorization=useRef(authorization),[transportError,setTransportError]=useState(null);
 useEffect(()=>{
  if(!controller)return;
  setTransportError(null);verifiedAuthorization.current=authorization;
  const instance=createRunPracticeTransport({controller,send:(...args)=>callbacks.current.onBatch(...args),
   onRoom:response=>{setTransportError(null);callbacks.current.onRoom?.(response);},onError:error=>{setTransportError(error);callbacks.current.onError?.(error);},now:()=>performance.now()});
  transport.current=instance;
  const visibility=()=>{if(document.hidden){controller.suspend();instance.suspend();}else{controller.resume();instance.resume();}};
  if(document.hidden)visibility();
  document.addEventListener('visibilitychange',visibility);
  return()=>{document.removeEventListener('visibilitychange',visibility);instance.close();controller.clear();if(transport.current===instance)transport.current=null;};
 },[controller]);
 useEffect(()=>{
  if(!controller||!room)return;
  controller.receive({room,receivedAt:performance.now()});
  transport.current?.pump();
 },[controller,room]);
 useEffect(()=>{
  if(verifiedAuthorization.current===authorization)return;
  verifiedAuthorization.current=authorization;
  // Arena updates this object only after the host's new token and identity
  // have been verified. Keep original commands and request IDs on same-owner
  // reauthorization; a different owner already owns a different controller.
  const state=transport.current?.state();
  if(['SESSION_CHANGED','UNAUTHORIZED','SESSION_EXPIRED','INVALID_TOKEN'].includes(state?.blocked)||transportError?.status===401)transport.current?.retry();
 },[authorization,controller,transportError]);
 return {enabled,controller,transportError,retry:()=>transport.current?.retry(),enqueue(type,at){
  if(transportError?.transport?.stopped)return {ok:false,reason:'transport-stopped'};
  if(!controller)return {ok:false,reason:'no-authority'};
  const result=controller.enqueue(type,at);if(result.ok)transport.current?.pump();return result;
 }};
}
