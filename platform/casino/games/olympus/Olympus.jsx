import React,{useEffect,useRef,useState} from 'react';
import {api,requestId,registerHostControls,requestExit} from '../../shared/client.mjs';
import {t,isRtl} from '../../shared/i18n.mjs';
import {full,short} from '../../shared/useRound.js';
import {CASINO_GAMES} from '../../../shared/casino-games.mjs';
import './olympus.css';

const GAME=CASINO_GAMES.olympus,SLOT=GAME.slot,COLS=SLOT.columns,ROWS=SLOT.rows;
const img=n=>`/casino/olympus/${n}.webp`;
const SYMS=[...SLOT.symbols.map(s=>s.id),'scatter'];
const idle=()=>Array.from({length:COLS*ROWS},(_,i)=>({s:SYMS[(i*7+3)%SYMS.length]}));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const ERR={INSUFFICIENT_FUNDS:'insufficient',SPIN_PENDING:'pending',WALLET_PENDING:'pending'};
const AUTO=[10,25,50,100,Infinity];
const buyCost=stake=>String(BigInt(stake)*BigInt(SLOT.buy.price_x100)/100n);

export default function Olympus({initial}){
 const last=initial.last_spin?.result?.spins.at(-1);
 const [balance,setBalance]=useState(initial.balance?.available_minor??null),[stake,setStake]=useState(GAME.stakes[2]);
 const [grid,setGrid]=useState(()=>last?.tumbles.at(-1)?.grid||last?.initial||idle());
 const [gen,setGen]=useState(0),[winCells,setWinCells]=useState([]),[popping,setPopping]=useState(false),[win,setWin]=useState(0n),[busy,setBusy]=useState(false);
 const [free,setFree]=useState(null),[mult,setMult]=useState(null),[big,setBig]=useState(null),[turbo,setTurbo]=useState(false),[toast,setToast]=useState(null);
 const [modal,setModal]=useState(null),[auto,setAuto]=useState(0);
 const speed=useRef(1);speed.current=turbo?0.45:1;
 const autoRef=useRef(0);
 const balanceRef=useRef(balance);balanceRef.current=balance;
 // Unchanged cells keep their key across tumbles, so only new or moved symbols animate in.
 const keys=useRef({grid:null,keys:[],gen:-1});
 if(keys.current.grid!==grid){const k=keys.current,prev=k.grid;keys.current={grid,gen,keys:grid.map((c,i)=>prev&&gen===k.gen&&prev[i]?.s===c.s&&prev[i]?.m===c.m?k.keys[i]:`${gen}-${i}-${Math.random()}`)};}
 const wait=ms=>sleep(ms*speed.current);
 useEffect(()=>registerHostControls({onBack:()=>{if(!busy)requestExit();}}),[busy]);
 const say=key=>setToast({key,id:Math.random()});

 async function play(result){
  let total=0n;const unit=BigInt(result.base_stake_minor);
  for(let si=0;si<result.spins.length;si++){
   const sp=result.spins[si],freeIndex=result.spins.slice(0,si+1).filter(x=>x.free).length;
   if(sp.free)setFree(f=>({n:freeIndex,of:result.free_spins,total:f?.total||0}));
   setWinCells([]);setMult(null);setGrid(sp.initial);setGen(g=>g+1);await wait(sp.free?650:520);
   let spinWin=0;
   for(const tb of sp.tumbles){
    setWinCells(tb.wins.flatMap(w=>w.cells));await wait(620);
    spinWin+=tb.wins.reduce((a,w)=>a+w.pay_x100,0);setWin(total+unit*BigInt(spinWin)/100n);
    setPopping(true);await wait(260);setPopping(false);setWinCells([]);setGrid(tb.grid);await wait(420);
   }
   if(sp.multiplier>1&&spinWin>0){setMult(sp.multiplier);await wait(900);}
   total+=unit*BigInt(sp.win_x100)/100n;setWin(total);
   if(!sp.free&&sp.scatters>=SLOT.freeSpins.trigger){setBig({kind:'free'});await wait(1600);setBig(null);}
   if(sp.free)setFree(f=>({...f,total:sp.total_multiplier}));
  }
  const x=Number(total*100n/unit)/100;
  if(x>=20){setBig({kind:x>=100?'epicWin':x>=50?'megaWin':'bigWin',amount:total});await wait(2600);setBig(null);}
  setFree(null);
 }

 async function spinOnce({buy=false}={}){
  const cost=buy?buyCost(stake):stake;
  if(balanceRef.current!==null&&BigInt(balanceRef.current)<BigInt(cost)){say('insufficient');return false;}
  setWin(0n);setBalance(b=>b===null?b:String(BigInt(b)-BigInt(cost)));
  try{
   const r=await api('/api/casino/spin',{request_id:requestId(),stake_minor:stake,...(buy?{buy:true}:{})});
   await play(r.result);setBalance(b=>b===null?b:String(BigInt(b)+BigInt(r.payout_minor)));return true;
  }catch(e){setBalance(b=>b===null?b:String(BigInt(b)+BigInt(cost)));say(ERR[e.code]||'failed');return false;}
 }
 async function run(task){
  if(busy)return;setBusy(true);
  try{await task();}finally{setBusy(false);api('/api/casino/state?balance=1').then(s=>s.balance&&setBalance(s.balance.available_minor)).catch(()=>{});}
 }
 const spin=()=>run(()=>spinOnce());
 const startAuto=n=>{setModal(null);autoRef.current=n;setAuto(n);run(async()=>{
  for(let left=n;left>0&&autoRef.current>0;left--){autoRef.current=left;setAuto(left);if(!await spinOnce())break;await sleep(250);}autoRef.current=0;setAuto(0);});};
 const buy=()=>{setModal(null);run(()=>spinOnce({buy:true}));};
 const step=d=>setStake(s=>GAME.stakes[Math.min(GAME.stakes.length-1,Math.max(0,GAME.stakes.indexOf(s)+d))]);

 return <div className={`ol-root ${free?'ol-free':''}`} dir={isRtl()?'rtl':'ltr'} style={{backgroundImage:`url(${img('background')})`}}>
  <header className="ol-top">
   <button className="ol-icon" aria-label="Back" disabled={busy} onClick={()=>requestExit()}>‹</button>
   <button className="ol-icon" aria-label={t('rules')} onClick={()=>setModal('rules')}>?</button>
  </header>
  <img className="ol-god" src={img('god')} alt="" draggable="false"/>
  <img className="ol-logo" src={img('logo')} alt="Olympus" draggable="false"/>
  <div className="ol-status">{free?<><b>{t('freeLeft',[free.n,free.of])}</b>{free.total>0&&<span>{t('totalMult',[free.total])}</span>}</>
   :<button className="ol-buy" disabled={busy} onClick={()=>setModal('buy')}><b>{t('freeSpins')}</b><small>{t('buy')} · {short(buyCost(stake))}</small></button>}</div>
  <div className="ol-temple">
   <img className="ol-column l" src={img('column')} alt="" draggable="false"/>
   <img className="ol-column r" src={img('column')} alt="" draggable="false"/>
   <div className="ol-board">
    <div className="ol-grid" style={{gridTemplateColumns:`repeat(${COLS},1fr)`}}>
     {grid.map((c,i)=><div key={keys.current.keys[i]} className={`ol-cell ${winCells.includes(i)?(popping?'pop':'win'):''}`} style={{animationDelay:`${(i%COLS)*30}ms`}}>
      <img src={img(c.s)} alt="" draggable="false"/>{c.s==='orb'&&<b className="ol-orb">×{c.m}</b>}
     </div>)}
    </div>
    {mult&&<div className="ol-mult">×{mult}</div>}
   </div>
  </div>
  <div className="ol-win"><img className="lau l" src={img('laurel')} alt=""/><div><small>{t('win')}</small><b>{full(win)}</b></div><img className="lau r" src={img('laurel')} alt=""/></div>
  <div className="ol-betrow">
   <button className="ol-step" disabled={busy} onClick={()=>step(-1)}>−</button>
   <div className="ol-plaque"><small>{t('stake')}</small><b>{full(stake)}</b></div>
   <button className="ol-step" disabled={busy} onClick={()=>step(1)}>+</button>
  </div>
  <footer className="ol-controls">
   <button className={`ol-round ${auto?'on':''}`} onClick={()=>auto?(autoRef.current=0,setAuto(0)):!busy&&setModal('auto')} aria-label={t('autoSpin')}>
    <img src={img('auto')} alt=""/><small>{auto?(auto===Infinity?'∞':auto):'AUTO'}</small></button>
   <button className={`ol-spin ${busy?'busy':''} ${auto?'auto':''}`} onClick={()=>auto?(autoRef.current=0,setAuto(0)):spin()} disabled={busy&&!auto} aria-label={t('spin')}>
    <img src={img('spin')} alt=""/>{auto?<span className="ol-stop">{t('stop')}</span>:null}</button>
   <button className={`ol-round ${turbo?'on':''}`} onClick={()=>setTurbo(v=>!v)} aria-label={t('turbo')}><img src={img('turbo')} alt=""/><small>TURBO</small></button>
  </footer>
  <div className="ol-balance"><i/><small>{t('balance')}</small><b>{balance===null?'—':full(balance)}</b></div>
  {big&&<div className="ol-big"><div>{big.kind==='free'?<b>{t('freeSpins')} ×{SLOT.freeSpins.award}</b>:<><b>{t(big.kind)}</b><em>{full(big.amount)}</em></>}</div></div>}
  {toast&&<div className="cs-toast" key={toast.id}>{t(toast.key)}</div>}
  {modal==='auto'&&<div className="cs-modal-back" onClick={()=>setModal(null)}><div className="cs-modal" onClick={e=>e.stopPropagation()}>
   <h2>{t('autoSpin')}</h2><div className="ol-autos">{AUTO.map(n=><button key={n} onClick={()=>startAuto(n)}>{n===Infinity?t('untilStop'):n}</button>)}</div>
   <button className="cs-gold-btn" onClick={()=>setModal(null)}>{t('cancel')}</button></div></div>}
  {modal==='buy'&&<div className="cs-modal-back" onClick={()=>setModal(null)}><div className="cs-modal" onClick={e=>e.stopPropagation()}>
   <h2>{t('buyFree')}</h2><p style={{textAlign:'center'}}>{t('buyFor',[full(buyCost(stake)),SLOT.freeSpins.award])}</p>
   <div className="ol-autos"><button onClick={buy}>{t('buy')}</button><button onClick={()=>setModal(null)}>{t('cancel')}</button></div></div></div>}
  {modal==='rules'&&<div className="cs-modal-back" onClick={()=>setModal(null)}><div className="cs-modal" onClick={e=>e.stopPropagation()}>
   <h2>{t('rules')}</h2><p>{t('slotRules')}</p>
   <div className="ol-pay">{SLOT.symbols.map(s=><div key={s.id}><img src={img(s.id)} alt=""/><span>{s.bands.map(([n,x])=>`${n}+ ×${x/100}`).join('   ')}</span></div>)}</div>
   <button className="cs-gold-btn" onClick={()=>setModal(null)}>{t('close')}</button></div></div>}
 </div>;
}
