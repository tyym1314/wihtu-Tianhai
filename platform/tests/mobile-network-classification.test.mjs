import test from 'node:test';
import assert from 'node:assert/strict';
import {networkAddress,isLocalGenerated,legacyLocalBlobEvidence,networkSummary,observeNetworkResponse,networkFailure} from '../scripts/mobile-quality-metrics.mjs';
const origin='http://localhost:49613',uuid='2f19ebbb-c1f4-46a3-b6b1-a9fdb0964327';
const request=(extra={})=>({path:'/a.webp',type:'image',method:'GET',status:200,start_epoch_ms:1000,request_start_ms:-1,encoded_body_bytes:-59,...extra});
const legacy=()=>request({path:origin+'/'+uuid});
test('HTTP address retains scheme and origin but never credentials, query or fragment',()=>{assert.deepEqual(networkAddress('https://user:password@example.test/api/pvp/rooms/private-id?access_token=secret#secret'),{url_protocol:'https:',url_origin:'https://example.test',path:'/api/pvp/rooms/[room]'});});
test('blob address preserves its actual scheme and can be classified without body-size inference',()=>{const a=networkAddress('blob:'+origin+'/'+uuid);assert.equal(a.url_protocol,'blob:');assert.equal(a.url_origin,origin);assert.equal(a.path,origin+'/'+uuid);assert(isLocalGenerated(a));});
test('inline data payload is not retained in measurement evidence',()=>{const a=networkAddress('data:text/plain,private-value');assert.equal(a.path,'[non-http]');assert.equal(JSON.stringify(a).includes('private-value'),false);assert(isLocalGenerated(a));});
test('explicit local-generated rows are separate from HTTP static and image budgets',()=>{const n=networkSummary([request({...networkAddress('blob:'+origin+'/'+uuid)}),request({path:'/a.webp',encoded_body_bytes:100})]);assert.equal(n.static_encoded_bytes,100);assert.equal(n.static_unknown_count,0);assert.equal(n.images.length,1);assert.equal(n.local_generated.length,1);assert.equal(n.local_generated[0].delivery,'local_generated');assert.equal(n.local_generated[0].observed_wire_body_bytes,null);});
test('repeated blob appearances never become duplicate HTTP transfers',()=>{const b=request({...networkAddress('blob:'+origin+'/'+uuid),encoded_body_bytes:100});const n=networkSummary([b,{...b,start_epoch_ms:1001}]);assert.equal(n.local_generated.length,2);assert.deepEqual(n.duplicate_transfers,[]);assert.equal(n.static_count,0);});
for(const value of [null,-59,-418,NaN])test('real HTTP unknown size stays unknown: '+value,()=>{const n=networkSummary([request({...networkAddress(origin+'/a.webp'),encoded_body_bytes:value})]);assert.equal(n.static_encoded_bytes,null);assert.equal(n.static_unknown_count,1);assert.equal(n.local_generated.length,0);});
test('HTTP UUID pathname is still a real unknown HTTP request',()=>{const n=networkSummary([request({...networkAddress(origin+'/'+uuid)})]);assert.equal(n.static_encoded_bytes,null);assert.equal(n.local_generated.length,0);});
test('a stored URL-looking path is never silently reclassified by live summary',()=>{const n=networkSummary([legacy()]);assert.equal(n.static_encoded_bytes,null);assert.equal(n.local_generated.length,0);});
test('legacy blob classification requires a verified pathname-only producer and exact origin',()=>{assert(legacyLocalBlobEvidence(legacy(),{origin,pathnameOnlyProducer:true}));assert.equal(legacyLocalBlobEvidence(legacy(),{origin}),null);assert.equal(legacyLocalBlobEvidence(legacy(),{origin:'http://localhost:9999',pathnameOnlyProducer:true}),null);});
for(const [label,extra]of [
 ['HTTP protocol',{url_protocol:'http:'}],['malformed UUID',{path:origin+'/not-uuid'}],
 ['query suffix',{path:origin+'/'+uuid+'?token=secret'}],['fragment',{path:origin+'/'+uuid+'#x'}],
 ['extra slash',{path:origin+'//'+uuid}],['UUID HTTP path',{path:'/'+uuid}],
 ['post',{method:'POST'}],['non-200',{status:404}],['real request timing',{request_start_ms:0}],
 ])test('legacy classifier refuses '+label,()=>{assert.equal(legacyLocalBlobEvidence({...legacy(),...extra},{origin,pathnameOnlyProducer:true}),null);});
test('negative bytes alone never justify legacy exclusion',()=>{assert.equal(legacyLocalBlobEvidence(request(),{origin,pathnameOnlyProducer:true}),null);});
test('cache corroboration cannot match a different recorded origin',()=>{const e=request({...networkAddress('https://a.test/a.webp'),encoded_body_bytes:100}),r={...networkAddress('https://b.test/a.webp'),same_origin:true,start_ms:0,transfer_bytes:0,decoded_bytes:100};assert.equal(networkSummary([e],{timeOrigin:1000,resources:[r]}).static_encoded_bytes,100);});
test('new classification and summary preserve the input objects',()=>{const e=request({...networkAddress('blob:'+origin+'/'+uuid)}),before=structuredClone(e);networkSummary([e]);assert.deepEqual(e,before);});

function fakeResponse({url='https://fonts.example/css2?private=redacted',type='stylesheet',status=200,bytes=154998,sizesError=false}={}){
 const request={url:()=>url,resourceType:()=>type,method:()=>'GET',timing:()=>({startTime:1000,responseEnd:1007,requestStart:1,responseStart:50}),sizes:async()=>{if(sizesError)throw Error('unavailable');return{responseBodySize:bytes};},failure:()=>({errorText:'DNS_ERROR'})};
 return{url:()=>url,request:()=>request,status:()=>status,headers:()=>({'content-encoding':'br'}),finished:async()=>{}};
}
test('probability network observer captures cross-origin stylesheet bytes without parsing authority state',async()=>{
 let parsed=0;const row=await observeNetworkResponse(fakeResponse(),{origin,onSameOriginResponse:async()=>parsed++});
 assert.equal(parsed,0);assert.equal(row.url_origin,'https://fonts.example');assert.equal(row.path,'/css2');assert.equal(row.encoded_body_bytes,154998);assert.equal(networkSummary([row]).static_encoded_bytes,154998);
});
test('cross-origin authority-shaped path cannot replace host session state',async()=>{let parsed=0;await observeNetworkResponse(fakeResponse({url:'https://fonts.example/v1/launch/exchange',type:'fetch'}),{origin,onSameOriginResponse:async()=>parsed++});assert.equal(parsed,0);await observeNetworkResponse(fakeResponse({url:origin+'/v1/launch/exchange',type:'fetch'}),{origin,onSameOriginResponse:async()=>parsed++});assert.equal(parsed,1);});
for(const input of [{bytes:-815},{sizesError:true}])test('unavailable external font bytes never become zero '+JSON.stringify(input),async()=>{const row=await observeNetworkResponse(fakeResponse({...input,url:'https://fonts.example/a.woff2',type:'font'}),{origin});const n=networkSummary([row]);assert.equal(n.static_count,1);assert.equal(n.static_encoded_bytes,null);assert.equal(n.static_unknown_count,1);});
test('external HTTP errors and request failures preserve origin in reliability evidence',async()=>{const http=[],resources=[];const response=fakeResponse({status:503});await observeNetworkResponse(response,{origin,onHttpError:e=>http.push(e),onResourceError:e=>resources.push(e)});assert.equal(http.length,1);assert.equal(resources.length,1);assert.equal(resources[0].url_origin,'https://fonts.example');assert.deepEqual(networkFailure(response.request()),{url_protocol:'https:',url_origin:'https://fonts.example',path:'/css2',type:'stylesheet',reason:'DNS_ERROR'});});
test('same pathname on different HTTP origins is not a duplicate transfer',()=>{const n=networkSummary([request({...networkAddress('https://a.test/a.webp'),encoded_body_bytes:100}),request({...networkAddress('https://b.test/a.webp'),encoded_body_bytes:100})]);assert.equal(n.static_encoded_bytes,200);assert.deepEqual(n.duplicate_transfers,[]);});
