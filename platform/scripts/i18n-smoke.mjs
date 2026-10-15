/**
 * Live smoke: for each game and language, launch through the demo partner, start a free
 * practice, and verify the UI renders without exceptions or leftover Chinese (en/ar).
 *   node scripts/i18n-smoke.mjs [games=all] [langs=zh,en,ar]
 */
import {chromium,devices} from 'playwright';
const DEMO=process.env.OASIS_DEMO_URL||'https://partner-demo.43.98.202.236.sslip.io/';
const ALL=['match','golf','bowling','carrom','darts','ludo','jackaroo','domino','pool','run','towerlink'];
const games=(process.argv[2]&&process.argv[2]!=='all'?process.argv[2].split(','):ALL),langs=(process.argv[3]||'zh,en,ar').split(',');
const CJK=/[\u3400-\u9fff]/;
const browser=await chromium.launch();const results=[];
for(const lang of langs)for(const game of games){
 const context=await browser.newContext({...devices['Pixel 7'],locale:lang==='zh'?'zh-CN':lang});const page=await context.newPage();const errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 const r={lang,game,ok:false};
 try{
  await page.goto(DEMO,{waitUntil:'domcontentloaded'});
  await page.click(`[data-lang=${lang}]`);await page.click(`[data-game=${game}]`);
  await page.waitForURL(/\/launch\//,{timeout:15000});
  const frame=page.frameLocator('iframe');
  const practice=frame.locator('.lobby-secondary button').nth(game==='towerlink'?2:1);
  await practice.waitFor({timeout:30000});await page.waitForFunction(()=>{const d=document.querySelector('iframe')?.contentDocument;const b=d&&d.querySelectorAll('.lobby-secondary button');return b&&[...b].every(x=>!x.disabled);},null,{timeout:30000});
  r.lobbyText=(await frame.locator('#root').innerText()).replace(/\s+/g,' ');
  await practice.click();
  await page.waitForTimeout(7000);
  r.gameText=(await frame.locator('#root').innerText()).replace(/\s+/g,' ');
  r.dir=await frame.locator('.arena-shell').first().getAttribute('dir').catch(()=>null);
  const leftover=lang==='zh'?[]:[...new Set(((r.lobbyText+' '+r.gameText).match(/[\u3400-\u9fff][^\s·,.:;!?()<>]*/g)||[]))];
  r.leftover=leftover.slice(0,12);r.errors=errors.slice(0,3);
  r.ok=errors.length===0&&r.gameText.length>20&&leftover.length===0;
  await page.screenshot({path:`/tmp/shots/smoke-${lang}-${game}.png`});
 }catch(e){r.error=e.message.split('\n')[0];r.errors=errors.slice(0,3);}
 // Leave the practice so the demo user has no active room for the next game.
 try{await page.evaluate(()=>window.OasisLauncher?.requestBack());await page.waitForTimeout(800);const f=page.frameLocator('iframe');const leave=f.locator('.arena-modal .arena-text-button');if(await leave.count())await leave.last().click();await page.waitForTimeout(1500);}catch{}
 delete r.lobbyText;r.gameText=r.gameText?.slice(0,90);results.push(r);console.log(JSON.stringify(r));
 await context.close();
}
await browser.close();
const failed=results.filter(r=>!r.ok);console.log(`\n${results.length-failed.length}/${results.length} passed`);process.exitCode=failed.length?1:0;
