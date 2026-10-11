import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
import {createOwnedNativeTapEvaluators,ownedNativeTapEventDOM,ownedPerformanceFailureDOM,prepareOwnedNativeTapReceipt,readOwnedNativeTapReceipt,removeOwnedNativeTapReceipt,assertOwnedNativeTapInstallation,assertOwnedNativeTapInstalledSlot,assertOwnedNativeTapReceipt} from '../scripts/android-player-performance.mjs';

// Local synthetic DOM/probe only. Input is a real trusted Chromium browser
// click; this is not an Android/device, game acceptance or timing measurement.
const url='https://native-tap-fixture.invalid/play/run',nonce='fixture-owned-nonce',documentId='fixture-owned-document';
const html='<button data-testid="run-jump" onclick="this.remove()"><b>Jump</b></button><div data-testid="run-track" data-revision="7"></div><div data-testid="run-scene" data-input-ready="true"></div>';
async function fixture(fn){
 const browser=await chromium.launch({headless:true});try{
  const context=await browser.newContext();await context.route('**/*',route=>route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:html}));const page=await context.newPage();await page.goto(url);
  const handle=await page.getByTestId('run-jump').elementHandle();assert.ok(handle);const evaluators=createOwnedNativeTapEvaluators();
  const timeOrigin=await page.evaluate(()=>performance.timeOrigin),scope={url,nonce,documentId,timeOrigin,frameId:'fixture-cdp-frame'};
  await page.evaluate(scope=>{globalThis.__oasisPhysicalPerf={schema:'android-physical-performance-v1',url:scope.url,nonce:scope.nonce,documentId:scope.documentId,timeOrigin:scope.timeOrigin};},scope);
  await fn({page,handle,evaluators,scope});await handle.dispose();
 }finally{await browser.close();}
}
const argumentsFor=(key,performanceScope=null)=>({key,expectedUrl:url,performanceScope});
async function install(handle,evaluators,args){
 const installation=await handle.evaluate(evaluators.install,args);assertOwnedNativeTapInstallation(installation,args);
 const slot=await handle.evaluate(readOwnedNativeTapReceipt,args);assertOwnedNativeTapInstalledSlot(slot,{installation,...args});return{installation,slot};
}

test('original string arrows are not invoked: no slot/DOM receipt and installation guard rejects before browser input',async()=>{
 await fixture(async({page,handle,scope})=>{
  const args=argumentsFor('original-string',scope),oldInstall='(element,args)=>('+prepareOwnedNativeTapReceipt.toString()+')(element,args,(element,scope)=>('+ownedNativeTapEventDOM.toString()+')(element,scope,'+ownedPerformanceFailureDOM.toString()+'))';
  const installation=await handle.evaluate(oldInstall,args);assert.equal(installation,undefined);assert.equal(await handle.evaluate((element,key)=>Object.hasOwn(element,key),args.key),false);
  let inputSent=false;assert.throws(()=>{assertOwnedNativeTapInstallation(installation,args);inputSent=true;},/INSTALLATION_REQUIRED/);assert.equal(inputSent,false);
  const oldRead='(element,args)=>('+ownedNativeTapEventDOM.toString()+')(element,args,'+ownedPerformanceFailureDOM.toString()+')';assert.equal(await handle.evaluate(oldRead,{performanceScope:scope}),undefined);
  await assert.rejects(handle.evaluate(readOwnedNativeTapReceipt,args),/RECEIPT_IDENTITY_CHANGED/);assert.deepEqual(await handle.evaluate(removeOwnedNativeTapReceipt,args),{removed:false,missing:true});assert.equal(await page.getByTestId('run-jump').count(),1);
 });
});

test('shared Function installs an empty entry slot and real trusted browser click remains readable after original element unmounts',async()=>{
 await fixture(async({page,handle,evaluators})=>{
  assert.equal(typeof evaluators.install,'function');assert.equal(typeof evaluators.readDOM,'function');const args=argumentsFor('entry-shared-function'),{installation,slot}=await install(handle,evaluators,args);
  assert.equal(installation.documentTimeOrigin,await page.evaluate(()=>performance.timeOrigin));assert.deepEqual(slot.events,[]);assert.equal(slot.overflow,false);
  await page.getByTestId('run-jump').click();assert.equal(await page.getByTestId('run-jump').count(),0);assert.equal(await handle.evaluate(element=>element.isConnected),false);
  const receipt=await handle.evaluate(readOwnedNativeTapReceipt,args);assertOwnedNativeTapReceipt(receipt,args);assert.deepEqual(receipt.events.map(row=>row.type),['pointerdown','pointerup','click']);assert.ok(receipt.events.every(row=>row.isTrusted));assert.deepEqual(receipt.observationErrors,[]);
  assert.deepEqual(await handle.evaluate(removeOwnedNativeTapReceipt,args),{removed:true,missing:false});await assert.rejects(handle.evaluate(readOwnedNativeTapReceipt,args),/RECEIPT_IDENTITY_CHANGED/);assert.deepEqual(await handle.evaluate(removeOwnedNativeTapReceipt,args),{removed:false,missing:true});
 });
});

test('shared scoped readDOM/install compose original helpers and bind every trusted event to exact owner and DOM',async()=>{
 await fixture(async({page,handle,evaluators,scope})=>{
  const dom=await handle.evaluate(evaluators.readDOM,{performanceScope:scope});assert.equal(dom.schema,'owned-native-tap-event-dom-v1');assert.deepEqual(dom.owner,{nonce,documentId,timeOrigin:scope.timeOrigin,url});assert.equal(dom.control.testId,'run-jump');assert.equal(dom.track.data.revision,'7');
  const authority={room:{version:3},runInputs:{revision:7}},args={...argumentsFor('scoped-shared-function',scope),authorityAtInstallation:authority};await install(handle,evaluators,args);await page.getByTestId('run-jump').click();
  const receipt=await handle.evaluate(readOwnedNativeTapReceipt,args);assertOwnedNativeTapReceipt(receipt,args);assert.deepEqual(receipt.performanceScope,scope);assert.deepEqual(receipt.authorityAtInstallation,authority);
  for(const event of receipt.events){assert.deepEqual(event.dom.owner,dom.owner);assert.equal(event.dom.control.testId,'run-jump');assert.equal(event.dom.track.data.revision,'7');assert.deepEqual(event.authorityReference.snapshot,authority);assert.equal(event.authorityReference.domRevision,'7');assert.ok(event.dom.at>=event.at);}
  assert.deepEqual(await handle.evaluate(removeOwnedNativeTapReceipt,args),{removed:true,missing:false});
 });
});

test('document, nonce, URL and clock drift fail the same composition before installation; post-install drift cannot pass event gate',async()=>{
 await fixture(async({page,handle,evaluators,scope})=>{
  for(const changed of [{nonce:'foreign'},{documentId:'foreign'},{url:url+'?foreign'},{timeOrigin:scope.timeOrigin+1}]){
   const foreign={...scope,...changed},args=argumentsFor('foreign-scope',foreign);await assert.rejects(handle.evaluate(evaluators.readDOM,{performanceScope:foreign}),/DOCUMENT_UNPROVEN|DOCUMENT_CLOCK_CHANGED/);await assert.rejects(handle.evaluate(evaluators.install,args),/DOCUMENT_UNPROVEN|DOCUMENT_CLOCK_CHANGED|PERFORMANCE_SCOPE_REQUIRED/);assert.equal(await handle.evaluate((element,key)=>Object.hasOwn(element,key),args.key),false);
  }
  const args=argumentsFor('drift-after-install',scope);await install(handle,evaluators,args);await page.evaluate(()=>{globalThis.__oasisPhysicalPerf.nonce='foreign-after-install';});await page.getByTestId('run-jump').click();const receipt=await handle.evaluate(readOwnedNativeTapReceipt,args);assert.ok(receipt.events.every(row=>row.isTrusted));assert.ok(receipt.observationErrors.length>0);assert.throws(()=>assertOwnedNativeTapReceipt(receipt,args),/EVENT_DOM_UNPROVEN/);await handle.evaluate(removeOwnedNativeTapReceipt,args);
 });
});

test('pre-input installation/slot guards reject missing or altered identity, clock, bounds and prior events',async()=>{
 await fixture(async({page,handle,evaluators,scope})=>{
  const args=argumentsFor('pre-input-proof',scope),{installation,slot}=await install(handle,evaluators,args);
  for(const changes of [{schema:'foreign'},{key:'foreign'},{url:url+'?foreign'},{documentTimeOrigin:NaN},{documentTimeOrigin:scope.timeOrigin+1},{performanceScope:{...scope,nonce:'foreign'}}])assert.throws(()=>assertOwnedNativeTapInstallation({...installation,...changes},args),/OWNED_NATIVE_TAP_INSTALLATION/);
  assert.throws(()=>assertOwnedNativeTapInstalledSlot(undefined,{installation,...args}),/INSTALLED_SLOT_REQUIRED/);
  for(const changes of [{key:'foreign'},{url:url+'?foreign'},{documentTimeOrigin:scope.timeOrigin+1},{performanceScope:{...scope,documentId:'foreign'}},{events:[{type:'click'}]},{overflow:true},{observationErrors:[{error:'unproven'}]}])assert.throws(()=>assertOwnedNativeTapInstalledSlot({...slot,...changes},{installation,...args}),/OWNED_NATIVE_TAP_(INSTALLED_SLOT|PRE_INPUT)/);
  await handle.evaluate((element,key)=>{element[key].documentTimeOrigin++;},args.key);await assert.rejects(handle.evaluate(readOwnedNativeTapReceipt,args),/RECEIPT_IDENTITY_CHANGED/);await handle.evaluate(removeOwnedNativeTapReceipt,args);assert.equal(await page.getByTestId('run-jump').count(),1);
 });
});

test('actual collector uses shared Functions and both pre-input guards before ADB; original cold entry start line stays exact',async()=>{
 const source=await readFile(new URL('../scripts/android-player-performance.mjs',import.meta.url),'utf8');assert.ok(source.includes('const tapEvaluators=createOwnedNativeTapEvaluators();'));assert.ok(source.includes('handle.evaluate(tapEvaluators.readDOM,{performanceScope})'));
 const installAt=source.indexOf('receipt.installation=await handle.evaluate(tapEvaluators.install,'),assertAt=source.indexOf('assertOwnedNativeTapInstallation(receipt.installation,',installAt),readAt=source.indexOf('receipt.installedSlot=await handle.evaluate(readOwnedNativeTapReceipt,',assertAt),slotAt=source.indexOf('assertOwnedNativeTapInstalledSlot(receipt.installedSlot,',readAt),inputAt=source.indexOf("await execute('adb',physicalAdbArgs(options,['shell','input','tap'",slotAt);
 assert.ok(installAt>=0&&assertAt>installAt&&readAt>assertAt&&slotAt>readAt&&inputAt>slotAt);assert.equal(source.includes('const tapDOMExpression='),false);
 const start=source.split('\n').find(line=>line.includes('const start=Date.now();round.startedAt='))+'\n';assert.equal(createHash('sha256').update(start).digest('hex'),'3765c4dd2baa96efc9321a4a92e35001df6d9feca335bc062e9e8a218bcaab2c');
});

test('browser evaluate preserves a bounded diagnostic for each original synchronous refusal without installing a receipt',async()=>{
 await fixture(async({page,handle,evaluators})=>{
  const cases=[
   ['urlMatches',{urlMatches:false,visibility:'unread',disabled:'unread',ariaDisabled:'unread'}],
   ['visibility',{urlMatches:true,visibility:'hidden',disabled:'unread',ariaDisabled:'unread'}],
   ['disabled',{urlMatches:true,visibility:'visible',disabled:true,ariaDisabled:'unread'}],
   ['ariaDisabled',{urlMatches:true,visibility:'visible',disabled:false,ariaDisabled:'true'}]
  ];
  for(const [failedPredicate,evaluatedPrefix] of cases){
   const args=argumentsFor('rejected-'+failedPredicate);
   if(failedPredicate==='urlMatches')args.expectedUrl=url+'?private-fixture-token';
   await handle.evaluate((element,kind)=>{
    if(kind==='visibility')Object.defineProperty(element.ownerDocument,'visibilityState',{value:'hidden',configurable:true});
    if(kind==='disabled')element.disabled=true;
    if(kind==='ariaDisabled')element.setAttribute('aria-disabled','true');
   },failedPredicate);
   try{
    await assert.rejects(handle.evaluate(evaluators.install,args),error=>{
     const marker=' | guard-diagnostic=',at=error.message.indexOf(marker);assert.ok(at>=0);
     const raw=error.message.slice(at+marker.length).split('\n')[0];assert.ok(raw.length<=350);
     assert.deepEqual(JSON.parse(raw),{schema:'owned-native-tap-guard-diagnostic-v1',failedPredicate,evaluatedPrefix});
     assert.equal(raw.includes('private-fixture-token'),false);assert.equal(raw.includes('fixture.invalid'),false);return true;
    });
    assert.equal(await handle.evaluate((element,key)=>Object.hasOwn(element,key),args.key),false);
   }finally{
    await handle.evaluate(element=>{delete element.ownerDocument.visibilityState;element.disabled=false;element.removeAttribute('aria-disabled');});
   }
  }
  const args=argumentsFor('success-after-refusals');await install(handle,evaluators,args);
  assert.deepEqual(await handle.evaluate(removeOwnedNativeTapReceipt,args),{removed:true,missing:false});
  assert.equal(await page.getByTestId('run-jump').count(),1);
 });
});
