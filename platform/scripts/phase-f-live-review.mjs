// Local Phase F acceptance. Creates only its own sandbox partner/App and wallet.
// Credentials stay in .local; reports and screenshots contain no secrets.
import {chromium} from 'playwright';
import pg from 'pg';
import {randomBytes} from 'node:crypto';
import {readFile,writeFile,mkdir,chmod} from 'node:fs/promises';
import {openSync,closeSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
const root=resolve(import.meta.dirname,'..'),base='http://127.0.0.1:8795',out=resolve(root,'review/phase-f');
const privateFile=resolve(root,'.local/phase-f-partner-account.json');
const save=async(path,data)=>{await writeFile(path,JSON.stringify(data,null,2),{mode:0o600});await chmod(path,0o600);};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(fn,label,ms=30000){for(const until=Date.now()+ms;Date.now()<until;){if(await fn())return;await sleep(300);}throw Error('Timed out: '+label);}
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const adminContext=await browser.newContext({viewport:{width:1440,height:1000}}),partnerContext=await browser.newContext({viewport:{width:1440,height:1100}});
const admin=await adminContext.newPage(),page=await partnerContext.newPage();
async function login(p,credentials,partner=false){await p.goto(base+'/#/partners');if(partner)await p.getByRole('button',{name:'合作方账号',exact:true}).click();await p.locator('input[name=username]').fill(credentials.username);await p.locator('input[name=password]').fill(credentials.password);await p.getByRole('button',{name:'登录工作台',exact:true}).click();await p.getByRole('heading',{name:'合作方与应用',exact:true}).waitFor();}
let account,appRecord;
try{
 await login(admin,JSON.parse(await readFile(resolve(root,'.local/development-credentials.json'),'utf8')));
 try{account=JSON.parse(await readFile(privateFile,'utf8'));}catch{
  account={name:'Majlis 独立接入示例',username:'majlis_phase_f',password:randomBytes(20).toString('base64url')};
  await admin.getByRole('button',{name:'创建账号',exact:true}).click();await admin.locator('input[name=partnerName]').fill(account.name);await admin.locator('input[name=partnerUsername]').fill(account.username);await admin.locator('input[name=partnerPassword]').fill(account.password);
  const response=admin.waitForResponse(r=>r.url().endsWith('/api/admin/partner-accounts')&&r.request().method()==='POST');await admin.getByRole('button',{name:'创建合作方账号',exact:true}).click();const created=await response;assert.equal(created.status(),201);account.account=(await created.json()).account;await save(privateFile,account);
 }
 await login(page,account,true);
 if(!account.app){
  await page.getByRole('button',{name:'创建应用',exact:true}).click();await page.getByPlaceholder('例如：Layali').fill('Majlis 独立沙箱');const response=page.waitForResponse(r=>r.url().endsWith('/api/partner/apps')&&r.request().method()==='POST');await page.getByRole('button',{name:'创建沙箱应用',exact:true}).click();const created=await response;assert.equal(created.status(),201);appRecord=await created.json();account.app=appRecord.app;account.credentials=appRecord.credentials;await save(privateFile,account);await page.getByRole('button',{name:'已保存，关闭'}).click();
 }
 const appId=account.app.id,apiPath='/api/partner/apps/'+appId;
 const result=await partnerContext.request.get(base+'/api/partner/apps');assert.equal((await result.json()).apps.length,1);
 const current=(await (await partnerContext.request.get(base+apiPath+'/integration')).json());
 if(!current.wallet.locked){
  const toggle=page.getByRole('switch',{name:'应用接入启用',exact:true});if(await toggle.getAttribute('aria-checked')==='true')await toggle.click();
  await page.getByRole('button',{name:'刷新接入状态'}).click();
  const walletDir=resolve(root,'.local/partner-wallet');await mkdir(walletDir,{recursive:true,mode:0o700});await chmod(walletDir,0o700);
  const profiles=(await(await adminContext.request.get(base+'/api/admin/profiles')).json()).profiles;
  account.wallet={key_id:'wk_phase_f_'+randomBytes(8).toString('hex'),secret_base64:randomBytes(32).toString('base64')};await save(privateFile,account);
  const scope={partner_id:account.app.partner_id,app_id:appId,environment:'sandbox',wallet_scope_id:account.app.wallet_scope_id,currency_id:account.app.currency_id};
  await save(resolve(walletDir,'config.json'),{schema_version:1,scope,currency_scale:2,...account.wallet,treasury_minor:'1000000000000',users:['demo_player','demo_player_2','demo_player_3','demo_player_4'].map(external_user_id=>({external_user_id,balance_minor:'1200000'})),math_profiles:profiles.map(p=>({game_id:p.gameId,math_version:p.version,math_config_hash:p.hash,max_payout_multiplier:String(p.maxMultiplier)}))});
  const db=new pg.Pool({connectionString:'postgres://oasis_local@127.0.0.1:5487/postgres'});try{if(!(await db.query('SELECT 1 FROM pg_database WHERE datname=$1',['oasis_partner_sandbox'])).rowCount)await db.query('CREATE DATABASE oasis_partner_sandbox');}finally{await db.end();}
  const log=openSync(resolve(walletDir,'server.log'),'a',0o600);const child=spawn(process.execPath,['examples/partner-wallet/server.mjs'],{cwd:root,env:{...process.env,OASIS_PARTNER_WALLET_DATABASE_URL:'postgres://oasis_local@127.0.0.1:5487/oasis_partner_sandbox',OASIS_PARTNER_WALLET_CONFIG:resolve(walletDir,'config.json')},detached:true,stdio:['ignore',log,log]});child.unref();closeSync(log);
  await wait(async()=>{try{return(await fetch('http://127.0.0.1:8801/health')).ok;}catch{return false;}},'independent wallet');
  await page.getByRole('button',{name:'绑定外部钱包',exact:true}).click();await page.getByLabel('钱包 Key ID',{exact:true}).fill(account.wallet.key_id);await page.getByLabel('钱包 Secret',{exact:true}).fill(account.wallet.secret_base64);const binding=page.waitForResponse(r=>r.url().endsWith('/integration/wallet'));await page.getByRole('button',{name:'保存并锁定绑定'}).click();assert.equal((await binding).status(),200);
  await save(resolve(root,'.local/partner-host.json'),{platform_base_url:base,host_origin:'http://127.0.0.1:8800',key_id:account.credentials.key_id,secret_base64:account.credentials.secret_base64,scope,external_user_id:'demo_player'});
 }
 await page.getByLabel('允许的宿主 Origin').fill(base+'\nhttp://127.0.0.1:8800');const origins=page.waitForResponse(r=>r.url().endsWith('/integration/origins'));await page.getByRole('button',{name:'保存宿主来源'}).click();assert.equal((await origins).status(),200);
 const probe=page.waitForResponse(r=>r.url().endsWith('/integration/probe'));await page.getByRole('button',{name:'查询玩家余额'}).click();assert.equal((await probe).status(),200);
 const toggle=page.getByRole('switch',{name:'应用接入启用',exact:true});if(await toggle.getAttribute('aria-checked')==='false')await toggle.click();
 let hostAlive=false;try{hostAlive=(await fetch('http://127.0.0.1:8800/api/host/config')).ok;}catch{}
 if(!hostAlive){const log=openSync(resolve(root,'.local/partner-host.log'),'a',0o600);const child=spawn(process.execPath,['specs/examples/partner-host/server.mjs','--config',resolve(root,'.local/partner-host.json')],{cwd:root,detached:true,stdio:['ignore',log,log]});child.unref();closeSync(log);}
 await wait(async()=>{try{return(await fetch('http://127.0.0.1:8800/api/host/config')).ok;}catch{return false;}},'independent host');
 let checks=(await(await partnerContext.request.get(base+apiPath+'/integration/checks')).json()).checks;
 if(!checks.length){await page.getByRole('button',{name:'运行沙箱检查'}).click();}
 await wait(async()=>{checks=(await(await partnerContext.request.get(base+apiPath+'/integration/checks')).json()).checks;if(checks[0]?.status==='FAILED')throw Error('Integration failed: '+checks[0].error_code);return checks[0]?.status==='PASSED';},'real independent wallet check',140000);
 await page.reload();await page.getByTestId('integration-panel').waitFor();await page.getByText('本地检查通过',{exact:true}).waitFor();await page.screenshot({path:resolve(out,'partner-workspace.png'),fullPage:true});
 await page.getByTestId('integration-panel').screenshot({path:resolve(out,'integration-checks.png')});
 await writeFile(resolve(out,'main-integration.json'),JSON.stringify({at:new Date().toISOString(),partner_id:account.app.partner_id,app_id:appId,own_app_count:1,independent_wallet_origin:'http://127.0.0.1:8801',independent_wallet_database:'oasis_partner_sandbox',host_origin:'http://127.0.0.1:8800',check:checks[0],boundary:'Local sandbox only; no external partner or physical device acceptance'},null,2));
 console.log(JSON.stringify({passed:true,app_id:appId,checks:checks[0].checks.length,status:checks[0].status}));
}finally{await browser.close();}
