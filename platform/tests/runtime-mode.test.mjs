import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runtimeConfiguration,assertProductionAppReady} from '../server/runtime-mode.mjs';
test('production requires explicit HTTPS, database, private directory and disabled reference wallet',()=>{
 assert.equal(runtimeConfiguration({}).environment,'sandbox');
 const env={OASIS_ENVIRONMENT:'production',OASIS_PUBLIC_ORIGIN:'https://games.example.com',OASIS_DATABASE_URL:'postgres://localhost/isolated',OASIS_LOCAL_DIR:'/private/production',OASIS_START_WALLET:'0'};
 assert.equal(runtimeConfiguration(env).admissionEnabled,false);
 assert.equal(runtimeConfiguration({...env,OASIS_PRODUCTION_ADMISSION_ENABLED:'1'}).admissionEnabled,true);
 for(const key of ['OASIS_DATABASE_URL','OASIS_LOCAL_DIR','OASIS_START_WALLET','OASIS_PUBLIC_ORIGIN']){const invalid={...env};delete invalid[key];assert.throws(()=>runtimeConfiguration(invalid));}
 assert.throws(()=>runtimeConfiguration({...env,OASIS_PUBLIC_ORIGIN:'http://localhost:9999'}));
 assert.throws(()=>runtimeConfiguration({OASIS_ENVIRONMENT:'prod'}));
});
test('sandbox process cannot admit a production app even if someone changes its status',async()=>{
 await assert.rejects(assertProductionAppReady({query:()=>{throw Error('unreachable');}},{environment:'production'}),{code:'PRODUCTION_ACCEPTANCE_REQUIRED'});
 await assertProductionAppReady(null,{environment:'sandbox'});
});
