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
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const easeOut=p=>1-Math.pow(1-p,3);
function stageFx(cls,ms){const el=document.querySelector('.cs-stage-root');if(!el)return;el.classList.remove(cls);void el.offsetWidth;el.classList.add(cls);setTimeout(()=>el.classList.remove(cls),ms);}
const BOLT=()=>{let x=50+Math.random()*40-20,y=0,pts=[`${x},0`];while(y<100){y+=8+Math.random()*10;x+=Math.random()*16-8;pts.push(`${x.toFixed(1)},${Math.min(100,y).toFixed(1)}`);}return pts.join(' ');};

/**
 * useCelebration(id, audio) -> {celebrate(total, stake, {at, fast}), node}
 * Each tier has its own scene: SMALL number pop, NICE silver ribbon, GREAT gold stamp, BIG vault doors, MEGA neon
 * shockwave, EPIC thunderstorm, LEGENDARY burning frame and crown. BIG+ roll up from BIG and break into each next
 * tier (charge, then flash and the new scene). Tap skips to the final tier and amount.
 */
export function useCelebration(id,audio){
 const [show,setShow]=useState(null),[pops,setPops]=useState([]),skip=useRef(null),theme=themeOf(id),th=thresholdsFor(id);
 useEffect(()=>{for(const n of ['title-nice','title-big','title-mega','title-epic','title-legendary','vault-door','crown','fire-frame']){const i=new Image();i.src=art(n);}},[]);
 async function celebrate(total,stake,{at,fast=false}={}){
  const win=Number(total),bet=Number(stake);if(!(win>0)||!(bet>0))return;
  const x=win/bet,tier=tierOf(x,th),speed=fast?0.5:1;
  const [sx,sy]=at?toScreen(at[0],at[1]):[innerWidth/2,innerHeight*0.62];
  // SMALL: the amount pops where it is shown; no banner (a win below the stake is not dressed up as a big moment).
  if(tier==='small'){
   const p={id:Math.random(),x:sx,y:sy,v:win};setPops(a=>[...a,p]);setTimeout(()=>setPops(a=>a.filter(q=>q.id!==p.id)),900);
   audio.play('ding',{volume:.7});burst({kind:'sparks',x:sx,y:sy,count:12,size:.8,theme});haptic('tick');await sleep(400*speed);return;
  }
  // NICE: a platinum badge pops above the reels (glass plate, light sweep, twinkling stars), amount rolls under it.
  if(tier==='nice'){
   const total=fast?1200:1800,ms=Math.min(900,total*0.5);setShow({kind:'nice',value:0});audio.play('nice',{volume:.9});haptic('light');
   setTimeout(()=>{const [cx,cy]=[innerWidth/2,innerHeight*0.42];burst({kind:'sparks',x:cx,y:cy,count:26,theme:{...theme,spark:['#ffffff','#bfe9ff','#7fd4ff']}});burst({kind:'coins',x:sx,y:sy,count:16,theme});},180);
   const t0=performance.now();while(true){const p=Math.min(1,(performance.now()-t0)/ms);setShow(s=>s&&{...s,value:Math.round(win*easeOut(p))});if(p>=1)break;await sleep(33);}
   setShow(s=>s&&{...s,done:true});await sleep(total-ms-280);setShow(s=>s&&{...s,leaving:true});await sleep(280);setShow(null);return;
  }
  audio.duck(tier==='great'?0.5:0.25);
  try{
   // GREAT: a gold stamp slams onto the screen, dust ring, coins burst, amount rolls.
   if(tier==='great'){
    const ms=Math.max(900,1500*speed);setShow({kind:'great',value:0});audio.play('stamp');
    setTimeout(()=>{stageFx('cs-shake',450);haptic('medium');burst({kind:'coins',x:innerWidth/2,y:innerHeight*0.45,count:36,theme});burst({kind:'sparks',x:innerWidth/2,y:innerHeight*0.45,count:30,theme});},170);
    rain({kind:'coins',ms,rate:14,size:.85,theme});const roll=await audio.loop('rollup',{volume:.5});
    let skipped=false;skip.current=()=>{skipped=true;};const t0=performance.now();
    while(!skipped){const p=Math.min(1,(performance.now()-t0)/ms);setShow(s=>({...s,value:Math.round(win*easeOut(p))}));if(p>=1)break;await sleep(33);}
    roll.stop();setShow(s=>({...s,value:win,done:true}));audio.play('roll-end',{volume:.9});
    await sleep(skipped?450:Math.max(600,700*speed));return;
   }
   // BIG and above: one roll-up through the tiers, breaking into each next scene.
   const steps=ORDER.slice(3,ORDER.indexOf(tier)+1).map(n=>({tier:n,from:th[n]*bet}));
   const ends=steps.map((s,i)=>i+1<steps.length?steps[i+1].from:win);
   const rollMs=(HOLD[tier]-1500)*speed,segMs=rollMs/(steps.length+0.5);
   const loop=await audio.loop('celebrate-loop',{volume:.5});
   const enter=(n,first)=>{
    setShow(s=>({...(s||{}),kind:'full',tier:n,flash:(s?.flash||0)+(first?0:1),charging:false,bolts:n==='epic'?1:0}));
    audio.play(STING[n]);haptic(BUZZ[n]);
    if(n==='big'){stageFx('cs-shake',450);fireworks({ms:HOLD[tier]*speed,every:700,theme});}
    if(n==='mega'){stageFx('cs-punch',520);for(const k of [0,350,700]){setTimeout(()=>{burst({kind:'confetti',x:0,y:innerHeight,angle:[-80,-45],speed:22,count:60,theme});burst({kind:'confetti',x:innerWidth,y:innerHeight,angle:[-135,-100],speed:22,count:60,theme});},k);}}
    if(n==='epic'){stageFx('cs-shake-hard',600);rain({kind:'gem',ms:rollMs,rate:22,theme});}
    if(n==='legendary'){stageFx('cs-shake-hard',600);loop.stop(400);rain({kind:'coins',ms:HOLD.legendary*speed,rate:26,size:.95,theme});fireworks({ms:HOLD.legendary*speed,every:420,theme});}
   };
   enter('big',true);
   // coins gush up from the bottom while it rolls
   const gush=setInterval(()=>burst({kind:'coins',x:innerWidth/2+(Math.random()-.5)*innerWidth*0.6,y:innerHeight+10,angle:[-105,-75],speed:19,count:5,theme}),260);
   const roll=await audio.loop('rollup',{volume:.55});
   let skipped=false;skip.current=()=>{skipped=true;};let from=0;
   try{
    for(const [i,step] of steps.entries()){
     if(skipped)break;
     if(i>0){enter(step.tier);roll.rate(1+i*0.12);}
     const to=ends[i],ms=i===0?segMs*1.5:segMs,last=i===steps.length-1,t0=performance.now();let charged=false;
     while(!skipped){
      const e=performance.now()-t0,p=Math.min(1,e/ms);setShow(s=>({...s,value:Math.round(from+(to-from)*easeOut(p))}));
      // Charge just before the next threshold: the number slows, the edges glow, a riser builds.
      if(!last&&!charged&&e>ms-650){charged=true;setShow(s=>({...s,charging:true}));audio.play('charge',{volume:.8});}
      if(p>=1)break;await sleep(33);
     }
     from=to;
    }
   }finally{clearInterval(gush);roll.stop();}
   if(skipped){setShow(s=>({...s,tier,flash:(s.flash||0)+1,charging:false,bolts:tier==='epic'?1:0}));audio.play(STING[tier]);stageFx('cs-shake-hard',600);}
   setShow(s=>({...s,value:win,done:true,charging:false}));audio.play('roll-end');if(ORDER.indexOf(tier)>=4)audio.play('cheer',{volume:.7});haptic('celebrate');
   burst({kind:'coins',x:innerWidth/2,y:innerHeight*0.78,count:40,size:1.1,theme});
   await sleep(skipped?1000:1500*speed);loop.stop(300);
  }finally{skip.current=null;setShow(null);audio.duck(1);}
 }
 // Lightning strikes every 0.7 s during EPIC.
 useEffect(()=>{if(show?.tier!=='epic'||show.done)return;const tm=setInterval(()=>{setShow(s=>s&&s.tier==='epic'?{...s,bolts:(s.bolts||0)+1}:s);haptic('light');},700);return()=>clearInterval(tm);},[show?.tier,show?.done]);
 // Local review only (localhost): window.__oasisFx(total, stake) plays a celebration without a real win.
 if(typeof location!=='undefined'&&/^(localhost|127\.0\.0\.1)$/.test(location.hostname))window.__oasisFx=(w,b,o)=>celebrate(w,b,o);
 const st=typeof document!=='undefined'&&document.querySelector('.cs-stage'),sc=st?st.getBoundingClientRect().width/st.offsetWidth:1;
 let layer=null;
 if(show?.kind==='nice')layer=<div className={`cs-nice ${show.done?'done':''} ${show.leaving?'leaving':''}`}>
  <div className="cs-nice-plate"><i className="cs-nice-sweep"/>{[0,1,2,3,4,5].map(i=><i key={i} className="cs-star" style={{'--i':i}}/>)}
   <img className="cs-nice-title" src={art('title-nice')} alt={t('niceWin')}/><em>{full(show.value)}</em></div></div>;
 else if(show?.kind==='great')layer=<div className={`cs-win banner great ${show.done?'done':''}`} onClick={()=>skip.current?.()}>
  <i className="cs-dust"/><div className="cs-win-box"><b className="cs-stamp">{t('greatWin')}</b><em className="cs-win-amount">{full(show.value)}</em></div></div>;
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
  {pops.map(p=><b key={p.id} className="cs-pop-amt" style={{left:p.x,top:p.y,'--s':sc}}>+{full(p.v)}</b>)}
 </>,document.body);
 return {celebrate,node};
}
