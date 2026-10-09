import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyPlayerAcceptanceRuntime} from '../scripts/android-player-acceptance.mjs';
import {playerResourceManifest} from '../scripts/android-player-acceptance-checks.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const sourceStamp=JSON.parse(await readFile(join(root,'release-build-manifest.json')));
const manifest=playerResourceManifest(sourceStamp);

test('actual full-build repository input keys authorize the complete player/run runtime closure',async()=>{
 const pins=await verifyPlayerAcceptanceRuntime(root,manifest.inputs);
 assert.equal(Object.keys(pins).length,11);
 for(const name of ['arena/main.jsx','shared/run-practice-profiles.mjs','server/player-routes.mjs','server/pvp/run-practice-inputs.mjs','server/pvp/run-practice-protocol.mjs','server/pvp/engine-worker.mjs']){
  assert.equal(pins[name],sourceStamp.inputs['platform/'+name]);
  assert.equal(sourceStamp.inputs[name],undefined,'real stamp must not manufacture platform-relative aliases');
 }
});

test('short aliases, missing or invalid source pins cannot authorize the unchanged actual files',async()=>{
 const aliases=Object.fromEntries(Object.entries(manifest.inputs).filter(([name])=>name.startsWith('platform/')).map(([name,value])=>[name.slice(9),value]));
 await assert.rejects(()=>verifyPlayerAcceptanceRuntime(root,aliases),/RELEASE_RUNTIME_SOURCE_PIN_MISSING: arena\/main.jsx/);
 const missing={...manifest.inputs};delete missing['platform/shared/run-practice-profiles.mjs'];
 await assert.rejects(()=>verifyPlayerAcceptanceRuntime(root,missing),/RELEASE_RUNTIME_SOURCE_PIN_MISSING: shared\/run-practice-profiles.mjs/);
 await assert.rejects(()=>verifyPlayerAcceptanceRuntime(root,{...manifest.inputs,'platform/arena/main.jsx':'not-a-sha'}),/RELEASE_RUNTIME_SOURCE_PIN_MISSING/);
 await assert.rejects(()=>verifyPlayerAcceptanceRuntime(root,{...manifest.inputs,'platform/arena/main.jsx':'0'.repeat(64)}),/RELEASE_RUNTIME_SOURCE_CHANGED: arena\/main.jsx/);
});

test('final runtime revalidation detects a Run protocol body changed after a successful preflight',async()=>{
 const pins=await verifyPlayerAcceptanceRuntime(root,manifest.inputs);
 const temporary=await mkdtemp(join(tmpdir(),'player-runtime-build-inputs-'));
 try{
  for(const name of Object.keys(pins)){
   const target=join(temporary,name);await mkdir(dirname(target),{recursive:true});await writeFile(target,await readFile(join(root,name)));
  }
  assert.deepEqual(await verifyPlayerAcceptanceRuntime(temporary,manifest.inputs),pins);
  const protocol=join(temporary,'server/pvp/run-practice-protocol.mjs');
  await writeFile(protocol,Buffer.concat([await readFile(protocol),Buffer.from('\n// source changed after the first read\n')]));
  await assert.rejects(()=>verifyPlayerAcceptanceRuntime(temporary,manifest.inputs),/RELEASE_RUNTIME_SOURCE_CHANGED: server\/pvp\/run-practice-protocol.mjs/);
 }finally{await rm(temporary,{recursive:true,force:true});}
});
