import test from 'node:test';
import assert from 'node:assert/strict';
import {clientAddress,adminSessionCookie} from '../server/proxy-context.mjs';

const request=(peer,forwarded)=>({socket:{remoteAddress:peer},headers:{'x-real-ip':forwarded}});

test('proxy forwarding is disabled unless explicitly opted in',()=>{
  const previous=process.env.OASIS_TRUST_LOOPBACK_PROXY;
  try{
    for(const value of [undefined,'0','true','yes']){
      if(value===undefined)delete process.env.OASIS_TRUST_LOOPBACK_PROXY;
      else process.env.OASIS_TRUST_LOOPBACK_PROXY=value;
      assert.equal(clientAddress(request('127.0.0.1','203.0.113.5')),'127.0.0.1');
    }
    process.env.OASIS_TRUST_LOOPBACK_PROXY='1';
    assert.equal(clientAddress(request('127.0.0.1','203.0.113.5')),'203.0.113.5');
  }finally{
    if(previous===undefined)delete process.env.OASIS_TRUST_LOOPBACK_PROXY;
    else process.env.OASIS_TRUST_LOOPBACK_PROXY=previous;
  }
});

test('public and private non-loopback peers cannot forge their rate-limit address',()=>{
  for(const peer of ['203.0.113.8','10.0.0.8','192.168.1.8','2001:db8::1','::ffff:192.168.1.8']){
    assert.equal(clientAddress(request(peer,'198.51.100.99'),{trustLoopbackProxy:true}),peer);
  }
});

test('explicitly trusted IPv4, IPv6 and IPv4-mapped loopbacks accept a literal',()=>{
  for(const peer of ['127.0.0.1','127.2.3.4','::1','0:0:0:0:0:0:0:1','::ffff:127.0.0.1','::ffff:7f00:1']){
    for(const forwarded of ['203.0.113.5','2001:db8::5']){
      assert.equal(clientAddress(request(peer,forwarded),{trustLoopbackProxy:true}),forwarded);
    }
  }
});

test('malformed or ambiguous X-Real-IP falls back to the peer',()=>{
  for(const forwarded of [undefined,'','bad','localhost','203.0.113.5, 198.51.100.1','203.0.113.5:1234',' 203.0.113.5','203.0.113.5 ','[2001:db8::1]','fe80::1%lo0',['203.0.113.5','198.51.100.1']]){
    assert.equal(clientAddress(request('127.0.0.1',forwarded),{trustLoopbackProxy:true}),'127.0.0.1');
  }
  assert.equal(clientAddress({headers:{'x-real-ip':'203.0.113.5'}},{trustLoopbackProxy:true}),'');
});

test('forwarded-for is never used and different guests receive separate addresses',()=>{
  const req=request('127.0.0.1',undefined);req.headers['x-forwarded-for']='203.0.113.77';
  assert.equal(clientAddress(req,{trustLoopbackProxy:true}),'127.0.0.1');
  assert.notEqual(clientAddress(request('127.0.0.1','203.0.113.1'),{trustLoopbackProxy:true}),clientAddress(request('127.0.0.1','203.0.113.2'),{trustLoopbackProxy:true}));
});

test('HTTPS admin login and logout cookies retain scope and add Secure',()=>{
  assert.equal(adminSessionCookie('token','https://example.test:9443'),'oasis_admin=token; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=28800; Secure');
  assert.equal(adminSessionCookie('','https://example.test:9443',0),'oasis_admin=; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=0; Secure');
});

test('HTTP local admin cookies retain their existing behavior',()=>{
  assert.equal(adminSessionCookie('token','http://127.0.0.1:8795'),'oasis_admin=token; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=28800');
  assert.equal(adminSessionCookie('','http://127.0.0.1:8795',0),'oasis_admin=; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=0');
});
