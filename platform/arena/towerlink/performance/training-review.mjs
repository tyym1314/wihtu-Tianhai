/** Reproducible legal-action playthroughs and idle controls; no service or wallet. */
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {TRAINING_VERSION,TRAINING_LESSONS} from '../training.mjs';
import {make,play} from '../../../tests/fixtures/towerlink-training-scenarios.mjs';
const out=new URL('./usability/training-validation.json',import.meta.url),results=[];
for(const lesson of TRAINING_LESSONS){
 const initial=make(lesson.number),successTrace=[],idleTrace=[],success=play(lesson.number,{trace:successTrace}),idle=play(lesson.number,{idle:true,trace:idleTrace});
 assert.equal(success.training.completed,true);assert.equal(idle.training.completed,false);assert.ok(idleTrace.some(t=>t.player!=='p0'));
 const summary=(state,trace)=>({durationMs:state.finishedAt-state.startedAt,completed:state.training.completed,failed:state.training.failed,reason:state.finishReason,winnerKeys:state.winnerKeys,heldTowers:state.owners.filter(owner=>owner==='p0').length,playerCommands:trace.filter(t=>t.player==='p0').length,aiCommands:trace.filter(t=>t.player!=='p0').length,progress:state.training.progress,trace});
 results.push({lessonId:lesson.id,title:lesson.title,objective:lesson.objective,graph:{towers:initial.towers.length,edges:initial.edges,terrain:initial.board.terrain??null},ai:initial.training.botProfile,success:summary(success,successTrace),idle:summary(idle,idleTrace)});
}
await mkdir(new URL('./usability/',import.meta.url),{recursive:true});await writeFile(out,JSON.stringify({trainingVersion:TRAINING_VERSION,scope:'Deterministic server simulation. Both sides use legal commands; learner commands have at least 500 ms spacing. Idle controls actually execute opponent AI. Not proof of human difficulty or competitive balance.',results},null,2));
console.table(results.map(r=>({lesson:r.lessonId,title:r.title,seconds:r.success.durationMs/1000,human:r.success.playerCommands,ai:r.success.aiCommands,idleSeconds:r.idle.durationMs/1000,idleAi:r.idle.aiCommands,idleWon:r.idle.completed})));
