import {test} from 'node:test';
import assert from 'node:assert/strict';
import {RateLimiter,ApiRateLimits,apiRateConfiguration,demoRateConfiguration} from '../server/rate-limit.mjs';
test('players and Apps have independent budgets, without a shared IP or 100-player ceiling',async()=>{
 const limiter=new ApiRateLimits({env:{},now:()=>0});
 for(let i=0;i<240;i++){
  const session=await limiter.authenticate('one-shared-IP',async()=>({app_id:'app',external_user_id:'user'+i}));
  for(let j=0;j<450;j++)limiter.player(session,'pvp','GET');
 }
 const a={app_id:'app',external_user_id:'user0'};
 for(let i=450;i<900;i++)limiter.player(a,'pvp','GET');
 assert.throws(()=>limiter.player(a,'pvp','GET'),e=>e.status===429&&e.retryAfterSeconds===60);
 assert.doesNotThrow(()=>limiter.player({app_id:'other-app',external_user_id:'user0'},'pvp','GET'));
 assert.doesNotThrow(()=>limiter.player({app_id:'app',external_user_id:'user1'},'pvp','GET'));
 assert.equal(limiter.addresses.buckets.size,0);
});
test('run polling does not consume the action budget and full legal input rate fits',()=>{
 const limiter=new ApiRateLimits({env:{},now:()=>0}),s={app_id:'run-app',external_user_id:'runner'};
 for(let i=0;i<900;i++)limiter.player(s,'pvp','GET');
 for(let i=0;i<600;i++)limiter.player(s,'pvp','POST','/api/pvp/rooms/room/action');
 for(let i=600;i<720;i++)limiter.player(s,'pvp','POST','/api/pvp/rooms/room/action');
 assert.throws(()=>limiter.player(s,'pvp','POST','/api/pvp/rooms/room/action'),e=>e.status===429);
 assert.doesNotThrow(()=>limiter.player(s,'pvp','POST','/api/pvp/rooms/room/leave'));
});
test('Run input batches share the action budget and cannot exhaust the independent leave budget',()=>{
 const limiter=new ApiRateLimits({env:{OASIS_RATE_PVP_ACTION_PER_MINUTE:'2',OASIS_RATE_PVP_ROOM_WRITE_PER_MINUTE:'1'},now:()=>0}),s={app_id:'app',external_user_id:'runner'};
 limiter.player(s,'pvp','POST','/api/pvp/rooms/room/inputs');
 limiter.player(s,'pvp','POST','/api/pvp/rooms/room/action');
 assert.throws(()=>limiter.player(s,'pvp','POST','/api/pvp/rooms/room/inputs'),e=>e.status===429);
 assert.doesNotThrow(()=>limiter.player(s,'pvp','POST','/api/pvp/rooms/room/leave'));
});
test('probability reads/writes and partner Apps are separately limited',()=>{
 const limiter=new ApiRateLimits({env:{OASIS_RATE_PROBABILITY_READ_PER_MINUTE:'2',OASIS_RATE_PROBABILITY_WRITE_PER_MINUTE:'2',OASIS_RATE_PARTNER_READ_PER_MINUTE:'2',OASIS_RATE_PARTNER_WRITE_PER_MINUTE:'2'},now:()=>0}),s={app_id:'app',external_user_id:'user'};
 for(let i=0;i<2;i++){limiter.player(s,'probability','GET');limiter.partner({id:'app'},'GET');}
 assert.throws(()=>limiter.player(s,'probability','GET'),e=>e.status===429);
 assert.throws(()=>limiter.partner({id:'app'},'GET'),e=>e.status===429);
 assert.doesNotThrow(()=>limiter.player(s,'probability','POST'));
 assert.doesNotThrow(()=>limiter.partner({id:'app'},'POST'));
 assert.doesNotThrow(()=>limiter.partner({id:'other-app'},'GET'));
});
test('failed authentication is IP-limited without denying a valid identity on that IP',async()=>{
 const limiter=new ApiRateLimits({env:{OASIS_RATE_AUTH_FAILURE_IP_PER_MINUTE:'2'},now:()=>0});
 const bad=()=>{throw Object.assign(new Error('Denied'),{status:401,code:'SESSION_REQUIRED'});};
 for(let i=0;i<2;i++)await assert.rejects(limiter.authenticate('shared',bad),e=>e.status===401);
 await assert.rejects(limiter.authenticate('shared',bad),e=>e.status===429&&e.retryAfterSeconds===60);
 assert.deepEqual(await limiter.authenticate('shared',async()=>({id:'valid'})),{id:'valid'});
 await assert.rejects(limiter.authenticate('other',bad),e=>e.status===401);
 assert.doesNotMatch(JSON.stringify([...limiter.addresses.buckets.keys()]),/Bearer|token/);
});
test('invalid limits fail configuration before requests, with no silent zero/infinite disable',()=>{
 for(const value of ['',0,'0','-1','1.5','Infinity','NaN','1000001',' 12','0x10']){
  assert.throws(()=>apiRateConfiguration({OASIS_RATE_PVP_ACTION_PER_MINUTE:value}),/INVALID_RATE_LIMIT_CONFIG/);
  assert.throws(()=>demoRateConfiguration({OASIS_RATE_DEMO_ANONYMOUS_IP_PER_MINUTE:value}),/INVALID_RATE_LIMIT_CONFIG/);
 }
 assert.equal(apiRateConfiguration({OASIS_RATE_PVP_ACTION_PER_MINUTE:'750'}).PVP_ACTION,750);
});
test('bucket memory is bounded, expiration reclaims room, boundary starts fresh window',()=>{
 let time=0;const limiter=new RateLimiter({maxBuckets:2,now:()=>time});
 assert.ok(limiter.take('a',1));assert.equal(limiter.take('a',1),false);assert.ok(limiter.take('b',1));assert.equal(limiter.take('c',1),false);
 time=60000;assert.ok(limiter.take('c',1));assert.ok(limiter.take('a',1));assert.equal(limiter.buckets.size,2);
});
test('Retry-After reflects the remaining window and the original bucket resets at expiry',()=>{
 let now=0;const limiter=new RateLimiter({now:()=>now});limiter.consume('identity',1);now=12345;
 assert.throws(()=>limiter.consume('identity',1),e=>e.code==='RATE_LIMITED'&&e.retryAfterSeconds===48);
 now=60000;assert.doesNotThrow(()=>limiter.consume('identity',1));
});
