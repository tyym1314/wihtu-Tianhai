import React,{useCallback,useEffect,useRef,useState} from 'react';
import {api,requestId,registerHostControls,requestExit} from '../../shared/client.mjs';
import {t,isRtl} from '../../shared/i18n.mjs';
import {full,short} from '../../shared/useRound.js';
import {useAudio} from '../../shared/audio.mjs';
import {Stage,Box,CountUp,PhaseBanner} from '../../shared/Stage.jsx';
import {CASINO_GAMES} from '../../../shared/casino-games.mjs';
import {HistoryModal} from '../../shared/History.jsx';
import './rocketstar2.css';

const GAME=CASINO_GAMES.rocketstar2;
const GROWTH=Math.log(2)/8000;
const multAt=ms=>Math.floor(100*Math.exp(GROWTH*Math.max(0,ms))+1e-9);
const img=n=>`/casino/rocketstar2/${n}.webp`;
const fx=x100=>(x100/100).toFixed(2);
const ERR={INSUFFICIENT_FUNDS:'insufficient',BETTING_CLOSED:'closed',OPTION_ALREADY_BET:'already',CRASHED:'crashedErr',ROUND_STAKE_LIMIT:'limit'};
const AUTO=[110,120,150,200,300,500,1000,2000,5000,10000];
// Design pixels on the 941x1672 plate.
const FLIGHT={x:0,y:236,w:941,h:900};
const HIST_X=[199,335,472,608,742];
const PANEL_Y=[1279,1473];
function phaseOf(r,n){if(n<r.bet_until)return'betting';if(!r.result)return'flying';return'crashed';}

function Flight({round,now,phase,ship,tip}){
 const ref=useRef(null);
 useEffect(()=>{
  const c=ref.current;if(!c)return;const W=FLIGHT.w,H=FLIGHT.h;if(c.width!==W){c.width=W;c.height=H;}const g=c.getContext('2d');g.clearRect(0,0,W,H);
  const flight=phase==='betting'?0:phase==='flying'?now-round.bet_until:Math.log(round.result.crash_x100/100)/GROWTH;
  const tMax=Math.max(10000,flight*1.15),mMax=Math.max(2,Math.exp(GROWTH*flight)*1.25);
  const X=s=>W*0.08+s/tMax*W*0.78,Y=m=>H*0.92-(m-1)/(mMax-1)*H*0.7;
  const el=ship.current;
  if(phase==='betting'){el.style.transform=`translate(${X(0)}px,${Y(1)}px) translate(-50%,-50%) rotate(0deg)`;el.style.opacity=1;return;}
  const pts=[];for(let i=0;i<=90;i++){const s=flight*i/90;pts.push([X(s),Y(Math.exp(GROWTH*s))]);}
  const grad=g.createLinearGradient(0,H,W,0);grad.addColorStop(0,'#ffb84d');grad.addColorStop(.6,'#ffd34d');grad.addColorStop(1,phase==='crashed'?'#ff3b5c':'#ffe37a');
  g.beginPath();g.moveTo(pts[0][0],H*.92);pts.forEach(p=>g.lineTo(p[0],p[1]));g.lineTo(pts.at(-1)[0],H*.92);g.closePath();
  const fill=g.createLinearGradient(0,H*.2,0,H);fill.addColorStop(0,'#ff9a3c44');fill.addColorStop(1,'#8a5cff00');g.fillStyle=fill;g.fill();
  const line=()=>{g.beginPath();pts.forEach((p,i)=>i?g.lineTo(p[0],p[1]):g.moveTo(p[0],p[1]));};
  g.lineCap='round';g.lineJoin='round';
  line();g.strokeStyle=phase==='crashed'?'#ff3b5c66':'#ff9a3c66';g.lineWidth=30;g.shadowColor=phase==='crashed'?'#ff3b5c':'#ffb84d';g.shadowBlur=40;g.stroke();
  line();g.strokeStyle=grad;g.lineWidth=12;g.shadowBlur=18;g.stroke();
  line();g.strokeStyle='#fff8dccc';g.lineWidth=4;g.shadowBlur=0;g.stroke();
  for(let i=6;i<pts.length;i+=12){g.beginPath();g.arc(pts[i][0],pts[i][1],7,0,7);g.fillStyle='#fff6d0';g.fill();}
  const [x,y]=pts.at(-1),[px,py]=pts[Math.max(0,pts.length-5)],ang=Math.atan2(py-y,x-px)*180/Math.PI;
  el.style.transform=`translate(${x}px,${y}px) translate(-50%,-50%) rotate(${45-ang}deg)`;el.style.opacity=phase==='crashed'?0:1;
  tip.current=[FLIGHT.x+x,FLIGHT.y+y];
 });
 return <canvas ref={ref} className="rs-canvas" style={{left:FLIGHT.x,top:FLIGHT.y,width:FLIGHT.w,height:FLIGHT.h}}/>;
}

function Panel({index,state,phase,mult,balance,onBet,onCash,audio}){
 const id=GAME.options[index].id,y=PANEL_Y[index];
 const [stake,setStake]=useState(GAME.chips[1]),[autoIdx,setAutoIdx]=useState(index?3:-1);
 const bet=state.my_bets.find(b=>b.option_id===id&&!['REJECTED','VOIDED','VOIDING'].includes(b.status));
 const locked=!!bet||phase!=='betting';
 const step=d=>{audio.play('click');setStake(s=>GAME.chips[Math.min(GAME.chips.length-1,Math.max(0,GAME.chips.indexOf(s)+d))]);};
 const auto=autoIdx<0?null:AUTO[autoIdx];
 let main,cls='bet';
 if(bet?.cashout_x100){cls='done';main=<><b>{fx(bet.cashout_x100)}x</b><small>+{full(bet.payout_minor)}</small></>;}
 else if(bet&&phase==='flying'&&bet.status==='ACCEPTED'){cls='cash';main=<><b>{t('cashOut')}</b><small>{full(BigInt(bet.stake_minor)*BigInt(mult)/100n)}</small></>;}
 else if(bet&&phase==='crashed'){const w=BigInt(bet.payout_minor||0);cls=w>0n?'done':'lost';main=<b>{w>0n?`+${full(w)}`:t('lost')}</b>;}
 else if(bet){cls='wait';main=<><b>{t('betPlaced')}</b></>;}
 else if(phase==='betting'){main=<><b>{t('bet')}</b><small>{full(stake)}</small></>;}
 else{cls='wait';main=<b>{t('waitNext')}</b>;}
 const click=()=>{if(cls==='cash')onCash(bet);else if(cls==='bet'&&phase==='betting')onBet(id,stake,auto);};
 return <>
  <button className="rs-step" style={{left:33,top:y-31}} disabled={locked} onClick={()=>step(-1)} aria-label="-"/>
  <Box x={108} y={y-26} w={130} h={52} className="rs-field">{short(stake)}</Box>
  <button className="rs-step" style={{left:241,top:y-31}} disabled={locked} onClick={()=>step(1)} aria-label="+"/>
  <button className="rs-step" style={{left:324,top:y-31}} disabled={locked} onClick={()=>{audio.play('click');setAutoIdx(i=>Math.max(-1,i-1));}} aria-label="-"/>
  <Box x={392} y={y-26} w={140} h={52} className={`rs-field ${auto?'':'off'}`}>{auto?`${fx(auto)}x`:'OFF'}</Box>
  <button className="rs-step" style={{left:532,top:y-31}} disabled={locked} onClick={()=>{audio.play('click');setAutoIdx(i=>Math.min(AUTO.length-1,i+1));}} aria-label="+"/>
  <button className={`rs-main ${cls}`} style={{left:616,top:y-92,width:286,height:136}} disabled={cls==='bet'&&(balance!==null&&BigInt(balance)<BigInt(stake))} onClick={click}>{main}</button>
 </>;
}

export default function RocketStar2({initial}){
 const [state,setState]=useState(initial),[balance,setBalance]=useState(initial.balance?.available_minor??null),[now,setNow]=useState(Date.now());
 const [toast,setToast]=useState(null),[menu,setMenu]=useState(false),[records,setRecords]=useState(false),[rules,setRules]=useState(false),[offline,setOffline]=useState(false),[pop,setPop]=useState(null);
 const audio=useAudio('rocketstar2',['launch','boom','cash','click','chip','tick','coin','select','close']);
 const offset=useRef(initial.server_now-Date.now()),balanceRound=useRef(null),ref=useRef(initial),ship=useRef(null),seen=useRef({}),tip=useRef([560,500]);
 const serverNow=()=>Date.now()+offset.current;
 const say=useCallback(key=>setToast({key,id:Math.random()}),[]);
 const refresh=useCallback(async withBalance=>{
  try{const s=await api(`/api/casino/state${withBalance?'?balance=1':''}`);offset.current=s.server_now-Date.now();ref.current=s;setState(s);setOffline(false);if(s.balance)setBalance(s.balance.available_minor);}catch{setOffline(true);}
 },[]);
 useEffect(()=>{let stop=false,timer;
  const loop=async()=>{const r=ref.current.round,want=!!r.result&&balanceRound.current!==r.id;if(want)balanceRound.current=r.id;
   await refresh(want);if(stop)return;const p=phaseOf(ref.current.round,serverNow());
   timer=setTimeout(loop,p==='flying'?200:p==='betting'?Math.min(600,Math.max(150,ref.current.round.bet_until-serverNow()+40)):500);};
  timer=setTimeout(loop,300);return()=>{stop=true;clearTimeout(timer);};
 },[refresh]);
 useEffect(()=>{let raf;const tick=()=>{setNow(serverNow());raf=requestAnimationFrame(tick);};raf=requestAnimationFrame(tick);return()=>cancelAnimationFrame(raf);},[]);
 useEffect(()=>registerHostControls({onBack:()=>requestExit()}),[]);
 const round=state.round,phase=phaseOf(round,now);
 // Phase sounds: launch on lift-off, explosion on crash; ticks in the last three seconds.
 useEffect(()=>{const k=round.id+phase;if(seen.current[k])return;seen.current[k]=1;if(phase==='flying')audio.play('launch');if(phase==='crashed')audio.play('boom');},[phase,round.id]);
 const secs=Math.max(0,Math.ceil((round.bet_until-now)/1000));
 useEffect(()=>{if(phase==='betting'&&secs<=3&&secs>0)audio.play('tick');},[secs]);
 const mult=phase==='flying'?multAt(now-round.bet_until):phase==='crashed'?round.result.crash_x100:100;
 async function onBet(option,stake,auto){
  if(phaseOf(ref.current.round,serverNow())!=='betting'){say('closed');return;}
  audio.play('chip');if(balance!==null)setBalance(b=>String(BigInt(b)-BigInt(stake)));
  try{const placed=await api('/api/casino/bets',{request_id:requestId(),round_id:round.id,option_id:option,stake_minor:stake,...(auto?{auto_x100:auto}:{})});
   setState(s=>s.round.id===round.id?{...s,my_bets:[...s.my_bets,placed]}:s);}
  catch(e){if(balance!==null)setBalance(b=>String(BigInt(b)+BigInt(stake)));say(ERR[e.code]||'failed');}
 }
 async function onCash(bet){
  try{const done=await api('/api/casino/cashout',{bet_id:bet.id});audio.play('cash');audio.play('coin');setPop({id:Math.random(),x:done.cashout_x100,v:done.payout_minor});setTimeout(()=>setPop(null),1600);setState(s=>({...s,my_bets:s.my_bets.map(b=>b.id===done.id?done:b)}));if(balance!==null)setBalance(b=>String(BigInt(b)+BigInt(done.payout_minor)));}
  catch(e){say(ERR[e.code]||'failed');}
 }
 const tone=x=>x>=1000?'gold':x>=200?'green':'red';
 const tier=mult>=1000?'t4':mult>=500?'t3':mult>=200?'t2':'t1';
 return <Stage plate={img('plate')} className={`rs-${phase}`} dir={isRtl()?'rtl':'ltr'}>
  {phase==='flying'&&<div className="rs-stars" style={{animationDuration:`${Math.max(.25,1.6-Math.log2(mult/100)*.35)}s`}}/>}
  <div className={phase==='crashed'?'rs-shake':''}><Flight round={round} now={now} phase={phase} ship={ship} tip={tip}/></div>
  <PhaseBanner round={round} phase={phase} text={{betting:t('startBet'),flying:t('stopBet')}} onShow={p=>audio.play(p==='betting'?'select':'close')}/>
  {pop&&<Box key={pop.id} x={170} y={720} w={600} h={160} className="rs-pop"><b>{fx(pop.x)}x</b><span>+{full(pop.v)}</span></Box>}
  <img ref={ship} className="rs-ship" src={img('ship')} alt="" style={{left:FLIGHT.x,top:FLIGHT.y}} draggable="false"/>
  {phase==='crashed'&&<React.Fragment key={round.id}><div className="rs-smoke" style={{left:tip.current[0],top:tip.current[1]}}/><div className="rs-boom" style={{left:tip.current[0],top:tip.current[1],margin:0,transform:'translate(-50%,-50%)'}}/>
   {Array.from({length:14},(_,i)=>{const a=i/14*Math.PI*2;return <span key={i} className="rs-debris" style={{left:tip.current[0],top:tip.current[1],'--dx':`${Math.cos(a)*(180+i%3*80)}px`,'--dy':`${Math.sin(a)*(180+i%4*60)}px`}}/>;})}</React.Fragment>}
  <Box x={0} y={430} w={941} h={240} className="rs-center">
   {phase==='betting'?<><b className="rs-count">{t('nextIn',[secs])}</b><div className="rs-bar"><i style={{width:`${Math.min(100,(round.bet_until-now)/GAME.round.betMs*100)}%`}}/></div></>
    :<><b key={phase==='flying'?tier:'c'} className={`rs-mult ${phase} ${tier}`}>{fx(mult)}x</b>{phase==='crashed'&&<small>{t('crashedAt',[fx(mult)])}</small>}</>}
  </Box>
  {state.history.slice(0,5).map((h,i)=>{const x=Math.round(Number(h.outcome)*100);return <Box key={h.seq} x={HIST_X[i]-56} y={186} w={112} h={44} className={`rs-hist ${tone(x)}`}>{h.outcome}x</Box>;})}
  <Box x={712} y={38} w={150} h={50} className="rs-balance">{balance===null?'—':<CountUp value={Number(balance)} format={v=>full(Math.round(v))}/>}</Box>
  <Box x={26} y={300} w={300} h={400} className="rs-cashouts">{(state.cashouts||[]).slice(-6).map((c,i)=><span key={c.external_user_id+i}>{c.external_user_id===state.me?'★':c.external_user_id.slice(0,6)} <b>{fx(c.cashout_x100)}x</b></span>)}</Box>
  {[0,1].map(i=><Panel key={i} index={i} state={state} phase={phase} mult={mult} balance={balance} onBet={onBet} onCash={onCash} audio={audio}/>)}
  <button className="rs-menu" style={{left:17,top:19,width:80,height:80}} onClick={()=>setMenu(m=>!m)} aria-label="menu"/>
  {menu&&<div className="cs-menu" style={{left:22,top:110}}>
   <button className="cs-icon-btn rs-ib" onClick={()=>{setRules(true);setMenu(false);}}>?</button>
   <button className="cs-icon-btn rs-ib" onClick={()=>{setRecords(true);setMenu(false);}} aria-label={t('records')}>📜</button>
    <button className="cs-icon-btn rs-ib" onClick={audio.toggle}>{audio.muted?'🔇':'🔊'}</button>
   <button className="cs-icon-btn rs-ib" onClick={()=>requestExit()}>⏻</button></div>}
  {offline&&<div className="cs-toast">{t('offline')}</div>}
  {toast&&<div className="cs-toast" key={toast.id}>{t(toast.key)}</div>}
  {rules&&<div className="cs-modal-back" onClick={()=>setRules(false)}><div className="cs-modal" onClick={e=>e.stopPropagation()}>
   <h2>{t('rules')}</h2><p>{t('rocketRules')}</p><h2>{t('fair')}</h2><p>{t('fairText')}</p><small>commitment: {round.commitment}</small>{round.seed&&<small>seed: {round.seed}</small>}
   <button className="cs-gold-btn" onClick={()=>setRules(false)}>{t('close')}</button></div></div>}
   {records&&<HistoryModal onClose={()=>setRecords(false)} label={id=>id.length===1?id.toUpperCase():id}/>}
 </Stage>;
}
