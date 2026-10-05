import test from 'node:test';
import assert from 'node:assert/strict';
import {createRoomPollCadence} from '../arena/shared/room-poller.mjs';

function fixture(game='golf'){
 let time=0,room={id:'one',status:'waiting'};
 const interval=createRoomPollCadence({game,readRoom:()=>room,now:()=>time});
 return {interval,time:at=>{time=at;},room:value=>{room=value;}};
}
test('funding burst lasts only two seconds despite fresh snapshots',()=>{
 const f=fixture();assert.equal(f.interval(),500);
 f.time(400);f.room({id:'one',status:'funding',version:2});assert.equal(f.interval(),100);
 f.time(2399);f.room({id:'one',status:'funding',version:99});assert.equal(f.interval(),100);
 f.time(2400);assert.equal(f.interval(),500);f.time(100000);assert.equal(f.interval(),500);
});
test('leaving funding immediately restores the normal cadence',()=>{
 for(const game of ['run','golf','towerlink']){
  const f=fixture(game);f.room({id:'one',status:'funding'});assert.equal(f.interval(),100);
  f.time(200);f.room({id:'one',status:'active'});assert.equal(f.interval(),game==='run'?150:500);
  f.room(null);assert.equal(f.interval(),500);
 }
});
test('a different room and a true funding re-entry get their own bounded window',()=>{
 const f=fixture();f.room({id:'one',status:'funding'});assert.equal(f.interval(),100);
 f.time(3000);assert.equal(f.interval(),500);
 f.room({id:'two',status:'funding'});assert.equal(f.interval(),100);
 f.time(5000);assert.equal(f.interval(),500);
 f.room({id:'two',status:'fault'});assert.equal(f.interval(),500);
 f.room({id:'two',status:'funding'});assert.equal(f.interval(),100);
 f.time(7000);assert.equal(f.interval(),500);
});
test('background wall-clock time does not extend the funding burst',()=>{
 const f=fixture();f.room({id:'one',status:'funding'});assert.equal(f.interval(),100);
 f.time(30000);assert.equal(f.interval(),500);
});
