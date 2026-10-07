import test from 'node:test';
import assert from 'node:assert/strict';
import {makeRunActionReceipt,readRunActionReceipt} from '../shared/run-action-receipt.mjs';
import * as E from '../arena/run/engine-v1.mjs';
const expected={roomId:'pvp_receipt_room',playerKey:'human',request_id:'request_receipt_1',seq:1,type:'jump',ruleVersion:'pvp-run-v1.0.0'};
const event={type:'input_accepted',playerKey:'human',input:'jump',inputNo:1,acceptedTick:1,at:1000};
function response(overrides={}){return{id:expected.roomId,me:'human',game_id:'run',me_last_seq:1,status:'active',
 game:{gameId:'run',me:'human',ruleVersion:expected.ruleVersion,status:'active',snapshotTick:0,
 players:[{key:'human',inputNo:1,appliedInputNo:0,forfeited:false,finishTick:null}]},
 action_receipt:makeRunActionReceipt({...expected,event}),...overrides};}

test('receipt is an explicit copy of accepted metadata, bound to original request and scope',()=>{
 const raw=response(),before=structuredClone(raw),receipt=readRunActionReceipt(raw,expected);
 assert.deepEqual(receipt,{roomId:expected.roomId,playerKey:'human',request_id:expected.request_id,seq:1,type:'jump',inputNo:1,acceptedTick:1,ruleVersion:expected.ruleVersion});
 assert.notEqual(receipt,raw.action_receipt);receipt.type='slide';assert.deepEqual(raw,before);
});
test('both historical and current pinned versions support canonical accepted actions',()=>{
 for(const ruleVersion of ['pvp-run-v1.0.0','pvp-run-v2.0.0','pvp-run-v2.1.0','pvp-run-v2.2.0'])for(const type of ['left','right','jump','slide','item','boost','shield']){
  const input=['boost','shield'].includes(type)?'item':type,scope={...expected,ruleVersion,type};
  const receipt=makeRunActionReceipt({...scope,event:{...event,input}});
  const raw=response({action_receipt:receipt});raw.game.ruleVersion=ruleVersion;
  assert.equal(readRunActionReceipt(raw,scope)?.type,input);
 }
});
test('receipt construction cannot turn a rejected, mismatched or malformed engine event into acceptance',()=>{
 for(const invalid of [{...event,type:'jump'},{...event,playerKey:'opponent'},{...event,input:'slide'},
  {...event,inputNo:0},{...event,inputNo:1.5},{...event,acceptedTick:0},{...event,acceptedTick:Infinity},null]){
  assert.throws(()=>makeRunActionReceipt({...expected,event:invalid}),{code:'RUN_ACTION_RECEIPT_INVALID'});
 }
 assert.throws(()=>makeRunActionReceipt({...expected,ruleVersion:'unknown',event}),{code:'RUN_ACTION_RECEIPT_INVALID'});
});
test('missing historical receipt and ordinary GET are compatible null fallbacks',()=>{
 const raw=response();delete raw.action_receipt;
 for(const value of [raw,null,undefined,{},[],42])assert.equal(readRunActionReceipt(value,expected),null);
});
test('any original intent identity or action mismatch cancels receipt use',()=>{
 for(const [key,value]of Object.entries({roomId:'pvp_other_room',playerKey:'opponent',request_id:'request_receipt_2',seq:2,type:'slide',ruleVersion:'pvp-run-v2.2.0'})){
  assert.equal(readRunActionReceipt(response(),{...expected,[key]:value}),null,key);
 }
 for(const key of Object.keys(expected)){const value={...expected};delete value[key];assert.equal(readRunActionReceipt(response(),value),null,key);}
});
test('wrong response room/user/sequence and forged receipt fields are refused',()=>{
 for(const [key,value]of Object.entries({id:'pvp_other_room',me:'opponent',game_id:'golf',me_last_seq:2,status:'cancelled'}))assert.equal(readRunActionReceipt(response({[key]:value}),expected),null,key);
 for(const [key,value]of Object.entries({seq:2,inputNo:2,acceptedTick:2,extra:'untrusted'})){
  const raw=response();raw.action_receipt[key]=value;assert.equal(readRunActionReceipt(raw,expected),null,key);
 }
});
test('the raw response must prove an accepted next-tick input, not an already-applied or different runner',()=>{
 for(const patch of [{inputNo:2},{appliedInputNo:1},{appliedInputNo:-1},{forfeited:true},{finishTick:1}]){
  const raw=response();Object.assign(raw.game.players[0],patch);assert.equal(readRunActionReceipt(raw,expected),null);
 }
 for(const patch of [{snapshotTick:1},{snapshotTick:-1},{me:'opponent'},{gameId:'golf'},{ruleVersion:'unknown'},{status:'finished'}]){
  const raw=response();Object.assign(raw.game,patch);assert.equal(readRunActionReceipt(raw,expected),null);
 }
 const duplicate=response();duplicate.game.players.push({...duplicate.game.players[0]});assert.equal(readRunActionReceipt(duplicate,expected),null);
});
test('a newer GET merged with an older ACK cannot be used as proof of that ACK',()=>{
 const ack=response();assert.ok(readRunActionReceipt(ack,expected));
 const current=response({me_last_seq:2,version:99});current.game.players[0].inputNo=2;current.game.players[0].appliedInputNo=1;
 assert.equal(readRunActionReceipt(current,expected),null);
 assert.deepEqual(readRunActionReceipt(ack,expected),readRunActionReceipt(structuredClone(ack),expected),'replay yields same identifier; caller still deduplicates');
});
test('receipt projection leaves authority pending until its existing next simulation tick',()=>{
 const state=E.createState('12'.repeat(32),1000,{players:[{key:'human',seatIndex:0},{key:'other',seatIndex:1}]});
 const result=E.act(state,'human',{type:'jump'},1000),before=structuredClone(state);
 const receipt=makeRunActionReceipt({...expected,event:result.event});
 assert.deepEqual(state,before);assert.equal(state.tick,0);assert.equal(state.players[0].jumpStartTick,null);
 assert.equal(state.players[0].pendingInput.no,receipt.inputNo);assert.equal(state.players[0].appliedInputNo,0);
 const raw=response({game:E.view(state,'human'),action_receipt:receipt});assert.deepEqual(readRunActionReceipt(raw,expected),receipt);
 assert.equal('pendingInput'in raw.game.players[0],false);assert.deepEqual(state,before);
});
