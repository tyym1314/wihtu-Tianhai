/** Serial, isolated loading-only batch. No retries and no frame/device acceptance. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {ARENA_IDS} from '../shared/games.mjs';
import {terminateOwnedChild} from './profile-mobile-isolated.mjs';
import {evaluateMobileQuality} from './evaluate-mobile-quality.mjs';

export function loadingBatchPlan(output){
 const base=resolve(output);
 return ['wifi','weak'].flatMap(shape=>[
  {name:`${shape}-arena`,script:'scripts/profile-game-performance.mjs',games:[...ARENA_IDS],report:'baseline.json'},
  {name:`${shape}-probability`,script:'scripts/profile-probability-performance.mjs',games:['thunder','tiger'],report:'report.json'},
 ].map(row=>({...row,shape,output:resolve(base,row.name),repetitions:5,cache_modes:shape==='wifi'?['cold','warm']:['cold'],sample_ms:1000})));
}

export async function assertFreshLoadingOutput(output){let entries;try{entries=await readdir(output);}catch(e){if(e.code==='ENOENT')return;throw e;}if(entries.length)throw new Error('OUTPUT_ALREADY_EXISTS: choose a fresh empty directory; preserving '+resolve(output));}
export function loadingBatchComplete(stages,observations,interrupted){return !interrupted&&stages.length===4&&observations===195&&stages.every(s=>s.process?.code===0&&!s.report_error);}

async function main(){
 const args=process.argv.slice(2);assert(args.length===0||args.length===2&&args[0]==='--out','Usage: profile-mobile-load-batch.mjs [--out directory]');
 const output=resolve(args[1]||process.env.OASIS_PROFILE_OUT||'review/deep-mobile-20260928/final-loading');
 const origin=new URL(process.env.OASIS_PROFILE_ORIGIN||'');
 assert(['localhost','127.0.0.1'].includes(origin.hostname)&&process.env.OASIS_PROFILE_SOURCE_KIND==='isolated-browser','Run this batch under profile-mobile-isolated.mjs');
 await assertFreshLoadingOutput(output);await mkdir(output,{recursive:true});
 const summary={schema_version:'mobile-loading-batch-v1',started_at:new Date().toISOString(),purpose:'Controlled loading only; 1-second activity window cannot pass FRAME-01',expected_observations:195,expected_unscored_primes:13,retries:0,stages:[],interrupted:false};
 let child,cancelChildStop,stopping=false;const reports=[];
 const stop=()=>{stopping=true;summary.interrupted=true;cancelChildStop=terminateOwnedChild(child,{graceMs:5000,onEscalate:()=>{summary.profiler_forced_kill=true;summary.browser_exit_verified=false;}});};
 process.once('SIGTERM',stop);process.once('SIGINT',stop);
 try{
  for(const plan of loadingBatchPlan(output)){
   if(stopping)break;
   const stage={...plan,started_at:new Date().toISOString()};summary.stages.push(stage);
   child=spawn(process.execPath,[plan.script],{cwd:process.cwd(),stdio:'inherit',env:{...process.env,OASIS_PROFILE_QUALITY:'1',OASIS_PROFILE_BROWSER:'chromium',OASIS_PROFILE_CPU:'1',OASIS_PROFILE_SHAPE:plan.shape,OASIS_PROFILE_GAMES:plan.games.join(','),OASIS_PROFILE_REPETITIONS:'5',OASIS_PROFILE_CACHE:plan.cache_modes.join(','),OASIS_PROFILE_SAMPLE_MS:'1000',OASIS_PROFILE_ENTRY:'demo',OASIS_PROFILE_OUT:plan.output,OASIS_PROFILE_SCENARIO:'controlled-loading-only',OASIS_PROFILE_MODE:'',OASIS_PROFILE_CAPACITY:'',OASIS_PROFILE_CPU_PROFILE:'',OASIS_PROFILE_LOCAL_ARENA:'',OASIS_PROFILE_LOCAL_LEGACY:'',OASIS_PROFILE_WORKER_FAULT:'',OASIS_PROFILE_CONTINUOUS:''}});
   stage.process=await new Promise(r=>{child.once('error',e=>r({code:null,error:e.message}));child.once('exit',(code,signal)=>r({code,signal}));});if(cancelChildStop?.done){stage.process_tree=await cancelChildStop.done;if(!stage.process_tree.verified)summary.browser_exit_verified=false;}cancelChildStop?.();cancelChildStop=null;child=null;
   stage.finished_at=new Date().toISOString();
   try{const report=JSON.parse(await readFile(resolve(plan.output,plan.report),'utf8'));reports.push(report);const rows=report.samples||report.games||[];stage.observations=rows.filter(r=>r.cache_mode!=='prime').length;stage.primes=rows.filter(r=>r.cache_mode==='prime').length;stage.recorded_failures=rows.filter(r=>r.error||r.errors?.length||!r.cleanup).length;}catch(e){stage.report_error=e.message;}
   await writeFile(resolve(output,'batch.json'),JSON.stringify(summary,null,2)+'\n');
  }
 }finally{
  process.off('SIGTERM',stop);process.off('SIGINT',stop);cancelChildStop?.();
  summary.finished_at=new Date().toISOString();summary.observations=summary.stages.reduce((n,s)=>n+(s.observations||0),0);summary.collected_all=summary.stages.length===4&&summary.observations===195&&!stopping;summary.completed=loadingBatchComplete(summary.stages,summary.observations,stopping);
  await writeFile(resolve(output,'batch.json'),JSON.stringify(summary,null,2)+'\n');
  await writeFile(resolve(output,'quality-verdict.json'),JSON.stringify(evaluateMobileQuality(reports),null,2)+'\n');
 }
 console.log(JSON.stringify({output,completed:summary.completed,observations:summary.observations,stages:summary.stages.map(s=>({name:s.name,process:s.process,observations:s.observations,recorded_failures:s.recorded_failures}))}));
 if(!summary.completed||summary.stages.some(s=>s.process.code!==0||s.report_error))process.exitCode=1;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)await main();
