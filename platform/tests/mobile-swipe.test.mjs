import test from 'node:test';
import assert from 'node:assert/strict';
import {createCardinalSwipe} from '../arena/match/swipe-gesture.mjs';
import {canSendRunInput} from '../arena/run/input-actions.mjs';
import * as Run from '../arena/run/engine.mjs';
const point=(x=0,y=0,id=1,extra={})=>({clientX:x,clientY:y,pointerId:id,button:0,isPrimary:true,...extra});

test('single-finger cardinal directions preserve origin and resolve once',()=>{
 for(const [x,y,direction] of [[40,2,'right'],[-40,2,'left'],[2,-40,'up'],[2,40,'down']]){
  const swipe=createCardinalSwipe();assert.equal(swipe.start(point(),12),true);
  swipe.move(point(x,y));assert.deepEqual(swipe.end(point(x,y)),{kind:'swipe',direction,meta:12});
  assert.equal(swipe.end(point(x,y)),null);assert.equal(swipe.blocksClick({detail:1}),true);
 }
});
test('tap jitter, short drag, diagonal and out-and-back have distinct safe outcomes',()=>{
 const swipe=createCardinalSwipe();swipe.start(point(),3);assert.equal(swipe.end(point(2,3)).kind,'tap');
 swipe.cancel(point(2,3));assert.equal(swipe.blocksClick({detail:1}),false,'Implicit capture loss after pointerup must not swallow a tap');
 for(const [x,y] of [[10,0],[30,29]]){swipe.start(point(),3);assert.equal(swipe.end(point(x,y)).kind,'cancel');assert.equal(swipe.blocksClick({detail:1}),true);}
 swipe.start(point(),3);swipe.move(point(40,0));assert.equal(swipe.end(point(0,0)).kind,'cancel');
});
test('secondary fingers, wrong pointerup, cancellation and lost capture cannot complete another gesture',()=>{
 const swipe=createCardinalSwipe();swipe.start(point(),4);assert.equal(swipe.end(point(40,0,2)),null);assert.equal(swipe.end(point(40,0)).kind,'swipe');
 swipe.start(point(),4);assert.equal(swipe.start(point(0,0,2,{isPrimary:false}),5),false);assert.equal(swipe.end(point(40,0)),null);
 swipe.start(point(),4);swipe.cancel(point());assert.equal(swipe.end(point(40,0)),null);
 assert.equal(swipe.blocksClick({detail:1}),true);assert.equal(swipe.blocksClick({detail:0}),false,'Keyboard activation remains available');
 swipe.start(point(),5);swipe.end(point());assert.equal(swipe.blocksClick({detail:1}),false,'The next intentional tap clears drag click suppression');
});
test('run dispatch checks current lane, action, stun, fall, deadline and roster state',()=>{
 const game=Run.view(Run.createState('12'.repeat(32),10000,{players:[{key:'p0',seatIndex:0},{key:'p1',seatIndex:1}]}),'p0'),p=game.players[0];
 for(const type of ['left','right','jump','slide'])assert.equal(canSendRunInput(game,'p0',type,10000),true);
 assert.equal(canSendRunInput(game,'p0','item',10000),false);p.inventory='shield';assert.equal(canSendRunInput(game,'p0','item',10000),true);
 p.lane=0;assert.equal(canSendRunInput(game,'p0','left',10000),false);p.lane=2;assert.equal(canSendRunInput(game,'p0','right',10000),false);p.lane=1;
 p.jumpStartTick=0;assert.equal(canSendRunInput(game,'p0','jump',10200),false);assert.equal(canSendRunInput(game,'p0','slide',10200),false);p.jumpStartTick=null;
 p.stunUntilTick=48;assert.equal(canSendRunInput(game,'p0','left',10200),false);p.stunUntilTick=0;
 p.fallUntilTick=90;assert.equal(canSendRunInput(game,'p0','jump',12000),false,'Wait for confirmed respawn even after its projected time');p.fallUntilTick=null;
 assert.equal(canSendRunInput(game,'p0','jump',9999),false);assert.equal(canSendRunInput(game,'p0','jump',game.deadlineAt),false);
 p.forfeited=true;assert.equal(canSendRunInput(game,'p0','jump',10000),false);
});
