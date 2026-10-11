import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFile} from 'node:fs/promises';
import {networkProtocolReceipt,networkConditionParameters,collectNetworkRuleProof,analyzeNetworkRuleProof} from '../scripts/android-player-network-proof.mjs';

const protocol=await readFile(new URL('../review/android-player-20261010/root-feedback-official-protocol-wn05wslg/browser_protocol.json',import.meta.url));
const scope={serial:'46dcfd25',androidUserId:0,uid:10416,packageName:'com.tianyahuyu.oasis.player.qa',pid:91,startTicks:'123',
 nonce:'actual-owner-nonce-unit-fixture',targetId:'page-fixture',targetType:'page',origin:'https://oasis-player.43.98.202.236.sslip.io',providerVersion:'150.0.7871.124'};
class Session extends EventEmitter{
 async send(method,parameters){this.calls??=[];this.calls.push({method,parameters:structuredClone(parameters)});
  if(method==='Browser.getVersion')return {product:'Chrome/'+scope.providerVersion,protocolVersion:'1.3'};
  if(method==='Network.emulateNetworkConditionsByRule')return {ruleIds:parameters.matchedNetworkConditions.length?['original-rule-id']:[]};return {};
 }
}
async function fixture(){
 const session=new Session();let time=1;const clock=()=>({epochMs:time+1700000000000,monotonicMs:time++});
 const handle=await collectNetworkRuleProof({session,scope,protocolBytes:protocol,exclusiveNetworkDomain:true,readTargetIdentity:async()=>structuredClone(scope),clock});
 // ExtraInfo may precede the normal request event according to the protocol.
 session.emit('Network.requestWillBeSentExtraInfo',{requestId:'r1',appliedNetworkConditionsId:'original-rule-id',headers:{}});
 session.emit('Network.requestWillBeSent',{requestId:'r1',frameId:'owned-frame',request:{url:scope.origin+'/assets/real.webp',method:'GET'},timestamp:2});
 session.emit('Network.responseReceived',{requestId:'r1',response:{status:200,fromDiskCache:false,fromServiceWorker:false,fromPrefetchCache:false}});
 session.emit('Network.loadingFinished',{requestId:'r1',encodedDataLength:2048});
 const capture=await handle.close();return {capture,session,proof:{captures:[capture],inventoryBefore:[scope],inventoryAfter:[scope],ownedRequests:[{targetId:scope.targetId,requestId:'r1',url:scope.origin+'/assets/real.webp'}]}};
}

test('original official bytes specify browser latency semantics and exact bitrate conversion',()=>{
 const receipt=networkProtocolReceipt(protocol);assert.equal(receipt.physicalRtt,false);assert.equal(receipt.latencySemantics,'minimum-request-to-response-headers-delay-ms');
 assert.deepEqual(networkConditionParameters(scope).matchedNetworkConditions,[{urlPattern:'',offline:false,latency:50,downloadThroughput:2500000,uploadThroughput:625000}]);
 assert.equal(networkConditionParameters(scope,'weak').matchedNetworkConditions[0].uploadThroughput,125000);
 const bad=Buffer.from(protocol);bad[0]=0;assert.throws(()=>networkProtocolReceipt(bad),/NETWORK_PROTOCOL_SHA_CHANGED/);
});
test('actual rule matching and successful cleanup prove shaping while physical RTT/calibration remain unproven',async()=>{
 const {capture,session,proof}=await fixture(),result=analyzeNetworkRuleProof(proof);
 assert.equal(result.status,'request-shaping-proven');assert.equal(result.requestCount,1);assert.equal(result.networkCalibrated,false);assert.equal(result.physicalRtt,false);
 assert.equal(capture.closed,true);assert.equal(session.eventNames().length,0);assert.deepEqual(session.calls.map(c=>c.method),['Network.enable','Browser.getVersion','Network.emulateNetworkConditionsByRule','Network.emulateNetworkConditionsByRule']);
});
test('missing rule event, wrong rule, failed/cache/SW/redirect response and in-flight requests cannot prove coverage',async()=>{
 const base=(await fixture()).proof;
 for(const kind of ['extra-missing','extra-other','failed','cache','service-worker','redirect','before-install','provider','reset']){
  const value=structuredClone(base),capture=value.captures[0],events=capture.events;
  if(kind==='extra-missing')capture.events=events.filter(e=>e.event!=='Network.requestWillBeSentExtraInfo');
  if(kind==='extra-other')events[0].value.appliedNetworkConditionsId='foreign-rule';
  if(kind==='failed')events.push({event:'Network.loadingFailed',value:{requestId:'r1',errorText:'net::ERR_FAILED'},received:events[3].received});
  if(kind==='cache')events[2].value.response.fromDiskCache=true;
  if(kind==='service-worker')events[2].value.response.fromServiceWorker=true;
  if(kind==='redirect')events[1].value.redirectResponse={status:302};
  if(kind==='before-install')events[1].received.monotonicMs=0;
  if(kind==='provider')capture.browserVersion.product='Chrome/149.0.1.1';
  if(kind==='reset')capture.commands.pop();
  assert.equal(analyzeNetworkRuleProof(value).requestShapingProven,false,kind);
 }
});
test('unknown worker/OOPIF, changed inventory, clone profile, overflow and unobserved request fail closed',async()=>{
 const base=(await fixture()).proof;
 for(const kind of ['worker','inventory','clone','overflow','foreign-request']){
  const value=structuredClone(base);
  if(kind==='worker')value.captures[0].events.push({event:'Target.attachedToTarget',value:{targetInfo:{type:'worker'}},received:{epochMs:1,monotonicMs:1}});
  if(kind==='inventory')value.inventoryAfter.push({...scope,targetId:'unobserved'});
  if(kind==='clone')value.captures[0].scope.uid=1010416;
  if(kind==='overflow')value.captures[0].overflow=1;
  if(kind==='foreign-request')value.ownedRequests[0].targetId='missing-target';
  assert.equal(analyzeNetworkRuleProof(value).requestShapingProven,false,kind);
 }
});
test('unsupported experimental command preserves failed installation and attempts own cleanup',async()=>{
 const session=new Session();const send=session.send.bind(session);session.send=async(m,p)=>{if(m==='Network.emulateNetworkConditionsByRule'&&p.matchedNetworkConditions.length)throw Error('method unsupported');return send(m,p);};
 await assert.rejects(()=>collectNetworkRuleProof({session,scope,protocolBytes:protocol,exclusiveNetworkDomain:true,readTargetIdentity:async()=>scope}),error=>{
  assert.equal(error.capture.started,false);assert.equal(error.capture.closed,true);assert.ok(error.capture.errors.length>0);return true;
 });assert.equal(session.eventNames().length,0);assert.ok(session.calls.some(c=>c.method==='Network.emulateNetworkConditionsByRule'&&c.parameters.matchedNetworkConditions.length===0));
});
test('a hung experimental call is bounded, retains the timeout and cleans up its listeners',async()=>{
 const session=new Session(),send=session.send.bind(session);session.send=(m,p)=>m==='Network.emulateNetworkConditionsByRule'&&p.matchedNetworkConditions.length?new Promise(()=>{}):send(m,p);
 await assert.rejects(()=>collectNetworkRuleProof({session,scope,protocolBytes:protocol,exclusiveNetworkDomain:true,readTargetIdentity:async()=>scope,maxCommandMs:10}),error=>{
  assert.equal(error.message,'NETWORK_COMMAND_TIMEOUT');assert.equal(error.capture.closed,true);assert.equal(error.capture.commands[2].error,'NETWORK_COMMAND_TIMEOUT');return true;
 });assert.equal(session.eventNames().length,0);
});
