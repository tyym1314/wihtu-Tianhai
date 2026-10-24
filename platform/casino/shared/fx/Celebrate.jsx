import React,{useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {t} from '../i18n.mjs';
import {full} from '../useRound.js';
import {haptic} from '../client.mjs';
import {burst,rain,fireworks,toScreen} from './particles.js';
import {themeOf} from './themes.js';

/**
 * Win tiers by win / stake. Presentation only: amounts come from the server.
 * NICE 1x and GREAT 3x everywhere; BIG / MEGA / EPIC / LEGENDARY by the game's volatility (operator decision
 * 2026-10-21) so every game reaches the whole ladder at a similar rate.
 */
const GROUPS={low:[6,12,20,30],mid:[10,20,40,70],high:[10,25,50,100]};
const GAME_GROUP={slot777:'low',worldgoal:'low',cleopatraslot:'mid',mahjongslot:'mid',yummy:'mid',pyramidslots:'mid',magicslot:'mid',
 sphinxlegend:'mid',jackpotslots:'mid',crazygems:'mid',oceanslot:'mid',djlive:'mid',nights1001:'high',chillislot:'high',olympus:'high'};
export function thresholdsFor(id){const [big,mega,epic,legendary]=GROUPS[GAME_GROUP[id]||'high'];return {nice:1,great:3,big,mega,epic,legendary};}
const ORDER=['small','nice','great','big','mega','epic','legendary'];
export function tierOf(x,th){if(x>=th.legendary)return 'legendary';if(x>=th.epic)return 'epic';if(x>=th.mega)return 'mega';if(x>=th.big)return 'big';if(x>=th.great)return 'great';if(x>=th.nice)return 'nice';return 'small';}
const HOLD={big:4000,mega:6000,epic:8000,legendary:10000};
const STING={big:'sting-big',mega:'sting-mega',epic:'sting-epic',legendary:'sting-legend'};
const BUZZ={big:'heavy',mega:'heavy',epic:'heavy',legendary:'celebrate'};
const LABEL={nice:'niceWin',great:'greatWin',big:'bigWin',mega:'megaWin',epic:'epicWin',legendary:'legendaryWin'};
const art=n=>`/casino/fx/${n}.webp?v=${__ASSET_VERSION__}`;
// Preloaded title images, kept referenced so the WebView keeps them decoded.
const TITLES={};
/** The lite title bar stays invisible until its title image has loaded, then slides in once: no first-frame jump. */
function LiteBar({src,alt,run,width,value}){
 const [ready,setReady]=useState(false);
 return <div className={`cs-lite-bar ${ready?'ready':''}`}><img src={src} alt={alt} ref={i=>{if(i?.complete&&i.naturalWidth&&!ready)setReady(true);}} onLoad={()=>setReady(true)} onError={()=>setReady(true)}/>
  <em key={run} className="cs-lite-amount" style={{minWidth:`${width}ch`}}>{value}</em></div>;
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const easeOut=p=>1-Math.pow(1-p,3);
function stageFx(cls,ms){const el=document.querySelector('.cs-stage-root');if(!el)return;el.classList.remove(cls);void el.offsetWidth;el.classList.add(cls);setTimeout(()=>el.classList.remove(cls),ms);}
const BOLT=()=>{let x=50+Math.random()*40-20,y=0,pts=[`${x},0`];while(y<100){y+=8+Math.random()*10;x+=Math.random()*16-8;pts.push(`${x.toFixed(1)},${Math.min(100,y).toFixed(1)}`);}return pts.join(' ');};

/**
 * useCelebration(id, audio) -> {celebrate(total, stake, {at, fast}), node}
 * Each tier has its own scene: SMALL amount flying into the WIN box, NICE platinum badge, GREAT winged plaque,
 * BIG vault doors, MEGA neon shockwave, EPIC thunderstorm, LEGENDARY burning frame and crown. BIG+ show the final
 * tier's scene directly while the amount rolls up. Tap skips to the final amount.
 */
export function useCelebration(id,audio){
 const [show,setShow]=useState(null),[pops,setPops]=useState([]),skip=useRef(null),theme=themeOf(id),th=thresholdsFor(id);
 // Celebration art loads while the player is idle, one file at a time; on a slow or data-saving connection only
 // when a celebration needs it.
 useEffect(()=>{const c=navigator.connection,slow=c&&(c.saveData||/(^|-)2g|3g/.test(c.effectiveType||''));if(slow)return;let stop=false;
  const tm=setTimeout(async()=>{for(const n of ['title-nice','title-great','great-banner','title-big','vault-door','title-mega','title-epic','title-legendary','crown','fire-frame']){if(stop)return;const i=new Image();i.src=art(n);await i.decode().catch(()=>{});}},6000);
  return()=>{stop=true;clearTimeout(tm);};},[]);
 const liteRun=useRef(0);
 // Title art is decoded before the first win, so the lite bar never lays out without it and jumps.
 useEffect(()=>{for(const k of ['great','big','mega','epic','legendary'])if(!TITLES[k]){const i=new Image();i.src=art('title-'+k);i.decode?.().catch(()=>{});TITLES[k]=i;}},[]);
 /**
  * Real-time games (arcade, crash): the same tiers without blocking the play. No dimming, no click capture: a title
  * bar at the top with the rolling amount, coins from the catch and an edge glow per tier; a newer win replaces it.
  */
 async function celebrateLite(win,bet,tier,sx,sy){
  const run=++liteRun.current,ms={great:1500,big:2000,mega:2500,epic:3000,legendary:3500}[tier],roll=ms*0.6;
  setShow(s=>({kind:'lite',tier,value:0,run,width:full(win).length,again:s?.kind==='lite'}));audio.play(tier==='great'?'stamp':STING[tier],{volume:.7});haptic(tier==='great'?'medium':BUZZ[tier]);
  burst({kind:'coins',x:sx,y:sy,count:tier==='great'?24:40,theme});burst({kind:'sparks',x:sx,y:sy,count:30,theme});
  if(tier!=='great')burst({kind:'confetti',x:innerWidth/2,y:innerHeight*0.12,count:tier==='big'?30:60,theme});
  const t0=performance.now();
  while(liteRun.current===run){const q=Math.min(1,(performance.now()-t0)/roll);setShow(s=>s&&s.run===run?{...s,value:Math.round(win*easeOut(q))}:s);if(q>=1)break;await sleep(33);}
  if(liteRun.current!==run)return;setShow(s=>s&&s.run===run?{...s,value:win,done:true}:s);audio.play('roll-end',{volume:.6});
  await sleep(ms-roll);if(liteRun.current===run)setShow(null);
 }
 // within: ms until the next round opens (round games); the show is shortened to end 1 s before it.
 async function celebrate(total,stake,{at,from,fast=false,lite=false,within}={}){
  const win=Number(total),bet=Number(stake);if(!(win>0)||!(bet>0))return;
  const x=win/bet,tier=tierOf(x,th),speed=fast?0.5:1;
  const [sx,sy]=at?toScreen(at[0],at[1]):[innerWidth/2,innerHeight*0.62];
  if(lite&&ORDER.indexOf(tier)>=2)return celebrateLite(win,bet,tier,sx,sy);
  // SMALL: the amount rises from the reels as a big gold number and flies into the WIN box, which flashes.
  // No banner: a win below the stake is not dressed up as a big moment.
  if(tier==='small'){
   const [fx0,fy0]=from?toScreen(from[0],from[1]):[innerWidth/2,innerHeight*0.45],fly=fast?420:620;
   const p={id:Math.random(),x0:fx0,y0:fy0,x1:sx,y1:sy,v:win,ms:fly};setPops(a=>[...a,p]);audio.play('ding',{volume:.7});haptic('tick');
   burst({kind:'sparks',x:fx0,y:fy0,count:16,size:.9,theme});
   const t0=performance.now();const trail=setInterval(()=>{const q=Math.min(1,(performance.now()-t0-250)/fly);if(q<0)return;const e=q*q*(3-2*q),x=fx0+(sx-fx0)*e,y=fy0+(sy-fy0)*e-Math.sin(Math.PI*e)*innerHeight*0.08;burst({kind:'sparks',x,y,count:3,size:.7,theme});},40);
   await sleep(250+fly);clearInterval(trail);audio.play('coin',{volume:.6});burst({kind:'coins',x:sx,y:sy,count:12,size:.8,theme});burst({kind:'sparks',x:sx,y:sy,count:18,theme});
   await sleep(fast?150:300);setPops(a=>a.filter(q=>q.id!==p.id));return;
  }
  // NICE: a platinum badge pops above the reels (glass plate, light sweep, twinkling stars), amount rolls under it.
  if(tier==='nice'){
   const total=fast?2000:2800,ms=fast?900:1300;setShow({kind:'nice',value:0});audio.play('nice',{volume:.9});haptic('light');
   setTimeout(()=>{const [cx,cy]=[innerWidth/2,innerHeight*0.6];burst({kind:'sparks',x:cx,y:cy,count:26,theme:{...theme,spark:['#ffffff','#bfe9ff','#7fd4ff']}});burst({kind:'coins',x:sx,y:sy,count:16,theme});},180);
   const t0=performance.now();while(true){const p=Math.min(1,(performance.now()-t0)/ms);setShow(s=>s&&{...s,value:Math.round(win*easeOut(p))});if(p>=1)break;await sleep(33);}
   setShow(s=>s&&{...s,done:true});await sleep(total-ms-280);setShow(s=>s&&{...s,leaving:true});await sleep(280);setShow(null);return;
  }
  audio.duck(tier==='great'?0.5:0.25);
  try{
   // GREAT: a gold stamp slams onto the screen, dust ring, coins burst, amount rolls.
   if(tier==='great'){
    const room=within===undefined?Infinity:Math.max(900,within-1000),k=Math.min(1,room/((fast?1500:2200)+(fast?1000:1300)));
    const ms=(fast?1500:2200)*k;setShow({kind:'great',value:0});audio.play('stamp');setTimeout(()=>audio.play('nice',{volume:.5,rate:.8}),120);
    setTimeout(()=>{stageFx('cs-shake',450);haptic('medium');burst({kind:'sparks',x:innerWidth/2,y:innerHeight*0.42,count:40,theme});burst({kind:'confetti',x:innerWidth/2,y:innerHeight*0.42,count:30,theme});},200);
    const fountain=setInterval(()=>{burst({kind:'coins',x:innerWidth*0.08,y:innerHeight,angle:[-88,-78],speed:13,count:3,theme});burst({kind:'coins',x:innerWidth*0.92,y:innerHeight,angle:[-102,-92],speed:13,count:3,theme});},150);setTimeout(()=>clearInterval(fountain),ms);const roll=await audio.loop('rollup',{volume:.5});
    let skipped=false;skip.current=()=>{skipped=true;};const t0=performance.now();
    while(!skipped){const p=Math.min(1,(performance.now()-t0)/ms);setShow(s=>({...s,value:Math.round(win*easeOut(p))}));if(p>=1)break;await sleep(33);}
    roll.stop();setShow(s=>({...s,value:win,done:true}));audio.play('roll-end',{volume:.9});burst({kind:'sparks',x:innerWidth/2,y:innerHeight*0.42,count:30,theme});
    await sleep(skipped?600:(fast?1000:1300)*k);return;
   }
   // BIG and above: straight into the final tier's scene (operator decision 2026-10-22: no step-by-step upgrades);
   // the amount rolls from 0 to the win, then holds.
   const room=within===undefined?Infinity:Math.max(1200,within-1000),sp=Math.min(fast?0.7:1,room/HOLD[tier]),rollMs=(HOLD[tier]-1500)*sp;
   const loop=audio.loop('celebrate-loop',{volume:.5});
   setShow({kind:'full',tier,flash:1,charging:false,bolts:tier==='epic'?1:0,value:0});audio.play(STING[tier]);haptic(BUZZ[tier]);
   if(tier==='big'){stageFx('cs-shake',450);fireworks({ms:HOLD.big*sp,every:700,theme});}
   if(tier==='mega'){stageFx('cs-punch',520);for(const k of [0,350,700,1400,2100]){setTimeout(()=>{burst({kind:'confetti',x:0,y:innerHeight,angle:[-80,-45],speed:22,count:60,theme});burst({kind:'confetti',x:innerWidth,y:innerHeight,angle:[-135,-100],speed:22,count:60,theme});},k);}fireworks({ms:HOLD.mega*sp,every:600,theme});}
   if(tier==='epic'){stageFx('cs-shake-hard',600);rain({kind:'gem',ms:rollMs,rate:22,theme});fireworks({ms:HOLD.epic*sp,every:500,theme});}
   if(tier==='legendary'){stageFx('cs-shake-hard',600);loop.stop(400);rain({kind:'coins',ms:HOLD.legendary*sp,rate:26,size:.95,theme});fireworks({ms:HOLD.legendary*sp,every:420,theme});}
   const gush=setInterval(()=>burst({kind:'coins',x:innerWidth/2+(Math.random()-.5)*innerWidth*0.6,y:innerHeight+10,angle:[-105,-75],speed:19,count:5,theme}),260);
   const roll=audio.loop('rollup',{volume:.55});
   let skipped=false;skip.current=()=>{skipped=true;};
   try{const t0=performance.now();while(!skipped){const q=Math.min(1,(performance.now()-t0)/rollMs);setShow(s=>({...s,value:Math.round(win*easeOut(q))}));if(q>=1)break;await sleep(33);}}
   finally{clearInterval(gush);roll.stop();}
   setShow(s=>({...s,value:win,done:true}));audio.play('roll-end');if(ORDER.indexOf(tier)>=4)audio.play('cheer',{volume:.7});haptic('celebrate');
   burst({kind:'coins',x:innerWidth/2,y:innerHeight*0.78,count:40,size:1.1,theme});
   await sleep(skipped?1000:1500*sp);loop.stop(300);
  }finally{skip.current=null;setShow(null);audio.duck(1);}
 }
 // Lightning strikes every 0.7 s during EPIC.
 useEffect(()=>{if(show?.tier!=='epic'||show.done)return;const tm=setInterval(()=>{setShow(s=>s&&s.tier==='epic'?{...s,bolts:(s.bolts||0)+1}:s);haptic('light');},700);return()=>clearInterval(tm);},[show?.tier,show?.done]);
 // Local review only (localhost): window.__oasisFx(total, stake) plays a celebration without a real win.
 if(typeof location!=='undefined'&&/^(localhost|127\.0\.0\.1)$/.test(location.hostname))window.__oasisFx=(w,b,o)=>celebrate(w,b,o);
 const st=typeof document!=='undefined'&&document.querySelector('.cs-stage'),sc=st?st.getBoundingClientRect().width/st.offsetWidth:1;
 let layer=null;
 if(show?.kind==='lite')layer=<div className={`cs-lite ${show.tier} ${show.done?'done':''}`}><i className="cs-lite-edge"/>
  <LiteBar src={art('title-'+show.tier)} alt={t(LABEL[show.tier])} run={show.run} width={show.width} value={full(show.value)}/></div>;
 if(show?.kind==='nice')layer=<div className={`cs-nice ${show.done?'done':''} ${show.leaving?'leaving':''}`}>
  <div className="cs-nice-plate"><i className="cs-nice-sweep"/>{[0,1,2,3,4,5].map(i=><i key={i} className="cs-star" style={{'--i':i}}/>)}
   <img className="cs-nice-title" src={art('title-nice')} alt={t('niceWin')}/><em>{full(show.value)}</em></div></div>;
 else if(show?.kind==='great')layer=<div className={`cs-great ${show.done?'done':''}`} onClick={()=>skip.current?.()}>
  <i className="cs-great-dim"/><i className="cs-great-rays"/><i className="cs-dust"/>
  <div className="cs-great-box"><img className="cs-great-title" src={art('title-great')} alt={t('greatWin')}/>
   <div className="cs-great-plaque"><img className="cs-great-banner" src={art('great-banner')} alt=""/><em>{full(show.value)}</em></div></div></div>;
 else if(show?.kind==='full')layer=<div className={`cs-win full ${show.tier} ${show.done?'done':''} ${show.charging?'charging':''}`} onClick={()=>skip.current?.()}>
  <i className="cs-win-bg"/>
  {show.tier==='big'&&<><i className="cs-vault l" style={{backgroundImage:`url(${art('vault-door')})`}}/><i className="cs-vault r" style={{backgroundImage:`url(${art('vault-door')})`}}/></>}
  <i className="cs-win-rays"/>{show.tier==='mega'&&<i className="cs-win-rays two"/>}
  {show.tier==='epic'&&<svg key={show.bolts} className="cs-bolts" viewBox="0 0 100 100" preserveAspectRatio="none"><polyline points={BOLT()}/><polyline className="thin" points={BOLT()}/></svg>}
  {show.tier==='legendary'&&<><i className="cs-fire" style={{backgroundImage:`url(${art('fire-frame')})`}}/><img className="cs-crown" src={art('crown')} alt=""/></>}
  {show.flash>0&&<i key={'f'+show.flash} className="cs-flash"/>}{show.flash>0&&<i key={'w'+show.flash} className="cs-wave"/>}
  <div className="cs-win-box">
   <img key={show.tier} className="cs-title" src={art('title-'+show.tier)} alt={t(LABEL[show.tier])}/>
   <em className="cs-win-amount">{full(show.value)}</em>
   {!show.done&&<small className="cs-win-skip">{t('tapToSkip')}</small>}
  </div>
 </div>;
 const node=(layer||pops.length>0)&&createPortal(<>
  {layer&&React.cloneElement(layer,{style:{'--s':sc}})}
  {pops.map(p=><b key={p.id} className="cs-fly-amt" style={{left:p.x0,top:p.y0,'--dx':`${p.x1-p.x0}px`,'--dy':`${p.y1-p.y0}px`,'--ms':`${p.ms}ms`,'--s':sc}}>+{full(p.v)}</b>)}
  {pops.map(p=><i key={'r'+p.id} className="cs-winbox-flash" style={{left:p.x1,top:p.y1,'--s':sc,animationDelay:`${250+p.ms}ms`}}/>)}
 </>,document.body);
 return {celebrate,node};
}
