import test from 'node:test';
import assert from 'node:assert/strict';
import {waitForPlayerForegroundRestoration} from '../scripts/android-player-acceptance.mjs';

const expected='com.miui.home/.launcher.Launcher';
const activity=component=>`topResumedActivity=ActivityRecord{abc u0 ${component} t1}`;
const clock=()=>{let at=0;const waits=[];return{now:()=>at,wait:async ms=>{waits.push(ms);at+=ms;},advance:ms=>{at+=ms;},waits};};

test('foreground restoration waits through zero and foreign activity until exact original component',async()=>{
 const time=clock(),rows=['No resumed activity',activity('owned.qa/.MainActivity'),activity(expected)];let reads=0;
 assert.equal(await waitForPlayerForegroundRestoration(async()=>{reads++;return rows.shift();},expected,time),expected);
 assert.equal(reads,3);assert.deepEqual(time.waits,[100,100]);
});

test('persistent zero foreground refuses at the 10 second deadline without adopting an activity',async()=>{
 const time=clock();let reads=0;
 await assert.rejects(waitForPlayerForegroundRestoration(async()=>{reads++;return 'No resumed activity';},expected,time),/ORIGINAL_FOREGROUND_NOT_RESTORED_TIMEOUT/);
 assert.equal(reads,100);assert.equal(time.now(),10000);assert.equal(time.waits.length,100);assert.ok(time.waits.every(ms=>ms===100));
});

test('multiple distinct resumed components immediately retain the original assertion',async()=>{
 const time=clock();let reads=0;
 await assert.rejects(waitForPlayerForegroundRestoration(async()=>{reads++;return activity(expected)+'\n'+activity('owned.qa/.MainActivity');},expected,time),error=>error instanceof assert.AssertionError&&error.code==='ERR_ASSERTION'&&error.actual===2&&error.expected===1&&error.message.startsWith('ANDROID_FOREGROUND_UNPROVEN'));
 assert.equal(reads,1);assert.deepEqual(time.waits,[]);
});

test('read errors and nonzero-activity parser failures are never swallowed',async()=>{
 const failure=new assert.AssertionError({actual:0,expected:1,operator:'strictEqual',message:'ANDROID_FOREGROUND_UNPROVEN'});
 const time=clock();
 await assert.rejects(waitForPlayerForegroundRestoration(async()=>{throw failure;},expected,time),error=>error===failure);
 await assert.rejects(waitForPlayerForegroundRestoration(async()=>null,expected,time),TypeError);
 assert.deepEqual(time.waits,[]);
});

test('an exact component observed only after the deadline cannot prove timely restoration',async()=>{
 const time=clock();let reads=0;
 await assert.rejects(waitForPlayerForegroundRestoration(async()=>{reads++;time.advance(10000);return activity(expected);},expected,time),/ORIGINAL_FOREGROUND_NOT_RESTORED_TIMEOUT/);
 assert.equal(reads,1);assert.deepEqual(time.waits,[]);
});
