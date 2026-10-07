import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';
import {join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {chromium} from 'playwright';

const root=fileURLToPath(new URL('../',import.meta.url)),output=join(root,'review','integration-wallet-ui');
await mkdir(output,{recursive:true});
const fixture=await mkdtemp(join(root,'review','wallet-ui-fixture-'));
let server,browser;
try{
 await writeFile(join(fixture,'index.html'),'<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head><body><div id="root"></div><script type="module" src="./fixture.jsx"></script></body></html>');
 await writeFile(join(fixture,'fixture.jsx'),`import React from 'react';import {createRoot} from 'react-dom/client';import IntegrationPanel from '/src/components/IntegrationPanel.jsx';import '/src/styles.css';const environment=new URLSearchParams(location.search).get('environment');createRoot(document.getElementById('root')).render(React.createElement(IntegrationPanel,{app:{id:'ui_wallet_app',name:'Wallet UI fixture',environment,status:'active',game_ids:['match']}}));`);
 server=await createServer({root,configFile:false,plugins:[react()],logLevel:'error',server:{host:'127.0.0.1',port:0}});await server.listen();
 const origin='http://127.0.0.1:'+server.httpServer.address().port;
 browser=await chromium.launch({headless:true});
 const results=[];
 for(const sample of [
  {environment:'production',mode:'platform',label:'平台自有钱包',probe:true},
  {environment:'production',mode:'external',label:'外部生产钱包',probe:true},
  {environment:'production',mode:'unconfigured',label:'钱包尚未配置',probe:false},
  {environment:'production',mode:'unexpected',label:'钱包状态未知',probe:false},
  {environment:'production',mode:'reference',label:'钱包状态未知',probe:false},
  {environment:'sandbox',mode:'reference',label:'平台参考钱包',probe:true},
  {environment:'sandbox',mode:'external',label:'独立沙箱钱包',probe:true},
  {environment:'sandbox',mode:'platform',label:'钱包状态未知',probe:false}
 ]){
  const page=await browser.newPage({viewport:{width:1180,height:900}}),errors=[],requests=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/**',async route=>{
   const request=route.request(),path=new URL(request.url()).pathname;
   let body;
   if(path.endsWith('/keys'))body={keys:[]};
   else if(path.endsWith('/probe')){
    const payload=request.postDataJSON();requests.push(payload);
    body={elapsed_ms:2,read_only:true,balance:{currency_id:'COIN',balance:{external_user_id:payload.external_user_id,available_minor:'0',reserved_minor:'0',currency_scale:2}}};
   }else body={platform_origin:origin,allowed_origins:['https://partner.example.invalid'],checks:[],wallet:{mode:sample.mode,wallet_url:sample.mode==='external'?'https://wallet.example.invalid':'',locked:sample.mode!=='unconfigured',can_configure:sample.mode==='unconfigured'}};
   await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.goto(origin+'/'+relative(root,fixture)+'/index.html?environment='+sample.environment);
  const card=page.getByTestId('integration-wallet');await card.getByRole('heading',{name:sample.label,exact:true}).waitFor();
  const input=card.getByRole('textbox'),probeButton=card.getByRole('button',{name:'查询玩家余额'});
  assert.equal(await input.inputValue(),sample.environment==='production'?'':'demo_player');
  assert.equal(await probeButton.isDisabled(),sample.environment==='production'||!sample.probe);
  if(sample.environment==='production')assert.equal(await page.getByRole('button',{name:'运行沙箱检查',exact:true}).isDisabled(),true);
  if(sample.probe){
   const expected=sample.environment==='production'?'player_real_app_123':'demo_player';
   if(sample.environment==='production')await input.fill(expected);
   assert.equal(await probeButton.isEnabled(),true);await probeButton.click();await card.getByRole('status').waitFor();
   assert.deepEqual(requests,[{external_user_id:expected}]);assert.ok((await card.getByRole('status').innerText()).includes(expected));
   if(sample.environment==='production')assert.ok(!(await card.innerText()).includes('demo_player'));
  }else{
   assert.equal(requests.length,0);
   if(sample.label==='钱包状态未知')assert.equal(await card.getByRole('button',{name:'绑定外部钱包'}).isDisabled(),true);
  }
  assert.deepEqual(errors,[]);await card.screenshot({path:join(output,`${sample.environment}-${sample.mode}.png`)});
  results.push({...sample,requests,errors,passed:true});await page.close();
 }
 await writeFile(join(output,'report.json'),JSON.stringify({passed:true,cases:results},null,2));console.log(JSON.stringify({passed:true,cases:results.length,report:join(output,'report.json')}));
}finally{await browser?.close();await server?.close();await rm(fixture,{recursive:true,force:true});}
