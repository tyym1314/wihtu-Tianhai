import test from 'node:test';
import assert from 'node:assert/strict';
import {startVisibleInterval} from '../arena/shared/visible-interval.mjs';
test('presentation intervals stop hidden, refresh immediately on return, and remove their listener',()=>{
 const target=new EventTarget();target.hidden=false;let reads=0,next=0;const timers=new Map(),stop=startVisibleInterval(()=>reads++,80,{target,setTimer:(f,ms)=>{assert.equal(ms,80);timers.set(++next,f);return next;},clearTimer:id=>timers.delete(id)});
 assert.equal(reads,1);assert.equal(timers.size,1);[...timers.values()][0]();assert.equal(reads,2);
 target.hidden=true;target.dispatchEvent(new Event('visibilitychange'));assert.equal(timers.size,0);assert.equal(reads,2);
 target.hidden=false;target.dispatchEvent(new Event('visibilitychange'));assert.equal(timers.size,1);assert.equal(reads,3);
 stop();assert.equal(timers.size,0);target.dispatchEvent(new Event('visibilitychange'));assert.equal(timers.size,0);assert.equal(reads,3);
});
test('initially hidden pages do not start an interval or sample a stale display',()=>{
 const target=new EventTarget();target.hidden=true;let calls=0;const stop=startVisibleInterval(()=>calls++,50,{target,setTimer:()=>assert.fail('hidden interval'),clearTimer:()=>assert.fail('no interval exists')});assert.equal(calls,0);stop();
});
