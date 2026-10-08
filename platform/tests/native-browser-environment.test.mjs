import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,access,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

test('native verifier rejects disabled Node TLS before reserving reports or opening a browser',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'oasis-native-tls-'));
 const output=join(directory,'must-not-exist');
 try{
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('../deploy/verify-native-browser.mjs',import.meta.url))],{
   env:{...process.env,NODE_TLS_REJECT_UNAUTHORIZED:'0',OASIS_VERIFY_ORIGIN:'https://127.0.0.1:1',OASIS_VERIFY_OUT:output},
   encoding:'utf8',timeout:10000,
  });
  assert.equal(result.error,undefined);
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/STRICT_TLS_REQUIRED/);
  assert.doesNotMatch(result.stderr,/ECONNREFUSED|browserType\.launch|net::/);
  await assert.rejects(access(output),{code:'ENOENT'});
 }finally{await rm(directory,{recursive:true,force:true});}
});
