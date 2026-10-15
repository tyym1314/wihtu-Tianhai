import React,{useEffect,useRef,useState} from 'react';
import {t,isRtl} from '../../shared/i18n.mjs';
import {useRound,full,short} from '../../shared/useRound.js';
import {useAudio} from '../../shared/audio.mjs';
import {Stage,Box,CountUp} from '../../shared/Stage.jsx';
import {CASINO_GAMES} from '../../../shared/casino-games.mjs';
import './greedylion.css';

const GAME=CASINO_GAMES.greedylion;
const img=n=>`/casino/greedylion/${n}.webp`;
// Design-pixel positions measured on the 941x1672 concept plate (clockwise from the top plate).
const ORDER=['tomato','corn','carrot','lettuce','shrimp','fish','steak','chicken'];
const PLATE={tomato:[472,652],corn:[670,736],carrot:[740,933],lettuce:[673,1109],shrimp:[472,1179],fish:[271,1107],steak:[201,930],chicken:[268,736]};
const CHIP_X=[75,212,348,484,620],CHIP_Y=1425,CENTER=[472,923],BALANCE=[808,45];
const MULT=Object.fromEntries(GAME.options.map(o=>[o.id,o.multiplier]));
const SPARKS=[[40,300],[118,420],[60,980],[905,640],[860,1010],[150,1270],[800,1300],[420,520]];
const icon=id=>ORDER.includes(id)?img(`icon-${id}`):img(id);

export default function GreedyLion({initial}){
 const g=useRound(initial,GAME),{state,round,phase,now}=g,audio=useAudio('greedylion',['chip','tick','win','lose','coin','click','select']);
 const [chip,setChip]=useState(GAME.chips[1]),[menu,setMenu]=useState(false),[rules,setRules]=useState(false);
 const [light,setLight]=useState(-1),[flies,setFlies]=useState([]),[coins,setCoins]=useState([]);
 const lastStep=useRef(-1),lastSec=useRef(-1),played=useRef(null);

 // Travelling light during the draw: ease-out over the draw window, landing on the outcome.
 useEffect(()=>{
  if(phase==='betting'){setLight(-1);lastStep.current=-1;return;}
  const r=round.result;if(!r)return;
  const target=ORDER.indexOf(r.outcome),special=target<0,end=round.reveal_at-450;
  const steps=special?4*ORDER.length:3*ORDER.length+target,p=Math.min(1,Math.max(0,(now-round.bet_until)/(end-round.bet_until)));
  const step=Math.floor((1-(1-p)**3)*steps);
  if(now>=end)setLight(special?-2:target);else{setLight(step%ORDER.length);if(step!==lastStep.current){lastStep.current=step;audio.play('tick',{volume:.5,rate:1+p*.3});}}
 },[now,phase,round]);
 // Countdown ticks in the last five seconds.
 const secs=Math.max(0,Math.ceil((round.bet_until-now)/1000));
 useEffect(()=>{if(phase==='betting'&&secs<=5&&secs>0&&secs!==lastSec.current){lastSec.current=secs;audio.play('tick');}},[secs,phase]);
 // Reveal: win/lose jingle and coins flying from the winning plates to the balance.
 useEffect(()=>{
  if(phase!=='result'||played.current===round.id||!round.result)return;played.current=round.id;
  const won=g.myWin>0n;audio.play(won?'win':g.myStake>0n?'lose':'select');
  if(won){const from=round.result.winners.filter(w=>PLATE[w]&&g.mine[w]).map(w=>PLATE[w]);
   setCoins(from.flatMap(([x,y],k)=>Array.from({length:10},(_,i)=>({id:`${round.id}-${k}-${i}`,x,y,dx:BALANCE[0]-x+(i-5)*8,dy:BALANCE[1]-y,delay:i*60}))));
   setTimeout(()=>audio.play('coin'),700);setTimeout(()=>setCoins([]),2200);}
 },[phase,round,g.myWin]);

 function bet(id){
  if(phase!=='betting')return;audio.play('chip');
  const i=GAME.chips.indexOf(chip),[tx,ty]=PLATE[id],f={id:Math.random(),x:CHIP_X[i],y:CHIP_Y,tx,ty,label:short(chip)};
  setFlies(v=>[...v,f]);requestAnimationFrame(()=>requestAnimationFrame(()=>setFlies(v=>v.map(x=>x.id===f.id?{...x,go:true}:x))));
  setTimeout(()=>setFlies(v=>v.filter(x=>x.id!==f.id)),500);g.bet(id,chip);
 }
 const winners=phase==='result'&&round.result?round.result.winners:[];
 const totals=state.totals||{};
 return <Stage plate={img('plate')} className={`gl-${phase}`} dir={isRtl()?'rtl':'ltr'}>
  {SPARKS.map(([x,y],i)=><span key={i} className="cs-sparkle" style={{left:x,top:y,animationDelay:`${i*.37}s`}}/>)}
  <Box x={517} y={30} w={116} h={116} className={`gl-timer ${phase==='betting'&&secs<=5?'urgent':''}`}>
   {phase==='betting'?<><small>{t('bet')}</small><b>{secs}s</b></>:phase==='drawing'?<b className="gl-spin">★</b>:<small>{t('result')}</small>}
  </Box>
  <Box x={742} y={20} w={132} h={50} className="gl-balance">{g.balance===null?'—':<CountUp value={Number(g.balance)} format={v=>full(Math.round(v))}/>}</Box>
  <Box x={672} y={150} w={248} h={112} className="gl-winners">
   {(state.today_winners||[]).length?state.today_winners.map((w,i)=><div key={w.external_user_id}><em className={`r${i}`}>{w.external_user_id===state.me?'★':(w.external_user_id[0]||'?').toUpperCase()}</em><span>{w.external_user_id===state.me?t('myBet'):w.external_user_id.slice(0,9)}</span><b>{short(w.payout_minor)}</b></div>)
    :<p>—</p>}
  </Box>
  {ORDER.map((id,i)=>{const [x,y]=PLATE[id];return <React.Fragment key={id}>
   <button className={`gl-plate ${light===i||light===-2&&winners.includes(id)?'lit':''} ${winners.includes(id)?'win':''} ${phase==='result'&&winners.length&&!winners.includes(id)?'dim':''}`} style={{left:x-86,top:y-98}} onClick={()=>bet(id)} aria-label={`${id} x${MULT[id]}`}/>
   <Box x={x-46} y={y+44} w={92} h={34} className="gl-mult">x{MULT[id]}</Box>
   {totals[id]&&<Box x={x-60} y={y-118} w={120} h={30} className="gl-total">{short(totals[id].stake_minor)}</Box>}
   {g.mine[id]&&<Box x={x+30} y={y-70} w={84} h={40} className="gl-mine">{short(g.mine[id])}</Box>}
  </React.Fragment>;})}
  {phase==='result'&&round.result&&<Box x={CENTER[0]-95} y={CENTER[1]-95} w={190} h={190} className="gl-center"><img src={icon(round.result.outcome)} alt=""/></Box>}
  {phase==='result'&&round.result&&<Box x={170} y={1250} w={600} h={110} className="gl-banner">
   {!ORDER.includes(round.result.outcome)&&<p className="special">{t(round.result.outcome)}</p>}
   {g.myWin>0n?<p className="won">{t('youWon')} <b><CountUp value={Number(g.myWin)} format={v=>full(Math.round(v))}/></b></p>:<p>{g.myStake>0n?t('noWin'):t('next')}</p>}
  </Box>}
  {GAME.chips.map((c,i)=><button key={c} className={`gl-chip ${chip===c?'on':''}`} style={{left:CHIP_X[i]-62,top:CHIP_Y-62}} onClick={()=>{setChip(c);audio.play('click');}} aria-label={short(c)}/>)}
  <button className="gl-repeat" style={{left:720,top:1384,width:204,height:84}} disabled={phase!=='betting'||!g.canRepeat} onClick={()=>{audio.play('chips');g.repeat();}} aria-label={t('repeat')}><span>{t('repeat')}</span></button>
  <Box x={36} y={1566} w={644} h={66} className="gl-results">{state.history.slice(0,10).map(h=><img key={h.seq} src={icon(h.outcome)} alt={h.outcome}/>)}</Box>
  {flies.map(f=><span key={f.id} className="cs-fly gl-flychip" style={{left:f.x-34,top:f.y-34,transform:f.go?`translate(${f.tx-f.x}px,${f.ty-f.y}px) scale(.7)`:'none',opacity:f.go?.2:1}}>{f.label}</span>)}
  {coins.map(c=><span key={c.id} className="cs-coin" style={{left:c.x-22,top:c.y-22,'--dx':`${c.dx}px`,'--dy':`${c.dy}px`,animationDelay:`${c.delay}ms`}}/>)}
  <div className="cs-menu" style={{right:22,top:290}}>
   <button className="cs-icon-btn" onClick={()=>setMenu(m=>!m)} aria-label="menu">≡</button>
   {menu&&<><button className="cs-icon-btn" onClick={()=>{setRules(true);setMenu(false);}} aria-label={t('rules')}>?</button>
    <button className="cs-icon-btn" onClick={audio.toggle} aria-label={t('sound')}>{audio.muted?'🔇':'🔊'}</button>
    <button className="cs-icon-btn" onClick={g.exit} aria-label="exit">⏻</button></>}
  </div>
  {g.offline&&<div className="cs-toast">{t('offline')}</div>}
  {g.toast&&<div className="cs-toast" key={g.toast.id}>{t(g.toast.key,[GAME.maxOptionsPerRound])}</div>}
  {rules&&<div className="cs-modal-back gl-modal" onClick={()=>setRules(false)}><div className="cs-modal" onClick={e=>e.stopPropagation()}>
   <h2>{t('rules')}</h2><p>{t('lionRules')}</p><h2>{t('fair')}</h2><p>{t('fairText')}</p><small>commitment: {round.commitment}</small>{round.seed&&<small>seed: {round.seed}</small>}
   <button className="cs-gold-btn" onClick={()=>setRules(false)}>{t('close')}</button></div></div>}
 </Stage>;
}
