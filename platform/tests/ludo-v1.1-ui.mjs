/** Production LudoGame + actual local HTTP engine. No host/auth or timing claim. */
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium,webkit} from 'playwright';
import {mobileBoardServer} from '../arena/ludo/qa/mobile-board-server.mjs';
import * as engine from '../arena/ludo/engine.mjs';
import * as legacy from '../arena/ludo/engine-v1.mjs';
import {point} from '../arena/ludo/topology.mjs';
const out=resolve(process.env.OASIS_LUDO_UI_OUT||'review/deep-mobile-20261004/ludo');await mkdir(out,{recursive:true});
const server=await mobileBoardServer(),players=[{key:'p0',seatIndex:0,name:'You'},{key:'p1',seatIndex:1,name:'Opponent'}];
const report={scope:'Current production LudoGame component, actual isolated HTTP engine. Desktop Chrome and WebKit mobile viewports with trusted taps; controlled mid-animation server checkpoints are explicitly labelled. Not iPhone, full host auth or a performance measurement.',cases:[],errors:[],cleanup:{}};
let browser;
const seedFor=(die,version=engine.RULE_VERSION)=>{for(let i=0;i<256;i++){const seed=i.toString(16).padStart(2,'0').repeat(32),s=engine.createState(seed,Date.now(),{players,ruleVersion:version});if(s.dice===die)return seed;}throw Error('No fixed die seed');};
const start=(die,version=engine.RULE_VERSION)=>{server.reset('ludo');server.configure('ludo',s=>Object.assign(s,engine.createState(seedFor(die,version),Date.now(),{players,ruleVersion:version})));return server.state('ludo');};
async function until(check,label){const end=Date.now()+5000;while(Date.now()<end){if(await check())return;await new Promise(r=>setTimeout(r,20));}throw Error('Timeout: '+label);}
async function roll(page){const response=page.waitForResponse(r=>r.url().includes('/action?game=ludo')&&r.request().method()==='POST');await page.locator('[data-action=ludo-roll]').tap();const r=await response;assert(r.ok());return r.json();}
try{
 for(const kind of['chromium','webkit']){
  browser=await(kind==='chromium'?chromium.launch({channel:'chrome',headless:true}):webkit.launch({headless:true}));
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:2}),page=await context.newPage();
  page.on('pageerror',e=>report.errors.push({browser:kind,message:e.message}));
  await page.addInitScript(()=>{window.__trustedLudo=[];addEventListener('pointerup',e=>window.__trustedLudo.push({trusted:e.isTrusted,pointerType:e.pointerType}),true);});
  const navigate=async()=>{await page.goto(server.origin+'/?game=ludo');await page.locator('[data-action=ludo-roll]').waitFor();};

  start(2);let count=server.actions.length;await navigate();const die=page.locator('[data-action=ludo-roll]');assert(await die.isEnabled());assert.equal(await die.getAttribute('data-dice-value'),'hidden');await page.waitForTimeout(800);assert.equal(server.state('ludo').rollCount,1);assert.equal(server.state('ludo').revealed,false);assert.equal(server.actions.length,count);
  await page.screenshot({path:resolve(out,`${kind}-no-move-before-reveal.png`)});const noMove=await roll(page);assert.equal(noMove.event.dice,2);assert.equal(noMove.event.autoPassReason,'no-moves');assert.equal(server.actions.length,count+1);assert.equal(await die.getAttribute('data-dice-value'),'2');await page.screenshot({path:resolve(out,`${kind}-no-move-revealed.png`)});await until(()=>server.state('ludo').turnKey==='p1','automatic pass after explicit reveal');await until(async()=>!(await die.getAttribute('class')).includes('ludo-dice-rolling'),'rolling released after pass');report.cases.push({browser:kind,case:'no-move-opening-waits-for-trusted-roll-then-passes',accepted_posts:1,passed:true});

  start(6);server.configure('ludo',s=>{s.sixes=3;s.thirdSix=true;});count=server.actions.length;await navigate();assert(await die.isEnabled());assert.equal(await die.getAttribute('data-dice-value'),'hidden');const third=await roll(page);assert.equal(third.event.autoPassReason,'third-six');assert.equal(third.event.dice,6);assert.equal(server.actions.length,count+1);await until(()=>server.state('ludo').turnKey==='p1','third six passes only after explicit reveal');report.cases.push({browser:kind,case:'third-six-checkpoint-allows-reveal-before-pass',controlled_third_six_checkpoint:true,accepted_posts:1,passed:true});

  start(6);count=server.actions.length;await navigate();const six=await roll(page);assert.equal(six.event.dice,6);await page.locator('[data-pawn-choice="0"]').waitFor();await page.locator('[data-pawn-choice="0"]').tap();const pawn=page.locator('[data-pawn="p0:0"]'),beforeTransform=await pawn.evaluate(e=>e.parentElement.getAttribute('transform'));const movedPromise=page.waitForResponse(r=>r.url().includes('/action?game=ludo')&&r.request().method()==='POST');await page.locator('[data-action=ludo-move]').tap();const moved=await(await movedPromise).json();assert.equal(moved.event.type,'move');assert.equal(moved.event.to,0);assert.equal(moved.room.game.players.find(p=>p.key==='p0').pieces[0],0);assert.equal(server.actions.length,count+2);const [px,py]=point(server.state('ludo').players[0].color,0,0),targetTransform=`translate(${20+(px+.5)*24} ${20+(py+.5)*24})`;await until(async()=>await pawn.evaluate(e=>e.parentElement.getAttribute('transform'))===targetTransform,'visible pawn reaches authoritative target');assert.notEqual(beforeTransform,targetTransform);await page.screenshot({path:resolve(out,`${kind}-six-legal-move.png`)});report.cases.push({browser:kind,case:'six-reveal-unlocks-pawn-and-real-touch-move',accepted_posts:2,svg_before:beforeTransform,svg_after:targetTransform,visible_position_changed:true,passed:true});

  // The companion HTTP client supplies an already-accepted move before 580ms,
  // modelling a newer authoritative event arriving during the local roll effect.
  start(6);await navigate();await roll(page);await until(async()=>(await die.getAttribute('class')).includes('ludo-dice-rolling'),'observed rolling before early move injection');const early=await page.request.post(server.origin+'/action?game=ludo',{data:{type:'move',piece:0}});assert(early.ok());await until(async()=>!(await die.getAttribute('class')).includes('ludo-dice-rolling'),'early real HTTP move cancels presentation');assert.equal(server.state('ludo').lastEvent.type,'move');report.cases.push({browser:kind,case:'early-http-move-replaces-roll-without-stuck-lock',controlled_companion_http:true,passed:true});

  start(6);await navigate();await roll(page);server.configure('ludo',s=>{s.turnDeadlineAt=Date.now()-1;});await until(()=>server.state('ludo').lastEvent?.type==='timeout','controlled authoritative timeout');await until(async()=>!(await die.getAttribute('class')).includes('ludo-dice-rolling'),'timeout cancels presentation');report.cases.push({browser:kind,case:'early-timeout-replaces-roll-without-stuck-lock',controlled_deadline:true,passed:true});

  // Historical auto-pass snapshot uses the actual legacy beginTurn algorithm.
  start(6,legacy.RULE_VERSION);await navigate();await roll(page);server.configure('ludo',s=>{s.seed=seedFor(2,legacy.RULE_VERSION);s.rollCount=0;legacy.testing.beginTurn(s,'p0',Date.now());});await until(async()=>!(await die.getAttribute('class')).includes('ludo-dice-rolling'),'legacy auto-pass cancels presentation');assert.equal(server.state('ludo').ruleVersion,legacy.RULE_VERSION);assert.equal(server.state('ludo').lastEvent.type,'auto-pass');report.cases.push({browser:kind,case:'legacy-auto-pass-replaces-roll-without-stuck-lock',controlled_legacy_checkpoint:true,passed:true});

  for(const width of[360,390]){await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);}
  const trusted=await page.evaluate(()=>window.__trustedLudo);assert(trusted.some(e=>e.trusted&&e.pointerType==='touch'));report.cases.push({browser:kind,case:'trusted-touch-and-360-390-no-overflow',trusted_touch:true,passed:true});
  await context.close();await browser.close();browser=null;
 }
 assert.deepEqual(report.errors,[]);report.passed=true;
}catch(error){report.failure=error.stack;process.exitCode=1;}
finally{await browser?.close();await server.close();report.cleanup={browser_closed:true,http_server_closed:true};report.checked_at=new Date().toISOString();await writeFile(resolve(out,'ui.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));}
