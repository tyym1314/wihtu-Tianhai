#!/usr/bin/env node
/** Read both private configurations only in this short-lived operator process. */
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {parseEnvironmentFile,preflight} from './isolation.mjs';

export async function run(argv=process.argv.slice(2)){
 if(argv.length!==4||argv[0]!=='--mock-env'||argv[2]!=='--live-env')throw Error('Usage: preflight.mjs --mock-env MOCK_RUNTIME_ENV --live-env LIVE_RUNTIME_ENV');
 const [mock,live]=await Promise.all([argv[1],argv[3]].map(async filename=>parseEnvironmentFile(await readFile(filename,'utf8'))));
 return preflight(mock,live);
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])){
 try{
  const result=await run();
  console.log(`MOCK_SANDBOX_PREFLIGHT_OK origin=${result.origin} games=${result.gameCount} db=${result.databaseIsolation} keys=${result.keyIsolation}`);
 }catch(error){
  console.error('MOCK_SANDBOX_PREFLIGHT_FAILED',error.message);
  process.exitCode=1;
 }
}
