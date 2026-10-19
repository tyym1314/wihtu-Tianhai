import React,{useEffect,useRef,useState} from 'react';
import {t,isRtl} from '../../shared/i18n.mjs';
import {useRound,full,short} from '../../shared/useRound.js';
import {useAudio} from '../../shared/audio.mjs';
import {Stage,Box,CountUp,PhaseBanner} from '../../shared/Stage.jsx';
import {RechargeTap,useHostBalance} from '../../shared/recharge.jsx';
import {CASINO_GAMES} from '../../../shared/casino-games.mjs';
import {HistoryModal} from '../../shared/History.jsx';
import './teenpatti.css';

const GAME=CASINO_GAMES.teenpatti,HANDS=GAME.options.map(o=>o.id),LABEL={ruby:'A',jade:'B',sapphire:'C'},MULT=(GAME.payout_x100/100).toFixed(2);
const img=n=>`/casino/teenpatti/${n}.webp?v=${__ASSET_VERSION__}`;
const SUIT={s:'♠',h:'♥',c:'♣',d:'♦'},RANK=r=>r==='T'?'10':r;
// Design pixels on the 941x1672 plate.
const CARD_X={ruby:167,jade:470,sapphire:772},CARD_Y=493,ZONE_X={ruby:37,jade:328,sapphire:630},ZONE_W=274;
const CHIP_X=[142,360,578,795],CHIP_Y=1170,BALANCE=[767,55];
const FLIP_AT=[1200,2700,4200],WIN_AT=5600,DEAL_FROM=[470,300];

function Card({code,open,i,dealt}){
 const red=code&&'hd'.includes(code[1]),dx=(i-1)*58,rot=(i-1)*9;
 return <div className={`tp-card ${open?'open':''} ${dealt?'dealt':''}`} style={{'--dx':`${dx}px`,'--rot':`${rot}deg`,transitionDelay:`${i*90}ms`}}>
  <div className="tp-back" style={{backgroundImage:`url(${img('cardback')})`}}/>
  <div className={`tp-face ${red?'red':''}`}>{code&&<><b>{RANK(code[0])}</b><i>{SUIT[code[1]]}</i><em>{SUIT[code[1]]}</em></>}</div>
 </div>;
}

export default function TeenPatti({initial}){
 const g=useRound(initial,GAME),{state,round,phase,now}=g,audio=useAudio('teenpatti',['chip','deal','flip','win','lose','click','tick','chips','coin','shuffle','select','close']);
 const [chip,setChip]=useState(GAME.chips[1]),[menu,setMenu]=useState(false),[records,setRecords]=useState(false),[rules,setRules]=useState(false),[coins,setCoins]=useState([]),[flies,setFlies]=useState([]);
 const since=now-round.bet_until,result=round.result,seen=useRef({});
 const shown=i=>phase==='result'||(phase==='drawing'&&since>=FLIP_AT[i]);
 const winner=result&&(phase==='result'||since>=WIN_AT)?result.outcome:null;
 const secs=Math.max(0,Math.ceil((round.bet_until-now)/1000));
 const once=(k,f)=>{if(!seen.current[round.id+k]){seen.current[round.id+k]=1;f();}};
 useEffect(()=>{if(phase==='drawing')once('deal',()=>audio.play('deal'));HANDS.forEach((_,i)=>{if(phase==='drawing'&&shown(i))once('f'+i,()=>audio.play('flip'));});
  if(winner)once('w',()=>{const won=g.myWin>0n||state.my_bets.some(b=>b.option_id===winner);audio.play(won?'win':g.myStake>0n?'lose':'select');
   if(g.mine[winner]){const x=ZONE_X[winner]+ZONE_W/2,y=950;setCoins(Array.from({length:12},(_,k)=>({id:round.id+k,x,y,dx:BALANCE[0]-x+(k-6)*10,dy:BALANCE[1]-y,delay:k*55})));setTimeout(()=>audio.play('coin'),700);setTimeout(()=>setCoins([]),2200);}});},[now]);
 useEffect(()=>{if(phase==='betting'&&secs<=3&&secs>0)once('t'+secs,()=>audio.play('tick'));},[secs]);
 const totals=state.totals||{};
 const doubleBets=async()=>{audio.play('chips');for(const [o,v] of Object.entries(g.mine))if(GAME.chips.includes(String(v)))await g.bet(o,String(v));else for(const c of [...GAME.chips].reverse()){let left=v;while(left>=BigInt(c)){await g.bet(o,c);left-=BigInt(c);}}};
 return <Stage plate={img('plate')} className={`tp-${phase}`} dir={isRtl()?'rtl':'ltr'}>
  <Box x={129} y={214} w={179} h={54} className={`tp-timer ${phase==='betting'&&secs<=5?'urgent':''}`}>{phase==='betting'?`${t('bet').toUpperCase()} ${secs}s`:phase==='drawing'?t('drawing'):t('result')}</Box>
  <RechargeTap x={688} y={32} w={170} h={46}/><Box x={688} y={32} w={170} h={46} className="tp-balance">{g.balance===null?'—':<CountUp value={Number(g.balance)} format={v=>full(Math.round(v))}/>}</Box>
  <PhaseBanner round={round} phase={phase} text={{betting:t('startBet'),drawing:t('stopBet')}} onShow={p=>audio.play(p==='betting'?'shuffle':'close')}/>
  {winner&&<span className="cs-burst" style={{left:CARD_X[winner],top:CARD_Y}}/>}
  {HANDS.map((id,i)=><div key={id} className={`tp-hand ${winner===id?'win':''} ${winner&&winner!==id?'lose':''}`} style={{left:CARD_X[id],top:CARD_Y}}>
   {[0,1,2].map(k=><Card key={k} i={k} code={result&&shown(i)?result.hands[id][k]:null} open={!!result&&shown(i)} dealt={phase!=='betting'}/>)}
   {result&&shown(i)&&<span className="tp-cat">{t(result.categories[id])}</span>}
   {winner===id&&<span className="tp-ribbon">{t('winner')} ×{MULT}</span>}
  </div>)}
  {HANDS.map(id=><button key={id} className={`tp-zone ${winner===id?'win':''}`} style={{left:ZONE_X[id],top:689,width:ZONE_W,height:381}} onClick={()=>{if(phase!=='betting')return;audio.play('chip');const i=GAME.chips.indexOf(chip),f={id:Math.random(),x:CHIP_X[i],y:CHIP_Y,tx:ZONE_X[id]+ZONE_W/2,ty:960,label:short(chip)};setFlies(v=>[...v,f]);requestAnimationFrame(()=>requestAnimationFrame(()=>setFlies(v=>v.map(x=>x.id===f.id?{...x,go:true}:x))));setTimeout(()=>setFlies(v=>v.filter(x=>x.id!==f.id)),500);g.bet(id,chip);}} aria-label={LABEL[id]}>
   <span className="tp-total">{full(totals[id]?.stake_minor||0)}</span>
   <span className="tp-players">{t('players',[totals[id]?.players||0])}</span>
   {g.mine[id]?<span className="tp-mine"><i/>{short(g.mine[id])}</span>:null}
  </button>)}
  {GAME.chips.map((c,i)=><button key={c} className={`tp-chip ${chip===c?'on':''}`} style={{left:CHIP_X[i]-84,top:CHIP_Y-84}} onClick={()=>{setChip(c);audio.play('click');}} aria-label={short(c)}/>)}
  <button className="tp-btn" style={{left:37,top:1267,width:418,height:117}} disabled={phase!=='betting'||!g.canRepeat} onClick={()=>{audio.play('chips');g.repeat();}} aria-label={t('repeat')}/>
  <button className="tp-btn" style={{left:486,top:1267,width:418,height:117}} disabled={phase!=='betting'||!g.myStake} onClick={doubleBets} aria-label={t('double')}/>
  <Box x={50} y={1466} w={724} h={120} className="tp-road">{state.history.slice(0,24).reverse().map(h=><i key={h.seq} className={`d-${h.outcome}`}>{LABEL[h.outcome]}</i>)}</Box>
  {flies.map(f=><span key={f.id} className="cs-fly tp-flychip" style={{left:f.x-40,top:f.y-40,transform:f.go?`translate(${f.tx-f.x}px,${f.ty-f.y}px) scale(.7)`:'none',opacity:f.go?.3:1}}>{f.label}</span>)}
  {coins.map(c=><span key={c.id} className="cs-coin" style={{left:c.x-22,top:c.y-22,'--dx':`${c.dx}px`,'--dy':`${c.dy}px`,animationDelay:`${c.delay}ms`}}/>)}
  <div className="cs-menu" style={{right:24,top:104}}>
   <button className="cs-icon-btn tp-ib" onClick={()=>setMenu(m=>!m)} aria-label="menu">≡</button>
   {menu&&<><button className="cs-icon-btn tp-ib" onClick={()=>{setRules(true);setMenu(false);}}>?</button>
    <button className="cs-icon-btn tp-ib" onClick={()=>{setRecords(true);setMenu(false);}} aria-label={t('records')}>📜</button>
    <button className="cs-icon-btn tp-ib" onClick={audio.toggle}>{audio.muted?'🔇':'🔊'}</button>
    <button className="cs-icon-btn tp-ib" onClick={g.exit}>⏻</button></>}
  </div>
  {phase==='result'&&(g.myWin>0n||g.myStake>0n)&&<Box x={220} y={880} w={500} h={110} className="tp-banner">{g.myWin>0n?<p>{t('youWon')} <b><CountUp value={Number(g.myWin)} format={v=>full(Math.round(v))}/></b></p>:<p>{t('noWin')}</p>}</Box>}
  {g.offline&&<div className="cs-toast">{t('offline')}</div>}
  {g.toast&&<div className="cs-toast" key={g.toast.id}>{t(g.toast.key,[GAME.maxOptionsPerRound])}</div>}
  {rules&&<div className="cs-modal-back" onClick={()=>setRules(false)}><div className="cs-modal" onClick={e=>e.stopPropagation()}>
   <h2>{t('rules')}</h2><p>{t('pattiRules').replace(/红宝石、翡翠、蓝宝石|Ruby, Emerald and Sapphire|الياقوت والزمرد والياقوت الأزرق/,'A / B / C')}</p><h2>{t('fair')}</h2><p>{t('fairText')}</p><small>commitment: {round.commitment}</small>{round.seed&&<small>seed: {round.seed}</small>}
   <button className="cs-gold-btn" onClick={()=>setRules(false)}>{t('close')}</button></div></div>}
   {records&&<HistoryModal onClose={()=>setRecords(false)} label={id=>LABEL[id]||id}/>}
 </Stage>;
}
