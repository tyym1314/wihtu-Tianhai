import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';
import {join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {chromium,webkit} from 'playwright';

const root=fileURLToPath(new URL('../',import.meta.url));
const run=new Date().toISOString().replaceAll(':','-')+'-'+randomBytes(3).toString('hex');
const output=join(root,'review','console-environment-ui',run);
await mkdir(output,{recursive:true});
const fixture=await mkdtemp(join(root,'review','console-ui-fixture-'));
let server,browser;
const results=[],errors=[];
try{
 await writeFile(join(fixture,'index.html'),'<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head><body><div id="root"></div><script type="module" src="./fixture.jsx"></script></body></html>');
 await writeFile(join(fixture,'fixture.jsx'),`import React from 'react';import {createRoot} from 'react-dom/client';import App from '/src/App.jsx';import '/src/styles.css';createRoot(document.getElementById('root')).render(<React.StrictMode><App/></React.StrictMode>);`);
 server=await createServer({root,configFile:false,plugins:[react()],logLevel:'error',server:{host:'127.0.0.1',port:0}});await server.listen();
 const origin='http://127.0.0.1:'+server.httpServer.address().port;
 for(const [engine,type] of [['chromium',chromium],['webkit',webkit]]){
  browser=await type.launch({headless:true});
  for(const sample of [
   {environment:'production',wallet:'platform',role:'admin'},
   {environment:'production',wallet:'platform',role:'partner'},
   {environment:'production',wallet:'external',role:'partner'},
   {environment:'sandbox',wallet:'reference',role:'admin'},
   {environment:'sandbox',wallet:'reference',role:'partner'},
   {environment:'unknown',wallet:'platform',role:'admin'},
   {environment:null,wallet:'reference',role:'partner'}
  ]){
   const page=await browser.newPage({viewport:{width:1180,height:900}}),requests=[];
   page.on('pageerror',error=>errors.push({engine,sample,message:error.message}));
   await page.addInitScript(mode=>sessionStorage.setItem('oasis-console-mode',mode),sample.role);
   const app={id:'app_real_fixture',name:'Fixture app',partner_id:'fixture_partner',environment:sample.environment,wallet_url:sample.wallet==='external'?'https://wallet.example.invalid':'',wallet_scope_id:'fixture_scope',currency_id:'COIN',currency_scale:2,status:'active',game_ids:['run','match']};
   await page.route('**/api/**',async route=>{
    const req=route.request(),path=new URL(req.url()).pathname;requests.push({path,method:req.method()});
    let body;
    if(path.endsWith('/session'))body={user:{id:'fixture_user',name:'Fixture user',role:sample.role==='partner'?'partner_developer':'platform_admin'},environment:sample.environment};
    else if(path.endsWith('/health'))body={api:'ok',database:'ok',wallet:'ok',production_enabled:false,wallet_dependencies:{status:'ok',providers:{platform:sample.wallet==='platform'?1:0,external:sample.wallet==='external'?1:0,reference:sample.wallet==='reference'?1:0},external_connectivity:'not_checked'}};
    else if(path.endsWith('/apps'))body={apps:[app]};
    else if(path.endsWith('/partner-accounts'))body={accounts:[]};
    else if(path.endsWith('/keys'))body={keys:[]};
    else if(path.endsWith('/integration'))body={platform_origin:origin,allowed_origins:[],checks:[],wallet:{mode:sample.wallet,locked:true,can_configure:false},scope:{environment:sample.environment},partner_key_id:'fixture_key'};
    else throw new Error('Unexpected fixture API: '+path);
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
   });
   await page.goto(origin+'/'+relative(root,fixture)+'/index.html#/partners');
   const known=['production','sandbox'].includes(sample.environment);
   if(!known){
    await page.getByText('后台环境信息不可用，请重新读取。',{exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'创建应用',exact:true}).count(),0);
    assert.equal(await page.getByLabel('当前后台环境').count(),0);
    assert.ok(requests.length>=1&&requests.every(r=>r.path.endsWith('/session')));
   }else{
    await page.getByLabel('当前后台环境').waitFor();
    assert.equal(await page.getByLabel('当前后台环境').innerText(),sample.environment==='production'?'生产环境':'联调沙箱');
    assert.equal(await page.getByRole('combobox',{name:'环境',exact:true}).count(),0);
    await page.getByTestId('integration-wallet').waitFor();
    const hosted=sample.environment==='production'&&sample.wallet==='platform';
    assert.equal(await page.getByTestId('hosted-player-entry').count(),hosted?1:0);
    assert.equal(await page.getByRole('button',{name:'打开沙箱游戏',exact:true}).count(),sample.environment==='sandbox'?1:0);
    if(hosted){
     assert.equal(await page.getByTestId('integration-wallet').getByRole('heading',{name:'平台自有钱包',exact:true}).count(),1);
     assert.equal(await page.getByLabel('钱包地址',{exact:true}).inputValue(),'请查看下方的钱包类型与配置');
     const url=new URL(await page.getByRole('link',{name:'打开玩家入口'}).getAttribute('href'));
     assert.equal(url.origin,origin);assert.equal(url.pathname,'/player');assert.deepEqual([...url.searchParams],[['app_id',app.id]]);
     assert.equal(url.hash,'');assert.equal(url.username,'');assert.equal(url.password,'');
     assert.equal(await page.getByLabel('玩家登录地址').inputValue(),url.href);
     await page.getByTestId('hosted-player-entry').screenshot({path:join(output,`${engine}-${sample.role}-player-entry.png`)});
    }
    if(sample.environment==='production'&&sample.role==='admin'){
     assert.equal(await page.getByRole('button',{name:'创建应用',exact:true}).isDisabled(),true);
     assert.ok((await page.locator('.portal-preview-note').innerText()).includes('生产应用由所属合作方账号创建'));
    }else{
     await page.getByRole('button',{name:'创建应用',exact:true}).click();
     await page.getByRole('heading',{name:sample.environment==='production'?'创建生产应用':'创建沙箱应用',exact:true}).waitFor();
     await page.getByRole('button',{name:'取消',exact:true}).click();
    }
    await page.locator('nav[aria-label="主导航"] a[href="#/docs"]').click();
    await page.getByText('当前必需钱包依赖',{exact:true}).waitFor();
    assert.equal(await page.getByText('外部钱包连接尚未验证；依赖检查通过不代表外部余额或结算可用。',{exact:true}).count(),sample.wallet==='external'?1:0);
    assert.equal(await page.getByRole('button',{name:'打开沙箱游戏',exact:true}).count(),sample.environment==='sandbox'?1:0);
    assert.equal(requests.some(r=>r.method!=='GET'||r.path.endsWith('/launch')),false);
    assert.equal(requests.some(r=>r.path.startsWith(sample.role==='partner'?'/api/admin/':'/api/partner/')),false);
   }
   results.push({engine,...sample,passed:true,requests});await page.close();
  }
  await browser.close();browser=null;
 }
 assert.deepEqual(errors,[]);
 await writeFile(join(output,'report.json'),JSON.stringify({passed:true,cases:results,errors,scope:'Actual console components with synthetic read-only API responses; no production admission or real account mutation.'},null,2));
 console.log(JSON.stringify({passed:true,cases:results.length,report:join(output,'report.json')}));
}catch(error){
 await writeFile(join(output,'failure.json'),JSON.stringify({passed:false,message:error.message,stack:error.stack,cases:results,errors},null,2));throw error;
}finally{await browser?.close();await server?.close();await rm(fixture,{recursive:true,force:true});}
