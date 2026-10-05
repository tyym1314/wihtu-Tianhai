import test from 'node:test';import assert from 'node:assert/strict';
import {createBoard,createTrainingBoard} from '../arena/towerlink/levels.mjs';
import {TRAINING_LESSONS} from '../arena/towerlink/training.mjs';
import {towerMetrics,layoutTowerPoints,towerHitAt} from '../arena/towerlink/tower-layout.mjs';
for(const[width,height]of[[320,314],[320,320],[360,420],[390,496],[390,540],[430,600]])test(`Independent 48px targets do not overlap at ${width}x${height}`,()=>{
 const maps=[...Array.from({length:6},(_,i)=>createBoard(2+Math.floor(i/2),i%2)),...TRAINING_LESSONS.slice(0,11).map(createTrainingBoard)];
 for(const map of maps){const copy=structuredClone(map),rotation=map.board.kind==='training'?0:-Math.PI*.75,m=towerMetrics(width,height),pts=layoutTowerPoints(map.towers,width,height,rotation);assert.ok(m.hitWidth>=44&&m.hitHeight>=44);assert.deepEqual(map,copy);
  for(let i=0;i<pts.length;i++){const a=pts[i];assert.equal(towerHitAt(pts,a.x,a.y-m.hitHeight*.41,m),i,`${map.level.id} target ${i} must select itself`);for(let j=i+1;j<pts.length;j++){const b=pts[j];assert.ok(Math.abs(a.x-b.x)>=m.hitWidth-.1||Math.abs(a.y-b.y)>=m.hitHeight-.1,`${map.level.id} targets ${i}/${j} overlap`);}}
  assert.equal(towerHitAt(pts,-100,-100,m),null);assert.equal(towerHitAt(pts,width+100,height+100,m),null);
 }
});
test('Art is smaller than the old renderer at the 390px mobile viewport',()=>{const m=towerMetrics(390,540);assert.ok(m.artWidth*1.05*1.22<62);assert.ok(m.artWidth*1.45<70);});
