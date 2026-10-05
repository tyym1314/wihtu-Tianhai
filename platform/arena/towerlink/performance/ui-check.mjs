/** Isolated browser validation; run ui-server.mjs in a separate process first. */
import {chromium,webkit} from 'playwright';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';

const base='http://127.0.0.1:18126/__tower-ui';
const out=new URL('./usability/',import.meta.url);
await mkdir(out,{recursive:true});
const report={at:new Date().toISOString(),scope:'Desktop Chromium/WebKit with mobile viewport emulation; this is not physical iPhone acceptance.',layouts:[],gestures:[],errors:[],failures:[]};
const cases=[[390,844,'players=2','battle-390'],[320,568,'players=2','battle-320'],[390,844,'players=4','four-390'],[390,844,'lesson=lesson-07','supply-390'],[320,568,'lesson=lesson-06','defense-320']];
const check=(condition,message)=>{if(!condition)report.failures.push(message);};
async function ready(page,query){
 await page.goto(base+'?'+query);
 await page.waitForSelector('[data-tower]');
 await page.waitForFunction(()=>document.querySelector('[data-testid="towerlink-game"]')?.dataset.state==='active');
 await page.waitForTimeout(250);
}
async function layout(page,browserName,name){
 const geometry=await page.evaluate(()=>{
  const nodes=[...document.querySelectorAll('[data-tower]')].map(e=>({id:+e.dataset.tower,...Object.fromEntries(['x','y','width','height','left','top','right','bottom'].map(k=>[k,e.getBoundingClientRect()[k]]))})),overlaps=[];
  for(let i=0;i<nodes.length;i++)for(let j=i+1;j<nodes.length;j++){
   const a=nodes[i],b=nodes[j],width=Math.min(a.right,b.right)-Math.max(a.left,b.left),height=Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top);
   if(width>1&&height>1)overlaps.push({a:a.id,b:b.id,width,height});
  }
  const production=document.querySelector('.tl-production'),summary=production.parentElement.getBoundingClientRect().toJSON(),productionLines=[...production.children].map(e=>{const range=document.createRange();range.selectNodeContents(e);return{text:e.innerText,rect:e.getBoundingClientRect().toJSON(),textBounds:range.getBoundingClientRect().toJSON()};}),controls=[...document.querySelectorAll('.tl-header button,.tl-control-panel button')].map(e=>({label:e.innerText||e.getAttribute('aria-label'),rect:e.getBoundingClientRect().toJSON()}));
  return{width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,stage:document.querySelector('.towerlink-stage').getBoundingClientRect().toJSON(),nodes,overlaps,summary,productionLines,controls};
 });
 report.layouts.push({browser:browserName,name,...geometry});
 check(geometry.nodes.every(n=>Math.abs(n.width-48)<.1&&Math.abs(n.height-52)<.1),`${browserName}/${name}: expected every tower to be 48 x 52 CSS px`);
 check(!geometry.overlaps.length,`${browserName}/${name}: tower hit targets overlap`);
 check(geometry.scrollWidth<=geometry.width&&geometry.scrollHeight<=geometry.height,`${browserName}/${name}: page overflows viewport`);
 check(geometry.nodes.every(n=>n.left>=0&&n.top>=0&&n.right<=geometry.width&&n.bottom<=geometry.height),`${browserName}/${name}: tower clipped by viewport`);
 check(geometry.controls.every(c=>c.rect.width>=44&&c.rect.height>=44),`${browserName}/${name}: header/footer control target below 44 CSS px`);
 check(geometry.productionLines.every(line=>line.textBounds.top>=geometry.summary.top-1&&line.textBounds.bottom<=geometry.summary.bottom+1),`${browserName}/${name}: production text exceeds selected tower summary`);
 await page.screenshot({path:new URL(`${browserName}-${name}.png`,out).pathname});
 // Keep the previous Chromium screenshot filenames for the accompanying review.
 if(browserName==='chromium')await page.screenshot({path:new URL(name+'.png',out).pathname});
}
async function point(page,id){const b=await page.locator(`[data-tower="${id}"]`).boundingBox();return{x:b.x+b.width/2,y:b.y+b.height/2};}
async function gestures(page,context,viewport){
 const {width,height}=viewport;
 await page.setViewportSize(viewport);await ready(page,'players=2');
 const cdp=await context.newCDPSession(page);
 await page.evaluate(()=>{window.towerReviewPointerEvents=[];document.querySelector('.towerlink-stage').addEventListener('pointerdown',e=>window.towerReviewPointerEvents.push({type:e.type,id:e.pointerId,primary:e.isPrimary}));document.querySelector('.towerlink-stage').addEventListener('lostpointercapture',e=>window.towerReviewPointerEvents.push({type:e.type,id:e.pointerId}));});
 const graph=await page.evaluate(()=>{const g=window.towerReview.room().game,from=g.owners.indexOf('p0');return{from,to:g.towers[from].neighbors[0],invalid:g.towers.findIndex((_,i)=>i!==from&&!g.towers[from].neighbors.includes(i))};});
 assert.notEqual(graph.invalid,-1,'fixture must have an unreachable tower');
 const from=await point(page,graph.from),to=await point(page,graph.to),invalid=await point(page,graph.invalid),stage=await page.locator('.towerlink-stage').boundingBox(),blank={x:stage.x+1,y:stage.y+stage.height*.55};
 const touchPoint=(p,id=1)=>({x:p.x,y:p.y,id,radiusX:4,radiusY:4,force:.5});
 const touch=(type,points)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:points.map(p=>touchPoint(p,p.id||1))});
 const count=()=>page.evaluate(()=>window.towerReview.actions().length);
 async function begin(target){await page.waitForFunction(()=>document.querySelector('[data-testid="towerlink-game"]')?.dataset.state==='active');await page.waitForTimeout(50);await touch('touchStart',[from]);await touch('touchMove',[{x:from.x+(target.x-from.x)*.5,y:from.y+(target.y-from.y)*.5}]);await touch('touchMove',[target]);await page.waitForTimeout(50);}
 async function record(name,before,expected,details={}){await page.waitForTimeout(220);const actions=await page.evaluate(()=>window.towerReview.actions());const actual=actions.slice(before);check(JSON.stringify(actual)===JSON.stringify(expected),`gesture ${name}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);report.gestures.push({browser:'chromium',width,height,name,passed:JSON.stringify(actual)===JSON.stringify(expected),actions:actual,...details});}
 let before=await count();await begin(to);
 const feedback=await page.locator('.tl-drag-feedback').innerText();check(feedback.includes('松手建立兵线'),'link feedback must describe creation');
 await page.screenshot({path:new URL(`chromium-drag-create-${width}.png`,out).pathname});
 await touch('touchEnd',[]);await page.waitForFunction(n=>window.towerReview.actions().length>n,before);await record('drag creates a real engine route',before,[{type:'link',from:graph.from,to:graph.to}],{feedback});
 before=await count();await begin(to);const cutFeedback=await page.locator('.tl-drag-feedback').innerText();check(cutFeedback.includes('松手断开这条兵线'),'same-route feedback must describe unlink');await page.screenshot({path:new URL(`chromium-drag-cut-${width}.png`,out).pathname});await touch('touchEnd',[]);await page.waitForFunction(n=>window.towerReview.actions().length>n,before);await record('same drag removes only that route',before,[{type:'unlink',from:graph.from,to:graph.to}],{feedback:cutFeedback});
 before=await count();await begin(blank);const blankFeedback=await page.locator('.tl-drag-feedback').innerText();await touch('touchEnd',[]);await record('blank drop cancels',before,[],{feedback:blankFeedback});
 before=await count();await begin(invalid);const invalidFeedback=await page.locator('.tl-drag-feedback').innerText();await touch('touchEnd',[]);await record('unconnected tower sends no command',before,[],{feedback:invalidFeedback});
 before=await count();await begin(to);await touch('touchCancel',[]);await record('native touch cancellation sends no command',before,[]);
 before=await count();await begin(to);await touch('touchStart',[to,{...blank,id:2}]);await touch('touchEnd',[]);await record('second finger cancels primary gesture',before,[]);
 before=await count();await begin(to);await touch('touchStart',[to,{x:width/2,y:height-34,id:2}]);await touch('touchEnd',[]);await record('second finger outside battlefield cancels primary gesture',before,[]);
 before=await count();await begin(to);await page.evaluate(()=>{const e=window.towerReviewPointerEvents.findLast(e=>e.type==='pointerdown'&&e.primary),stage=document.querySelector('.towerlink-stage');if(!stage.hasPointerCapture(e.id))throw Error('primary pointer is not captured');stage.releasePointerCapture(e.id);});await touch('touchMove',[to]);await touch('touchEnd',[]);await record('lost pointer capture cancels',before,[]);
 before=await count();await begin(to);await touch('touchEnd',[]);await page.waitForFunction(n=>window.towerReview.actions().length>n,before);await record('route can be created after cancellation',before,[{type:'link',from:graph.from,to:graph.to}]);
 check(await page.locator('[data-action="tower-stop"]').count()===0,'stop-all should not occupy main controls');await page.locator('[data-action="tower-manage"]').click();
 const stop=page.locator('[data-action="tower-stop"]');await stop.waitFor({state:'visible'});const stopText=(await stop.innerText()).trim(),stopBox=await stop.boundingBox();check(stopText==='撤掉这座塔全部路线','secondary route action must name selected-tower scope');check(stopBox.height>=44,'secondary route clear target should be >= 44 CSS px high');await page.screenshot({path:new URL(`chromium-route-panel-${width}.png`,out).pathname});before=await count();await stop.click();await page.waitForFunction(n=>window.towerReview.actions().length>n,before);await record('secondary action clears selected tower routes',before,[{type:'stop',towerId:graph.from}],{text:stopText,buttonHeight:stopBox.height});
 const events=await page.evaluate(()=>window.towerReviewPointerEvents);check(events.some(e=>e.type==='pointerdown'&&!e.primary),'multitouch test must produce a non-primary pointer');check(events.some(e=>e.type==='lostpointercapture'),'capture test must produce capture loss');(report.pointerEvents||=[]).push({width,height,events});
 await cdp.detach();
}
try{
 for(const[browserName,type]of[['chromium',chromium],['webkit',webkit]]){
  const browser=await type.launch({headless:true});
  try{
   const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true,deviceScaleFactor:1}),page=await context.newPage();
   page.on('pageerror',error=>report.errors.push({browser:browserName,error:error.message}));
   for(const[width,height,query,name]of cases){await page.setViewportSize({width,height});await ready(page,query);await layout(page,browserName,name);}
   if(browserName==='chromium')for(const viewport of [{width:390,height:844},{width:320,height:568}])await gestures(page,context,viewport);
  }finally{await browser.close();}
 }
}catch(error){report.failures.push(error.stack||error.message);}
check(report.errors.length===0,'browser emitted uncaught page errors');
report.passed=report.failures.length===0;
await writeFile(new URL('report.json',out),JSON.stringify(report,null,2));
console.log(JSON.stringify({passed:report.passed,layouts:report.layouts.map(({browser,name,stage,overlaps})=>({browser,name,stageHeight:stage.height,overlapCount:overlaps.length})),gestures:report.gestures,errors:report.errors,failures:report.failures},null,2));
assert.equal(report.failures.length,0,'UI validation failed; see usability/report.json');
