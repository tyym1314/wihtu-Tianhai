import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {ARENA_FEEDBACK_CONFIGS,arenaFeedbackPlan,readArenaFeedbackPresentation,installOwnedArenaFeedbackObservation,readOwnedArenaFeedbackObservation,renderArenaFeedbackGlyphTemplate,analyzeVisibleArenaFeedback} from '../scripts/android-player-arena-feedback.mjs';
import {summarizeVisibleFeedback} from '../scripts/android-player-performance-checks.mjs';
import {VISIBLE_FEEDBACK_PROTOCOL_SHA256,VISIBLE_FEEDBACK_IMPLEMENTATION_VERSION,VISIBLE_FEEDBACK_IMPLEMENTATION_SOURCES} from '../scripts/android-player-visible-feedback.mjs';
const require=createRequire(import.meta.url),{PNG}=require(join(dirname(require.resolve('playwright-core')),'lib/utilsBundle.js'));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex'),epoch=1791700000000,width=320,height=240;
const rect={x:90,y:168,width:140,height:24},triggerRect={x:80,y:150,width:160,height:48};
const specs=[['golf','shot'],['bowling','roll'],['carrom','shot'],['pool','shot'],['darts','throw'],['ludo','roll'],['ludo','move'],['jackaroo','pass'],['jackaroo','play'],['domino','draw'],['domino','pass'],['domino','play'],['match','swap'],['towerlink','link'],['towerlink','stop']];

// Deterministic raster fixtures exercise original-PNG evidence validation only;
// they never represent physical-device performance or actual production frames.
function glyph(text,color=[200,210,220]){
 const data=Buffer.alloc(rect.width*rect.height*4),seed=Buffer.from(sha(text),'hex');
 for(let y=4;y<20;y++)for(let x=4;x<136;x++){if((seed[(Math.floor(x/5)+Math.floor(y/4))%32]>>(x%5))&1){const i=(y*rect.width+x)*4;for(let c=0;c<3;c++)data[i+c]=color[c];data[i+3]=255;}}
 return data;
}
function image(plan,text,template,{pending=false,animation=false,opacity=1}={}){
 const data=Buffer.alloc(width*height*4);for(let i=0;i<data.length;i+=4){data[i]=20;data[i+1]=26;data[i+2]=32;data[i+3]=255;}
 for(let y=0;y<rect.height;y++)for(let x=0;x<rect.width;x++){
  const i=((rect.y+y)*width+rect.x+x)*4,k=(y*rect.width+x)*4;
  if(['disabled-green','disabled-dark'].includes(plan.pixelRule)){
   const color=pending?(plan.pixelRule==='disabled-green'?[91,110,89]:[32,24,36]):[220,170,50];for(let c=0;c<3;c++)data[i+c]=color[c];
  }else if(template[k+3])for(let c=0;c<3;c++)data[i+c]=Math.round(template[k+c]*opacity+data[i+c]*(1-opacity));
  if(animation){data[i]=(x*17+y*11)%256;data[i+1]=(x*5+y*29)%256;data[i+2]=(x*13+y*3)%256;}
 }
 // The scene can move independently of the feedback ROI.
 if(text==='scene-animation')for(let y=20;y<100;y++)for(let x=20;x<250;x++)data[(y*width+x)*4]=(x+y)%256;
 return PNG.sync.write({width,height,data});
}
function fixture(game='golf',actionType=ARENA_FEEDBACK_CONFIGS[game].actions[0],options={}){
 const plan=arenaFeedbackPlan({game,actionType,locale:'en',...(game==='domino'&&actionType==='play'?{end:'left'}:{}),...(game==='match'?{cell:7}:{})});
 const scope={nonce:'owned-arena-proof',documentId:'a'.repeat(32),timeOrigin:epoch,url:'https://owned.example/play/'+game,frameId:'own-'+game,loaderId:'own-loader',contextId:4,topFrameId:'top',topLoaderId:'top-loader',topUrl:'https://owned.example/player'};
 const owner={nonce:scope.nonce,documentId:scope.documentId,timeOrigin:epoch,url:scope.url},projection={topViewport:{width,height},topScroll:{x:0,y:0},iframeRect:{x:0,y:0,width,height},gameViewport:{width,height},gameScroll:{x:0,y:0}};
 const state=at=>({owner,phase:'feedbackProof',continuousActive:false,visible:true,at,wallEpochMs:epoch+at,projection:structuredClone(projection)});
 const tree={frame:{id:scope.topFrameId,loaderId:scope.topLoaderId,url:scope.topUrl},childFrames:[{frame:{id:scope.frameId,loaderId:scope.loaderId,parentId:scope.topFrameId,url:scope.url}}]};
 const text=plan.texts?.en?.[0]??'CONFIRM',color=plan.pixelRule==='disabled-text'?[126,159,166]:[200,210,220],template=glyph(text,color),baselineGlyph=glyph('READY');
 const presentation=(at,pending)=>({schema:'owned-arena-feedback-presentation-v1',owner,at,trigger:{selector:plan.trigger,disabled:pending,rect:{...triggerRect}},feedback:{selector:plan.feedback,rect:{...rect},textRect:{...rect},text:pending?text:'READY',color:'rgb('+color.join(', ')+')',font:'12px sans-serif',letterSpacing:'0px',opacity:'1'},...(pending&&!['disabled-green','disabled-dark'].includes(plan.pixelRule)?{glyphTemplate:{schema:'owned-arena-offscreen-glyph-template-v1',comparisonOnly:true,text,color:'rgb('+color.join(', ')+')',font:'12px sans-serif',letterSpacing:'0px',pixelScale:1,width:rect.width,height:rect.height,rgbaBase64:template.toString('base64')}}:{})});
 const bytes=image(plan,'READY',baselineGlyph),pendingBytes=image(plan,text,template,{pending:true,opacity:options.opacity??1});
 const frame=(index,at,data=bytes)=>({index,sessionId:12,metadata:{timestamp:(epoch+at)/1000,pageScaleFactor:1,offsetTop:0,deviceWidth:width,deviceHeight:height,scrollOffsetX:0,scrollOffsetY:0},received:{epochMs:epoch+at+5000,monotonicMs:at},ackDispatched:{epochMs:epoch+at+5000,monotonicMs:at},ack:{ok:true,completed:{epochMs:epoch+at+5001,monotonicMs:at+1}},state:state(at+2),pngBase64:data.toString('base64'),pngBytes:data.length,pngSha256:sha(data),sink:{path:'original-'+index+'.png',bytes:data.length,sha256:sha(data)}});
 const frames=[frame(1,10),frame(2,40),frame(3,60),frame(4,90,pendingBytes),frame(5,120,pendingBytes)],capture={schema:'owned-visible-feedback-capture-v1',phase:'feedbackProof',phaseId:'own-phase',scope,protocol:{schema:'visible-feedback-official-protocol-v1',sha256:VISIBLE_FEEDBACK_PROTOCOL_SHA256},implementation:{schema:'visible-feedback-official-implementation-v1',version:VISIBLE_FEEDBACK_IMPLEMENTATION_VERSION,sources:structuredClone(VISIBLE_FEEDBACK_IMPLEMENTATION_SOURCES),timestampSemantics:'captured-video-frame-received-wall-time-v1',captureBeforeTimestamp:true,bitmapConversionAfterTimestamp:true,swapTimestamp:false,physicalPresent:false},webviewVersion:VISIBLE_FEEDBACK_IMPLEMENTATION_VERSION,startParameters:{format:'png',everyNthFrame:1},frames,rawBytes:frames.reduce((n,f)=>n+f.pngBytes,0),dropped:0,errors:[],started:true,closed:true,before:state(0),after:state(180),treeBefore:structuredClone(tree),treeAfter:structuredClone(tree)};
 const event=(type,at)=>({type,at,owner,triggerSelector:plan.trigger,isTrusted:true,isPrimary:true,pointerType:'touch',pointerId:7,x:150,y:174});
 const events=plan.gesture==='tap'?[event('pointerdown',50),event('pointerup',55),event('click',56)]:[event('pointerdown',50),event('pointermove',52),event('pointerup',55)];
 const observation={schema:'owned-visible-arena-feedback-observation-v1',scope:structuredClone(scope),plan:structuredClone(plan),phase:'feedbackProof',phaseId:'own-phase',removed:true,overflow:false,errors:[],initial:presentation(0,false),presentations:[presentation(58,true)],events};
 const request={frameId:scope.frameId,requestStartedEpochMs:epoch+57,roomIdHash:sha('own-room'),requestSha256:'b'.repeat(64),transferFinished:true,failed:false,canceled:false,responseStatus:200};
 const action={accepted:true,protocol:'arena-action-v1',cursorBefore:10,cursorAfter:11,proof:{sequence:11,type:actionType},gestureCompletedEpochMs:epoch+55,requestStartedEpochMs:epoch+57,responseFinishedEpochMs:epoch+150,roomIdHash:request.roomIdHash,requestSha256:request.requestSha256,responseSha256:'c'.repeat(64)};
 return {plan,capture,observation,requests:[request],actions:[action],frame,bytes,pendingBytes,template,state,presentation};
}
const analyze=f=>analyzeVisibleArenaFeedback(f),recount=f=>{f.capture.rawBytes=f.capture.frames.reduce((n,r)=>n+r.pngBytes,0);},reject=f=>{const r=analyze(f);assert.equal(r.passed,false,JSON.stringify(r));assert.equal(r.status,'insufficient');return r;};

test('ten distinct arenas plus real submitting variants bind original PNGs to their own exact accepted sequence',()=>{
 assert.equal(Object.keys(ARENA_FEEDBACK_CONFIGS).length,10);assert.ok(!Object.hasOwn(ARENA_FEEDBACK_CONFIGS,'run'));
 for(const [game,type]of specs){const f=fixture(game,type),before=JSON.stringify(f),r=analyze(f);assert.equal(r.status,'pass',game+' '+type+' '+JSON.stringify(r));assert.equal(r.commandBinding.sequence,11);assert.equal(r.commandBinding.type,type);assert.equal(r.firstFeedbackFrame.pngSha256,sha(f.pendingBytes));assert.equal(r.latencyMs,35);assert.equal(r.swapStatus,'insufficient');assert.equal(r.physicalPanelPresent,false);assert.equal(JSON.stringify(f),before);}
});
test('runner summary dispatches own arena schema/sequence/type without borrowing Run or another game proof',()=>{
 const round=f=>({game:f.plan.game,documentId:f.capture.scope.documentId,documentTimeOrigin:epoch,context:{frameId:f.capture.scope.frameId,contextId:f.capture.scope.contextId,url:f.capture.scope.url},sampleBoundaries:{start:{epochMs:epoch+1000}},visibleFeedbackPhases:[{schema:'owned-performance-visible-feedback-phase-v1',phase:'feedbackProof',position:'beforeContinuous',plan:f.plan,finalized:true,errors:[],capture:f.capture,observation:f.observation,acceptedActions:f.actions,probe:{closed:true,dropped:0},analysis:analyze(f)}]});
 for(const [game,type]of specs){const r=round(fixture(game,type));assert.equal(summarizeVisibleFeedback([r],100).status,'pass',game+' '+type);
  for(const mutate of [r=>r.game='run',r=>r.game='slot',r=>r.visibleFeedbackPhases[0].analysis.game='foreign',r=>r.visibleFeedbackPhases[0].acceptedActions[0].proof.sequence++,r=>r.visibleFeedbackPhases[0].acceptedActions[0].proof.type='foreign',r=>r.visibleFeedbackPhases[0].observation.scope.frameId='foreign',r=>r.visibleFeedbackPhases[0].analysis.schema='owned-visible-run-feedback-v1',r=>r.visibleFeedbackPhases[0].plan.trigger='svg',r=>r.visibleFeedbackPhases[0].capture.frames[3].pngSha256='d'.repeat(64),r=>r.visibleFeedbackPhases[0].finalized=false]){const bad=JSON.parse(JSON.stringify(r));mutate(bad);assert.equal(summarizeVisibleFeedback([bad],100).status,'insufficient',game);}
 }
 const missing=fixture('golf','shot');missing.actions=[];assert.equal(summarizeVisibleFeedback([round(missing)],100).status,'insufficient');
});
test('real opacity changes do not become arbitrary pixel-difference proof; expected glyph shape remains necessary',()=>{
 const f=fixture('pool','shot',{opacity:.62});assert.equal(analyze(f).passed,true,JSON.stringify(analyze(f)));
 for(const [game,type]of specs){const noPixels=fixture(game,type);noPixels.capture.frames[3]=noPixels.frame(4,90);noPixels.capture.frames[4]=noPixels.frame(5,120);recount(noPixels);reject(noPixels);}
});
test('cancelled, synthetic, unrelated-control and off-control touch cannot be promoted by a later accepted action',()=>{
 const changes=[f=>f.observation.events.splice(2,0,{...f.observation.events[1],type:'pointercancel'}),f=>f.observation.events[1].isTrusted=false,f=>f.observation.events[1].pointerId=9,f=>f.observation.events[1].triggerSelector='svg',f=>f.observation.events[1].owner.documentId='d'.repeat(32),f=>f.observation.events[1].x=2];
 for(const change of changes){const f=fixture('darts','throw');change(f);reject(f);}
});
test('no ACK, missing/rejected/duplicate action, foreign POST and wrong exact sequence fail closed',()=>{
 const changes=[f=>f.actions=[],f=>f.actions[0].accepted=false,f=>f.requests[0].responseStatus=409,f=>f.requests[0].transferFinished=false,f=>f.requests[0].frameId='foreign',f=>f.actions.push(structuredClone(f.actions[0])),f=>f.requests.push({...f.requests[0]}),f=>f.actions[0].proof.sequence++,f=>f.actions[0].proof.type='place',f=>f.actions[0].protocol='run-practice-inputs-v2',f=>f.actions[0].roomIdHash='d'.repeat(64),f=>f.capture.frames[3].ack.ok=false];
 for(const change of changes){const f=fixture('pool','shot');change(f);reject(f);}
});
test('all original frames, their own document/phase and complete byte/hash/ACK sequence are required',()=>{
 const changes=[f=>delete f.capture.frames[3].pngBase64,f=>f.capture.frames[3].sink.sha256='d'.repeat(64),f=>f.capture.frames[0].pngBase64=f.pendingBytes.toString('base64'),f=>f.capture.frames[3].state.owner.url='https://owned.example/play/run',f=>f.capture.after.continuousActive=true,f=>f.capture.scope.url='https://owned.example/play/run',f=>f.capture.treeAfter.childFrames[0].frame.loaderId='new-loader',f=>f.capture.frames.splice(2,1),f=>f.capture.dropped=1,f=>f.observation.phaseId='other-phase',f=>f.observation.removed=false,f=>f.capture.frames[3].received.epochMs+=20,f=>{for(const clock of [f.capture.frames[3].received,f.capture.frames[3].ackDispatched,f.capture.frames[3].ack.completed]){clock.monotonicMs-=100;clock.epochMs-=100;}},f=>f.capture.after.wallEpochMs+=4];
 for(const change of changes){const f=fixture('match','swap');change(f);reject(f);}
});
test('shine, course, animated SVG, selected clearing and post-ACK movement never substitute pending ROI pixels',()=>{
 for(const [game,type]of specs){for(const inside of [false,true]){const f=fixture(game,type),data=image(f.plan,'scene-animation',glyph('READY'),{animation:inside});f.capture.frames[3]=f.frame(4,90,data);f.capture.frames[4]=f.frame(5,120,data);recount(f);reject(f);}}
 const late=fixture('bowling','roll');late.actions[0].responseFinishedEpochMs=epoch+80;reject(late);
 const noPending=fixture('towerlink','link');noPending.observation.presentations=[];reject(noPending);
});
test('a glyph template or DOM pending time alone supplies no latency; foreign/configured text or color is rejected',()=>{
 const changes=[f=>f.observation.presentations[0].feedback.text='some changing label',f=>f.observation.presentations[0].glyphTemplate.text='other glyphs',f=>delete f.observation.presentations[0].glyphTemplate,f=>f.observation.presentations[0].feedback.selector='canvas',f=>f.observation.presentations[0].feedback.rect.x++,f=>f.observation.plan.feedback='svg',f=>f.plan={...f.plan,feedback:'svg'}];
 for(const change of changes){const f=fixture('golf','shot');change(f);reject(f);}
 const domino=fixture('domino','play');domino.observation.presentations[0].feedback.color='rgb(255, 240, 203)';reject(domino);
});
test('disabled greens/dark controls require a stable originally enabled ROI, never a pre-existing disabled control',()=>{
 for(const [game,type]of [['jackaroo','play'],['ludo','move']]){const f=fixture(game,type);f.observation.initial.trigger.disabled=true;reject(f);const same=fixture(game,type);same.capture.frames[0]=same.frame(1,10,same.pendingBytes);same.capture.frames[1]=same.frame(2,40,same.pendingBytes);recount(same);reject(same);const moving=fixture(game,type);moving.capture.frames[0]=moving.frame(1,10,image(moving.plan,'animated',moving.template,{animation:true}));recount(moving);reject(moving);}
});
test('the unchanged 100 ms captured upper-bound gate retains late/missing provider evidence as insufficient',()=>{
 const f=fixture('match','swap');f.capture.frames=[f.frame(1,10),f.frame(2,40),f.frame(3,70),f.frame(4,100),f.frame(5,130),f.frame(6,160),f.frame(7,190,f.pendingBytes)];f.capture.after=f.state(250);f.actions[0].responseFinishedEpochMs=epoch+230;recount(f);const r=reject(f);assert.equal(r.latencyMs,135);assert.equal(r.latencyIntervalMs.lowerExclusive,0);
 const unsupported=fixture('carrom','shot');unsupported.capture.implementation=null;assert.equal(reject(unsupported).capturedContentVerified,true);
 assert.match(analyzeVisibleArenaFeedback({...fixture(),thresholdMs:150}).reasons.join(' '),/FIXED_STANDARD/);
});
test('actual source submitting selectors are retained; preparation/selection and unsupported Run plans are refused',async()=>{
 const files={golf:'golf/GolfGame.jsx',bowling:'bowling/BowlingGame.jsx',carrom:'carrom/CarromGame.jsx',pool:'pool/PoolGame.jsx',darts:'darts/DartsGame.jsx',ludo:'ludo/LudoGame.jsx',jackaroo:'jackaroo/JackarooGame.jsx',domino:'domino/DominoGame.jsx',match:'match/MatchGame.jsx',towerlink:'towerlink/TowerLinkGame.jsx'};
 for(const [game,file]of Object.entries(files)){const body=await readFile(new URL('../arena/'+file,import.meta.url),'utf8');const trigger=ARENA_FEEDBACK_CONFIGS[game].trigger,attribute=trigger.match(/\[([^=\]]+)(?:="([^"]+)")?\]/);if(attribute)assert.ok(body.includes(attribute[2]?attribute[1]+'="'+attribute[2]+'"':attribute[1]+'='),game+' source submitting selector drifted');}
 assert.throws(()=>arenaFeedbackPlan({game:'run',actionType:'jump'}));assert.throws(()=>arenaFeedbackPlan({game:'pool',actionType:'place'}));assert.throws(()=>arenaFeedbackPlan({game:'match',actionType:'swap'}));assert.throws(()=>arenaFeedbackPlan({game:'domino',actionType:'play',end:'cancel'}));
});
test('passive presentation read is serializable, refuses foreign realm/continuous phase and changes no app state',()=>{
 const f=fixture('jackaroo','play'),plan=f.plan,scope=f.capture.scope,p={schema:'android-physical-performance-v1',...f.observation.initial.owner},element={disabled:true,childNodes:[{nodeType:3,textContent:'CONFIRM'}],contains:()=>true,getAttribute:()=>null,getBoundingClientRect:()=>({...rect})},document={visibilityState:'visible',hasFocus:()=>true,querySelectorAll:()=>[element]};
 const context=vm.createContext({__oasisPhysicalPerf:p,location:{href:scope.url},performance:{timeOrigin:epoch,now:()=>58},document,getComputedStyle:()=>({color:'rgb(200, 210, 220)',font:'12px sans-serif',letterSpacing:'0px',opacity:'0.75'})});
 const read=()=>JSON.parse(JSON.stringify(vm.runInContext('('+readArenaFeedbackPresentation.toString()+')('+JSON.stringify({scope,plan})+')',context)));
 const result=read();assert.equal(result.trigger.disabled,true);assert.equal(result.glyphTemplate,undefined);assert.deepEqual(p,{schema:'android-physical-performance-v1',...f.observation.initial.owner});p.documentId='e'.repeat(32);assert.throws(read,/DOCUMENT_CHANGED/);p.documentId=scope.documentId;p.sampleStartAt=1;assert.throws(read,/CONTINUOUS_SAMPLE_REFUSED/);
});

test('passive glyph renderer matches real local Chromium text pixels using the actual Golf control CSS',async()=>{
 // Every request is fulfilled in memory. The page is a local test fixture;
 // screenshot bytes exercise font/ROI matching, never a device latency claim.
 const {chromium}=await import('playwright'),browser=await chromium.launch({headless:true});
 try{
  const css=await readFile(new URL('../arena/golf/golf.css',import.meta.url),'utf8'),page=await browser.newPage({viewport:{width,height}}),intercepted=[];
  await page.route('**/*',route=>{const url=route.request().url();intercepted.push(url);return url==='https://arena-feedback-fixture.invalid/play/golf'?route.fulfill({contentType:'text/html',body:'<style>'+css+'</style><style>body{margin:0;background:#141a20}.og-game{min-height:240px}#fixture{position:absolute;left:80px;top:150px;width:160px;height:48px}</style><section class="og-game"><button id="fixture" class="og-shoot" data-testid="golf-shoot"><span>SHOOT</span></button></section>'}):route.fulfill({status:404,contentType:'text/plain',body:''});});
  await page.goto('https://arena-feedback-fixture.invalid/play/golf');await page.evaluate(()=>document.fonts.ready);const f=fixture('golf','shot'),timeOrigin=await page.evaluate(()=>performance.timeOrigin),scope={...f.capture.scope,timeOrigin,url:page.url()};
  await page.evaluate(scope=>{globalThis.__oasisPhysicalPerf={schema:'android-physical-performance-v1',nonce:scope.nonce,documentId:scope.documentId,timeOrigin:scope.timeOrigin,url:scope.url};},scope);
  const initial=await page.evaluate(readArenaFeedbackPresentation,{scope,plan:f.plan}),before=await page.screenshot();assert.equal(initial.glyphTemplate,undefined);
  await page.evaluate(()=>{const el=document.querySelector('[data-testid="golf-shoot"]');el.disabled=true;el.querySelector('span').textContent='BALL IN MOTION';});
  const retained=await page.evaluate(readArenaFeedbackPresentation,{scope,plan:f.plan}),after=await page.screenshot();assert.equal(retained.glyphTemplate,undefined);
  await page.evaluate(()=>{const el=document.querySelector('[data-testid="golf-shoot"]');el.disabled=false;el.querySelector('span').textContent='SHOOT';});
  const pending=await page.evaluate(renderArenaFeedbackGlyphTemplate,{scope,presentation:retained,pixelScale:1});assert.equal(retained.glyphTemplate,undefined,'Post-capture template generation preserves the original pending readback');
  const owner=f.observation.initial.owner;f.observation.initial={...initial,owner,at:0};f.observation.presentations=[{...pending,owner,at:58}];f.observation.events.forEach(e=>{e.x=150;e.y=174;});
  f.capture.frames=[f.frame(1,10,before),f.frame(2,40,before),f.frame(3,60,before),f.frame(4,90,after),f.frame(5,120,after)];recount(f);const r=analyze(f);assert.equal(r.passed,true,JSON.stringify(r));assert.equal(r.firstFeedbackFrame.pngSha256,sha(after));assert.equal(intercepted.filter(url=>url===page.url()).length,1);assert.equal(pending.glyphTemplate.comparisonOnly,true);
 }finally{await browser.close();}
});

test('actual Jackaroo CSS and Lucide Send pending PNG retains sixteen quiet samples outside its icon',async()=>{
 const [{chromium},React,{renderToStaticMarkup},{Send}]=await Promise.all([import('playwright'),import('react'),import('react-dom/server'),import('lucide-react')]);
 const browser=await chromium.launch({headless:true});
 try{
  const css=(await Promise.all(['boardkit/boardkit.css','jackaroo/jackaroo.css','ludo/restoration.css','jackaroo/restoration.css'].map(path=>readFile(new URL('../arena/'+path,import.meta.url),'utf8')))).join('\n');
  const button=renderToStaticMarkup(React.createElement('button',{className:'bk-button jack-confirm','data-action':'jack-confirm',style:{position:'absolute',left:75,top:10,width:170,height:46}},React.createElement(Send,{size:15}),'PASS SECRETLY'));
  const page=await browser.newPage({viewport:{width,height}}),url='https://arena-feedback-fixture.invalid/play/jackaroo';
  await page.route('**/*',route=>route.request().url()===url?route.fulfill({contentType:'text/html',body:'<style>'+css+'</style><style>body{margin:0;background:#09251c}.jack-scene{min-height:240px;--majlis:none}</style><section class="bk-scene jack-scene"><div class="jack-action-row" style="position:absolute;left:0;top:140px;width:320px;height:66px">'+button+'</div></section>'}):route.fulfill({status:404,body:''}));
  await page.goto(url);await page.evaluate(()=>document.fonts.ready);
  const f=fixture('jackaroo','pass'),timeOrigin=await page.evaluate(()=>performance.timeOrigin),scope={...f.capture.scope,timeOrigin,url};
  await page.evaluate(scope=>{globalThis.__oasisPhysicalPerf={schema:'android-physical-performance-v1',nonce:scope.nonce,documentId:scope.documentId,timeOrigin:scope.timeOrigin,url:scope.url};},scope);
  const initial=await page.evaluate(readArenaFeedbackPresentation,{scope,plan:f.plan}),before=await page.screenshot();
  await page.evaluate(()=>document.querySelector('[data-action="jack-confirm"]').disabled=true);
  const pending=await page.evaluate(readArenaFeedbackPresentation,{scope,plan:f.plan}),after=await page.screenshot();
  const icon=await page.locator('[data-action="jack-confirm"] > svg').boundingBox();assert.equal(icon.width,15);assert.equal(icon.height,15);
  const r=initial.feedback.rect;assert.ok(r.x+r.width*.20>=icon.x&&r.x+r.width*.20<=icon.x+icon.width,'Original .20 column crosses the real Send icon');
  const owner=f.observation.initial.owner;f.observation.initial={...initial,owner,at:0};f.observation.presentations=[{...pending,owner,at:58}];f.observation.events.forEach(e=>{e.x=r.x+r.width/2;e.y=r.y+r.height/2;});
  f.capture.frames=[f.frame(1,10,before),f.frame(2,40,before),f.frame(3,60,before),f.frame(4,90,after),f.frame(5,120,after)];recount(f);
  const result=analyze(f);assert.equal(result.passed,true,JSON.stringify(result));assert.equal(result.frameMatches[3].matchingSamples,16);assert.equal(result.frameMatches[3].totalSamples,16);assert.equal(result.firstFeedbackFrame.pngSha256,sha(after));
  const enabled=JSON.parse(JSON.stringify(f));enabled.capture.frames=enabled.capture.frames.map((row,i)=>f.frame(i+1,[10,40,60,90,120][i],before));recount(enabled);reject(enabled);
  const preexisting=JSON.parse(JSON.stringify(f));preexisting.observation.initial.trigger.disabled=true;reject(preexisting);
  const same=JSON.parse(JSON.stringify(f));same.capture.frames[0]=f.frame(1,10,after);same.capture.frames[1]=f.frame(2,40,after);recount(same);reject(same);
 }finally{await browser.close();}
});

test('serialized arena observer retains actual trusted submitting touch and mutation, removes only its own listeners, and rejects foreign/continuous realms',async()=>{
 const {chromium}=await import('playwright'),browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width,height},hasTouch:true}),url='https://arena-feedback-fixture.invalid/play/golf';
  await page.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<section class="og-game"><button data-testid="golf-shoot" style="position:absolute;left:80px;top:150px;width:160px;height:48px"><span>SHOOT</span></button></section>'}));await page.goto(url);
  const f=fixture('golf','shot'),scope={...f.capture.scope,url,timeOrigin:await page.evaluate(()=>performance.timeOrigin)},key='__oasisFeedback_'+ '4'.repeat(32);
  await page.evaluate(scope=>{globalThis.__oasisPhysicalPerf={schema:'android-physical-performance-v1',nonce:scope.nonce,documentId:scope.documentId,timeOrigin:scope.timeOrigin,url:scope.url};globalThis.foreignClicks=0;document.addEventListener('click',()=>foreignClicks++);document.querySelector('button').addEventListener('click',e=>{e.currentTarget.disabled=true;e.currentTarget.querySelector('span').textContent='BALL IN MOTION';});},scope);
  const install=()=>page.evaluate('('+installOwnedArenaFeedbackObservation.toString()+')('+JSON.stringify({scope,key,phaseId:'actual-local-observer',plan:f.plan})+','+readArenaFeedbackPresentation.toString()+')');
  await install();await page.locator('button').tap();const observation=await page.evaluate(readOwnedArenaFeedbackObservation,{scope,key,remove:true});
  assert.equal(observation.removed,true);assert.deepEqual(observation.events.map(e=>e.type),['pointerdown','pointerup','click']);assert.equal(observation.events.every(e=>e.isTrusted&&e.pointerType==='touch'),true);assert.equal(observation.initial.trigger.disabled,false);assert.ok(observation.presentations.some(p=>p.trigger.disabled&&p.feedback.text==='BALL IN MOTION'));assert.deepEqual(observation.errors,[]);assert.equal(await page.evaluate(()=>foreignClicks),1);assert.equal(await page.evaluate(key=>Object.hasOwn(globalThis,key),key),false);
  await page.evaluate(()=>{document.querySelector('button').disabled=false;globalThis.__oasisPhysicalPerf.sampleStartAt=1;});await assert.rejects(install,/CONTINUOUS_SAMPLE_REFUSED/);
  await page.evaluate(()=>{delete globalThis.__oasisPhysicalPerf.sampleStartAt;globalThis.__oasisPhysicalPerf.documentId='f'.repeat(32);});await assert.rejects(install,/DOCUMENT_CHANGED/);
 }finally{await browser.close();}
});
