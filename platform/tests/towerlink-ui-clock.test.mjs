import test from 'node:test';
import assert from 'node:assert/strict';
import {towerUiClockKey} from '../arena/towerlink/ui-clock.mjs';
test('sub-second canvas motion need not rebuild the Tower HUD, visible seconds do',()=>{
 const g={deadlineAt:180000,startedAt:0,towers:[]};
 assert.equal(towerUiClockKey(g,100,100,0),towerUiClockKey(g,900,900,0));
 assert.notEqual(towerUiClockKey(g,900,900,0),towerUiClockKey(g,1000,1000,0));
});
test('command cooldown and stale connection boundaries update without waiting a full second',()=>{
 const g={deadlineAt:180000,startedAt:0,busyUntil:450,towers:[]};
 assert.notEqual(towerUiClockKey(g,449,449,0),towerUiClockKey(g,450,450,0));
 assert.notEqual(towerUiClockKey(g,8200,8000,0),towerUiClockKey(g,8200,8001,0));
 assert.notEqual(towerUiClockKey(g,8200,8001,0),towerUiClockKey(g,8200,8001,8001));
});
test('start countdown and every tower construction countdown retain their own edges',()=>{
 const g={deadlineAt:180000,startedAt:800,towers:[{upgrade:{completesAt:1750}},{upgrade:{completesAt:2400}}]};
 assert.notEqual(towerUiClockKey(g,749,749,0),towerUiClockKey(g,750,750,0));
 assert.notEqual(towerUiClockKey(g,799,799,0),towerUiClockKey(g,800,800,0));
 assert.notEqual(towerUiClockKey(g,1399,1399,0),towerUiClockKey(g,1400,1400,0));
});
