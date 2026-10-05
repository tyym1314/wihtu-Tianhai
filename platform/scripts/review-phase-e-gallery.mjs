import fs from 'node:fs';
import {chromium} from 'playwright';
import {games} from '../src/data.js';
const base=process.env.OASIS_REVIEW_BASE||'http://127.0.0.1:8795',out=new URL('../review/phase-e/',import.meta.url).pathname;
const credentials=JSON.parse(fs.readFileSync(new URL('../.local/development-credentials.json',import.meta.url)));
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}),ctx=await browser.newContext({viewport:{width:1440,height:1000}}),page=await ctx.newPage(),report={at:new Date().toISOString(),media:[],errors:[]};
const assert=(v,m)=>{if(!v)throw Error(m);};page.on('pageerror',e=>report.errors.push(e.message));
try{
 const login=await ctx.request.post(base+'/api/admin/login',{headers:{origin:base},data:credentials});assert(login.ok(),'admin login');await page.goto(base+'/#/games');
 for(const game of games.filter(g=>g.sample)){
  await page.getByRole('button',{name:`查看${game.name}详情`,exact:true}).click();await page.getByRole('img',{name:`${game.name}手机实玩画面`,exact:true}).waitFor();await page.waitForFunction(()=>document.querySelector('.playable-preview img')?.naturalWidth>0,undefined,{timeout:60000});
  await page.getByRole('button',{name:'设计参考',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.design-board')?.naturalWidth>0,undefined,{timeout:60000});
  await page.getByRole('button',{name:'动效录屏',exact:true}).click();await page.waitForFunction(()=>{const v=document.querySelector('.playable-preview video');if(!v)return false;if(v.readyState<2){if(!v.dataset.qaLoaded){v.dataset.qaLoaded='1';v.load();}return false;}return true;},undefined,{timeout:60000});
  const info=await page.locator('.playable-preview video').evaluate(async v=>{await v.play();await new Promise(r=>setTimeout(r,250));v.pause();const duration=v.duration;v.currentTime=Math.min(7,duration/2);await new Promise(r=>v.addEventListener('seeked',r,{once:true}));return{duration,width:v.videoWidth,height:v.videoHeight,currentTime:v.currentTime,readyState:v.readyState};});assert(info.duration>5&&info.width===390&&info.height===844&&info.currentTime>0,'bad clip '+game.id);report.media.push({game:game.id,...info});
  if(game.id==='pool')await page.screenshot({path:out+'platform-motion-preview.png',fullPage:true});await page.getByRole('button',{name:'关闭详情',exact:true}).click();
 }
 await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'查看沙丘竞速详情',exact:true}).click();assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile gallery overflow');await page.screenshot({path:out+'platform-mobile-preview.png',fullPage:true});assert(!report.errors.length,'gallery browser error');
 const health=await ctx.request.get(base+'/api/admin/health');report.health=await health.json();assert(report.health.api==='ok'&&report.health.database==='ok'&&report.health.wallet==='ok','health');
}catch(e){report.failure=e.stack;throw e;}finally{fs.writeFileSync(out+'gallery-validation.json',JSON.stringify(report,null,2));await browser.close();}
console.log(JSON.stringify(report));
