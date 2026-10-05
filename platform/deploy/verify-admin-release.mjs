/** Read-only public admin verification; credentials never enter reports or screenshots. */
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const origin=process.env.OASIS_VERIFY_ORIGIN||'https://game.tianyahuyu.com';
const expectedRelease=process.env.OASIS_VERIFY_RELEASE||'20260920-03';
const credentials=JSON.parse(await fs.readFile(process.env.OASIS_VERIFY_ADMIN_CREDENTIALS||new URL('../.local/development-credentials.json',import.meta.url),'utf8'));
const out=new URL('../review/deployment/',import.meta.url);await fs.mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage();page.setDefaultTimeout(45000);
const errors=[],report={at:new Date().toISOString(),origin,scope:'Public HTTPS admin login and read-only mobile console verification',passed:false};
page.on('pageerror',error=>errors.push(error.message));
try{
 await page.goto(origin+'/#/releases');await page.locator('input[name=username]').fill(credentials.username);await page.locator('input[name=password]').fill(credentials.password);
 await page.getByRole('button',{name:'登录工作台',exact:true}).click();await page.getByRole('heading',{name:'发布与运行状态',exact:true}).waitFor();
 const status=await page.evaluate(()=>fetch('/api/admin/operations-status').then(async r=>({status:r.status,body:await r.json()})));
 assert.equal(status.status,200);assert.equal(status.body.release?.version,expectedRelease);assert.equal(status.body.monitor.status,'ok');assert.equal(status.body.production_admission_enabled,false);
 if(process.env.OASIS_VERIFY_ANDROID==='passed'){assert.equal(status.body.android?.status,'passed');assert.equal(status.body.android?.games_passed,12);}
 const cookies=await context.cookies(origin+'/api/admin/session');assert.ok(cookies.some(c=>c.name==='oasis_admin'&&c.secure&&c.httpOnly));
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:new URL('release-operations-live-390.png',out).pathname,fullPage:true});
 await page.goto(origin+'/#/security');await page.locator('input[autocomplete="current-password"]').waitFor();
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:new URL('release-security-live-390.png',out).pathname,fullPage:true});
 report.release=status.body.release;report.monitor=status.body.monitor;report.capacity=status.body.capacity;report.android=status.body.android;report.cookie_flags_verified=true;report.errors=errors;assert.deepEqual(errors,[]);report.passed=true;
}catch(error){report.failure=error.message;throw error;}
finally{await fs.writeFile(new URL('release-admin-live.json',out),JSON.stringify(report,null,2));await browser.close();}
console.log(JSON.stringify({passed:report.passed,version:report.release?.version,monitor:report.monitor?.status,capacity:report.capacity?.status}));
