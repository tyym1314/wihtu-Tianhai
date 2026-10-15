import React,{useEffect,useRef,useState} from 'react';
import {api,requestId,registerHostControls,requestExit} from '../../shared/client.mjs';
import {t,isRtl} from '../../shared/i18n.mjs';
import {full,short} from '../../shared/useRound.js';
import {CASINO_GAMES} from '../../../shared/casino-games.mjs';
import './skypalace.css';

const GAME=CASINO_GAMES.skypalace,COLS=GAME.slot.columns,ROWS=GAME.slot.rows;
const img=n=>`/casino/skypalace/${n}.webp`;
const SYMS=[...GAME.slot.symbols.map(s=>s.id),'scatter'];
const idle=()=>Array.from({length:COLS*ROWS},(_,i)=>({s:SYMS[(i*7+3)%SYMS.length]}));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const ERR={INSUFFICIENT_FUNDS:'insufficient',SPIN_PENDING:'pending',WALLET_PENDING:'pending'};

export default function SkyPalace({initial}){
 const [balance,setBalance]=useState(initial.balance?.available_minor??null),[stake,setStake]=useState(GAME.stakes[2]);
 const [grid,setGrid]=useState(()=>initial.last_spin?.result?.spins.at(-1)?.tumbles.at(-1)?.grid||initial.last_spin?.result?.spins.at(-1)?.initial||idle());
 const [gen,setGen]=useState(0),[winCells,setWinCells]=useState([]),[popping,setPopping]=useState(false),[win,setWin]=useState(0n),[busy,setBusy]=useState(false);
 const [free,setFree]=useState(null),[mult,setMult]=useState(null),[big,setBig]=useState(null),[turbo,setTurbo]=useState(false),[toast,setToast]=useState(null),[modal,setModal]=useState(false);
 const speed=useRef(1);speed.current=turbo?0.45:1;
 // Unchanged cells keep their key across tumbles, so only new or moved symbols animate in.
 const keys=useRef({grid:null,keys:[]});
 if(keys.current.grid!==grid){const prev=keys.current.grid;keys.current={grid,keys:grid.map((c,i)=>prev&&prev[i]&&prev[i].s===c.s&&prev[i].m===c.m&&gen===keys.current.gen?keys.current.keys[i]:`${gen}-${i}-${Math.random()}`),gen};}
 const wait=ms=>sleep(ms*speed.current);
 useEffect(()=>registerHostControls({onBack:()=>{if(!busy)requestExit();}}),[busy]);
 const say=key=>setToast({key,id:Math.random()});

 async function play(result,stakeMinor){
  let total=0n;const unit=BigInt(stakeMinor);
  for(let si=0;si<result.spins.length;si++){
   const sp=result.spins[si];
   if(sp.free)setFree({n:si,of:result.spins.length-1,total:sp.total_multiplier});
   setWinCells([]);setMult(null);setGrid(sp.initial);setGen(g=>g+1);await wait(sp.free?650:520);
   let spinWin=0;
   for(const tb of sp.tumbles){
    setWinCells(tb.wins.flatMap(w=>w.cells));await wait(620);
    spinWin+=tb.wins.reduce((a,w)=>a+w.pay_x100,0);setWin(total+unit*BigInt(spinWin)/100n);
    setPopping(true);await wait(260);setPopping(false);setWinCells([]);setGrid(tb.grid);await wait(420);
   }
   if(sp.multiplier>1&&spinWin>0){setMult(sp.multiplier);await wait(900);}
   total+=unit*BigInt(sp.win_x100)/100n;setWin(total);
   if(!sp.free&&sp.scatters>=GAME.slot.freeSpins.trigger){setBig({kind:'free'});await wait(1600);setBig(null);}
   if(sp.free)setFree(f=>({...f,total:sp.total_multiplier}));
  }
  const x=Number(total*100n/unit)/100;
  if(x>=20){setBig({kind:x>=100?'epicWin':x>=50?'megaWin':'bigWin',amount:total});await wait(2600);setBig(null);}
  setFree(null);
 }

 async function spin(){
  if(busy)return;
  if(balance!==null&&BigInt(balance)<BigInt(stake)){say('insufficient');return;}
  setBusy(true);setWin(0n);setBalance(b=>b===null?b:String(BigInt(b)-BigInt(stake)));
  try{
   const r=await api('/api/casino/spin',{request_id:requestId(),stake_minor:stake});
   await play(r.result,stake);
   setBalance(b=>b===null?b:String(BigInt(b)+BigInt(r.payout_minor)));
  }catch(e){setBalance(b=>b===null?b:String(BigInt(b)+BigInt(stake)));say(ERR[e.code]||'failed');}
  finally{setBusy(false);api('/api/casino/state?balance=1').then(s=>s.balance&&setBalance(s.balance.available_minor)).catch(()=>{});}
 }
 const step=d=>setStake(s=>GAME.stakes[Math.min(GAME.stakes.length-1,Math.max(0,GAME.stakes.indexOf(s)+d))]);

 return <div className={`sp-root ${free?'sp-free':''}`} dir={isRtl()?'rtl':'ltr'} style={{backgroundImage:`url(${img('background')})`}}>
  <header className="sp-top">
   <button className="sp-icon" aria-label="Back" disabled={busy} onClick={()=>requestExit()}>‹</button>
   <div className="sp-balance"><i/>{balance===null?'—':full(balance)}</div>
   <button className="sp-icon" aria-label={t('rules')} onClick={()=>setModal(true)}>?</button>
  </header>
  <div className="sp-hero">
   <img className="sp-god" src={img('god')} alt="" draggable="false"/>
   {free?<div className="sp-freebar"><b>{t('freeLeft',[free.n,free.of])}</b>{free.total>0&&<span>{t('totalMult',[free.total])}</span>}</div>:<div className="sp-title">SKY PALACE</div>}
  </div>
  <div className="sp-board">
   <div className="sp-grid" style={{gridTemplateColumns:`repeat(${COLS},1fr)`}}>
    {grid.map((c,i)=><div key={keys.current.keys[i]} className={`sp-cell ${winCells.includes(i)?(popping?'pop':'win'):''}`} style={{animationDelay:`${(i%COLS)*28}ms`}}>
     <img src={img(c.s)} alt="" draggable="false"/>{c.s==='orb'&&<b className="sp-orb">×{c.m}</b>}
    </div>)}
   </div>
   {mult&&<div className="sp-mult">×{mult}</div>}
  </div>
  <div className="sp-winline"><small>{t('win')}</small><b>{full(win)}</b></div>
  <footer className="sp-controls">
   <div className="sp-stake"><small>{t('stake')}</small><div><button disabled={busy} onClick={()=>step(-1)}>−</button><b>{short(stake)}</b><button disabled={busy} onClick={()=>step(1)}>+</button></div></div>
   <button className={`sp-spin ${busy?'busy':''}`} disabled={busy} onClick={spin} aria-label={t('spin')}><span>⟳</span></button>
   <button className={`sp-turbo ${turbo?'on':''}`} onClick={()=>setTurbo(v=>!v)}>⚡<small>{t('turbo')}</small></button>
  </footer>
  {big&&<div className="sp-big"><div>{big.kind==='free'?<b>{t('freeSpins')} ×{GAME.slot.freeSpins.award}</b>:<><b>{t(big.kind)}</b><em>{full(big.amount)}</em></>}</div></div>}
  {toast&&<div className="cs-toast" key={toast.id}>{t(toast.key)}</div>}
  {modal&&<div className="cs-modal-back" onClick={()=>setModal(false)}><div className="cs-modal" onClick={e=>e.stopPropagation()}>
   <h2>{t('rules')}</h2><p>{t('slotRules')}</p>
   <div className="sp-pay">{GAME.slot.symbols.map(s=><div key={s.id}><img src={img(s.id)} alt=""/><span>{s.bands.map(([n,x])=>`${n}+ ×${x/100}`).join('  ')}</span></div>)}</div>
   <button className="cs-gold-btn" onClick={()=>setModal(false)}>{t('close')}</button></div></div>}
 </div>;
}
