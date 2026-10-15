import React,{useState} from 'react';
import {t,isRtl} from '../../shared/i18n.mjs';
import {useRound,full,short} from '../../shared/useRound.js';
import {CASINO_GAMES} from '../../../shared/casino-games.mjs';
import './teenpatti.css';

const GAME=CASINO_GAMES.teenpatti,HANDS=GAME.options.map(o=>o.id),MULT=(GAME.payout_x100/100).toFixed(2);
const img=n=>`/casino/teenpatti/${n}.webp`;
const SUIT={s:'♠',h:'♥',c:'♣',d:'♦'},RANK=r=>r==='T'?'10':r;
// Reveal choreography inside the 7 s draw window: one hand every 1.5 s, winner at 5.5 s.
const FLIP_AT=[1200,2700,4200],WIN_AT=5600;

function Card({code,open,delay}){
 const red=code&&'hd'.includes(code[1]);
 return <div className={`rp-card ${open?'open':''}`} style={{animationDelay:`${delay}ms`}}>
  <div className="rp-back" style={{backgroundImage:`url(${img('cardback')})`}}/>
  <div className={`rp-face ${red?'red':''}`}>{code&&<><b>{RANK(code[0])}</b><i>{SUIT[code[1]]}</i><em>{SUIT[code[1]]}</em></>}</div>
 </div>;
}

export default function RoyalPatti({initial}){
 const g=useRound(initial,GAME),{state,round,phase,now}=g;
 const [chip,setChip]=useState(GAME.chips[1]),[modal,setModal]=useState(false);
 const since=now-round.bet_until,result=round.result;
 const shown=i=>phase==='result'||(phase==='drawing'&&since>=FLIP_AT[i]);
 const winner=result&&(phase==='result'||since>=WIN_AT)?result.outcome:null;
 const secs=Math.max(0,Math.ceil((round.bet_until-now)/1000));
 const totals=state.totals||{};
 return <div className={`rp-root rp-${phase}`} dir={isRtl()?'rtl':'ltr'} style={{backgroundImage:`url(${img('background')})`}}>
  <header className="rp-top">
   <button className="rp-icon" aria-label="Back" onClick={g.exit}>‹</button>
   <div className="rp-balance"><i/>{g.balance===null?'—':full(g.balance)}</div>
   <button className="rp-icon" aria-label={t('rules')} onClick={()=>setModal(true)}>?</button>
  </header>
  <div className="rp-status">
   {phase==='betting'?<><img src={img('logo')} alt=""/><div><small>{t('betting')}</small><b className={secs<=5?'urgent':''}>{secs}</b></div></>
    :winner?<div className="rp-winner"><img src={img(winner)} alt=""/><b>{t('wins',[t(winner)])}</b></div>
    :<div><small>{t('drawing')}</small><b className="dots">• • •</b></div>}
  </div>
  <div className="rp-hands">
   {HANDS.map((id,i)=><div key={id} className={`rp-hand ${winner===id?'win':''} ${winner&&winner!==id?'lose':''}`}>
    <img className="rp-emblem" src={img(id)} alt=""/>
    <div className="rp-cards">{[0,1,2].map(k=><Card key={k} code={result&&shown(i)?result.hands[id][k]:null} open={!!result&&shown(i)} delay={k*90}/>)}</div>
    <span className="rp-cat">{result&&shown(i)?t(result.categories[id]):t(id)}</span>
   </div>)}
  </div>
  <div className="rp-zones">
   {HANDS.map(id=><button key={id} className={`rp-zone z-${id} ${winner===id?'win':''}`} onClick={()=>g.bet(id,chip)}>
    <span className="rp-zone-name">{t(id)}</span><span className="rp-zone-mult">×{MULT}</span>
    <span className="rp-zone-total">{t('total')} {short(totals[id]?.stake_minor||0)}</span>
    {g.mine[id]?<span className="rp-zone-mine">{short(g.mine[id])}</span>:<span className="rp-zone-mine empty">+</span>}
   </button>)}
  </div>
  <div className="rp-road" aria-label={t('history')}>{state.history.slice(0,16).map(h=><i key={h.seq} className={`d-${h.outcome}`}/>)}</div>
  {phase==='result'&&(g.myWin>0n||g.myStake>0n)&&<div className="rp-banner">{g.myWin>0n?<p>{t('youWon')} <b>{full(g.myWin)}</b></p>:<p>{t('noWin')}</p>}</div>}
  <footer className="rp-controls">
   <div className="rp-chips">{GAME.chips.map((c,i)=><button key={c} className={`rp-chip c${i} ${chip===c?'on':''}`} onClick={()=>setChip(c)}>{short(c)}</button>)}</div>
   <button className="rp-repeat" disabled={phase!=='betting'||!g.canRepeat} onClick={g.repeat}>{t('repeat')}</button>
  </footer>
  <div className="rp-round">{t('round',[round.seq])}{g.myStake>0n?` · ${t('myBet')} ${short(g.myStake)}`:''}</div>
  {g.offline&&<div className="cs-toast">{t('offline')}</div>}
  {g.toast&&<div className="cs-toast" key={g.toast.id}>{t(g.toast.key,[GAME.maxOptionsPerRound])}</div>}
  {modal&&<div className="cs-modal-back" onClick={()=>setModal(false)}><div className="cs-modal" onClick={e=>e.stopPropagation()}>
   <h2>{t('rules')}</h2><p>{t('pattiRules')}</p><h2>{t('fair')}</h2><p>{t('fairText')}</p><small>commitment: {round.commitment}</small>{round.seed&&<small>seed: {round.seed}</small>}
   <button className="cs-gold-btn" onClick={()=>setModal(false)}>{t('close')}</button></div></div>}
 </div>;
}
