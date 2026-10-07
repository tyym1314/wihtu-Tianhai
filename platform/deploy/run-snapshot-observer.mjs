import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

const schema='oasis-run-game-v1',key=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const text=value=>typeof value==='string'&&value.length>0;
const hash=value=>createHash('sha256').update(value).digest('hex');
const requireProof=(value,code)=>{if(!value)throw Object.assign(new Error(code),{code});};
const gameValid=room=>room.game&&typeof room.game==='object'&&!Array.isArray(room.game)&&room.game.gameId==='run'&&room.game.me===room.me&&text(room.game.ruleVersion)&&text(room.game.physicsVersion)&&Number.isSafeInteger(room.game.snapshotTick)&&room.game.snapshotTick>=0;
const authorityEnvelope=room=>JSON.stringify([room.status,room.me_last_seq,room.practice,room.entry_minor]);

export function createRunSnapshotObserver(){
 const tickets=new WeakMap(),entries=new Map();let auth=null,generation=0,sequence=0,tail=Promise.resolve();
 return {
  begin({path,method,authorization=null,hint=null}){
   const ticket=Object.freeze({sequence:++sequence});
   tickets.set(ticket,{path,method,authorization,hint,generation:auth&&authorization==='Bearer '+auth.token?generation:null});
   return ticket;
  },
  authorize({token,sessionId,playerId,appId},ticket){
   requireProof([token,sessionId,playerId,appId].every(text),'RUN_SNAPSHOT_AUTH_INCOMPLETE');
   if(auth&&['token','sessionId','playerId','appId'].every(k=>auth[k]==={token,sessionId,playerId,appId}[k]))return;
   requireProof(!ticket||tickets.has(ticket),'RUN_SNAPSHOT_UNKNOWN_AUTH_REQUEST');
   requireProof(!auth||!ticket||ticket.sequence>auth.after,'RUN_SNAPSHOT_AUTH_RESPONSE_OUT_OF_ORDER');
   generation++;entries.clear();auth={token,sessionId,playerId,appId,after:ticket?.sequence??0};
  },
  enqueue(body,consume){
   const read=Promise.resolve(body);void read.catch(()=>{});
   const work=tail.then(()=>read).then(consume);tail=work.catch(()=>{});return work;
  },
  inspect(ticket,room){
   const request=tickets.get(ticket);requireProof(request,'RUN_SNAPSHOT_REQUEST_MISSING');
   if(request.method==='GET'&&/^\/api\/pvp\/rooms\/[A-Za-z0-9_-]+$/.test(request.path))requireProof(room&&text(room.id)&&text(room.game_id)&&text(room.me)&&Number.isSafeInteger(room.version)&&room.version>=0,'RUN_SNAPSHOT_ENVELOPE_INVALID');
   if(auth&&room?.game_id==='run')requireProof(request.authorization==='Bearer '+auth.token&&
    (request.generation===generation||request.generation===null&&ticket.sequence>auth.after),'RUN_SNAPSHOT_AUTH_CHANGED');
   const meta=room?.run_game_transfer;
   if(meta===undefined){
    if(room?.game_id==='run'){
     requireProof(Object.hasOwn(room,'game'),'RUN_SNAPSHOT_GAME_MISSING');
     requireProof(room.game===null&&['waiting','funding','cancelled','settled','voided'].includes(room.status)||gameValid(room),'RUN_SNAPSHOT_GAME_INVALID');
    }
    return {kind:'full',room};
   }
   requireProof(request.method==='GET'&&/^\/api\/pvp\/rooms\/[A-Za-z0-9_-]+$/.test(request.path),'RUN_SNAPSHOT_NOT_ROOM_GET');
   requireProof(request.hint==='full'||key(request.hint),'RUN_SNAPSHOT_GET_HINT_MISSING');
   requireProof(auth&&request.authorization==='Bearer '+auth.token&&
    (request.generation===generation||request.generation===null&&ticket.sequence>auth.after),'RUN_SNAPSHOT_AUTH_CHANGED');
   requireProof(meta&&typeof meta==='object'&&!Array.isArray(meta)&&Object.keys(meta).length===4&&meta.schema===schema&&key(meta.key)&&key(meta.scope)&&typeof meta.omitted==='boolean','RUN_SNAPSHOT_METADATA_INVALID');
   requireProof(room.game_id==='run'&&text(room.id)&&room.me===auth.playerId&&Number.isSafeInteger(room.version)&&room.version>=0,'RUN_SNAPSHOT_ENVELOPE_INVALID');
   const target=request.path.slice(request.path.lastIndexOf('/')+1);
   requireProof(target===room.id||target===room.code,'RUN_SNAPSHOT_ROOM_MISMATCH');
   requireProof(meta.scope===hash(JSON.stringify([schema,auth.appId,'run',auth.playerId])),'RUN_SNAPSHOT_SCOPE_MISMATCH');
   if(meta.omitted){
    requireProof(!Object.hasOwn(room,'game')&&request.hint===meta.key,'RUN_SNAPSHOT_OMISSION_CONFLICT');
    const prior=entries.get(meta.key);
    requireProof(prior&&prior.generation===generation&&prior.sequence<ticket.sequence&&prior.id===room.id&&prior.me===room.me&&prior.version===room.version&&prior.scope===meta.scope,'RUN_SNAPSHOT_FULL_PROOF_MISSING');
    requireProof(prior.envelope===authorityEnvelope(room),'RUN_SNAPSHOT_OUTER_AUTHORITY_CHANGED');
    return {kind:'duplicate',evidence:{request_sequence:ticket.sequence,full_request_sequence:prior.sequence,room_id:room.id,player_id:room.me,version:room.version,scope:meta.scope,key:meta.key}};
   }
   requireProof(gameValid(room),'RUN_SNAPSHOT_GAME_INVALID');
   const actual=hash(JSON.stringify([schema,meta.scope,room.id,room.me,room.version,room.game]));
   requireProof(actual===meta.key,'RUN_SNAPSHOT_HASH_MISMATCH');
   const prior=entries.get(meta.key);
   if(!prior||ticket.sequence<prior.sequence)entries.set(meta.key,Object.freeze({generation,sequence:ticket.sequence,id:room.id,me:room.me,version:room.version,scope:meta.scope,envelope:authorityEnvelope(room)}));
   while(entries.size>64)entries.delete(entries.keys().next().value);
   return {kind:'full',room};
  }
 };
}

export function runSnapshotRequest(observer,request,path){
 const headers=typeof request.headers==='function'?request.headers():{};
 assert(headers&&typeof headers==='object'&&!Array.isArray(headers),'RUN_SNAPSHOT_HEADERS_INVALID');
 return observer.begin({path,method:request.method(),authorization:headers.authorization??null,hint:headers['x-oasis-known-run-game']??null});
}
