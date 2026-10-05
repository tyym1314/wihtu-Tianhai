/** Controlled browser regression of the real Tower Link Canvas renderer. */
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const output=fileURLToPath(new URL('../review/towerlink-v2.1-collision/',import.meta.url));
const base=process.env.TOWERLINK_COLLISION_REVIEW_ORIGIN||'http://127.0.0.1:18120';
const report={at:new Date().toISOString(),base,scope:'Controlled browser fixture imports the actual createTowerScene and production WebP art. The clock and authoritative snapshots are test inputs. Captures actual soldier drawImage transforms and collision effect/audio callbacks. This is not a real-player network, wallet, physical-device, or server-capacity acceptance.',checks:[],screenshots:[],errors:[],passed:false};
await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({viewport:{width:390,height:760},deviceScaleFactor:1,isMobile:true,hasTouch:true});
const page=await context.newPage();
page.on('pageerror',error=>report.errors.push(error.message));
page.on('request',request=>{if(new URL(request.url()).pathname.startsWith('/api/'))report.errors.push('Unexpected API request: '+request.url());});

try{
 await page.route(base+'/__tower-collision-review',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:`<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tower Link collision acceptance</title><style>*{box-sizing:border-box}body{margin:0;color:#23433e;background:#e7f2e8;font-family:system-ui}header{margin:20px 18px 0;padding:16px;text-align:center;border:2px solid #cdb565;border-radius:20px;background:#fffae9e8;box-shadow:0 6px 18px #203b3029}h1{font-size:23px;margin:0 0 6px}small{font-size:12px;color:#547969}canvas{display:block;width:390px;height:500px}footer{margin:0 18px;padding:16px;border:2px solid #cdb565;border-radius:16px;background:#fff9e9ef;text-align:center;min-height:88px}#phase{display:block;font-weight:750;font-size:17px;margin-bottom:8px}#detail{font-size:13px;color:#4b6659}#tag{position:absolute;top:135px;left:26px;font-size:12px;color:#214e41;background:#ffffffe3;padding:5px 8px;border-radius:6px}</style></head><body><header><h1>连线占塔 · 碰撞回归</h1><small>受控时间 · 实际 Canvas 与游戏素材</small></header><span id="tag">绿色 →　← 红色</span><canvas id="battle"></canvas><footer><span id="phase">准备验收</span><span id="detail">此页仅验证渲染，不代表真实玩家网络验收</span></footer></body></html>`}));
 await page.goto(base+'/__tower-collision-review');
 const setup=await page.evaluate(async()=>{
  const {createTowerScene,towerPoint}=await import('/arena/towerlink/tower-scene.js');
  const {preloadTowerAssets,coreAssetURL}=await import('/arena/towerlink/tower-assets.mjs');
  const assets=await preloadTowerAssets();
  document.body.style.backgroundImage=`url("${coreAssetURL('sky')}")`;document.body.style.backgroundSize='390px 760px';
  const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d'),pending=new Map();
  let rafId=0,ts=0,now=1700,draws=[],arcs=[],text=[],sounds=[],state;
  // Control only this fixture's animation scheduling. createTowerScene itself
  // stays untouched and is called with the same read callback used in-game.
  window.requestAnimationFrame=callback=>{pending.set(++rafId,callback);return rafId;};
  window.cancelAnimationFrame=id=>pending.delete(id);
  const drawImage=ctx.drawImage.bind(ctx),arc=ctx.arc.bind(ctx),fillText=ctx.fillText.bind(ctx);
  ctx.drawImage=(...args)=>{
   if(args[0]?.src?.includes('soldiers-atlas')){const m=ctx.getTransform();draws.push({team:Math.round(args[1]/(args[0].width/4)),x:m.e,y:m.f,scaleX:m.a,frame:Math.round(args[2]/(args[0].height/4)),source:args[0].src});}
   return drawImage(...args);
  };
  ctx.arc=(x,y,r,...args)=>{const m=ctx.getTransform();arcs.push({x:m.a*x+m.c*y+m.e,y:m.b*x+m.d*y+m.f,r});return arc(x,y,r,...args);};
  ctx.fillText=(label,x,y,...args)=>{text.push({label,x,y});return fillText(label,x,y,...args);};
  const towers=[{id:0,x:.15,y:.45,ring:'outer',level:1,kind:'barracks',troops:20,neighbors:[1]},{id:1,x:.85,y:.45,ring:'outer',level:1,kind:'barracks',troops:20,neighbors:[0]}];
  const game=(left,right)=>({gameId:'towerlink',status:'active',ruleVersion:'towerlink-v2.1.0',simulationAt:1500,serverNow:1500,startedAt:1000,deadlineAt:181000,level:{id:'controlled-collision'},towers,owners:['green','red'],players:[{key:'green'},{key:'red'}],edges:[[0,1]],orders:[],armies:[{id:'left',ownerKey:'green',from:0,to:1,count:left,departedAt:1000,arrivesAt:3000},{id:'right',ownerKey:'red',from:1,to:0,count:right,departedAt:1000,arrivesAt:3000}],recentEvents:[]});
  const initial=game(4,4);
  state={game:initial,roomId:'equal',selected:null,aim:null,me:'green',reduced:false,rotation:0,serverAt:1500,serverTime:()=>now,onRoadBattle:event=>sounds.push({at:now,event:structuredClone(event)})};
  const dispose=createTowerScene(canvas,()=>state);
  await new Promise(resolve=>setTimeout(resolve,80)); // ResizeObserver publishes real canvas bounds.
  window.collisionReview={
   reset(left,right,id){state={...state,roomId:id,game:game(left,right),serverAt:1500};sounds=[];},
   draw(at,phase='碰撞验收'){
    ts+=Math.max(20,at-now);now=at;draws=[];arcs=[];text=[];
    const next=[...pending.values()];pending.clear();for(const callback of next)callback(ts);
    document.querySelector('#phase').textContent=phase;
    document.querySelector('#detail').textContent=`游戏时刻 ${at} ms · 士兵精灵 ${draws.length} · 碰撞反馈 ${sounds.length}`;
    return{at,draws:structuredClone(draws),arcs:structuredClone(arcs),text:structuredClone(text),sounds:structuredClone(sounds)};
   },
   confirm(at,survivors){state={...state,serverAt:at,game:{...state.game,simulationAt:at,serverNow:at,armies:survivors?[{...initial.armies[0],count:survivors}]:[],recentEvents:[{id:'towerlink:confirmed',type:'road-battle',at:2000,edge:[0,1],position:.5,casualties:survivors?4:8,ownerKey:survivors?'green':null,survivors,participants:[{ownerKey:'green',count:4},{ownerKey:'red',count:survivors?2:4}]}]}};},
   dispose,
   points:towers.map(t=>towerPoint(t,390,500,0)),
  };
  return{assets:assets.images.size,canvas:{width:canvas.width,height:canvas.height},points:window.collisionReview.points};
 });
 assert.equal(setup.assets,5);assert.deepEqual(setup.canvas,{width:390,height:500});
 report.checks.push({kind:'actual-renderer-assets',...setup});
 const draw=(at,label)=>page.evaluate(({at,label})=>window.collisionReview.draw(at,label),{at,label});
 const reset=(left,right,id)=>page.evaluate(({left,right,id})=>window.collisionReview.reset(left,right,id),{left,right,id});
 const capture=async name=>{await page.screenshot({path:output+name});report.screenshots.push(name);};
 const [a,b]=setup.points,mid={x:(a.x+b.x)/2,y:(a.y+b.y)/2},dx=mid.x-195,dy=mid.y-250,len=Math.hypot(dx,dy)||1,control={x:mid.x+dx/len*46.8,y:mid.y+dy/len*46.8};
 const contact={x:.25*a.x+.5*control.x+.25*b.x,y:.25*a.y+.5*control.y+.25*b.y};
 const near=(actual,expected,message)=>assert(Math.abs(actual-expected)<.00001,`${message}: ${actual} vs ${expected}`);

 const before=await draw(1700,'4 对 4 · 相遇前');
 assert.equal(before.draws.length,4);assert.deepEqual([...new Set(before.draws.map(d=>d.team))].sort(),[0,1]);
 assert(before.draws.find(d=>d.team===0).x<contact.x);assert(before.draws.find(d=>d.team===1).x>contact.x);
 assert.equal(before.sounds.length,0);await capture('equal-before.png');
 const precontact=await draw(1999,'4 对 4 · 接触前 1 ms');assert.equal(precontact.draws.length,4);
 const impact=await draw(2000,'4 对 4 · 接触当帧全部抵消');
 assert.equal(impact.draws.length,0);assert.equal(impact.sounds.length,1);assert(impact.arcs.length>0);
 near(impact.arcs[0].x,contact.x,'flash lies on curved road contact x');near(impact.arcs[0].y+14,contact.y,'flash lies on curved road contact y');
 await capture('equal-contact.png');
 const after150=await draw(2150,'4 对 4 · 相遇后 150 ms');assert.equal(after150.draws.length,0);assert.equal(after150.sounds.length,1);await capture('equal-after-150ms.png');
 const after500=await draw(2500,'4 对 4 · 相遇后 500 ms');assert.equal(after500.draws.length,0);assert.equal(after500.sounds.length,1);await capture('equal-after-500ms.png');
 report.checks.push({kind:'equal-armies-real-draws',before,precontact,impact,after150,after500,contact});

 await page.evaluate(()=>window.collisionReview.confirm(2500,0));
 const confirmed=await draw(2520,'服务器快照确认 · 不重播');
 assert.equal(confirmed.draws.length,0);assert.equal(confirmed.sounds.length,1);assert(confirmed.arcs[0].r>20,'confirmation retains original flash age instead of restarting at radius 8');
 report.checks.push({kind:'confirmation-does-not-replay',frame:confirmed});await capture('equal-confirmed.png');

 await reset(4,2,'unequal');const unequalBefore=await draw(1700,'4 对 2 · 相遇前');assert.equal(unequalBefore.draws.length,4);await capture('unequal-before.png');
 const unequalContact=await draw(2000,'4 对 2 · 余下 2 兵');assert.equal(unequalContact.draws.length,2);assert(unequalContact.draws.every(d=>d.team===0));assert.equal(unequalContact.sounds.length,1);
 near(unequalContact.draws[0].x,contact.x,'remaining lead soldier starts at collision x');near(unequalContact.draws[0].y,contact.y,'remaining lead soldier starts at collision y');await capture('unequal-contact.png');
 const unequalAfter=await draw(2200,'剩余 2 兵 · 继续向敌塔行军');assert.equal(unequalAfter.draws.length,2);assert(unequalAfter.draws[0].x>unequalContact.draws[0].x);assert.equal(unequalAfter.sounds.length,1);await capture('unequal-after.png');
 await page.evaluate(()=>window.collisionReview.confirm(2250,2));const unequalConfirmed=await draw(2270,'服务器确认 · 余兵继续');assert.equal(unequalConfirmed.draws.length,2);assert(unequalConfirmed.draws[0].x>unequalAfter.draws[0].x);assert.equal(unequalConfirmed.sounds.length,1);
 report.checks.push({kind:'partial-survivors-real-draws',before:unequalBefore,impact:unequalContact,after:unequalAfter,confirmed:unequalConfirmed});

 await reset(4,4,'delayed-snapshot');const frames=[];
 for(let at=1750;at<=2250;at+=10){const frame=await draw(at,'500 ms 快照空窗 · 连续渲染');frames.push({at,count:frame.draws.length,leads:[0,1].map(team=>frame.draws.find(d=>d.team===team)).filter(Boolean),feedback:frame.sounds.length});if(at<2000){assert.equal(frame.draws.length,4);assert(frame.draws.find(d=>d.team===0).x<contact.x);assert(frame.draws.find(d=>d.team===1).x>contact.x);}else{assert.equal(frame.draws.length,0);assert.equal(frame.sounds.length,1);}}
 report.checks.push({kind:'500-ms-snapshot-gap-no-crossing',snapshotsReceivedDuringWindow:0,frames});
 assert.equal(report.errors.length,0);report.passed=true;
}catch(error){report.errors.push(error.stack||String(error));process.exitCode=1;}
finally{
 await writeFile(output+'report.json',JSON.stringify(report,null,2)+'\n');
 await writeFile(output+'README.md',`# Tower Link collision renderer regression\n\nRun: ${report.at}\n\nStatus: ${report.passed?'PASS':'FAIL'}\n\n${report.scope}\n\nChecks:\n\n- Actual production renderer and five decoded WebP art assets.\n- 4 vs 4: both parties visible before contact; no soldier draw at or after exact contact.\n- 4 vs 2: two surviving green sprites continue on their unchanged path.\n- The impact flash and reverse-direction armies meet at the same curved-road point.\n- A 500 ms interval without snapshots never draws opponents beyond each other.\n- A later authoritative confirmation does not replay the flash or audio callback.\n\nScreenshots:\n\n${report.screenshots.map(name=>`- [${name}](${name})`).join('\n')}\n\nFull draw transforms, time samples, callback counts and failures are in [report.json](report.json).\n`);
 await browser.close();
 console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,errors:report.errors,output},null,2));
}
