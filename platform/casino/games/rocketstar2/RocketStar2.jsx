import React,{useCallback,useEffect,useRef,useState} from 'react';
import {api,requestId,registerHostControls,requestExit} from '../../shared/client.mjs';
import {t,isRtl} from '../../shared/i18n.mjs';
import {CASINO_GAMES} from '../../../shared/casino-games.mjs';
import './rocketstar2.css';

const GAME=CASINO_GAMES.rocketstar2;
const GROWTH=Math.log(2)/8000;
const multAt=ms=>Math.floor(100*Math.exp(GROWTH*Math.max(0,ms))+1e-9);
const img=n=>`/casino/rocketstar2/${n}.webp`;
const full=minor=>new Intl.NumberFormat('en-US').format(Math.floor(Number(minor||0)/100));
const short=minor=>{const v=Number(minor||0)/100;const f=(n,s)=>`${Number.isInteger(n)?n:n.toFixed(1)}${s}`;return v>=1e6?f(v/1e6,'M'):v>=1e3?f(v/1e3,'K'):String(Math.floor(v));};
const fx=x100=>(x100/100).toFixed(2);
const tone=x100=>x100>=1000?'gold':x100>=200?'green':'red';
const ERR={INSUFFICIENT_FUNDS:'insufficient',BETTING_CLOSED:'closed',OPTION_ALREADY_BET:'already',CRASHED:'crashedErr',ROUND_STAKE_LIMIT:'limit'};
const AUTO_STEPS=[110,120,150,200,300,500,1000,2000,5000,10000];

function phaseOf(round,now){if(now<round.bet_until)return'betting';if(!round.result)return'flying';return'crashed';}

function Flight({round,now,phase}){
 const ref=useRef(null),rocket=useRef(null),boom=useRef(null);
 useEffect(()=>{
  const c=ref.current;if(!c)return;const dpr=Math.min(2,window.devicePixelRatio||1),W=c.clientWidth,H=c.clientHeight;
  if(c.width!==W*dpr){c.width=W*dpr;c.height=H*dpr;}const g=c.getContext('2d');g.setTransform(dpr,0,0,dpr,0,0);g.clearRect(0,0,W,H);
  const flight=phase==='betting'?0:phase==='flying'?now-round.bet_until:Math.log(round.result.crash_x100/100)/GROWTH;
  const tMax=Math.max(10000,flight*1.15),mNow=Math.exp(GROWTH*flight),mMax=Math.max(2,mNow*1.25);
  const X=s=>W*0.07+s/tMax*W*0.82,Y=m=>H*0.9-(m-1)/(mMax-1)*H*0.72;
  // Grid
  g.strokeStyle='#ffffff14';g.lineWidth=1;for(let i=1;i<5;i++){const y=H*0.9-i*H*0.18;g.beginPath();g.moveTo(W*0.07,y);g.lineTo(W*0.95,y);g.stroke();}
  if(phase==='betting'){rocket.current.style.transform=`translate(${X(0)}px,${Y(1)}px) translate(-30%,-70%) rotate(0deg)`;boom.current.style.opacity=0;return;}
  const pts=[];for(let i=0;i<=80;i++){const s=flight*i/80;pts.push([X(s),Y(Math.exp(GROWTH*s))]);}
  const grad=g.createLinearGradient(0,H,W,0);grad.addColorStop(0,'#5ee7ff');grad.addColorStop(1,phase==='crashed'?'#ff4d6d':'#ffd34d');
  g.beginPath();g.moveTo(pts[0][0],H*0.9);pts.forEach(p=>g.lineTo(p[0],p[1]));g.lineTo(pts.at(-1)[0],H*0.9);g.closePath();
  const fill=g.createLinearGradient(0,H*0.2,0,H*0.9);fill.addColorStop(0,phase==='crashed'?'#ff4d6d33':'#ffd34d33');fill.addColorStop(1,'#5ee7ff05');g.fillStyle=fill;g.fill();
  g.beginPath();pts.forEach((p,i)=>i?g.lineTo(p[0],p[1]):g.moveTo(p[0],p[1]));g.strokeStyle=grad;g.lineWidth=4;g.shadowColor='#ffd34d';g.shadowBlur=14;g.stroke();g.shadowBlur=0;
  const [x,y]=pts.at(-1),[px,py]=pts[Math.max(0,pts.length-4)],angle=Math.atan2(py-y,x-px)*180/Math.PI;
  rocket.current.style.transform=`translate(${x}px,${y}px) translate(-50%,-50%) rotate(${45-angle}deg)`;rocket.current.style.opacity=phase==='crashed'?0:1;
  boom.current.style.transform=`translate(${x}px,${y}px) translate(-50%,-50%)`;boom.current.style.opacity=phase==='crashed'?1:0;
 });
 return <div className="rr-flight"><canvas ref={ref}/><img ref={rocket} className="rr-rocket" src={img('rocket')} alt="" draggable="false"/><img ref={boom} className="rr-boom" src={img('explosion')} alt="" draggable="false"/></div>;
}

function Panel({id,state,phase,mult,balance,onBet,onCash}){
 const [stake,setStake]=useState(GAME.chips[0]),[autoOn,setAutoOn]=useState(false),[autoIdx,setAutoIdx]=useState(3);
 const bet=state.my_bets.find(b=>b.option_id===id&&!['REJECTED','VOIDED','VOIDING'].includes(b.status));
 const step=(arr,v,d)=>arr[Math.min(arr.length-1,Math.max(0,arr.indexOf(v)+d))];
 let button;
 if(bet?.cashout_x100)button=<button className="rr-btn done">{t('cashedOut')} {fx(bet.cashout_x100)}x<small>+{full(bet.payout_minor)}</small></button>;
 else if(bet&&phase==='flying'&&bet.status==='ACCEPTED')button=<button className="rr-btn cash" onClick={()=>onCash(bet)}>{t('cashOut')}<small>{full(BigInt(bet.stake_minor)*BigInt(mult)/100n)}</small></button>;
 else if(bet&&phase==='crashed')button=<button className={`rr-btn ${BigInt(bet.payout_minor||0)>0n?'done':'lost'}`}>{BigInt(bet.payout_minor||0)>0n?`${t('cashedOut')} +${full(bet.payout_minor)}`:t('lost')}</button>;
 else if(bet)button=<button className="rr-btn wait">{t('betPlaced')}</button>;
 else if(phase==='betting')button=<button className="rr-btn bet" disabled={balance!==null&&BigInt(balance)<BigInt(stake)} onClick={()=>onBet(id,stake,autoOn?AUTO_STEPS[autoIdx]:null)}>{t('bet')}<small>{full(stake)}</small></button>;
 else button=<button className="rr-btn wait" disabled>{t('waitNext')}</button>;
 const locked=!!bet||phase!=='betting';
 return <div className="rr-panel">
  <div className="rr-row"><button disabled={locked} onClick={()=>setStake(step(GAME.chips,stake,-1))}>−</button><b>{short(stake)}</b><button disabled={locked} onClick={()=>setStake(step(GAME.chips,stake,1))}>+</button></div>
  <div className="rr-row rr-auto"><label><input type="checkbox" disabled={locked} checked={autoOn} onChange={e=>setAutoOn(e.target.checked)}/>{t('auto')}</label>
   <button disabled={locked||!autoOn} onClick={()=>setAutoIdx(i=>Math.max(0,i-1))}>−</button><b className={autoOn?'':'off'}>{fx(AUTO_STEPS[autoIdx])}x</b><button disabled={locked||!autoOn} onClick={()=>setAutoIdx(i=>Math.min(AUTO_STEPS.length-1,i+1))}>+</button></div>
  {button}
 </div>;
}

export default function RocketRush({initial}){
 const [state,setState]=useState(initial),[balance,setBalance]=useState(initial.balance?.available_minor??null),[now,setNow]=useState(Date.now());
 const [toast,setToast]=useState(null),[modal,setModal]=useState(false),[offline,setOffline]=useState(false);
 const offset=useRef(initial.server_now-Date.now()),balanceRound=useRef(null),stateRef=useRef(initial);
 const serverNow=()=>Date.now()+offset.current;
 const say=useCallback(key=>setToast({key,id:Math.random()}),[]);
 const refresh=useCallback(async withBalance=>{
  try{const s=await api(`/api/casino/state${withBalance?'?balance=1':''}`);offset.current=s.server_now-Date.now();stateRef.current=s;setState(s);setOffline(false);if(s.balance)setBalance(s.balance.available_minor);}
  catch{setOffline(true);}
 },[]);
 useEffect(()=>{let stop=false,timer;
  const loop=async()=>{const r=stateRef.current.round,n=serverNow(),crashed=!!r.result;
   const want=crashed&&balanceRound.current!==r.id;if(want)balanceRound.current=r.id;
   await refresh(want);if(stop)return;
   const p=phaseOf(stateRef.current.round,serverNow());timer=setTimeout(loop,p==='flying'?200:p==='betting'?Math.min(600,Math.max(150,stateRef.current.round.bet_until-serverNow()+40)):500);};
  timer=setTimeout(loop,300);return()=>{stop=true;clearTimeout(timer);};
 },[refresh]);
 useEffect(()=>{let raf;const tick=()=>{setNow(serverNow());raf=requestAnimationFrame(tick);};raf=requestAnimationFrame(tick);return()=>cancelAnimationFrame(raf);},[]);
 useEffect(()=>registerHostControls({onBack:()=>requestExit()}),[]);

 const round=state.round,phase=phaseOf(round,now);
 const mult=phase==='flying'?multAt(now-round.bet_until):phase==='crashed'?round.result.crash_x100:100;
 async function onBet(option,stake,auto){
  if(phaseOf(stateRef.current.round,serverNow())!=='betting'){say('closed');return;}
  if(balance!==null)setBalance(b=>String(BigInt(b)-BigInt(stake)));
  try{const placed=await api('/api/casino/bets',{request_id:requestId(),round_id:round.id,option_id:option,stake_minor:stake,...(auto?{auto_x100:auto}:{})});
   setState(s=>s.round.id===round.id?{...s,my_bets:[...s.my_bets,placed]}:s);}
  catch(e){if(balance!==null)setBalance(b=>String(BigInt(b)+BigInt(stake)));say(ERR[e.code]||'failed');}
 }
 async function onCash(bet){
  try{const done=await api('/api/casino/cashout',{bet_id:bet.id});setState(s=>({...s,my_bets:s.my_bets.map(b=>b.id===done.id?done:b)}));if(balance!==null)setBalance(b=>String(BigInt(b)+BigInt(done.payout_minor)));}
  catch(e){say(ERR[e.code]||'failed');}
 }
 const secs=Math.max(0,Math.ceil((round.bet_until-now)/1000));
 return <div className={`rr-root rr-${phase}`} dir={isRtl()?'rtl':'ltr'} style={{backgroundImage:`url(${img('background')})`}}>
  <header className="rr-top">
   <button className="rr-icon" aria-label="Back" onClick={()=>requestExit()}>‹</button>
   <div className="rr-balance"><i/>{balance===null?'—':full(balance)}</div>
   <button className="rr-icon" aria-label={t('rules')} onClick={()=>setModal(true)}>?</button>
  </header>
  <div className="rr-history">{state.history.slice(0,12).map(h=>{const x=Math.round(Number(h.outcome)*100);return <span key={h.seq} className={tone(x)}>{h.outcome}x</span>;})}</div>
  <div className="rr-stage">
   <Flight round={round} now={now} phase={phase}/>
   <div className="rr-center">
    {phase==='betting'?<><img className="rr-logo" src={img('logo')} alt=""/><b className="rr-count">{t('nextIn',[secs])}</b><div className="rr-bar"><i style={{width:`${Math.min(100,(round.bet_until-now)/GAME.round.betMs*100)}%`}}/></div></>
     :phase==='flying'?<b className="rr-mult">{fx(mult)}x</b>
     :<><b className="rr-mult crashed">{fx(mult)}x</b><small>{t('crashedAt',[fx(mult)])}</small></>}
   </div>
   {state.cashouts?.length>0&&<div className="rr-cashouts"><small>{t('cashedList')}</small>{state.cashouts.slice(-6).map((c,i)=><span key={i}>{c.external_user_id===state.me?'★':c.external_user_id.slice(0,6)} <b>{fx(c.cashout_x100)}x</b></span>)}</div>}
  </div>
  <div className="rr-panels">{GAME.options.map(o=><Panel key={o.id} id={o.id} state={state} phase={phase} mult={mult} balance={balance} onBet={onBet} onCash={onCash}/>)}</div>
  <div className="rr-round">{t('round',[round.seq])}</div>
  {offline&&<div className="cs-toast">{t('offline')}</div>}
  {toast&&<div className="cs-toast" key={toast.id}>{t(toast.key)}</div>}
  {modal&&<div className="cs-modal-back" onClick={()=>setModal(false)}><div className="cs-modal" onClick={e=>e.stopPropagation()}>
   <h2>{t('rules')}</h2><p>{t('rocketRules')}</p><h2>{t('fair')}</h2><p>{t('fairText')}</p><small>commitment: {round.commitment}</small>{round.seed&&<small>seed: {round.seed}</small>}
   <button className="cs-gold-btn" onClick={()=>setModal(false)}>{t('close')}</button></div></div>}
 </div>;
}
