import test from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {compactRoomSnapshot} from '../server/pvp/snapshot-transfer.mjs';
import {createSnapshotTransfer} from '../arena/shared/snapshot-transfer.mjs';
import * as Jack from '../arena/jackaroo/engine.mjs';

function fixture(){
 const s=Jack.createState('41'.repeat(32),1000,{players:Array.from({length:4},(_,seatIndex)=>({key:`p${seatIndex}`,seatIndex}))});
 s.phase='play';s.turnKey='p0';s.pendingNext=false;s.busyUntil=1000;s.turnDeadlineAt=21000;
 s.players[0].hand=['C','D','H','S'].map(suit=>({id:suit+'7',rank:7,suit}));
 s.players[0].pieces.forEach((p,i)=>{p.progress=i*10;p.protected=false;});
 return {id:'room-a',me:'p0',game_id:'jackaroo',version:1,server_now:1000,game:Jack.view(s,'p0')};
}
const path='/api/pvp/rooms/room-a';
test('large four-sevens snapshot: legacy keeps every action, opt-in preserves exact view and fresh clocks',()=>{
 const room=fixture(),full=compactRoomSnapshot(room);assert.equal(room.game.legalActions.length,3664);assert.equal(full.game,room.game);
 const c=createSnapshotTransfer(),first=c.restore(c.begin(path,true),full),ticket=c.begin(path,true);
 const later={...room,version:2,server_now:2345,game:{...room.game,turnDeadlineAt:9876}},delta=compactRoomSnapshot(later,ticket.entry.key);
 assert.equal('legalActions' in delta.game,false);assert.equal(delta.game.legalActionsOmitted,true);
 const restored=c.restore(ticket,delta);assert.deepEqual(restored,{...later,legal_actions_key:full.legal_actions_key});assert.equal(restored.game.legalActions,first.game.legalActions);
 assert.throws(()=>first.game.legalActions.pop(),TypeError);assert.throws(()=>first.game.legalActions[0].segments[0].steps=999,TypeError);
 assert.ok(gzipSync(JSON.stringify(delta)).length<gzipSync(JSON.stringify(full)).length/3,'real gzip byte reduction including whole room');
});
test('scope, rules and any nested action change invalidate key; unrelated games and small sets stay full',()=>{
 const room=fixture(),key=compactRoomSnapshot(room).legal_actions_key;
 for(const mutate of [r=>r.id='room-b',r=>r.me='p1',r=>r.game.ruleVersion='future',r=>r.game.legalActions[0].segments[0].steps=99]){
  const changed=structuredClone(room);mutate(changed);const full=compactRoomSnapshot(changed,key);assert.ok(Array.isArray(full.game.legalActions));assert.notEqual(full.legal_actions_key,key);
 }
 for(const room of [{game_id:'run',game:{legalActions:Array(10000).fill({type:'jump'})}},{game_id:'jackaroo',game:{legalActions:[]}},{id:'waiting',game:null}])assert.equal(compactRoomSnapshot(room,key),room);
 assert.ok(Array.isArray(compactRoomSnapshot(fixture(),['invalid-header']).game.legalActions));
});
test('overlapping polls restore their captured full set without replacing a newer cache',()=>{
 const c=createSnapshotTransfer(),a=fixture(),full=compactRoomSnapshot(a);c.restore(c.begin(path,true),full);
 const old=c.begin(path,true),newer=c.begin(path,true),b=structuredClone(a);b.version=3;b.game.legalActions[0].segments[0].steps=3;
 const newFull=compactRoomSnapshot(b);c.restore(newer,newFull);
 const restored=c.restore(old,compactRoomSnapshot({...a,version:2},old.entry.key));assert.deepEqual(restored.game.legalActions,a.game.legalActions);assert.equal(c.begin(path,true).entry.key,newFull.legal_actions_key);
});
test('authorization reset, room identity, missing cache and key mismatch never merge another private hand',()=>{
 const c=createSnapshotTransfer(),full=compactRoomSnapshot(fixture());c.restore(c.begin(path,true),full);const old=c.begin(path,true),delta=compactRoomSnapshot(fixture(),old.entry.key);
 for(const changed of [delta,{...delta,me:'p1'},{...delta,id:'room-b'},{...delta,legal_actions_key:'f'.repeat(64)}])assert.throws(()=>c.restore(c.begin('/api/pvp/rooms/unknown',true),changed),{code:'SNAPSHOT_REFRESH_REQUIRED'});
 c.clear();assert.equal(c.begin(path,true).entry,undefined);assert.throws(()=>c.restore(old,delta),{code:'SESSION_CHANGED'});
});
test('cache is bounded to two rooms; a small authoritative action set clears the old entry',()=>{
 const c=createSnapshotTransfer();for(const id of ['room-a','room-b','room-c']){const r=fixture();r.id=id;const p='/api/pvp/rooms/'+id;c.restore(c.begin(p,true),compactRoomSnapshot(r));}
 assert.equal(c.begin(path,true).entry,undefined);const p='/api/pvp/rooms/room-c';assert.ok(c.begin(p,true).entry);
 const small=fixture();small.id='room-c';small.version=2;small.game.legalActions=[];c.restore(c.begin(p,true),small);assert.equal(c.begin(p,true).entry,undefined);
 assert.equal(c.begin('/api/arena/session',true).enabled,false);assert.equal(c.begin(path,false).enabled,false);
});
test('client opts in only to GET snapshots and retries a malformed omission once without replaying actions',async()=>{
 const original=globalThis.fetch,reads=[],c=await import('../arena/shared/client.mjs?transfer-test='+Date.now());c.authorize('token-a');
 let calls=0;const room=fixture();
 globalThis.fetch=async(url,o)=>{reads.push(o);calls++;if(calls===3)return Response.json({id:room.id,me:room.me,legal_actions_key:'f'.repeat(64),game:{legalActionsOmitted:true}});return Response.json(compactRoomSnapshot({...room,version:calls},o.headers['X-Oasis-Known-Actions']));};
 try{
  await c.api(path);await c.api(path);assert.equal(reads[0].headers['X-Oasis-Known-Actions'],undefined);assert.match(reads[1].headers['X-Oasis-Known-Actions'],/^[a-f0-9]{64}$/);
  const recovered=await c.api(path);assert.equal(recovered.game.legalActions.length,3664);assert.equal(reads.length,4);assert.equal(reads[3].headers['X-Oasis-Known-Actions'],undefined);
  await c.api(path+'/action',{seq:1,action:{type:'pass'}});assert.equal(reads.length,5);assert.equal(reads[4].headers['X-Oasis-Known-Actions'],undefined);assert.equal(reads[4].method,'POST');
  c.authorize('token-b');await c.api(path);assert.equal(reads.at(-1).headers['X-Oasis-Known-Actions'],undefined);
 }finally{globalThis.fetch=original;c.authorize('');}
});
test('an accepted POST response from an obsolete authorization is discarded without replay',async()=>{
 const original=globalThis.fetch,c=await import('../arena/shared/client.mjs?identity-test='+Date.now());let finish,calls=0;
 c.authorize('old-user');globalThis.fetch=async()=>{calls++;return new Promise(resolve=>finish=()=>resolve(Response.json({id:'old-room',me:'old-user',version:9,me_last_seq:1})));};
 try{const pending=c.api('/api/pvp/rooms/old-room/action',{seq:1,action:{type:'pass'}});c.authorize('new-user');finish();await assert.rejects(pending,{code:'SESSION_CHANGED'});assert.equal(calls,1,'already sent POST is never retried');}
 finally{globalThis.fetch=original;c.authorize('');}
});
test('a late 401 from a previous token cannot invalidate the freshly authorized session',async()=>{
 const original=globalThis.fetch,c=await import('../arena/shared/client.mjs?late-401-test='+Date.now());let finish;
 c.authorize('old-user');globalThis.fetch=()=>new Promise(resolve=>finish=()=>resolve(Response.json({error:{code:'SESSION_EXPIRED'}},{status:401})));
 try{const pending=c.api('/api/arena/session');c.authorize('new-user');finish();await assert.rejects(pending,{code:'SESSION_CHANGED'});}
 finally{globalThis.fetch=original;c.authorize('');}
});
