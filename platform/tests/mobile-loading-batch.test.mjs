import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadingBatchPlan,assertFreshLoadingOutput,loadingBatchComplete} from '../scripts/profile-mobile-load-batch.mjs';
test('controlled load plan is WiFi all13 cold5/warm5 then weak all13 cold5',()=>{
 const plan=loadingBatchPlan('/tmp/test-loading-plan');
 assert.deepEqual(plan.map(p=>p.name),['wifi-arena','wifi-probability','weak-arena','weak-probability']);
 assert.equal(new Set(plan.filter(p=>p.shape==='wifi').flatMap(p=>p.games)).size,13);
 assert.equal(plan.reduce((n,p)=>n+p.games.length*p.repetitions*p.cache_modes.length,0),195);
 assert.equal(plan.filter(p=>p.cache_modes.includes('warm')).reduce((n,p)=>n+p.games.length,0),13);
 assert(plan.filter(p=>p.shape==='weak').every(p=>p.cache_modes.join(',')==='cold'));
 assert(plan.every(p=>p.sample_ms===1000));
});

test('old batch artifacts cannot become fresh evidence after a failed child',async()=>{const dir=await fs.mkdtemp(join(tmpdir(),'quality-batch-test-'));try{await assertFreshLoadingOutput(dir);await fs.writeFile(join(dir,'stale.png'),'old');await assert.rejects(()=>assertFreshLoadingOutput(dir),/OUTPUT_ALREADY_EXISTS/);assert.equal(await fs.readFile(join(dir,'stale.png'),'utf8'),'old');}finally{await fs.rm(dir,{recursive:true,force:true});}});
test('all 195 observations with a failed stage are collected but not completed',()=>{const stages=Array.from({length:4},()=>({process:{code:0}}));assert(loadingBatchComplete(stages,195,false));stages[0].process.code=1;assert(!loadingBatchComplete(stages,195,false));stages[0].process.code=0;assert(!loadingBatchComplete(stages,195,true));});
