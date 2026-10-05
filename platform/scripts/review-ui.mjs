import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const out=path.join(root,'review');fs.mkdirSync(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.REVIEW_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const context=await browser.newContext({viewport:{width:1440,height:1000},deviceScaleFactor:1});
const p=await context.newPage();
const errors=[],results=[];
p.on('pageerror',e=>errors.push(e.message));
const go=async route=>{await p.goto(`http://127.0.0.1:8795/#/${route}`);await p.locator('main').waitFor();await p.waitForTimeout(180);};
async function check(name,fn){try{await fn();results.push({name,result:'PASS'});console.log('PASS',name);}catch(e){results.push({name,result:'FAIL',error:e.message});console.error('FAIL',name,e.message);await p.screenshot({path:path.join(out,'failure-'+results.length+'.png'),fullPage:true});}}
try {
  await check('Seven desktop pages render without horizontal overflow',async()=>{
    for(const r of ['overview','games','settings','partners','docs','ledger','releases']){
      await go(r);assert.equal(await p.locator('h1').count(),1,r);
      assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,r);
      await p.screenshot({path:path.join(out,`${r}-desktop.png`),fullPage:true});
    }
  });
  await check('12-game catalog, category/search/list and original game link',async()=>{
    await go('games');assert.equal(await p.locator('.game-card').count(),12);
    await p.getByRole('button',{name:/^概率游戏/}).click();assert.equal(await p.locator('.game-card').count(),2);
    await p.getByRole('button',{name:'查看虎虎生财详情',exact:true}).click();
    assert.equal(await p.getByRole('link',{name:'打开原独立试玩'}).getAttribute('href'),'http://127.0.0.1:8790/');
    await p.getByRole('button',{name:'关闭详情',exact:true}).click();
    await p.getByRole('button',{name:/^竞技对战/}).click();assert.equal(await p.locator('.game-card').count(),10);
    await p.getByRole('textbox',{name:'筛选游戏'}).fill('绿洲');assert.equal(await p.locator('.game-card').count(),1);
    await p.getByRole('button',{name:'列表视图'}).click();assert.equal(await p.locator('.data-table tbody tr').count(),1);
  });
  await check('Payout calculator respects 2-decimal coin precision and team split',async()=>{
    await go('settings');await p.getByRole('button',{name:'2 人',exact:true}).click();
    assert.match(await p.locator('.prize-number').innerText(),/^190/);
    await p.getByLabel(/每人入场金币/).selectOption('50');await p.getByRole('button',{name:'3 人',exact:true}).click();await p.getByRole('button',{name:'3%',exact:true}).click();
    assert.match(await p.locator('.prize-number').innerText(),/^145\.5/);
    await p.getByRole('button',{name:'恢复默认'}).click();await p.getByRole('switch',{name:'队伍平均分奖'}).click();
    assert.match(await p.locator('.payout-lines .total').innerText(),/190/);
    await p.getByRole('button',{name:'保存设计草稿'}).click();assert.equal(await p.getByRole('button',{name:'草稿已保存'}).count(),1);
    await p.getByRole('button',{name:'概率数学版本'}).click();await p.locator('.rtp-option').filter({hasText:'98'}).click();
    assert.match(await p.locator('.math-table').innerText(),/rtp98-candidate/);
    assert.match(await p.locator('.math-table').innerText(),/不能生产生效/);
    await p.screenshot({path:path.join(out,'rtp-desktop.png'),fullPage:true});
    await p.getByRole('button',{name:'查看发布流程'}).click();await p.locator('.release-banner').waitFor();assert.equal(await p.locator('.release-banner').count(),1);
  });
  await check('Partner create validation and App-specific local game permissions',async()=>{
    await go('partners');await p.getByRole('button',{name:'创建应用',exact:true}).click();
    await p.getByRole('button',{name:'创建本地应用'}).click();assert.match(await p.getByRole('alert').innerText(),/2–24/);
    await p.getByPlaceholder('例如：Layali').fill('Layali');await p.getByPlaceholder('layali',{exact:true}).fill('layali');
    await p.getByRole('button',{name:'创建本地应用'}).click();
    assert.equal(await p.locator('.portal-app-card').count(),4);
    assert.equal(await p.getByRole('switch',{checked:true}).count(),0);
    await p.getByRole('switch',{name:/Carrom.*本地游戏授权/}).click();assert.equal(await p.getByRole('switch',{checked:true}).count(),1);
    await p.locator('.portal-app-card').filter({hasText:'Majlis'}).click();assert.equal(await p.getByRole('switch',{checked:true}).count(),6);
    await p.locator('.portal-app-card').filter({hasText:'Layali'}).click();assert.equal(await p.getByRole('switch',{checked:true}).count(),1);
    await p.getByLabel(/钱包服务地址/).fill('http://wallet.example');await p.getByLabel(/事件接收地址/).fill('https://wallet.example/events');await p.getByLabel(/允许来源/).fill('https://app.example');
    await p.getByRole('button',{name:'保存本地配置'}).click();assert.match(await p.getByRole('alert').innerText(),/HTTPS/);
    await p.getByLabel(/钱包服务地址/).fill('https://wallet.example');await p.getByRole('button',{name:'保存本地配置'}).click();assert.equal(await p.getByRole('alert').count(),0);
  });
  await check('Wallet flow: success, failure, timeout, cancellation, duplicate result',async()=>{
    await go('docs');
    for(const [id,a,b] of [['success','1,090','900'],['insufficient','1,000','80'],['timeout','1,090','900'],['cancel','1,000','1,000'],['duplicate','1,090','900']]){
      await p.getByLabel('演示场景').selectOption(id);await p.getByRole('button',{name:'运行本地演示'}).click();
      await p.waitForFunction(()=>document.querySelector('.portal-simulator-footer')?.textContent.includes('本地流程演示完成'),null,{timeout:10000});
      const text=await p.locator('.portal-ledger-preview').innerText();assert.ok(text.includes(a),id+' A');assert.ok(text.includes(b),id+' B');
    }
    await p.screenshot({path:path.join(out,'wallet-demo-desktop.png'),fullPage:true});
  });
  await check('Developer documentation and language switching use nine-line signature',async()=>{
    await p.locator('.portal-doc-nav-item').filter({hasText:'请求签名'}).click();
    for(const language of ['Node.js','Java','PHP']){await p.getByRole('tab',{name:language,exact:true}).click();const code=await p.locator('.portal-code').innerText();assert.ok(code.includes('GP-HMAC-SHA256-V1'),language);}
    const response=await p.request.get('http://127.0.0.1:8795/specs/openapi.json');assert.equal(response.status(),200);assert.equal((await response.json()).openapi,'3.1.0');
  });
  await check('Unknown settlement lookup preserves original result and CSV export',async()=>{
    await go('ledger');await p.getByRole('button',{name:'查看待确认',exact:true}).click();assert.equal(await p.locator('.data-table tbody tr').count(),1);
    await p.getByRole('button',{name:'详情',exact:true}).click();await p.getByRole('button',{name:'演示查单恢复'}).click();
    await p.getByRole('button',{name:'再次查单（结果不变）'}).click();assert.match(await p.locator('.ledger-summary').innerText(),/已结算/);
    await p.getByRole('button',{name:'关闭局单详情'}).click();
    const download=p.waitForEvent('download');await p.getByRole('button',{name:'导出示例'}).click();const d=await download;assert.equal(d.suggestedFilename(),'oasis-design-sample-rounds.csv');
  });
  await check('Production design view prevents simulated connection actions',async()=>{
    await go('partners');await p.getByLabel('环境',{exact:true}).selectOption('live');assert.equal(await p.getByRole('button',{name:'创建应用',exact:true}).isDisabled(),true);
    await p.getByRole('link',{name:'接入与文档'}).click();assert.equal(await p.getByRole('button',{name:'运行本地演示'}).isDisabled(),true);
    await p.getByRole('link',{name:'规则与收益'}).click();assert.equal(await p.getByRole('button',{name:'保存设计草稿'}).isDisabled(),true);
    await p.getByLabel('环境',{exact:true}).selectOption('sandbox');
  });
  await check('390px and 360px design layouts; keyboard and mobile navigation',async()=>{
    for(const width of [390,360]){await p.setViewportSize({width,height:844});for(const route of ['overview','games','settings','partners','docs','ledger','releases']){await go(route);assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${route} ${width}px`);if(width===390)await p.screenshot({path:path.join(out,`${route}-mobile.png`),fullPage:true});}}
    await p.getByRole('button',{name:'打开导航'}).click();assert.equal(await p.locator('.sidebar.is-open').count(),1);await p.getByRole('link',{name:/游戏中心/}).click();assert.equal(await p.locator('.sidebar.is-open').count(),0);
  });
  await check('No unhandled browser errors',async()=>assert.deepEqual(errors,[]));
} finally {
  const report={testedAt:new Date().toISOString(),browser:await browser.version(),scope:'Desktop Chrome and resized desktop viewports; design-state interactions only, not real iOS/Android/wallet integration.',results,pageErrors:errors};
  fs.writeFileSync(path.join(out,'ui-review.json'),JSON.stringify(report,null,2)+'\n');
  await browser.close();
}
if(results.some(r=>r.result==='FAIL'))process.exitCode=1;
