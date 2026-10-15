import React,{useCallback,useEffect,useRef,useState} from 'react';
import {api,requestId,registerHostControls,requestExit} from '../../shared/client.mjs';
import {t,isRtl} from '../../shared/i18n.mjs';
import {CASINO_GAMES} from '../../../shared/casino-games.mjs';
import './lionfeast.css';

const GAME=CASINO_GAMES.lionfeast;
// Clockwise from the top socket; vegetables and dishes alternate around the ring.
const ORDER=['tomato','shrimp','corn','fish','carrot','steak','lettuce','chicken'];
const MULT=Object.fromEntries(GAME.options.map(o=>[o.id,o.multiplier]));
const img=n=>`/casino/lionfeast/${n}.webp`;
const short=minor=>{const v=Number(minor||0)/100;const f=(n,s)=>`${Number.isInteger(n)?n:n.toFixed(1)}${s}`;return v>=1e6?f(v/1e6,'M'):v>=1e3?f(v/1e3,'K'):String(Math.floor(v));};
const full=minor=>new Intl.NumberFormat('en-US').format(Math.floor(Number(minor||0)/100));
const ERRORS={INSUFFICIENT_FUNDS:'insufficient',BETTING_CLOSED:'closed',ROUND_STAKE_LIMIT:'limit'};

function phaseOf(round,now){if(!round)return'betting';if(now<round.bet_until)return'betting';if(now<round.reveal_at)return'drawing';return'result';}

export default function LionFeast({initial}){
 const [state,setState]=useState(initial),[balance,setBalance]=useState(initial.balance?.available_minor??null);
 const [chip,setChip]=useState(GAME.chips[1]),[toast,setToast]=useState(null),[modal,setModal]=useState(false),[offline,setOffline]=useState(false);
 const [now,setNow]=useState(Date.now()),[light,setLight]=useState(-1),[pending,setPending]=useState({});
 const offset=useRef(initial.server_now-Date.now()),lastBets=useRef([]),roundRef=useRef(initial.round.id),balanceRound=useRef(null);
 const serverNow=()=>Date.now()+offset.current;
 const round=state.round,phase=phaseOf(round,now);

 const say=useCallback(key=>{setToast({key,id:Math.random()});},[]);
 const refresh=useCallback(async(withBalance=false)=>{
  try{
   const s=await api(`/api/casino/state${withBalance?'?balance=1':''}`);offset.current=s.server_now-Date.now();setOffline(false);
   if(s.round.id!==roundRef.current){
    // New round: remember what I bet last round for "Repeat".
    setState(prev=>{if(prev.my_bets.length)lastBets.current=prev.my_bets.filter(b=>['ACCEPTED','SETTLING','SETTLED'].includes(b.status)).map(b=>({option_id:b.option_id,stake_minor:b.stake_minor}));return s;});
    roundRef.current=s.round.id;setPending({});
   }else setState(s);
   if(s.balance)setBalance(s.balance.available_minor);
  }catch{setOffline(true);}
 },[]);

 // Poll faster around phase changes; fetch the settled balance once per round after the reveal.
 useEffect(()=>{let stop=false,timer;
  const loop=async()=>{const n=serverNow(),r=roundRef.current&&state.round;
   const reveal=r&&n>=r.reveal_at&&balanceRound.current!==r.id;if(reveal)balanceRound.current=r.id;
   await refresh(reveal);if(stop)return;
   const s=state.round,next=[s.bet_until,s.reveal_at,s.ends_at].map(x=>x-serverNow()).filter(x=>x>0);
   timer=setTimeout(loop,Math.max(250,Math.min(1000,...next.map(x=>x+60))));};
  timer=setTimeout(loop,800);return()=>{stop=true;clearTimeout(timer);};
 },[refresh,state.round]);

 // Frame clock for countdowns and the travelling light.
 useEffect(()=>{let raf;const tick=()=>{const n=serverNow();setNow(n);
   const r=state.round;
   if(r.result&&n>=r.bet_until){
    const target=ORDER.indexOf(r.result.outcome),special=target<0,end=r.reveal_at-450;
    const steps=special?4*ORDER.length:3*ORDER.length+target,p=Math.min(1,Math.max(0,(n-r.bet_until)/(end-r.bet_until)));
    const step=Math.floor((1-(1-p)**3)*steps);setLight(n>=end?(special?-2:target):step%ORDER.length);
   }else if(n<r.bet_until)setLight(-1);
   raf=requestAnimationFrame(tick);};
  raf=requestAnimationFrame(tick);return()=>cancelAnimationFrame(raf);
 },[state.round]);

 useEffect(()=>registerHostControls({onBack:()=>requestExit()}),[]);

 const mine={},totals=state.totals||{};
 for(const b of state.my_bets)if(!['REJECTED','VOIDED','VOIDING'].includes(b.status))mine[b.option_id]=(mine[b.option_id]||0n)+BigInt(b.stake_minor);
 for(const [o,v] of Object.entries(pending))mine[o]=(mine[o]||0n)+v;

 async function bet(option,stake=chip){
  if(phaseOf(round,serverNow())!=='betting'){say('closed');return;}
  const used=new Set([...Object.keys(mine)]);if(!used.has(option)&&used.size>=GAME.maxOptionsPerRound){say('tooMany');return;}
  if(balance!==null&&BigInt(balance)<BigInt(stake)){say('insufficient');return;}
  setPending(p=>({...p,[option]:(p[option]||0n)+BigInt(stake)}));
  if(balance!==null)setBalance(b=>String(BigInt(b)-BigInt(stake)));
  try{
   const placed=await api('/api/casino/bets',{request_id:requestId(),round_id:round.id,option_id:option,stake_minor:stake});
   setState(s=>s.round.id===round.id?{...s,my_bets:[...s.my_bets,placed]}:s);
  }catch(e){
   if(balance!==null)setBalance(b=>String(BigInt(b)+BigInt(stake)));
   say(e.code==='TOO_MANY_OPTIONS'?'tooMany':ERRORS[e.code]||'failed');
  }finally{setPending(p=>{const v=(p[option]||0n)-BigInt(stake);const n={...p};if(v>0n)n[option]=v;else delete n[option];return n;});}
 }
 async function repeat(){for(const b of lastBets.current)await bet(b.option_id,b.stake_minor);}

 const secs=Math.max(0,Math.ceil((round.bet_until-now)/1000));
 const winners=phase==='result'&&round.result?round.result.winners:[];
 const myWin=phase==='result'?state.my_bets.reduce((a,b)=>a+BigInt(b.payout_minor||0),0n):0n;
 const myStake=state.my_bets.filter(b=>!['REJECTED','VOIDED'].includes(b.status)).reduce((a,b)=>a+BigInt(b.stake_minor),0n);

 return <div className={`lf-root lf-${phase}`} dir={isRtl()?'rtl':'ltr'} style={{backgroundImage:`url(${img('background')})`}}>
  <header className="lf-top">
   <button className="lf-icon" aria-label="Back" onClick={()=>requestExit()}>‹</button>
   <div className="lf-balance"><i/>{balance===null?'—':full(balance)}</div>
   <button className="lf-icon" aria-label={t('rules')} onClick={()=>setModal(true)}>?</button>
  </header>
  <div className="lf-stage">
   <img className="lf-lion" src={img('lion')} alt="" draggable="false"/>
   <div className="lf-wheel">
    <img className="lf-ring" src={img('ring')} alt="" draggable="false"/>
    {ORDER.map((id,i)=>{const a=(-90+i*45)*Math.PI/180,x=50+35.6*Math.cos(a),y=50+35.6*Math.sin(a);
     const cls=['lf-slot',light===i&&'lit',winners.includes(id)&&'win',phase==='result'&&winners.length&&!winners.includes(id)&&'dim',light===-2&&winners.includes(id)&&'lit'].filter(Boolean).join(' ');
     return <button key={id} className={cls} style={{left:`${x}%`,top:`${y}%`}} onClick={()=>bet(id)} aria-label={`${id} x${MULT[id]}`}>
      <img src={img(id)} alt="" draggable="false"/>
      <span className="lf-mult">×{MULT[id]}</span>
      {mine[id]?<span className="lf-mine">{short(mine[id])}</span>:null}
      {totals[id]?<span className="lf-total">{short(totals[id].stake_minor)}</span>:null}
     </button>;})}
    <div className="lf-center">
     {phase==='betting'?<><small>{t('betting')}</small><b className={secs<=5?'urgent':''}>{secs}</b></>
      :phase==='drawing'?<><small>{t('drawing')}</small><b className="spin">★</b></>
      :round.result&&ORDER.includes(round.result.outcome)?<img src={img(round.result.outcome)} alt=""/>:round.result?<img src={img(round.result.outcome)} alt="" className="special"/>:null}
    </div>
   </div>
   {phase==='result'&&round.result&&<div className="lf-banner">
    {!ORDER.includes(round.result.outcome)&&<p className="lf-special">{t(round.result.outcome)}</p>}
    {myWin>0n?<p className="lf-win">{t('youWon')} <b>{full(myWin)}</b></p>:myStake>0n?<p>{t('noWin')}</p>:<p>{t('next')}</p>}
    {state.top_winners.length>0&&<div className="lf-top3"><small>{t('topWinners')}</small>{state.top_winners.map((w,i)=><span key={w.external_user_id}><em>{i+1}</em>{w.external_user_id===state.me?'★':w.external_user_id.slice(0,8)} <b>{short(w.payout_minor)}</b></span>)}</div>}
   </div>}
  </div>
  <div className="lf-history" aria-label={t('history')}>{state.history.slice(0,10).map(h=><img key={h.seq} src={img(h.outcome)} alt={h.outcome}/>)}</div>
  <footer className="lf-controls">
   <div className="lf-chips">{GAME.chips.map((c,i)=><button key={c} className={`lf-chip c${i} ${chip===c?'on':''}`} onClick={()=>setChip(c)}>{short(c)}</button>)}</div>
   <button className="lf-repeat" disabled={phase!=='betting'||!lastBets.current.length} onClick={repeat}>{t('repeat')}</button>
  </footer>
  <div className="lf-round">{t('round',[round.seq])}{myStake>0n?<span> · {t('myBet')} {short(myStake)}</span>:null}</div>
  {offline&&<div className="cs-toast" key="off">{t('offline')}</div>}
  {toast&&<div className="cs-toast" key={toast.id}>{t(toast.key,[GAME.maxOptionsPerRound])}</div>}
  {modal&&<div className="cs-modal-back" onClick={()=>setModal(false)}><div className="cs-modal" onClick={e=>e.stopPropagation()}>
   <h2>{t('rules')}</h2><p>{t('lionRules')}</p><h2>{t('fair')}</h2><p>{t('fairText')}</p><small>commitment: {round.commitment}</small>{round.seed&&<small>seed: {round.seed}</small>}
   <button className="cs-gold-btn" onClick={()=>setModal(false)}>{t('close')}</button></div></div>}
 </div>;
}
