import test from 'node:test';
import assert from 'node:assert/strict';
import {validateNativeHealthProducerSelection,validateNativeHealthProducerContract,validateSource15NativeDeploymentEvidence} from '../deploy/native-browser-checks.mjs';

// Pure input fixtures test the new contract boundary. They are not deployment,
// pressure-test or phone acceptance originals, and never reach network or ADB.
const origin='https://oasis-player.43.98.202.236.sslip.io';
const pins={
 'platform/server/index.mjs':'a'.repeat(64),
 'platform/server/security.mjs':'b'.repeat(64),
 'platform/server/runtime-mode.mjs':'c'.repeat(64),
};
const selection=()=>({schema:'root-source15-native-health-producer-contract-v1',origin,method:'GET',path:'/health',environment:'production',release_manifest:{path:'/private/fixture/source15-manifest.json',sha256:'d'.repeat(64)},source_sha256:{...pins},expected_body:{bytes:42,sha256:'497add72f0f622772613ee2efaee64243b3a2cfcddb80476b239d80ecc852ddb'},deployment_evidence:{path:'/private/fixture/source15-open.json',sha256:'e'.repeat(64)}});
const binding={origin,manifestSha256:'d'.repeat(64),sourcePins:pins,deploymentEvidenceSha256:'e'.repeat(64)};

test('Source15 requires actual manifest/source/evidence bindings before native use',()=>{
 const raw=selection();assert.equal(validateNativeHealthProducerSelection(raw,{origin}),raw);
 assert.throws(()=>validateNativeHealthProducerContract(raw),/ACTUAL_SOURCE15_BINDINGS/);
 assert.throws(()=>validateNativeHealthProducerContract(raw,{origin}),/ACTUAL_SOURCE15_BINDINGS/);
 const verified=validateNativeHealthProducerContract(raw,binding);
 assert.ok(Object.isFrozen(verified)&&Object.isFrozen(verified.source_sha256));
 assert.equal(validateNativeHealthProducerContract(verified),verified);
 assert.throws(()=>validateNativeHealthProducerContract(structuredClone(verified)),/ACTUAL_SOURCE15_BINDINGS/);
 for(const patch of [{manifestSha256:'f'.repeat(64)},{sourcePins:{}},{deploymentEvidenceSha256:'f'.repeat(64)},{origin:'https://foreign.example'}])assert.throws(()=>validateNativeHealthProducerContract(raw,{...binding,...patch}),/HEALTH_PRODUCER/);
});

test('Source15 selection refuses unbound placeholders or a changed health body',()=>{
 for(const edit of [v=>v.release_manifest.sha256='PENDING',v=>v.source_sha256['platform/server/index.mjs']='PENDING',v=>v.expected_body.bytes=16384,v=>v.expected_body.sha256='f'.repeat(64),v=>v.environment='sandbox',v=>v.path='/health?nonce=1',v=>v.method='POST',v=>v.extra=true]){
  const value=selection();edit(value);assert.throws(()=>validateNativeHealthProducerSelection(value,{origin}),/HEALTH_PRODUCER/);
 }
});

test('historical free11/source13 proof cannot be relabelled a Source15 internal13 open',()=>{
 const old={schema:1,kind:'source10-open-after-final-only-operation',passed:true,action:'open',phase:'complete_free_open',target_release:'/opt/oasis/releases/20261013-01'};
 assert.throws(()=>validateSource15NativeDeploymentEvidence(old,{origin,manifestSha256:binding.manifestSha256}),/DEPLOYMENT_KIND/);
 const relabelled={...old,kind:'production-firstparty-source15-operation'};
 assert.throws(()=>validateSource15NativeDeploymentEvidence(relabelled,{origin,manifestSha256:binding.manifestSha256}),/DEPLOYMENT_NOT_CONFIRMED/);
});
