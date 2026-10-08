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


test('password change sends only current/new credentials, clears CSRF after confirmed success and never returns passwords',async()=>{
 const calls=[],client=fixture(async(url,options)=>{calls.push({url,options});return response(url.endsWith('/session')?{csrf_token:'password_csrf'}:url.endsWith('/password')?{ok:true,reauthenticate:true}:{});});
 await client.session();
 assert.deepEqual(await client.changePassword('Current-fixture-only!','New-password-fixture-only!'),{ok:true,reauthenticate:true});
 const changed=calls[1];assert.equal(changed.url,'/api/player/password');assert.equal(changed.options.headers['x-oasis-csrf'],'password_csrf');
 assert.deepEqual(JSON.parse(changed.options.body),{current_password:'Current-fixture-only!',new_password:'New-password-fixture-only!'});
 assert.equal(changed.options.credentials,'same-origin');assert.equal(changed.options.cache,'no-store');
 await client.logout();assert.equal(calls[2].options.headers['x-oasis-csrf'],undefined);
});

test('password change does not replay uncertain writes; a definite denial retains the CSRF for manual retry',async()=>{
 for(const result of ['network','invalid',400]){
  let calls=0;const headers=[];
  const client=fixture(async(url,options)=>{if(url.endsWith('/session'))return response({csrf_token:'existing_csrf'});calls++;headers.push(options.headers);if(result==='network')throw new TypeError('disconnected');return response(result==='invalid'?{}:{error:{code:'CURRENT_PASSWORD_INVALID'}},result===400?400:200);});
  await client.session();await assert.rejects(client.changePassword('Current-fixture-only!','New-fixture-only!'));assert.equal(calls,1);
  await assert.rejects(client.changePassword('Current-fixture-only!','New-fixture-only!'));assert.equal(calls,2);
  assert(headers.every(value=>value['x-oasis-csrf']==='existing_csrf'));
 }
 assert.match(playerMessage({code:'CURRENT_PASSWORD_INVALID'}),/当前密码不正确/);
 assert.match(playerMessage({code:'PASSWORD_UNCHANGED'}),/不能.*相同/);
});
