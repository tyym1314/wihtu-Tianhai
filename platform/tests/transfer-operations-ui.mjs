import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,mkdir,readFile} from 'node:fs/promises';
import {join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,createHash} from 'node:crypto';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {chromium,webkit} from 'playwright';

const root=fileURLToPath(new URL('../',import.meta.url)),run=new Date().toISOString().replaceAll(':','-')+'-'+randomBytes(3).toString('hex');
const out=join(root,'review/transfer-operations-ui',run),files=['src/components/TransferOperations.jsx','src/components/transfer-operations.css','src/pages/Admin.jsx','src/api.js'];
await mkdir(out,{recursive:true});const source=async()=>Object.fromEntries(await Promise.all(files.map(async p=>[p,createHash('sha256').update(await readFile(join(root,p))).digest('hex')]))),before=await source();
const fixture=await mkdtemp(join(root,'review/transfer-ops-ui-fixture-'));let server,browser;const cases=[],errors=[];let failure;
try{
 await writeFile(join(fixture,'index.html'),'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="./fixture.jsx"></script>');
 await writeFile(join(fixture,'fixture.jsx'),`import React from 'react';import {createRoot} from 'react-dom/client';import App from '/src/App.jsx';import '/src/styles.css';createRoot(document.getElementById('root')).render(<React.StrictMode><App/></React.StrictMode>);`);
 server=await createServer({root,configFile:false,plugins:[react()],logLevel:'error',server:{host:'127.0.0.1',port:0}});await server.listen();
 const origin='http://127.0.0.1:'+server.httpServer.address().port;
 for(const [engine,type] of [['chromium',chromium],['webkit',webkit]]){
  browser=await type.launch({headless:true});
  for(const mode of ['admin','partner']){
   const page=await browser.newPage({viewport:mode==='partner'?{width:390,height:844}:{width:1280,height:960}}),requests=[];
   page.on('pageerror',e=>errors.push({engine,mode,message:e.message}));
   await page.addInitScript(mode=>sessionStorage.setItem('oasis-console-mode',mode),mode);
   const apps=['app_alpha','app_second'].map((id,i)=>({id,name:i?'第二应用':'合成合作方应用',partner_id:'partner_fixture',environment:'production',currency_scale:2,currency_id:'COIN'}));
   const row={transfer_id:'transfer_original',request_id:'original_request',app_id:'app_alpha',app_name:'合成合作方应用',partner_id:'partner_fixture',environment:'production',direction:'OUT',amount_minor:'12345',currency_id:'COIN',currency_scale:2,state:'PENDING',observation:'TRANSFER_UNKNOWN',pending_age_seconds:1800,age_seconds:1800,attempts:3,next_attempt_at:'2026-10-09T01:00:00Z',retry_state:'BACKOFF',error_category:'OUTCOME_UNKNOWN',local_state:'FUNDS_HELD',external_state:'UNKNOWN',hold:{kind:'FUNDS_RESERVED',amount_minor:'12345'},admission:{app_status:'active',binding_status:'disabled',account_active:true},created_at:'2026-10-09T00:00:00Z',updated_at:'2026-10-09T00:30:00Z'};
   let detailStatus=200,terminal=false,listError=false,holdDetail=false;const heldDetails=[];
   await page.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url());if(url.origin!==origin)throw Error('NON_LOOPBACK_REQUEST');
    if(!url.pathname.startsWith('/api/'))return route.continue();
    requests.push({path:url.pathname,query:url.search,method:req.method()});assert.equal(req.method(),'GET');assert(url.pathname.startsWith('/api/'+mode+'/'));
    const path=url.pathname.replace('/api/'+mode+'/','');let body,status=200;
    if(path==='session')body={user:{id:'fixture_'+mode,name:'Fixture',role:mode==='partner'?'partner_developer':'platform_admin',partner_id:'partner_fixture'},environment:'production'};
    else if(path==='apps')body={apps};
    else if(['rounds','operations'].includes(path))body={[path]:[]};
    else if(path==='audit')body={events:[]};
    else if(path==='transfers'){
     if(listError){status=403;body={error:{code:'SCOPE_FORBIDDEN',message:'合成权限拒绝'}};}
     else body={as_of:'2026-10-09T00:30:00Z',transfers:url.searchParams.get('app_id')==='app_second'?[]:[url.searchParams.has('cursor')?{...row,transfer_id:'transfer_second',request_id:'second_request'}:row],next_cursor:url.searchParams.has('cursor')?null:'fixture_cursor'};
    }else if(path==='transfers/transfer_original'){
     status=detailStatus;body=status===404?{error:{code:'NOT_FOUND',message:'合成原单不存在'}}:{as_of:'2026-10-09T00:31:00Z',transfer:{...row,external_operation_id:'external_operation_original',external_transaction_id:terminal?'external_transaction_confirmed':null,ledger_transaction_id:terminal?'ledger_final':null,external_user_id:'synthetic_user',binding_id:'synthetic_binding',account_id:'synthetic_account',receipt:terminal?{body_sha256:'a'.repeat(64)}:null,...(terminal?{state:'SUCCEEDED',external_state:'SUCCEEDED',local_state:'DEBITED',pending_age_seconds:null,hold:{kind:'NONE',amount_minor:'0'}}:{})}};
     if(holdDetail)await new Promise(resolve=>{heldDetails.push(resolve);});
    }else throw Error('UNEXPECTED_API '+path);
    await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)}).catch(e=>{if(!holdDetail)throw e;});
   });
   await page.goto(origin+'/'+relative(root,fixture)+'/index.html#/ledger');
   const region=page.getByRole('region',{name:'资金划转查询'});
   await region.getByText('original_request',{exact:true}).waitFor();
   assert.match(await region.innerText(),/123\.45 COIN/);assert.match(await region.innerText(),/划出资金保留中/);assert.match(await region.innerText(),/结果未知/);
   await region.getByRole('button',{name:'查看划转 original_request'}).click();
   const dialog=page.getByRole('dialog',{name:'资金划转原单详情'});await dialog.getByText('external_operation_original',{exact:true}).waitFor();
   assert.match(await dialog.innerText(),/划出资金 123\.45 COIN/);assert.equal(await dialog.getByRole('button',{name:/退款|解冻|重试划转|强制/}).count(),0);
   await dialog.screenshot({path:join(out,`${engine}-${mode}-pending.png`)});
   terminal=true;await dialog.getByRole('button',{name:'只读刷新详情'}).click();await dialog.getByText('external_transaction_confirmed',{exact:true}).waitFor();assert.match(await dialog.innerText(),/平台已划出/);assert.match(await dialog.innerText(),/资金保留：无 0\.00 COIN/);
   await dialog.getByRole('button',{name:'关闭划转详情'}).click();cases.push({engine,mode,case:'unknown-hold-safe-detail-and-terminal-readback',passed:true});
   await region.getByRole('button',{name:'下一页划转'}).click();await region.getByText('second_request',{exact:true}).waitFor();assert(await region.getByRole('button',{name:'下一页划转'}).isDisabled());
   await region.getByRole('button',{name:'返回首批划转'}).click();await region.getByText('original_request',{exact:true}).waitFor();
   await region.getByLabel('划转状态',{exact:true}).selectOption('PENDING');await region.getByLabel('划转原始请求号').fill('original_request');const queried=page.waitForResponse(r=>new URL(r.url()).searchParams.get('request_id')==='original_request');await region.getByRole('button',{name:'查询原单',exact:true}).click();await queried;
   assert(requests.some(r=>r.path.endsWith('/transfers')&&new URLSearchParams(r.query).get('state')==='PENDING'&&new URLSearchParams(r.query).get('request_id')==='original_request'));
   cases.push({engine,mode,case:'filters-and-bounded-pagination',passed:true});
   detailStatus=404;await region.getByRole('button',{name:'查看划转 original_request'}).click();await dialog.getByText('合成原单不存在',{exact:true}).waitFor();assert.equal(await dialog.getByText('external_transaction_confirmed',{exact:true}).count(),0);await dialog.getByRole('button',{name:'关闭划转详情'}).click();
   detailStatus=200;holdDetail=true;await region.getByRole('button',{name:'查看划转 original_request'}).click();for(let i=0;i<100&&!heldDetails.length;i++)await page.waitForTimeout(10);assert(heldDetails.length,'Old detail GET must actually be held before switching App');
   await page.getByLabel('应用范围',{exact:true}).selectOption('app_second');await region.getByText('暂无符合条件的资金划转',{exact:true}).waitFor();for(const resolve of heldDetails)resolve();await page.waitForTimeout(100);assert.equal(await page.getByRole('dialog',{name:'资金划转原单详情'}).count(),0);assert.equal(await region.getByText('original_request',{exact:true}).count(),0);holdDetail=false;
   cases.push({engine,mode,case:'not-found-and-late-detail-after-app-scope-switch',passed:true});
   listError=true;await region.getByRole('button',{name:'刷新划转',exact:true}).click();await region.getByText('合成权限拒绝',{exact:true}).waitFor();assert.equal(await region.getByText('original_request',{exact:true}).count(),0);assert(requests.every(r=>r.method==='GET'&&r.path.startsWith('/api/'+mode+'/')));
   cases.push({engine,mode,case:'permission-failure-and-all-requests-read-only',passed:true,requests});await page.close();
  }
  await browser.close();browser=null;
 }
 assert.deepEqual(errors,[]);assert.deepEqual(await source(),before);
}catch(error){failure={message:error.message,stack:error.stack};throw error;}
finally{
 await browser?.close();await server?.close();await rm(fixture,{recursive:true,force:true});
 await writeFile(join(out,'report.json'),JSON.stringify({passed:!failure,cases,errors,failure,source_before:before,source_after:await source(),browser_closed:!browser||!browser.isConnected(),listener_closed:!server?.httpServer?.listening,fixture_removed:true,scope:'Local actual console components and synthetic GET responses in Chromium/WebKit; backend tenant/auth/ledger invariants are tested separately with real isolated PostgreSQL. No real funds or remote requests.'},null,2),{flag:'wx'});
 console.log(JSON.stringify({report:join(out,'report.json'),passed:!failure,cases:cases.length}));
}
