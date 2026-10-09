import assert from 'node:assert/strict';
import test from 'node:test';
import {createGolfSourceCache} from '../asset-generation-cache.mjs';
const deferred=()=>{let resolve,reject;return{promise:new Promise((a,b)=>{resolve=a;reject=b;}),resolve:value=>resolve(value),reject:error=>reject(error)};};
test('shared course generation survives one cancellation and successful source remains reusable',async()=>{
 const pending=deferred(),signals=[];let loads=0;const cache=createGolfSourceCache((key,signal)=>{loads++;signals.push(signal);return pending.promise;}),a=new AbortController(),b=new AbortController();
 const first=cache('1',{signal:a.signal}),second=cache('1',{signal:b.signal});await Promise.resolve();a.abort();await assert.rejects(first,{name:'AbortError'});assert.equal(signals[0].aborted,false);
 const source={course:1};pending.resolve(source);assert.equal(await second,source);b.abort();assert.equal(await cache('1'),source);assert.equal(loads,1);
});
test('last cancellation retires generation and late failure cannot discard its retry',async()=>{
 const jobs=[];const cache=createGolfSourceCache((key,signal)=>{const job=deferred();jobs.push({...job,key,signal});return job.promise;}),controller=new AbortController();
 const old=cache('2',{signal:controller.signal});await Promise.resolve();controller.abort();await assert.rejects(old,{name:'AbortError'});assert.equal(jobs[0].signal.aborted,true);
 const retry=cache('2');await Promise.resolve();jobs[0].reject(new Error('Retired download failed'));jobs[1].resolve({fresh:true});const source=await retry;assert.equal(await cache('2'),source);assert.equal(jobs.length,2);
});
test('failed course is retryable without evicting independent common source',async()=>{
 const attempts=new Map(),common={botanicals:true};const cache=createGolfSourceCache(async key=>{const n=(attempts.get(key)||0)+1;attempts.set(key,n);if(key==='common')return common;if(n===1)throw new Error('Decode failed');return{course:key};});
 assert.equal(await cache('common'),common);await assert.rejects(cache('0'),/Decode failed/);assert.deepEqual(await cache('0'),{course:'0'});assert.equal(await cache('common'),common);assert.equal(attempts.get('common'),1);
});
