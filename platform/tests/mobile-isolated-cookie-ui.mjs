/** Local temporary desktop context only; no device, navigation, network or DB. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {createLoopbackCookieIsolation,withOwnedLoopbackCookie} from '../scripts/mobile-isolated-cookie.mjs';

test('real browser finally removes only its exact owned alias, including after failure',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const context=await browser.newContext(),origin='http://localhost:34567',name=createLoopbackCookieIsolation().name,other=createLoopbackCookieIsolation().name;
  const baseline=[{name:'oasis_quality_demo',value:'legacy',domain:'localhost',path:'/'},{name:other,value:'another-instance',domain:'localhost',path:'/'},{name,value:'same-name-other-path',domain:'localhost',path:'/unrelated'}];
  await context.addCookies(baseline);
  for(const failing of [false,true]){
   const original=new Error('test run failed');
   const result=withOwnedLoopbackCookie(context,{origin,name},async()=>{
    await context.addCookies([{name,value:'owned',domain:'localhost',path:'/',httpOnly:true,sameSite:'Lax'}]);
    if(failing)throw original;return 'done';
   });
   if(failing)await assert.rejects(result,error=>error===original);else assert.equal(await result,'done');
   const remaining=(await context.cookies()).map(({name,value,domain,path})=>({name,value,domain,path}));
   assert.deepEqual(remaining.sort((a,b)=>(a.name+a.path).localeCompare(b.name+b.path)),[...baseline].sort((a,b)=>(a.name+a.path).localeCompare(b.name+b.path)));
  }
  await context.close();
 }finally{await browser.close();}
});
