/** Scoped passive callbacks and pixel validation for ten non-Run arenas.
 * Importing this module performs no device, network, input or runtime mutation.
 * Expected glyphs are a comparison template, never captured-frame evidence.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {VISIBLE_FEEDBACK_LIMITS,VISIBLE_FEEDBACK_PROTOCOL_SHA256,assertVisibleFeedbackImplementation} from './android-player-visible-feedback.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex'),finite=Number.isFinite;
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const button=id=>'[data-testid="'+id+'"]';
export const ARENA_FEEDBACK_CONFIGS=freeze({
 golf:{actions:['shot'],scene:'.og-game',trigger:button('golf-shoot'),feedback:button('golf-shoot')+' > span',texts:{en:['BALL IN MOTION'],zh:['球 正 在 滚 动'],ar:['الكرة تتحرك']},exclude:['.og-shoot-shine','canvas','course'],source:'arena/golf/GolfGame.jsx:46,66'},
 bowling:{actions:['roll'],scene:button('bowling-scene'),trigger:button('bowling-roll'),feedback:button('bowling-roll'),directText:true,texts:{en:['ROLLING…'],zh:['滚球中…'],ar:['ROLLING…']},exclude:['.nb-roll-button > span','canvas'],source:'arena/bowling/BowlingGame.jsx:11,32'},
 carrom:{actions:['shot'],scene:'.oc-game',trigger:button('carrom-shoot'),feedback:button('carrom-shoot')+' > span',texts:{en:['…'],zh:['…'],ar:['…']},exclude:['.oc-strike > i','canvas','.oc-shot-toast'],source:'arena/carrom/CarromGame.jsx:29,47'},
 pool:{actions:['shot'],scene:'.op-game',trigger:button('pool-shoot'),feedback:button('pool-shoot')+' > span',texts:{en:['…'],zh:['…'],ar:['…']},exclude:['.op-shoot > i','canvas','spin','place','call'],source:'arena/pool/PoolGame.jsx:13,32'},
 darts:{actions:['throw'],scene:'.da-scene',trigger:'svg.da-board[role="application"]',feedback:'.da-gesture-instruction > span',gesture:'release',texts:{en:['CONFIRMING…'],zh:['正在确认投镖…'],ar:['CONFIRMING…']},exclude:['.da-aim','.da-held-stage','.da-swipe-arc','.da-flight-dart','.da-hit-marker'],source:'arena/darts/DartsGame.jsx:79,87'},
 ludo:{actions:['roll','move'],scene:'.ludo-scene',trigger:'[data-action="ludo-roll"]',feedback:'.ludo-dice-area > span',texts:{en:['✦','SIX · EXTRA TURN'],zh:['✦','六点 · 再来一次'],ar:['✦','ستة · دور إضافي']},textPatterns:{en:'^MOVE [1-6]$',zh:'^前进 [1-6]$',ar:'^تقدم [1-6]$'},exclude:['.ludo-visible-face','svg','.bk-route','capture'],source:'arena/ludo/LudoGame.jsx:18'},
 jackaroo:{actions:['pass','play','discard'],scene:'.jack-scene',trigger:'[data-action="jack-confirm"]',feedback:'[data-action="jack-confirm"]',pixelRule:'disabled-green',exclude:['svg','.bk-route','.jack-passed-card','.jack-hand'],source:'arena/jackaroo/JackarooGame.jsx:34,40; arena/jackaroo/restoration.css:24'},
 domino:{actions:['play','draw','pass'],scene:'.do-scene',trigger:button('domino-draw'),feedback:button('domino-draw'),directText:true,texts:{en:['确认中…'],zh:['确认中…'],ar:['确认中…']},exclude:['.do-endpoint','svg','.do-flight','.do-hand'],source:'arena/domino/DominoGame.jsx:23,33'},
 match:{actions:['swap'],scene:'.match-scene',trigger:'[data-cell]',feedback:'.match-message',texts:{en:['Resolving your gems…'],zh:['正在结算连锁…'],ar:['جارٍ احتساب السلسلة…']},exclude:['.match-piece','.match-cell-selected','.match-effects','canvas'],source:'arena/match/MatchGame.jsx:65,75,95'},
 towerlink:{actions:['link','unlink','stop','upgrade'],scene:button('towerlink-game'),trigger:button('towerlink-game'),feedback:'.towerlink-tip',directText:true,gesture:'release',texts:{en:['Confirming command…'],zh:['正在确认指令…'],ar:['Confirming command…']},exclude:['.tl-spin','svg','troops','drag-aim'],source:'arena/towerlink/TowerLinkGame.jsx:63,90'}
});

/** Only actual submitting controls are supported. Preparatory card/pawn/tile
 * selection, aiming and cancel targets deliberately have no feedback plan. */
export function arenaFeedbackPlan({game,actionType,locale='en',end,cell}){
 const config=ARENA_FEEDBACK_CONFIGS[game];assert.ok(config&&config.actions.includes(actionType),'ARENA_FEEDBACK_SUBMISSION_UNSUPPORTED');
 assert.ok(['en','zh','ar'].includes(locale),'ARENA_FEEDBACK_LOCALE_UNSUPPORTED');
 const plan={game,actionType,locale,...structuredClone(config),...(end===undefined?{}:{end}),...(cell===undefined?{}:{cell})};
 if(game==='ludo'&&actionType==='move')Object.assign(plan,{trigger:'[data-action="ludo-move"]',feedback:'[data-action="ludo-move"]',pixelRule:'disabled-dark'});
 if(game==='domino'){
  if(actionType==='play'){assert.ok(['left','right'].includes(end),'ARENA_FEEDBACK_DOMINO_END_REQUIRED');Object.assign(plan,{trigger:button('domino-'+end),feedback:button('domino-'+end),pixelRule:'disabled-text',texts:{en:[end.toUpperCase()],zh:[end==='left'?'接左端':'接右端'],ar:[end.toUpperCase()]}});}
  else plan.trigger=plan.feedback=button('domino-'+actionType);
 }
 if(game==='match'){assert.ok(Number.isSafeInteger(cell)&&cell>=0&&cell<36,'ARENA_FEEDBACK_MATCH_SUBMIT_CELL_REQUIRED');plan.trigger='[data-cell="'+cell+'"]';}
 if(game==='towerlink'&&['stop','upgrade'].includes(actionType)){plan.gesture='tap';plan.trigger='[data-action="tower-'+(actionType==='stop'?'stop':'upgrade-confirm')+'"]';}
 plan.gesture??='tap';plan.pixelRule??='pending-text';
 plan.roi=game==='darts'?'.da-gesture-instruction':game==='ludo'&&actionType==='roll'?'.ludo-dice-area':plan.feedback.endsWith(' > span')?plan.trigger:plan.feedback;
 return freeze(plan);
}
const owner=scope=>({nonce:scope.nonce,documentId:scope.documentId,timeOrigin:scope.timeOrigin,url:scope.url});
function assertScope(scope,game){
 assert.ok(scope&&typeof scope.nonce==='string'&&scope.nonce.length>0&&/^[a-f0-9]{32}$/.test(scope.documentId)&&finite(scope.timeOrigin),'ARENA_FEEDBACK_OWNER_REQUIRED');
 const url=new URL(scope.url);assert.ok(url.protocol==='https:'&&url.pathname==='/play/'+game,'ARENA_FEEDBACK_GAME_DOCUMENT_CHANGED');
 assert.equal(new URL(scope.topUrl).origin,url.origin);for(const key of ['frameId','loaderId','topFrameId','topLoaderId'])assert.ok(typeof scope[key]==='string'&&scope[key].length>0,'ARENA_FEEDBACK_FRAME_BINDING_REQUIRED');assert.ok(Number.isSafeInteger(scope.contextId));
}
function assertState(state,scope){assert.deepEqual(state.owner,owner(scope),'ARENA_FEEDBACK_FOREIGN_FRAME');assert.equal(state.phase,'feedbackProof');assert.equal(state.continuousActive,false);assert.equal(state.visible,true);assert.ok(finite(state.at)&&Math.abs(scope.timeOrigin+state.at-state.wallEpochMs)<=5,'ARENA_FEEDBACK_REALM_CLOCK_REQUIRED');}
function assertTree(tree,scope){
 assert.deepEqual({id:tree.frame.id,loaderId:tree.frame.loaderId,url:tree.frame.url},{id:scope.topFrameId,loaderId:scope.topLoaderId,url:scope.topUrl});
 const frames=(tree.childFrames??[]).filter(f=>f.frame.url===scope.url);assert.equal(frames.length,1);assert.deepEqual({id:frames[0].frame.id,loaderId:frames[0].frame.loaderId,parentId:frames[0].frame.parentId},{id:scope.frameId,loaderId:scope.loaderId,parentId:scope.topFrameId});
}
function textAllowed(plan,text){return (plan.texts?.[plan.locale]??[]).includes(text)||(plan.textPatterns?.[plan.locale]&&new RegExp(plan.textPatterns[plan.locale]).test(text));}
function rgb(text){const m=String(text).match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*1)?\)$/);assert.ok(m,'ARENA_FEEDBACK_OPAQUE_TEXT_COLOR_REQUIRED');return m.slice(1).map(Number);}

/** Serializable passive default-realm read, with no DOM attachment or input.
 * This callback records layout/style only. Render comparison glyphs after the
 * original PNG collector closes, so template work cannot warm or delay input. */
export function readArenaFeedbackPresentation({scope,plan}){
 const p=globalThis.__oasisPhysicalPerf;
 if(location.href!==scope.url||performance.timeOrigin!==scope.timeOrigin||p?.schema!=='android-physical-performance-v1'||p.nonce!==scope.nonce||p.documentId!==scope.documentId||p.timeOrigin!==scope.timeOrigin||p.url!==scope.url)throw Error('ARENA_FEEDBACK_DOCUMENT_CHANGED');
 if(Number.isFinite(p.sampleStartAt)&&!Number.isFinite(p.sampleEndAt)&&!p.stopped)throw Error('ARENA_FEEDBACK_CONTINUOUS_SAMPLE_REFUSED');
 if(document.visibilityState!=='visible'||!document.hasFocus())throw Error('ARENA_FEEDBACK_FOREGROUND_REQUIRED');
 const one=selector=>{const rows=document.querySelectorAll(selector);if(rows.length!==1)throw Error('ARENA_FEEDBACK_CONTROL_NOT_UNIQUE');return rows[0];};
 const trigger=one(plan.trigger),element=one(plan.feedback),container=one(plan.roi),scene=one(plan.scene),r=trigger.getBoundingClientRect(),rect=container.getBoundingClientRect();
 if(!scene.contains(trigger)||!scene.contains(element)||!container.contains(element))throw Error('ARENA_FEEDBACK_CONTROL_OUTSIDE_SCENE');
 const nodes=[...element.childNodes].filter(n=>n.nodeType===3&&n.textContent.trim()),text=nodes.map(n=>n.textContent).join('').trim();let textRect;
 if(!['disabled-green','disabled-dark'].includes(plan.pixelRule)){if(nodes.length!==1)throw Error('ARENA_FEEDBACK_DIRECT_TEXT_ROI_REQUIRED');const range=document.createRange();range.selectNodeContents(nodes[0]);if(range.getClientRects().length!==1)throw Error('ARENA_FEEDBACK_WRAPPED_TEXT_UNSUPPORTED');textRect=range.getBoundingClientRect();}
 const shape=v=>({x:v.x,y:v.y,width:v.width,height:v.height}),css=getComputedStyle(element),at=performance.now();
 return {schema:'owned-arena-feedback-presentation-v1',owner:{nonce:scope.nonce,documentId:scope.documentId,timeOrigin:scope.timeOrigin,url:scope.url},at,trigger:{selector:plan.trigger,disabled:trigger.disabled===true||trigger.getAttribute('aria-disabled')==='true',rect:shape(r)},feedback:{selector:plan.feedback,rect:shape(rect),...(textRect?{textRect:shape(textRect)}:{}),text,color:css.color,font:css.font,letterSpacing:css.letterSpacing,opacity:css.opacity,direction:css.direction}};
}

/** Passive observer installed immediately before the existing driver's final
 * submission. It reads pending state before ACK; mutation times are never the
 * displayed-frame timestamp. No input, app callback or server state is changed. */
export function installOwnedArenaFeedbackObservation({scope,key,phaseId,plan},readPresentation){
 if(!/^__oasisFeedback_[a-f0-9]{16,64}$/.test(key)||typeof phaseId!=='string'||typeof readPresentation!=='function')throw Error('ARENA_FEEDBACK_OBSERVATION_ARGUMENT_INVALID');
 if(Object.hasOwn(globalThis,key))throw Error('ARENA_FEEDBACK_OBSERVER_ALREADY_PRESENT');
 const trigger=document.querySelector(plan.trigger),feedback=document.querySelector(plan.feedback),scene=document.querySelector(plan.scene);
 const snapshot=()=>{if(!trigger?.isConnected||!feedback?.isConnected||document.querySelector(plan.trigger)!==trigger||document.querySelector(plan.feedback)!==feedback||document.querySelector(plan.scene)!==scene)throw Error('ARENA_FEEDBACK_CONTROL_REPLACED');return readPresentation({scope,plan});};
 const initial=snapshot();if(initial.trigger.disabled)throw Error('ARENA_FEEDBACK_SUBMIT_CONTROL_DISABLED');
 const record={schema:'owned-visible-arena-feedback-observation-v1',scope:{...scope},plan,phaseId,phase:'feedbackProof',initial,events:[],presentations:[],errors:[],overflow:false,removed:false},handlers=[];
 const append=(list,value)=>{if(list.length>=64){record.overflow=true;return;}list.push(value);};
 for(const type of ['pointerdown','pointermove','pointerup','pointercancel',...(plan.gesture==='tap'?['click']:[])]){
  const handler=e=>{if(!e.composedPath().includes(trigger))return;const at=performance.now();try{snapshot();append(record.events,{type,at,owner:{nonce:scope.nonce,documentId:scope.documentId,timeOrigin:scope.timeOrigin,url:scope.url},triggerSelector:plan.trigger,isTrusted:e.isTrusted,isPrimary:e.isPrimary!==false,pointerId:e.pointerId??null,pointerType:e.pointerType||null,x:e.clientX,y:e.clientY});}catch(error){append(record.errors,{type,at,error:error.message});}};
  document.addEventListener(type,handler,true);handlers.push({type,handler});
 }
 const observer=new MutationObserver(()=>{try{append(record.presentations,snapshot());}catch(error){append(record.errors,{type:'mutation',at:performance.now(),error:error.message});}});
 observer.observe(feedback,{attributes:true,attributeFilter:['disabled','aria-disabled','class','style'],childList:true,characterData:true,subtree:true});
 if(trigger!==feedback)observer.observe(trigger,{attributes:true,attributeFilter:['disabled','aria-disabled','class','style']});
 Object.defineProperty(record,'dispose',{value:()=>{for(const {type,handler}of handlers)document.removeEventListener(type,handler,true);observer.disconnect();record.removed=true;}});
 Object.defineProperty(record,'verify',{value:snapshot});globalThis[key]=record;return {schema:record.schema,key,phaseId,initial};
}
export function readOwnedArenaFeedbackObservation({scope,key,remove=false}){
 const record=globalThis[key];if(record?.schema!=='owned-visible-arena-feedback-observation-v1'||record.scope.nonce!==scope.nonce||record.scope.documentId!==scope.documentId||record.scope.timeOrigin!==scope.timeOrigin||record.scope.url!==scope.url)throw Error('ARENA_FEEDBACK_OBSERVER_OWNER_CHANGED');
 if(remove){record.dispose();delete globalThis[key];}else record.verify();return JSON.parse(JSON.stringify(record));
}

/** Serializable comparison preparation AFTER capture, from the retained actual
 * pending style/Range readback. The canvas never attaches to the DOM, and its
 * bitmap is never accepted as a capture frame or a presentation timestamp. */
export function renderArenaFeedbackGlyphTemplate({scope,presentation,pixelScale=1}){
 const p=globalThis.__oasisPhysicalPerf,o=presentation?.owner;
 if(location.href!==scope.url||performance.timeOrigin!==scope.timeOrigin||p?.schema!=='android-physical-performance-v1'||p.nonce!==scope.nonce||p.documentId!==scope.documentId||p.timeOrigin!==scope.timeOrigin||p.url!==scope.url||o?.nonce!==scope.nonce||o.documentId!==scope.documentId||o.timeOrigin!==scope.timeOrigin||o.url!==scope.url)throw Error('ARENA_FEEDBACK_DOCUMENT_CHANGED');
 if(Number.isFinite(p.sampleStartAt)&&!Number.isFinite(p.sampleEndAt)&&!p.stopped)throw Error('ARENA_FEEDBACK_CONTINUOUS_SAMPLE_REFUSED');
 if(presentation.schema!=='owned-arena-feedback-presentation-v1')throw Error('ARENA_FEEDBACK_RETAINED_STYLE_REQUIRED');
 const css=presentation.feedback,text=css.text,textRect=css.textRect;
 if(typeof text!=='string'||text.length>256||typeof css.font!=='string'||css.font.length>512||!textRect)throw Error('ARENA_FEEDBACK_RETAINED_STYLE_REQUIRED');
 if(!Number.isFinite(pixelScale)||pixelScale<1||pixelScale>4||textRect.width<=0||textRect.height<=0||textRect.width*pixelScale>2048||textRect.height*pixelScale>256)throw Error('ARENA_FEEDBACK_GLYPH_TEMPLATE_BOUND');
 if(!document.fonts?.check(css.font,text))throw Error('ARENA_FEEDBACK_FONT_NOT_READY');
 const canvas=document.createElement('canvas');canvas.width=Math.ceil(textRect.width*pixelScale);canvas.height=Math.ceil(textRect.height*pixelScale);const ctx=canvas.getContext('2d');ctx.scale(pixelScale,pixelScale);ctx.font=css.font;ctx.fillStyle=css.color;ctx.textBaseline='alphabetic';
 if(css.letterSpacing!=='normal'&&css.letterSpacing!=='0px'){if(!('letterSpacing'in ctx))throw Error('ARENA_FEEDBACK_LETTER_SPACING_UNSUPPORTED');ctx.letterSpacing=css.letterSpacing;}
 ctx.direction=css.direction;ctx.textAlign=ctx.direction==='rtl'?'right':'left';const metrics=ctx.measureText(text);if(!Number.isFinite(metrics.fontBoundingBoxAscent)||!Number.isFinite(metrics.fontBoundingBoxDescent))throw Error('ARENA_FEEDBACK_FONT_METRICS_REQUIRED');const baseline=(textRect.height-metrics.fontBoundingBoxAscent-metrics.fontBoundingBoxDescent)/2+metrics.fontBoundingBoxAscent;ctx.fillText(text,ctx.direction==='rtl'?textRect.width:0,baseline);
 const data=ctx.getImageData(0,0,canvas.width,canvas.height).data;let binary='';for(let start=0;start<data.length;start+=4096)binary+=String.fromCharCode(...data.subarray(start,start+4096));
 return {...presentation,glyphTemplate:{schema:'owned-arena-offscreen-glyph-template-v1',comparisonOnly:true,text,color:css.color,font:css.font,letterSpacing:css.letterSpacing,pixelScale,width:canvas.width,height:canvas.height,rgbaBase64:btoa(binary)}};
}

const require=createRequire(import.meta.url);let decoder;
function png(row){
 assert.ok(typeof row.pngBase64==='string'&&row.pngBase64.length<=Math.ceil(VISIBLE_FEEDBACK_LIMITS.maxPngBytes/3)*4,'ARENA_FEEDBACK_ORIGINAL_PNG_REQUIRED');const bytes=Buffer.from(row.pngBase64,'base64');assert.equal(bytes.toString('base64'),row.pngBase64);assert.equal(sha(bytes),row.pngSha256,'ARENA_FEEDBACK_ORIGINAL_PNG_SHA_CHANGED');assert.equal(bytes.length,row.pngBytes);assert.equal(row.sink?.sha256,row.pngSha256);assert.equal(row.sink?.bytes,bytes.length);
 assert.ok(bytes.length>=24&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),'ARENA_FEEDBACK_ORIGINAL_PNG_REQUIRED');const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);assert.ok(width>0&&height>0&&width<=4096&&height<=4096&&width*height<=8*1024*1024);
 if(!decoder){const path=join(dirname(require.resolve('playwright-core')),'lib/utilsBundle.js');decoder={read:require(path).PNG.sync.read,pin:{source:'Installed Playwright bundled PNG decoder',sha256:sha(readFileSync(path))}};}
 const image=decoder.read(bytes);assert.equal(image.width,width);assert.equal(image.height,height);assert.equal(image.data.length,width*height*4);return image;
}
function crop(image,metadata,projection,rect){
 const near=(a,b,t=.5)=>finite(a)&&finite(b)&&Math.abs(a-b)<=t;
 assert.ok(metadata.pageScaleFactor===1&&metadata.offsetTop===0&&near(metadata.deviceWidth,projection.topViewport.width)&&near(metadata.deviceHeight,projection.topViewport.height)&&near(metadata.scrollOffsetX,projection.topScroll.x)&&near(metadata.scrollOffsetY,projection.topScroll.y),'ARENA_FEEDBACK_PROJECTION_UNPROVEN');
 const scale=image.width/metadata.deviceWidth;assert.ok(scale>=1&&scale<=4&&near(scale,image.height/metadata.deviceHeight,.002));const r={x:Math.round((projection.iframeRect.x+rect.x)*scale),y:Math.round((projection.iframeRect.y+rect.y)*scale),width:Math.ceil(rect.width*scale),height:Math.ceil(rect.height*scale),scale};assert.ok(r.width>=2&&r.height>=2&&r.x>=2&&r.y>=2&&r.x+r.width<image.width-2&&r.y+r.height<image.height-2,'ARENA_FEEDBACK_ROI_UNPROVEN');return r;
}
function colorMatch(pixel,color,tolerance=20){return color.every((v,i)=>Math.abs(pixel[i]-v)<=tolerance);}
function pixelsMatch(image,r,presentation,plan){
 const at=(x,y)=>{const i=((r.y+y)*image.width+r.x+x)*4;assert.equal(image.data[i+3],255,'ARENA_FEEDBACK_TRANSPARENT_PIXELS');return image.data.subarray(i,i+3);};
 if(['disabled-green','disabled-dark'].includes(plan.pixelRule)){
  // Jackaroo PASS SECRETLY includes a centered Lucide Send icon. Sample the
  // control's side padding, keeping all sixteen original pixel checks.
  const columns=plan.pixelRule==='disabled-green'?[.08,.12,.88,.92]:[.14,.20,.80,.86];
  let matched=0,count=0;for(const fx of columns)for(const fy of [.36,.44,.52,.60]){const [red,green,blue]=at(Math.floor(r.width*fx),Math.floor(r.height*fy));count++;if(plan.pixelRule==='disabled-green'?red>=45&&red<=145&&green>=65&&green<=165&&blue>=40&&blue<=145&&green>=red&&Math.abs(red-blue)<=30:red<=55&&green<=50&&blue<=65&&Math.max(red,green,blue)-Math.min(red,green,blue)<=35)matched++;}
  return {matched:matched===count,matchingSamples:matched,totalSamples:count,rule:plan.pixelRule};
 }
 const t=presentation.glyphTemplate;assert.ok(t?.schema==='owned-arena-offscreen-glyph-template-v1'&&t.comparisonOnly===true&&t.text===presentation.feedback.text&&t.color===presentation.feedback.color&&t.font===presentation.feedback.font&&t.letterSpacing===presentation.feedback.letterSpacing,'ARENA_FEEDBACK_EXPECTED_GLYPHS_REQUIRED');
 assert.ok(t.width===r.width&&t.height===r.height&&Math.abs(t.pixelScale-r.scale)<.002&&t.width*t.height*4<=2*1024*1024,'ARENA_FEEDBACK_GLYPH_PROJECTION_CHANGED');const bytes=Buffer.from(t.rgbaBase64??'','base64');assert.equal(bytes.toString('base64'),t.rgbaBase64);assert.equal(bytes.length,t.width*t.height*4);const color=rgb(t.color),ink=[];let expected=0;
 for(let i=0;i<bytes.length;i+=4){if(bytes[i+3]>25)expected++;if(bytes[i+3]>=200){assert.ok(colorMatch(bytes.subarray(i,i+3),color,1));ink.push({x:(i/4)%t.width,y:Math.floor(i/4/t.width)});}}
 assert.ok(ink.length>=8,'ARENA_FEEDBACK_GLYPHS_NOT_IDENTIFIABLE');
 // Shape correlation survives real parent opacity (Pool .62), antialiasing and
 // text shadows. It compares the configured glyph edges, never overall motion.
 const alpha=(x,y)=>bytes[(y*t.width+x)*4+3],points=[];let energy=0;
 for(let y=1;y<t.height-1;y++)for(let x=1;x<t.width-1;x++){const gx=alpha(x+1,y)-alpha(x-1,y),gy=alpha(x,y+1)-alpha(x,y-1);if(gx*gx+gy*gy>=4096){points.push({x,y,gx,gy});energy+=gx*gx+gy*gy;}}
 assert.ok(points.length>=12,'ARENA_FEEDBACK_GLYPH_EDGES_REQUIRED');const luminances=new Float32Array(r.width*r.height);for(let y=0;y<r.height;y++)for(let x=0;x<r.width;x++){const i=((r.y+y)*image.width+r.x+x)*4;assert.equal(image.data[i+3],255,'ARENA_FEEDBACK_TRANSPARENT_PIXELS');luminances[y*r.width+x]=image.data[i]*.2126+image.data[i+1]*.7152+image.data[i+2]*.0722;}
 const luminance=(x,y)=>luminances[y*r.width+x],gray=(x,y)=>{const a=Math.floor(x),b=Math.floor(y),fx=x-a,fy=y-b;return luminance(a,b)*(1-fx)*(1-fy)+luminance(a+1,b)*fx*(1-fy)+luminance(a,b+1)*(1-fx)*fy+luminance(a+1,b+1)*fx*fy;};let best=0;
 for(let dy=-2;dy<=2;dy+=.5)for(let dx=-2;dx<=2;dx+=.5){let dot=0,actualEnergy=0;for(const p of points){const x=p.x+dx,y=p.y+dy;if(x<1||y<1||x>=r.width-2||y>=r.height-2)continue;const gx=gray(x+1,y)-gray(x-1,y),gy=gray(x,y+1)-gray(x,y-1);dot+=gx*p.gx+gy*p.gy;actualEnergy+=gx*gx+gy*gy;}if(actualEnergy>0)best=Math.max(best,Math.abs(dot)/Math.sqrt(energy*actualEnergy));}
 let pixelColorVerified=true;if(plan.pixelRule==='disabled-text'){const values=ink.map(p=>[...at(p.x,p.y)]);const median=channel=>values.map(p=>p[channel]).sort((a,b)=>a-b)[Math.floor(values.length/2)];pixelColorVerified=colorMatch([median(0),median(1),median(2)],[126,159,166],22);}
 return {matched:best>=.90&&pixelColorVerified,glyphEdgeCorrelation:best,pixelColorVerified,expectedPixels:expected,glyphTemplateSha256:sha(bytes),rule:plan.pixelRule};
}

/** Consumes the unchanged PNG collector row shape. There is no DOM/RAF latency
 * fallback. Root must later supply the real scoped gesture/presentation readback
 * and accepted-action records; missing evidence remains insufficient. */
export function analyzeVisibleArenaFeedback({plan,capture,observation,actions=[],requests=[],thresholdMs=100}){
 const result={schema:'owned-visible-arena-feedback-v1',game:plan?.game,status:'insufficient',captureStatus:'insufficient',swapStatus:'insufficient',passed:false,thresholdMs:100,phase:'feedbackProof',physicalPanelPresent:false,latencyMs:null,reasons:[],limitations:['Original captured-content receipt upper bound; neither swap nor physical panel presentation is claimed','Offscreen glyphs and DOM state are comparison/corroboration only; original captured PNG pixels and one accepted action are mandatory','Pending-only adapter: post-ACK scene animations, cancelled drag and arbitrary changing pixels cannot qualify']};
 try{
  assert.equal(thresholdMs,100,'ARENA_FEEDBACK_FIXED_STANDARD_REQUIRED');assert.deepEqual(plan,arenaFeedbackPlan({game:plan?.game,actionType:plan?.actionType,locale:plan?.locale,end:plan?.end,cell:plan?.cell}),'ARENA_FEEDBACK_PLAN_CHANGED');assert.equal(capture?.schema,'owned-visible-feedback-capture-v1');assert.equal(capture.phase,'feedbackProof');assert.equal(capture.started,true);assert.equal(capture.closed,true);assertScope(capture.scope,plan.game);const scope=capture.scope;
  assert.equal(capture.protocol?.sha256,VISIBLE_FEEDBACK_PROTOCOL_SHA256);assert.deepEqual(capture.startParameters,{format:'png',everyNthFrame:1});assert.equal(capture.dropped,0);assert.deepEqual(capture.errors,[]);assertState(capture.before,scope);assertState(capture.after,scope);assertTree(capture.treeBefore,scope);assertTree(capture.treeAfter,scope);assert.deepEqual(capture.before.projection,capture.after.projection);const start=scope.timeOrigin+capture.before.at,end=scope.timeOrigin+capture.after.at;assert.ok(end>start&&end-start<=VISIBLE_FEEDBACK_LIMITS.maxDurationMs);assert.ok(Math.abs((capture.after.wallEpochMs-capture.before.wallEpochMs)-(end-start))<=2,'ARENA_FEEDBACK_REALM_CLOCK_DRIFT');
  assert.equal(observation?.schema,'owned-visible-arena-feedback-observation-v1');assert.deepEqual(observation.scope,scope);assert.deepEqual(observation.plan,plan,'ARENA_FEEDBACK_PLAN_CHANGED');assert.equal(observation.phase,'feedbackProof');assert.equal(observation.phaseId,capture.phaseId);assert.equal(observation.removed,true);assert.equal(observation.overflow,false);assert.deepEqual(observation.errors,[]);
  const events=observation.events;assert.ok(Array.isArray(events)&&events.length>=2&&events.length<=64&&!events.some(e=>e.type==='pointercancel'),'ARENA_FEEDBACK_CANCELLED_OR_MISSING_GESTURE');const down=events[0],up=events.find(e=>e.type==='pointerup');assert.equal(down.type,'pointerdown');assert.equal(events.filter(e=>e.type==='pointerup').length,1);assert.ok(up&&down.at<up.at);assert.ok(events.every(e=>['pointerdown','pointermove','pointerup','click'].includes(e.type)&&e.isTrusted===true&&e.isPrimary===true),'ARENA_FEEDBACK_TRUSTED_GESTURE_REQUIRED');assert.equal(down.pointerType,'touch');assert.equal(up.pointerType,'touch');assert.ok(Number.isSafeInteger(down.pointerId)&&up.pointerId===down.pointerId);for(let i=1;i<events.length;i++)assert.ok(events[i].at>=events[i-1].at);for(const event of events){assert.deepEqual(event.owner,owner(scope));assert.equal(event.triggerSelector,plan.trigger);assert.ok(finite(event.at)&&finite(event.x)&&finite(event.y));if(event.type!=='click')assert.equal(event.pointerId,down.pointerId);}
  const submitting=plan.gesture==='tap'?events.at(-1):up;if(plan.gesture==='tap'){assert.deepEqual(events.map(e=>e.type),['pointerdown','pointerup','click']);}else assert.equal(events.at(-1),up);assert.ok(scope.timeOrigin+down.at>=start&&scope.timeOrigin+submitting.at<=end);
  const initial=observation.initial;assert.deepEqual(initial.owner,owner(scope));assert.equal(initial.trigger.selector,plan.trigger);assert.equal(initial.trigger.disabled,false);assert.equal(initial.feedback.selector,plan.feedback);const rect=initial.feedback.rect;for(const event of events){const r=initial.trigger.rect;assert.ok(event.x>=r.x&&event.x<=r.x+r.width&&event.y>=r.y&&event.y<=r.y+r.height,'ARENA_FEEDBACK_GESTURE_OUTSIDE_SUBMIT_CONTROL');}
  const gestureEpochMs=scope.timeOrigin+up.at,owned=requests.filter(r=>r.frameId===scope.frameId&&r.requestStartedEpochMs>=scope.timeOrigin+submitting.at&&r.requestStartedEpochMs<=end);assert.equal(owned.length,1,'ARENA_FEEDBACK_UNIQUE_POST_REQUIRED');const request=owned[0];assert.ok(request.transferFinished===true&&!request.failed&&!request.canceled&&request.responseStatus>=200&&request.responseStatus<300,'ARENA_FEEDBACK_POST_NOT_ACCEPTED');
  const accepted=actions.filter(a=>a.accepted===true&&a.requestSha256===request.requestSha256);assert.equal(accepted.length,1,'ARENA_FEEDBACK_ACCEPTED_ACTION_REQUIRED');const action=accepted[0];assert.equal(action.protocol,'arena-action-v1');assert.equal(action.proof?.type,plan.actionType);assert.ok(Number.isSafeInteger(action.cursorBefore)&&action.cursorBefore>=0&&action.cursorAfter===action.cursorBefore+1&&action.proof.sequence===action.cursorAfter,'ARENA_FEEDBACK_ACCEPTED_SEQUENCE_CHANGED');assert.equal(action.roomIdHash,request.roomIdHash);for(const h of [request.roomIdHash,request.requestSha256,action.responseSha256])assert.match(h,/^[a-f0-9]{64}$/);assert.ok(Math.abs(action.gestureCompletedEpochMs-gestureEpochMs)<=2);assert.equal(action.requestStartedEpochMs,request.requestStartedEpochMs);assert.ok(action.responseFinishedEpochMs>=request.requestStartedEpochMs&&action.responseFinishedEpochMs<=end);
  const pending=(observation.presentations??[]).filter(p=>p.at>=submitting.at&&scope.timeOrigin+p.at<action.responseFinishedEpochMs);assert.ok(pending.length,'ARENA_FEEDBACK_PRE_ACK_PRESENTATION_REQUIRED');const presentation=pending.find(p=>['disabled-green','disabled-dark'].includes(plan.pixelRule)?p.trigger.disabled===true:textAllowed(plan,p.feedback.text));assert.ok(presentation,'ARENA_FEEDBACK_SPECIFIC_PENDING_STATE_REQUIRED');assert.deepEqual(presentation.owner,owner(scope));assert.equal(presentation.trigger.selector,plan.trigger);assert.equal(presentation.feedback.selector,plan.feedback);assert.deepEqual(presentation.feedback.rect,rect,'ARENA_FEEDBACK_ROI_MOVED');
  const pixelRoi=['disabled-green','disabled-dark'].includes(plan.pixelRule)?rect:presentation.feedback.textRect;assert.ok(pixelRoi&&pixelRoi.x>=rect.x&&pixelRoi.y>=rect.y&&pixelRoi.x+pixelRoi.width<=rect.x+rect.width+.5&&pixelRoi.y+pixelRoi.height<=rect.y+rect.height+.5,'ARENA_FEEDBACK_TEXT_ROI_OUTSIDE_CONTROL');
  if(plan.pixelRule==='pending-text')assert.notEqual(presentation.feedback.text,initial.feedback.text,'ARENA_FEEDBACK_BASELINE_ALREADY_PENDING');if(plan.pixelRule==='disabled-text'){assert.equal(presentation.trigger.disabled,true);assert.ok(colorMatch(rgb(presentation.feedback.color),[126,159,166],22),'ARENA_FEEDBACK_DISABLED_TEXT_COLOR_CHANGED');}
  const rows=capture.frames;assert.ok(Array.isArray(rows)&&rows.length>=4&&rows.length<=VISIBLE_FEEDBACK_LIMITS.maxFrames);let total=0,previous=-Infinity,offset,lastReceive=-Infinity;const matches=[];let dimensions,baseline;
  for(let i=0;i<rows.length;i++){
   const row=rows[i],at=row.metadata.timestamp*1000;assert.equal(row.index,i+1);assert.ok(Number.isSafeInteger(row.sessionId));assertState(row.state,scope);assert.deepEqual(row.state.projection,capture.before.projection);assert.ok(finite(at)&&at>1262304000000&&at>previous&&(i===0||at-previous<=VISIBLE_FEEDBACK_LIMITS.maxObservedGapMs)&&at>=start-50&&at<=end,'ARENA_FEEDBACK_FRAME_ORDER_OR_GAP');previous=at;assert.ok(row.ack?.ok===true,'ARENA_FEEDBACK_FRAME_ACK_REQUIRED');for(const c of [row.received,row.ackDispatched,row.ack.completed]){assert.ok(finite(c.epochMs)&&finite(c.monotonicMs));offset??=c.epochMs-c.monotonicMs;assert.ok(Math.abs(c.epochMs-c.monotonicMs-offset)<=2);}assert.ok(row.received.monotonicMs>=lastReceive,'ARENA_FEEDBACK_RECEIVE_CLOCK_REVERSED');lastReceive=row.received.monotonicMs;assert.ok(row.ackDispatched.monotonicMs>=row.received.monotonicMs&&row.ackDispatched.monotonicMs-row.received.monotonicMs<=1&&row.ack.completed.monotonicMs>=row.ackDispatched.monotonicMs&&row.ack.completed.monotonicMs-row.ackDispatched.monotonicMs<=VISIBLE_FEEDBACK_LIMITS.maxAckMs);
   const image=png(row),r=crop(image,row.metadata,capture.before.projection,pixelRoi);dimensions??={width:image.width,height:image.height};assert.deepEqual({width:image.width,height:image.height},dimensions);total+=row.pngBytes;const match=pixelsMatch(image,r,presentation,plan);matches.push({index:row.index,pngSha256:row.pngSha256,metadataEpochMs:at,...match});
   if(at<scope.timeOrigin+down.at){const bytes=[];for(let y=0;y<r.height;y++)bytes.push(image.data.subarray(((r.y+y)*image.width+r.x)*4,((r.y+y)*image.width+r.x+r.width)*4));const digest=sha(Buffer.concat(bytes));baseline??={digests:[],indices:[]};baseline.digests.push(digest);baseline.indices.push(row.index);assert.equal(match.matched,false,'ARENA_FEEDBACK_BASELINE_ALREADY_MATCHES');}
  }
  assert.ok(total===capture.rawBytes&&total<=VISIBLE_FEEDBACK_LIMITS.maxRawBytes);assert.ok(baseline?.digests.length>=2&&baseline.digests.at(-1)===baseline.digests.at(-2),'ARENA_FEEDBACK_STABLE_ROI_REQUIRED');
  result.frameMatches=matches;const first=matches.find(m=>m.metadataEpochMs>=scope.timeOrigin+submitting.at&&m.metadataEpochMs<action.responseFinishedEpochMs&&m.matched);assert.ok(first,'ARENA_FEEDBACK_ORIGINAL_PENDING_PIXELS_UNOBSERVED');result.commandBinding={protocol:action.protocol,sequence:action.proof.sequence,type:action.proof.type,requestSha256:request.requestSha256,responseSha256:action.responseSha256,roomIdHash:request.roomIdHash,gestureEpochMs,requestStartedEpochMs:request.requestStartedEpochMs,responseFinishedEpochMs:action.responseFinishedEpochMs};result.baseline={frameIndices:baseline.indices.slice(-2),roi:pixelRoi};result.firstFeedbackFrame={index:first.index,pngSha256:first.pngSha256,metadataEpochMs:first.metadataEpochMs};result.capturedContentVerified=true;result.decoder=structuredClone(decoder.pin);
  const implementation=assertVisibleFeedbackImplementation(capture.implementation,capture.webviewVersion);assert.ok(rows.every(r=>r.metadata.monotonicTimestamp===undefined),'ARENA_FEEDBACK_PROVIDER_METADATA_CHANGED');result.timestampSemantics=implementation.timestampSemantics;result.providerVersion=capture.webviewVersion;const upper=first.metadataEpochMs-gestureEpochMs;assert.ok(upper>0&&upper<=VISIBLE_FEEDBACK_LIMITS.maxDurationMs);result.latencyMs=upper;result.latencyIntervalMs={lowerExclusive:0,upperInclusive:upper};result.captureStatus=result.status=upper<=100?'pass':'insufficient';result.passed=result.status==='pass';if(!result.passed)result.reasons.push('Captured pending-content receipt upper bound exceeds 100 ms; this does not prove a slow physical display');
 }catch(error){result.reasons.push(error.message);}return result;
}
