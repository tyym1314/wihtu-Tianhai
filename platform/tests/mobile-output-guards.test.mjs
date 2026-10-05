import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {assertFreshReportPath} from '../scripts/profile-mobile-isolated.mjs';
test('harness refuses existing reports, directories and dangling symlinks before any service starts',async()=>{
 const dir=await fs.mkdtemp(join(tmpdir(),'oasis-output-guard-'));
 try{const file=join(dir,'report.json');await assertFreshReportPath(file);await fs.writeFile(file,'preserve');await assert.rejects(()=>assertFreshReportPath(file),/OUTPUT_ALREADY_EXISTS/);await assert.rejects(()=>assertFreshReportPath(dir),/OUTPUT_ALREADY_EXISTS/);const link=join(dir,'old-output');await fs.symlink(join(dir,'absent'),link);await assert.rejects(()=>assertFreshReportPath(link),/OUTPUT_ALREADY_EXISTS/);assert.equal(await fs.readFile(file,'utf8'),'preserve');}
 finally{await fs.rm(dir,{recursive:true,force:true});}
});
for(const script of ['profile-game-performance.mjs','profile-probability-performance.mjs'])test(script+' quality mode refuses prior evidence before browser launch',async()=>{
 const dir=await fs.mkdtemp(join(tmpdir(),'oasis-profile-output-'));
 try{await fs.writeFile(join(dir,'previous.json'),'original');const result=spawnSync(process.execPath,['scripts/'+script],{cwd:new URL('..',import.meta.url),encoding:'utf8',env:{...process.env,OASIS_PROFILE_QUALITY:'1',OASIS_PROFILE_OUT:dir,OASIS_PROFILE_BROWSER:'chromium',OASIS_PROFILE_GAMES:script.includes('probability')?'tiger':'run',OASIS_PROFILE_SHAPE:'',OASIS_PROFILE_LOCAL_ARENA:'',OASIS_PROFILE_LOCAL_LEGACY:'',OASIS_PROFILE_WORKER_FAULT:'',OASIS_PROFILE_CONTINUOUS:'',OASIS_PROFILE_REPETITIONS:'1',OASIS_PROFILE_CACHE:'cold'}});assert.notEqual(result.status,0);assert.match(result.stderr,/OUTPUT_ALREADY_EXISTS/);assert.deepEqual(await fs.readdir(dir),['previous.json']);assert.equal(await fs.readFile(join(dir,'previous.json'),'utf8'),'original');}
 finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('evaluator never overwrites an earlier verdict',async()=>{
 const dir=await fs.mkdtemp(join(tmpdir(),'oasis-verdict-output-'));
 try{const file=join(dir,'verdict.json'),input=join(dir,'input.json');await fs.writeFile(file,'original');await fs.writeFile(input,JSON.stringify({observations:[]}));const result=spawnSync(process.execPath,['scripts/evaluate-mobile-quality.mjs','--input',input,'--out',file],{cwd:new URL('..',import.meta.url),encoding:'utf8'});assert.notEqual(result.status,0);assert.match(result.stderr,/EEXIST/);assert.equal(await fs.readFile(file,'utf8'),'original');}
 finally{await fs.rm(dir,{recursive:true,force:true});}
});
