import React,{useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {t} from '../i18n.mjs';
import {full} from '../useRound.js';
import {haptic} from '../client.mjs';
import {burst,rain,fireworks,toScreen} from './particles.js';
import {themeOf} from './themes.js';

/**
 * Win tiers by win / stake (operator decision 2026-10-20). Presentation only: amounts come from the server.
 * small < 1x, nice 1-3x, great 3-10x, big 10-25x, mega 25-50x, epic 50-100x, legendary >= 100x.
 */
export const TIERS=[['small',0],['nice',1],['great',3],['big',10],['mega',25],['epic',50],['legendary',100]];
export const tierOf=x=>[...TIERS].reverse().find(([,m])=>x>=m)?.[0]||'small';
const LABEL={nice:'niceWin',great:'greatWin',big:'bigWin',mega:'megaWin',epic:'epicWin',legendary:'legendaryWin'};
const HOLD_MS={big:4000,mega:6000,epic:8000,legendary:10000};
const STINGER={great:'sting-great',big:'sting-big',mega:'sting-mega',epic:'sting-epic',legendary:'sting-epic'};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const ease=p=>1-(1-p)*(1-p);

function shake(strength){
 const el=document.querySelector('.cs-stage-root');if(!el)return;
 el.classList.remove('cs-shake','cs-shake-hard');void el.offsetWidth;el.classList.add(strength>1?'cs-shake-hard':'cs-shake');
 setTimeout(()=>el.classList.remove('cs-shake','cs-shake-hard'),650);
}

/**
 * useCelebration(id, audio): returns {celebrate(total, stake, {at, fast}), node}.
 * celebrate() resolves when the presentation is over (tap skips to the final amount).
 * `at` = [x, y] design pixel where small wins burst (usually the win display).
 */
export function useCelebration(id,audio){
 const [show,setShow]=useState(null),skip=useRef(null),theme=themeOf(id);
 async function celebrate(total,stake,{at,fast=false}={}){
  const win=Number(total),bet=Number(stake);if(!(win>0)||!(bet>0))return;
  const x=win/bet,tier=tierOf(x),speed=fast?0.5:1;
  const [sx,sy]=at?toScreen(at[0],at[1]):[innerWidth/2,innerHeight*0.62];
  if(tier==='small'){audio.play('win-s',{volume:.7});burst({kind:'coins',x:sx,y:sy,count:10,size:.8,theme});haptic('tick');await sleep(250*speed);return;}
  if(tier==='nice'){audio.play('win-m',{volume:.8});burst({kind:'coins',x:sx,y:sy,count:26,theme});burst({kind:'sparks',x:sx,y:sy,count:18,theme});haptic('light');await sleep(650*speed);return;}
  audio.duck(0.3);
  try{
   if(tier==='great'){
    const ms=1600*speed;setShow({tier,label:'great',value:0,banner:true});audio.play('win-l');haptic('medium');
    const roll=await audio.loop('rollup',{volume:.55});rain({kind:'coins',ms,rate:16,size:.85,theme});burst({kind:'sparks',x:innerWidth/2,y:innerHeight*0.45,count:30,theme});
    let skipped=false;skip.current=()=>{skipped=true;};
    const start=performance.now();
    while(!skipped){const p=Math.min(1,(performance.now()-start)/ms);setShow(s=>({...s,value:Math.round(win*ease(p))}));if(p>=1)break;await sleep(33);}
    roll.stop();setShow(s=>({...s,value:win,done:true}));audio.play('roll-end',{volume:.9});
    await sleep(skipped?500:700*speed);return;
   }
   // Full-screen: roll up through each tier threshold, upgrading the banner as each one is crossed.
   const steps=TIERS.filter(([n,m])=>m>=10&&m<=x).map(([n,m])=>({tier:n,from:m*bet}));
   const ends=steps.map((s,i)=>i+1<steps.length?steps[i+1].from:win);
   const rollMs=(HOLD_MS[tier]-1400)*speed,segMs=rollMs/(steps.length+0.6);
   setShow({tier:'big',label:'big',value:0});audio.play(STINGER.big);haptic('heavy');shake(1);
   fireworks({ms:HOLD_MS[tier]*speed,every:tier==='big'?650:380,theme});rain({kind:'coins',ms:rollMs,rate:tier==='big'?18:26,size:.85,theme});
   const roll=await audio.loop('rollup',{volume:.6});
   let skipped=false;skip.current=()=>{skipped=true;};
   let from=0;
   for(const [i,step] of steps.entries()){
    if(skipped)break;
    if(i>0){setShow(s=>({...s,tier:step.tier,label:step.tier}));audio.play(STINGER[step.tier]);haptic('heavy');shake(2);
     burst({kind:'confetti',x:innerWidth/2,y:innerHeight*0.2,count:70,size:1.1,theme});burst({kind:'coins',x:innerWidth/2,y:innerHeight*0.78,count:28,theme});roll.rate(1+i*0.12);}
    const to=ends[i],ms=i===0?segMs*1.6:segMs,start=performance.now();
    while(!skipped){const p=Math.min(1,(performance.now()-start)/ms);setShow(s=>({...s,value:Math.round(from+(to-from)*ease(p))}));if(p>=1)break;await sleep(33);}
    from=to;
   }
   roll.stop();
   if(skipped){setShow(s=>({...s,tier,label:tier}));audio.play(STINGER[tier]);shake(2);}
   setShow(s=>({...s,value:win,done:true}));audio.play('roll-end');haptic('celebrate');
   burst({kind:'coins',x:innerWidth/2,y:innerHeight*0.78,count:40,size:1.1,theme});
   await sleep(skipped?900:1400*speed);
  }finally{skip.current=null;setShow(null);audio.duck(1);}
 }
 // Local review only (localhost): window.__oasisFx(total, stake) plays a celebration without a real win.
 if(typeof location!=='undefined'&&/^(localhost|127\.0\.0\.1)$/.test(location.hostname))window.__oasisFx=(w,b,o)=>celebrate(w,b,o);
 // Full-screen layer outside the (clipped) stage; contents scale with the stage like the rest of the game.
 const st=typeof document!=='undefined'&&document.querySelector('.cs-stage'),sc=st?st.getBoundingClientRect().width/st.offsetWidth:1;
 const node=show&&createPortal(<div className={`cs-win ${show.banner?'banner':'full'} ${show.tier} ${show.done?'done':''}`} style={{'--s':sc}} onClick={()=>skip.current?.()}>
  {!show.banner&&<i className="cs-win-rays"/>}
  <div className="cs-win-box">
   <b key={show.label} className="cs-win-label">{t(LABEL[show.label])}</b>
   <em className="cs-win-amount">{full(show.value)}</em>
   {!show.banner&&!show.done&&<small className="cs-win-skip">{t('tapToSkip')}</small>}
  </div>
 </div>,document.body);
 return {celebrate,node};
}
