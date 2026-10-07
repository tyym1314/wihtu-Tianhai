import test from 'node:test';
import assert from 'node:assert/strict';
import {createPlayerClient,playerMessage} from '../src/pages/PlayerClient.mjs';

const response=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
const fixture=(fetch,extra={})=>createPlayerClient({appId:'app_one',origin:'https://player.example.invalid',fetch,requestId:()=> 'intent_one',...extra});

test('player client sends only same-origin HttpOnly session requests and uses current CSRF for writes',async()=>{
 const calls=[],client=fixture(async(url,options)=>{calls.push({url,options});return response(url.endsWith('/session')?{csrf_token:'new_csrf'}:{});});
 await client.metadata();await client.session();await client.logout();
 assert.equal(calls[0].url,'/api/player/app?app_id=app_one');
 for(const {options} of calls){assert.equal(options.credentials,'same-origin');assert.equal(options.cache,'no-store');assert.equal(options.headers.authorization,undefined);}
 assert.equal(calls[2].options.headers['x-oasis-csrf'],'new_csrf');assert.deepEqual(JSON.parse(calls[2].options.body),{});
});

test('uncertain launch retry and manual retry preserve exact request body and request ID',async()=>{
 const bodies=[];let fail=true;
 const launch=fixture(async(url,options)=>{bodies.push(options.body);if(fail)throw new TypeError('network disconnected');return response({session_id:'accepted_session'});}).launchRequester('match');
 await assert.rejects(launch({gameId:'match'}));assert.equal(bodies.length,2);fail=false;
 assert.deepEqual(await launch({gameId:'match'}),{session_id:'accepted_session'});assert.equal(new Set(bodies).size,1);
 assert.equal(JSON.parse(bodies[0]).external_user_id,undefined);
});

test('reauthorization binds original game, App and session and uses a new request ID',async()=>{
 const bodies=[];let sequence=0;
 const launch=fixture(async(url,options)=>{bodies.push(JSON.parse(options.body));return response({session_id:'original_session'});},{requestId:()=> 'intent_'+(++sequence)}).launchRequester('run');
 await launch({gameId:'run'});await launch({gameId:'run',resumeSessionId:'original_session'});
 assert.equal(bodies[1].resume_session_id,'original_session');assert.equal(bodies[1].app_id,'app_one');assert.equal(bodies[1].game_id,'run');assert.notEqual(bodies[0].request_id,bodies[1].request_id);
 await assert.rejects(launch({gameId:'match'}),/GAME_SELECTION_CHANGED/);assert.equal(bodies.length,2);
});

test('known admission denial and rate limits never automatically replay; expired auth requests login',async()=>{
 for(const status of [401,403,409,429]){
  let calls=0,expired=0;
  const launch=fixture(async()=>{calls++;return response({error:{code:status===401?'LOGIN_REQUIRED':'PRODUCTION_ACCEPTANCE_REQUIRED'}},status);},{onExpired:()=>expired++}).launchRequester('match');
  await assert.rejects(launch({gameId:'match'}));assert.equal(calls,1);assert.equal(expired,status===401?1:0);
 }
 assert.match(playerMessage({status:404,code:'NOT_FOUND'}),/暂不可用/);
});

test('abort stops retries when the player leaves while a launch is in flight',async()=>{
 const controller=new AbortController();let calls=0;
 const launch=fixture(async(url,options)=>{calls++;controller.abort();throw new DOMException('Aborted','AbortError');}).launchRequester('match');
 await assert.rejects(launch({gameId:'match',signal:controller.signal}));assert.equal(calls,1);
});
