import test from 'node:test';
import assert from 'node:assert/strict';
import {createTowerClock} from '../presentation-clock.mjs';

test('a faster response rebases once to confirmed simulation time and immediately keeps moving',()=>{
 const clock=createTowerClock(1000,0);
 assert.equal(clock.now(600),1600);
 clock.receive(1840,1750,600);
 assert.equal(clock.now(600),1750);
 for(let at=610,last=1750;at<=900;at+=10){const now=clock.now(at);assert.ok(now>last);assert.ok(now-last>=9-1e-8&&now-last<=11+1e-8);last=now;}
});
test('slower responses slew monotonically instead of stepping the render clock backwards',()=>{
 const clock=createTowerClock(1000,0);
 assert.equal(clock.now(600),1600);
 clock.receive(1360,1250,600);
 let last=clock.now(600);
 for(let at=610;at<=1600;at+=10){const now=clock.now(at);assert.ok(now>last);assert.ok(now-last>=9-1e-8&&now-last<=11+1e-8);last=now;}
});
test('future simulationAt during the ready countdown does not skip the countdown',()=>{
 const clock=createTowerClock(1000,0);
 clock.receive(1000,3000,0);
 assert.equal(clock.now(0),1000);
 assert.equal(clock.now(500),1500);
 clock.receive(1600,3000,600);
 assert.equal(clock.now(600),1600);
});
test('older snapshot clocks cannot reset the target or refresh the last receipt',()=>{
 const clock=createTowerClock(1000,0);
 clock.receive(1600,1500,600);
 const before=clock.now(650);
 assert.equal(clock.receive(1300,1250,700),false);
 assert.equal(clock.serverAt,1600);
 assert.equal(clock.lastReceipt,600);
 assert.equal(clock.now(750),before+100);
});
test('scene extrapolation remains capped at 1400 ms and can resume after a new snapshot',()=>{
 const clock=createTowerClock(1000,0);
 const visual=local=>Math.min(clock.now(local),clock.serverAt+1400);
 assert.equal(visual(1000),2000);
 assert.equal(visual(1400),2400);
 assert.equal(visual(5000),2400);
 clock.receive(6000,5875,5000);
 assert.equal(visual(5000),6000);
 assert.equal(visual(5010),6010);
 assert.equal(visual(10000),7400);
});
