import test from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {webcrypto} from 'node:crypto';
import * as Run from '../arena/run/engine.mjs';
import {compactRoomSnapshot} from '../server/pvp/snapshot-transfer.mjs';
import {createSnapshotTransfer} from '../arena/shared/snapshot-transfer.mjs';
import {digestRunGame,runGameKeyMaterial} from '../shared/run-snapshot-transfer.mjs';

const path='/api/pvp/rooms/run-room',session={app_id:'app-a',game_id:'run',external_user_id:'human'};
function fixture(){
 const state=Run.createState('12'.repeat(32),1000,{players:[{key:'human',seatIndex:0},{key:'bot',seatIndex:1,isBot:true}]});
 return {id:'run-room',code:'RUNROOM',game_id:'run',me:'human',version:12,server_now:1000,players:[{external_user_id:'human',connected:true},{external_user_id:'bot',connected:true}],game:Run.view(state,'human')};
}
const compact=(room,key='full',auth=session)=>compactRoomSnapshot(room,undefined,{runKey:key,session:auth});
const wire=value=>JSON.parse(JSON.stringify(value));
const full=()=>wire(compact(fixture()));

test('legacy Run responses are unchanged; explicit negotiation binds exact game and authenticated scope',async()=>{
 const room=fixture();assert.equal(compactRoomSnapshot(room),room);assert.equal(compact(room,undefined,null),room);
 for(const bad of [null,'',[],{},'bad','A'.repeat(64)])assert.equal(compact(room,bad),room);
 const encoded=compact(room),meta=encoded.run_game_transfer;
 assert.equal(meta.omitted,false);assert.deepEqual(encoded.game,room.game);
 assert.equal(await digestRunGame(runGameKeyMaterial(encoded,meta.scope)),meta.key);
 const omitted=compact(room,meta.key);assert.equal(Object.hasOwn(omitted,'game'),false);assert.equal(omitted.run_game_transfer.omitted,true);
 assert.ok(gzipSync(JSON.stringify(omitted)).length<gzipSync(JSON.stringify(encoded)).length*.6);
 assert.equal(compact({...room,game:null},meta.key).run_game_transfer,undefined);
 for(const auth of [null,{...session,game_id:'golf'},{...session,external_user_id:'other'},{...session,app_id:''}])assert.equal(compact(room,meta.key,auth),room);
});
test('same version but different nested game, rule, room, player, or authenticated app never uses an old key',()=>{
 const original=fixture(),key=compact(original).run_game_transfer.key;
 for(const change of [r=>r.game.players[0].distance=1,r=>r.game.ruleVersion='future',r=>r.game.physicsVersion='future',r=>r.game.courseId='other',r=>r.version++,r=>r.id='other-room',r=>{r.me='other';r.game.me='other';}]){
  const changed=structuredClone(original);change(changed);const response=compact(changed,key,{...session,external_user_id:changed.me});
  assert.equal(response.run_game_transfer.omitted,false);assert.notEqual(response.run_game_transfer.key,key);assert.deepEqual(response.game,changed.game);
 }
 const changed=compact(original,key,{...session,app_id:'app-b'});assert.equal(changed.run_game_transfer.omitted,false);assert.notEqual(changed.run_game_transfer.scope,compact(original).run_game_transfer.scope);
});
test('restoration retains complete fresh outer clock/presence while reusing an immutable exact game',async()=>{
 const c=createSnapshotTransfer(),first=await c.restoreRun(c.begin(path,true),full()),ticket=c.begin(path,true),later=fixture();later.server_now=4567;later.players[0].connected=false;
 const response=wire(compact(later,ticket.runEntry.key)),restored=await c.restoreRun(ticket,response);
 assert.equal(restored.server_now,4567);assert.equal(restored.players[0].connected,false);assert.equal(restored.game,first.game);assert.deepEqual(restored.game,later.game);
 assert.throws(()=>restored.game.players[0].distance=99,TypeError);assert.throws(()=>restored.game.events.push({}),TypeError);
});
test('omission requires captured exact key/scope/room/player/version and no conflicting game',async()=>{
 const c=createSnapshotTransfer();await c.restoreRun(c.begin(path,true),full());const ticket=c.begin(path,true),delta=wire(compact(fixture(),ticket.runEntry.key));
 for(const change of [r=>r.run_game_transfer.key='f'.repeat(64),r=>r.run_game_transfer.scope='e'.repeat(64),r=>r.id='other-room',r=>r.me='other',r=>r.version++,r=>r.game={},r=>r.run_game_transfer.extra=true,r=>r.run_game_transfer.omitted='true',r=>delete r.run_game_transfer]){
  const bad=structuredClone(delta);change(bad);await assert.rejects(c.restoreRun(ticket,bad),{code:'SNAPSHOT_REFRESH_REQUIRED'});
 }
 await assert.rejects(c.restoreRun(c.begin(path,true,{full:true}),delta),{code:'SNAPSHOT_REFRESH_REQUIRED'});
 await assert.rejects(c.restoreRun(c.begin('/api/pvp/rooms/other-room',true),delta),{code:'SNAPSHOT_REFRESH_REQUIRED'});
});
test('corrupt full key or game cannot populate cache; same-version valid new full is used whole',async()=>{
 const c=createSnapshotTransfer();const ticket=c.begin(path,true);
 for(const change of [r=>r.game.players[0].distance++,r=>r.run_game_transfer.key='0'.repeat(64),r=>delete r.game,r=>r.run_game_transfer=null]){
  const bad=full();change(bad);await assert.rejects(c.restoreRun(ticket,bad),{code:'SNAPSHOT_REFRESH_REQUIRED'});assert.equal(c.begin(path,true).runEntry,undefined);
 }
 await c.restoreRun(ticket,full());const changed=fixture();changed.game.players[0].distance=7;const next=wire(compact(changed,c.begin(path,true).runEntry.key));
 assert.equal(next.run_game_transfer.omitted,false);assert.equal((await c.restoreRun(c.begin(path,true),next)).game.players[0].distance,7);
});
test('overlapping older polls restore captured game without replacing a newer cache',async()=>{
 const c=createSnapshotTransfer();await c.restoreRun(c.begin(path,true),full());const old=c.begin(path,true),newer=fixture();newer.version++;newer.game.players[0].distance=8;
 await c.restoreRun(c.begin(path,true),wire(compact(newer)));const key=c.begin(path,true).runEntry.key;
 const restored=await c.restoreRun(old,wire(compact(fixture(),old.runEntry.key)));assert.equal(restored.game.players[0].distance,0);assert.equal(c.begin(path,true).runEntry.key,key);
 await c.restoreRun(old,full());assert.equal(c.begin(path,true).runEntry.key,key);
});
test('authorization invalidates outstanding tickets, and room cache remains bounded',async()=>{
 const c=createSnapshotTransfer();await c.restoreRun(c.begin(path,true),full());const old=c.begin(path,true);c.clear();await assert.rejects(c.restoreRun(old,full()),{code:'SESSION_CHANGED'});
 for(const id of ['a','b','c']){const room=fixture();room.id=id;await c.restoreRun(c.begin('/api/pvp/rooms/'+id,true),wire(compact(room)));}
 assert.equal(c.begin('/api/pvp/rooms/a',true).runEntry,undefined);assert.ok(c.begin('/api/pvp/rooms/c',true).runEntry);
 assert.equal(c.begin(path,false).runEnabled,false);assert.equal(c.begin('/api/arena/session',true).runEnabled,false);
});
test('authorization changing during asynchronous digest cannot populate the new cache',async()=>{
 const descriptor=Object.getOwnPropertyDescriptor(globalThis,'crypto');let resolve;
 Object.defineProperty(globalThis,'crypto',{configurable:true,value:{subtle:{digest:()=>new Promise(r=>resolve=r)}}});
 try{
  const c=createSnapshotTransfer(),response=full(),ticket=c.begin(path,true),pending=c.restoreRun(ticket,response);c.clear();
  resolve(await webcrypto.subtle.digest('SHA-256',new TextEncoder().encode(runGameKeyMaterial(response,response.run_game_transfer.scope))));
  await assert.rejects(pending,{code:'SESSION_CHANGED'});assert.equal(c.begin(path,true).runEntry,undefined);
 }finally{Object.defineProperty(globalThis,'crypto',descriptor);}
});
async function withClient(fn){
 const original=globalThis.fetch,c=await import('../arena/shared/client.mjs?run-transfer='+Math.random());c.authorize('token-a');
 try{await fn(c);}finally{globalThis.fetch=original;c.authorize('');}
}
test('client negotiates GET only, performs one forced-full recovery, and leaves POST receipt untouched',async()=>withClient(async c=>{
 const calls=[];let corrupt=false;globalThis.fetch=async(url,options)=>{calls.push({url,...options});if(options.method==='POST')return Response.json({...fixture(),action_receipt:{request_id:'original'}});const response=compact(fixture(),options.headers['X-Oasis-Known-Run-Game']);if(corrupt){corrupt=false;response.run_game_transfer.key='f'.repeat(64);}return Response.json(response);};
 await c.api(path);await c.api(path);assert.equal(calls[0].headers['X-Oasis-Known-Run-Game'],'full');assert.match(calls[1].headers['X-Oasis-Known-Run-Game'],/^[a-f0-9]{64}$/);
 corrupt=true;assert.equal((await c.api(path)).game.gameId,'run');assert.equal(calls.length,4);assert.equal(calls[3].headers['X-Oasis-Known-Run-Game'],'full');
 const posted=await c.api(path+'/action',{seq:1,action:{type:'jump'}});assert.equal(posted.action_receipt.request_id,'original');assert.equal(calls.length,5);assert.equal(calls[4].headers['X-Oasis-Known-Run-Game'],undefined);
 c.authorize('token-b');await c.api(path);assert.equal(calls.at(-1).headers['X-Oasis-Known-Run-Game'],'full');
}));
test('second malformed GET fails, HTTP errors and mutation failures are never retried',async()=>withClient(async c=>{
 let count=0;globalThis.fetch=async()=>{count++;return Response.json({...fixture(),run_game_transfer:{}});};
 await assert.rejects(c.api(path),{code:'SNAPSHOT_REFRESH_REQUIRED'});assert.equal(count,2);
 for(const [body,status]of [[undefined,401],[undefined,503],[{seq:1,action:{type:'jump'}},409],[{seq:1,action:{type:'jump'}},503]]){
  count=0;globalThis.fetch=async()=>{count++;return Response.json({error:{code:'FIXTURE'}},{status});};await assert.rejects(c.api(body?path+'/action':path,body),{status});assert.equal(count,1);
 }
}));
for(const kind of ['unavailable','rejected'])test('WebCrypto '+kind+' safely preserves the full GET path',async()=>withClient(async c=>{
 const descriptor=Object.getOwnPropertyDescriptor(globalThis,'crypto'),calls=[];
 Object.defineProperty(globalThis,'crypto',{configurable:true,value:kind==='unavailable'?{}:{subtle:{digest:async()=>{throw Error('fixture digest unavailable');}}}});
 globalThis.fetch=async(url,options)=>{calls.push(options);return Response.json(compact(fixture(),options.headers['X-Oasis-Known-Run-Game']??null));};
 try{assert.equal((await c.api(path)).game.gameId,'run');assert.equal(calls.length,kind==='unavailable'?1:2);assert.equal(calls.at(-1).headers['X-Oasis-Known-Run-Game'],undefined);await c.api(path);assert.equal(calls.at(-1).headers['X-Oasis-Known-Run-Game'],undefined);}
 finally{Object.defineProperty(globalThis,'crypto',descriptor);}
}));
