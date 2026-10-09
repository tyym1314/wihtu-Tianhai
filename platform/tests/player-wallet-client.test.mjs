import test from 'node:test';
import assert from 'node:assert/strict';
import {createPlayerClient,formatPlayerMinor} from '../src/pages/PlayerClient.mjs';

const snapshot={partner_id:'partner_one',app_id:'app_one',environment:'production',wallet_scope_id:'wallet_one',currency_id:'COIN',balance:{external_user_id:'player_app_one',available_minor:'1',reserved_minor:'0',currency_scale:2,ledger_version:'0'},as_of:'2026-10-10T00:00:00.000Z'};
const response=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});

test('wallet client requests only its fixed App with cookie identity, GET and no-store',async()=>{
 const calls=[],client=createPlayerClient({appId:'app_one',origin:'https://player.example.invalid',fetch:async(url,options)=>{calls.push({url,options});return response(snapshot);}});
 assert.deepEqual(await client.wallet(),snapshot);
 assert.equal(calls.length,1);assert.equal(calls[0].url,'/api/player/wallet?app_id=app_one');
 assert.equal(calls[0].options.method,'GET');assert.equal(calls[0].options.credentials,'same-origin');assert.equal(calls[0].options.cache,'no-store');
 assert.equal(calls[0].options.body,undefined);assert.equal(calls[0].options.headers.authorization,undefined);
});

test('minor formatting preserves zero, micro amounts, all allowed scales and int64 precision',()=>{
 for(let scale=0;scale<=6;scale++){
  assert.equal(formatPlayerMinor('0',scale),scale?'0.'+'0'.repeat(scale):'0');
  assert.equal(formatPlayerMinor('1',scale),scale?'0.'+'0'.repeat(scale-1)+'1':'1');
 }
 assert.equal(formatPlayerMinor('101',2),'1.01');assert.equal(formatPlayerMinor('9223372036854775807',6),'9,223,372,036,854.775807');
 for(const invalid of [null,undefined,0,0.01,'01','-1','1.0','1e3','9223372036854775808'])assert.equal(formatPlayerMinor(invalid,2),'—');
 for(const scale of [-1,7,1.5,null])assert.equal(formatPlayerMinor('0',scale),'—');
});

test('wallet validates App, production scope and MoneyBalance; failures never become zero',async()=>{
 const invalids=[null,{}, {...snapshot,app_id:'other_app'},{...snapshot,environment:'sandbox'},{...snapshot,currency_id:'COIN/USD'},{...snapshot,as_of:'invalid'},
  ...[{available_minor:0},{available_minor:'01'},{available_minor:'-1'},{available_minor:'9223372036854775808'},{reserved_minor:undefined},{currency_scale:7},{currency_scale:2.5},{ledger_version:'invalid'},{external_user_id:'player/other'}].map(change=>({...snapshot,balance:{...snapshot.balance,...change}}))];
 for(const value of invalids){const client=createPlayerClient({appId:'app_one',origin:'https://player.example.invalid',fetch:async()=>response(value)});await assert.rejects(client.wallet(),{code:'WALLET_INVALID_BALANCE'});}
 for(const status of [401,403,404,503]){
  let calls=0;const client=createPlayerClient({appId:'app_one',origin:'https://player.example.invalid',fetch:async()=>{calls++;return response({error:{code:'BALANCE_UNAVAILABLE'}},status);}});
  await assert.rejects(client.wallet(),{status});assert.equal(calls,1);
 }
 const network=createPlayerClient({appId:'app_one',origin:'https://player.example.invalid',fetch:async()=>{throw new TypeError('offline');}});
 await assert.rejects(network.wallet(),/offline/);
});

test('wallet read propagates cancellation, with no retry or retained snapshot',async()=>{
 const controller=new AbortController();let signal;
 const client=createPlayerClient({appId:'app_one',origin:'https://player.example.invalid',fetch:async(_url,options)=>{signal=options.signal;return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}));}});
 const pending=client.wallet({signal:controller.signal});controller.abort();await assert.rejects(pending,{name:'AbortError'});assert.equal(signal.aborted,true);
});
