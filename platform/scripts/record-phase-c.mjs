import fs from 'node:fs';import {chromium} from 'playwright';import {legalMoves} from '../arena/match/engine.mjs';
const base='http://127.0.0.1:8795',dir=new URL('../review/phase-c/videos/',import.meta.url).pathname;fs.mkdirSync(dir,{recursive:true});
const credentials=JSON.parse(fs.readFileSync(new URL('../.local/development-credentials.json',import.meta.url)));
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const ctx=await browser.newContext({viewport:{width:390,height:844},recordVideo:{dir,size:{width:390,height:844}}});const host=await ctx.newPage(),paths=[];
try{
 await ctx.request.post(base+'/api/admin/login',{headers:{origin:base},data:credentials});await host.goto(base+'/#/partners');await host.locator('.sandbox-launcher').waitFor();const apps=(await(await ctx.request.get(base+'/api/admin/apps')).json()).apps;const app=apps.find(a=>a.name==='QA UI')||apps[0];await host.locator('.portal-app-card').filter({hasText:app.name}).click();
 for(const game of ['match','golf']){
 await host.locator('.sandbox-launcher select').last().selectOption(game);await host.getByLabel('测试用户 ID',{exact:true}).fill('demo_player_4');const pp=host.waitForEvent('popup');await host.getByRole('button',{name:'打开沙箱游戏',exact:true}).click();const page=await pp;await page.setViewportSize({width:390,height:844});let room;page.on('response',async r=>{if(r.url().includes('/api/pvp/rooms')&&r.status()<300)try{const d=await r.json();if(d.id&&(!room||d.id!==room.id||d.version>=room.version))room=d;}catch{}});await page.locator('.lobby-settings').waitFor();await page.waitForTimeout(900);await page.getByRole('button',{name:'免费练习',exact:false}).click();await page.getByRole('button',{name:'确认规则 · 准备开局',exact:true}).click();await page.locator(game==='match'?'.match-board':'.og-canvas canvas').waitFor();await page.waitForTimeout(1200);
 if(game==='match')for(let i=0;i<5;i++){const m=legalMoves(room.game.board)[0];await page.locator(`[data-cell="${m.from}"]`).click();await page.locator(`[data-cell="${m.to}"]`).click();await page.waitForTimeout(2200);}
 else{await page.getByTestId('golf-shoot').click();await page.waitForTimeout(7300);await page.getByTestId('golf-shoot').click();await page.waitForTimeout(4000);}
 await page.getByRole('button',{name:'返回房间',exact:true}).click();await page.getByRole('button',{name:'确认离开',exact:true}).click();await page.getByRole('button',{name:'再来一局',exact:true}).waitFor();await page.close();const video=await page.video().path(),target=dir+game+'-motion.webm';fs.renameSync(video,target);paths.push(target);
 }
}finally{await host.close();const unused=await host.video().path();await browser.close();fs.unlinkSync(unused);}
console.log(JSON.stringify({videos:paths,audio:'Playwright screen recordings do not include audio. Signal and mute validated separately.'}));
