/** Real browser CSS/touch regression only; no renderer, game/API or device claim. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from 'playwright';

const root=resolve(new URL('..',import.meta.url).pathname);
const out=resolve(process.env.RUN_CONTROL_CSS_OUT||resolve(root,'review/run-control-feedback-css'));
const paths=['arena/shell.css','arena/run/run.css'],sources=await Promise.all(paths.map(path=>readFile(resolve(root,path),'utf8')));
const report={scope:'Actual source CSS in isolated Chrome touch DOM; no React commit, game, GPU, public host or physical-device performance proof.',
 startedAt:new Date().toISOString(),sourceFiles:paths.map((path,index)=>({path,bytes:Buffer.byteLength(sources[index]),sha256:createHash('sha256').update(sources[index]).digest('hex')})),cases:[],errors:[],assertionFailures:[],passed:false};
const browser=await chromium.launch({channel:'chrome',headless:true});
const context=await browser.newContext({viewport:{width:412,height:850},deviceScaleFactor:3,isMobile:true,hasTouch:true});
const page=await context.newPage(),cdp=await context.newCDPSession(page);
page.on('pageerror',error=>report.errors.push(error.message));
const fixture=`<button id="other-control" style="position:fixed;z-index:20;left:4px;top:4px;width:90px;height:32px">Other control</button>
<section class="run-scene"><div class="run-bottom"><div class="run-speed"><b>8.0<small>m/s</small></b><span>滑动或按键操作</span></div>
<div class="run-main-controls"><button class="run-item" data-testid="run-item"><span>✦</span><b>护盾</b><small>TAP TO ACTIVATE</small></button><button class="run-jump" data-testid="run-jump"><b>跳跃</b><small>JUMP</small></button></div>
<div class="run-direction-controls"><button data-testid="run-left" aria-label="向左换道">←</button><button class="run-slide" data-testid="run-slide"><b>滑铲</b></button><button data-testid="run-right" aria-label="向右换道">→</button></div>
<div class="run-footnote"><span>OASIS · ARENA</span><span>480 m</span></div></div></section>`;
const read=async id=>page.locator(id).evaluate(element=>window.readControlStyle(element));
const touch=async(type,point)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'?[]:[point]});
const verify=(name,check)=>{try{check();}catch(error){report.assertionFailures.push({name,message:error.message});}};
function scaled(actual,base){
 assert.equal(actual.transform,'matrix(0.94, 0, 0, 0.94, 0, 0)');
 assert.deepEqual(actual.layout,base.layout,'feedback cannot relayout or move the touch target');
 // DOMRect values use browser floating point; this checks the original .94
 // center transform and is unrelated to native/performance geometry gates.
 for(const key of ['width','height'])assert.ok(Math.abs(actual.rect[key]-base.rect[key]*.94)<.0001,key+' scale');
 for(const [position,size]of [['x','width'],['y','height']])assert.ok(Math.abs(actual.rect[position]+actual.rect[size]/2-base.rect[position]-base.rect[size]/2)<.0001,position+' center');
}
try{
 for(const order of [[0,1],[1,0]]){
  await page.setContent(`<meta name="viewport" content="width=device-width,initial-scale=1"><style>${order.map(index=>sources[index]).join('\n')}</style>${fixture}`);
  await page.evaluate(()=>{
   window.readControlStyle=element=>{const rect=element.getBoundingClientRect(),style=getComputedStyle(element);return{
    disabled:element.disabled,active:element.matches(':active'),transform:style.transform,rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},
    layout:{left:element.offsetLeft,top:element.offsetTop,width:element.offsetWidth,height:element.offsetHeight}};};
   window.touchEvents=[];
   // Chrome's real touch compatibility mouse/click dispatch can retain its
   // active style while matches(':active') is already false. Record the
   // original computed style inside those trusted events, without forcing
   // pseudo state or synthesizing DOM events.
   for(const type of ['pointerdown','pointerup','mousedown','mouseup','click'])document.addEventListener(type,event=>{
    const button=event.target.closest('button');if(button)touchEvents.push({type,trusted:event.isTrusted,id:button.dataset.testid||button.id,state:readControlStyle(button)});
   },true);
  });
  for(const type of ['item','jump','left','slide','right']){
   const id=`[data-testid="run-${type}"]`,base=await read(id),point={x:base.rect.x+base.rect.width/2,y:base.rect.y+base.rect.height/2};
   assert.equal(base.transform,'none');
   const row={order:order.map(index=>paths[index]),type,base,states:[]};report.cases.push(row);
   for(const disabled of [false,true])for(const feedback of [false,true]){
    // Separate independent touches so Chrome's short active-style retention
    // from one tap does not suppress the next tap's compatibility styling.
    // This fixture pause is unrelated to the game's 170 ms feedback timer.
    await page.waitForTimeout(220);
    await page.evaluate(({id,disabled,feedback,type})=>{const element=document.querySelector(id);element.disabled=disabled;document.querySelector('.run-scene').className='run-scene'+(feedback?' run-feedback-'+type:'');window.touchEvents=[];}, {id,disabled,feedback,type});
    const before=await read(id);await touch('touchStart',point);const down=await read(id);
    await touch('touchEnd',point);const released=await read(id),events=await page.evaluate(()=>touchEvents);
    const state={disabled,feedback,before,down,released,events};row.states.push(state);
    verify(`${type}/${disabled}/${feedback}/trusted-events`,()=>{
     assert.ok(events.every(event=>event.trusted));
     if(!disabled)assert.equal(events.filter(event=>event.type==='click'&&event.id==='run-'+type).length,1,'one real touch generates one native click');
     else assert.equal(events.filter(event=>event.type==='click').length,0,'disabled controls cannot click');
    });
    for(const [phase,value]of [['before',before],['touch-down',down],...events.map(event=>[event.type,event.state]),['released',released]]){
     verify(`${type}/${disabled}/${feedback}/${phase}`,()=>{
      if(feedback&&type!=='item')scaled(value,base);
      else{assert.equal(value.transform,'none','Run active must not inherit global translateY');assert.deepEqual(value.rect,base.rect,'Run press bounds remain exact');}
      assert.deepEqual(value.rect,before.rect,'touch active, click and release preserve the current feedback bounds');
     });
    }
   }
   await page.evaluate(id=>{document.querySelector(id).disabled=false;document.querySelector('.run-scene').className='run-scene';},id);
  }
  await page.waitForTimeout(220);
  const otherBase=await read('#other-control'),otherPoint={x:otherBase.rect.x+otherBase.rect.width/2,y:otherBase.rect.y+otherBase.rect.height/2};
  await page.evaluate(()=>window.touchEvents=[]);await touch('touchStart',otherPoint);await touch('touchEnd',otherPoint);
  const events=await page.evaluate(()=>touchEvents),otherPressed=events.find(event=>event.type==='mousedown')?.state;
  assert.ok(otherPressed,'real touch must exercise the global active style');assert.equal(otherPressed.transform,'matrix(1, 0, 0, 1, 0, 1)');
  assert.ok(events.every(event=>event.trusted));report.cases.push({order:order.map(index=>paths[index]),type:'other-control',base:otherBase,pressed:otherPressed,events});
 }
 assert.deepEqual(report.errors,[]);assert.deepEqual(report.assertionFailures,[]);report.passed=true;
}catch(error){report.failure=error.stack;process.exitCode=1;}
finally{
 await touch('touchEnd',{x:1,y:1}).catch(()=>{});await mkdir(out,{recursive:true});
 if(!report.passed)await page.screenshot({path:resolve(out,'failure.png')}).catch(()=>{});
 await context.close();await browser.close();report.finishedAt=new Date().toISOString();await writeFile(resolve(out,'report.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({output:out,passed:report.passed,cases:report.cases.length,assertionFailures:report.assertionFailures.length,failure:report.failure?.split('\n')[0],scope:report.scope},null,2));
}
