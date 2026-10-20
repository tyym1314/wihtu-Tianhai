import {ChipRow,chipAt} from '../../shared/ChipRow.jsx';
import React,{useEffect,useRef,useState} from 'react';
import {t,isRtl} from '../../shared/i18n.mjs';
import {useRound,full,short} from '../../shared/useRound.js';
import {useAudio} from '../../shared/audio.mjs';
import {Stage,Box,CountUp,PhaseBanner} from '../../shared/Stage.jsx';
import {RechargeTap,useHostBalance} from '../../shared/recharge.jsx';
import {HistoryModal} from '../../shared/History.jsx';
import {tableRules,tableOptionName} from './rules.mjs';
import {CASINO_GAMES} from '../../../shared/casino-games.mjs';
import {TABLES} from './layouts.mjs';
import '../wheel/wheel.css';
import './table.css';

export const WHEEL_ORDER=[0,32,15,19,4,21,2,25,17,34,6,27,13,36,11,30,8,23,10,5,24,16,33,1,20,14,31,9,22,18,29,7,28,12,35,3,26];
const RED=new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
export const numColor=n=>n===0?'green':RED.has(n)?'red':'black';
const SPARKS=[[60,320],[880,420],[90,1040],[860,1100],[460,250]];
const ease=p=>1-(1-p)**3;
const pip={1:[4],2:[0,8],3:[0,4,8],4:[0,2,6,8],5:[0,2,4,6,8],6:[0,2,3,5,6,8]};
export const Die=({v,size})=><span className={`tg-die ${v===1||v===4?'red':''}`} style={{width:size,height:size}}>{pip[v].map(i=><i key={i} style={{left:`${25+(i%3)*25}%`,top:`${25+Math.floor(i/3)*25}%`}}/>)}</span>;
const dice=o=>o.slice(1).split('').map(Number);

/** The European wheel: number ring is SVG (exact pocket order), the plate's own turret is rotated with it. */
function Roulette({d,plate,angle,ball}){
 const [cx,cy,r1,r0,rt]=d.wheel,step=360/37;
 return <>
  <div className="tg-turret" style={{left:cx-rt,top:cy-rt,width:2*rt,height:2*rt,backgroundImage:`url(${plate})`,backgroundPosition:`${-(cx-rt)}px ${-(cy-rt)}px`,transform:`rotate(${angle}deg)`}}/>
  <svg className="tg-ring" style={{left:cx-r1,top:cy-r1,width:2*r1,height:2*r1}} viewBox={`${-r1} ${-r1} ${2*r1} ${2*r1}`}>
   <g transform={`rotate(${angle})`}>
    {WHEEL_ORDER.map((n,i)=>{const a0=(i*step-step/2-90)*Math.PI/180,a1=(i*step+step/2-90)*Math.PI/180,p=(r,a)=>`${r*Math.cos(a)} ${r*Math.sin(a)}`;
     return <g key={n}><path d={`M${p(r0,a0)} L${p(r1,a0)} A${r1} ${r1} 0 0 1 ${p(r1,a1)} L${p(r0,a1)} A${r0} ${r0} 0 0 0 ${p(r0,a0)}Z`} className={`pk ${numColor(n)}`}/>
      <text transform={`rotate(${i*step}) translate(0 ${-(r1-(r1-r0)*.28)})`} className="pn" style={{fontSize:(r1-r0)*.21}}>{n}</text></g>;})}
    <circle r={r1} className="rim"/><circle r={r0} className="rim"/>
   </g>
   {ball&&<circle cx={ball[1]*Math.sin(ball[0]*Math.PI/180)} cy={-ball[1]*Math.cos(ball[0]*Math.PI/180)} r={(r1-r0)*.17} className="ball"/>}
  </svg>
 </>;
}

/** Roulette / SicBo style table games: bets on board cells, outcome drawn by a wheel or a dice cup. */
export default function TableGame({initial}){
 const id=initial.game_id,GAME=CASINO_GAMES[id],L=TABLES[id],img=n=>`/casino/${id}/${n}.webp?v=${__ASSET_VERSION__}`,D=L.drawer;
 const g=useRound(initial,GAME),{state,round,phase,now}=g;
 const audio=useAudio(id,['chip','tick','win','lose','coin','click','select','close','chips','spin','dice','throw']);
 const [chip,setChip]=useState(GAME.chips[1]),[menu,setMenu]=useState(false),[records,setRecords]=useState(false),[rules,setRules]=useState(false);
 const [flies,setFlies]=useState([]),[coins,setCoins]=useState([]);
 const lastSec=useRef(-1),played=useRef(null),rolled=useRef(null);
 const result=round.result,outcome=result?.outcome;
 const winning=o=>outcome&&(o.covers?o.covers.includes(outcome):o.id===outcome);
 const winners=phase==='result'&&outcome?GAME.options.filter(winning).map(o=>o.id):[];
 const secs=Math.max(0,Math.ceil((round.bet_until-now)/1000));
 const p=Math.min(1,Math.max(0,(now-round.bet_until)/(round.reveal_at-600-round.bet_until)));
 useEffect(()=>{if(phase==='betting'&&secs<=5&&secs>0&&secs!==lastSec.current){lastSec.current=secs;audio.play('tick');}},[secs,phase]);
 useEffect(()=>{if(phase==='drawing'&&rolled.current!==round.id){rolled.current=round.id;if(D.type==='dice')audio.play('dice');}},[phase,round.id]);
 useEffect(()=>{
  if(phase!=='result'||played.current===round.id||!result)return;played.current=round.id;
  const won=g.myWin>0n;audio.play(won?'win':g.myStake>0n?'lose':'select');
  if(won){const bal=[L.balance[0]+L.balance[2]/2,L.balance[1]+L.balance[3]/2];
   const from=GAME.options.filter(o=>winning(o)&&g.mine[o.id]).map(o=>{const [x,y,w,h]=L.cells[o.id];return [x+w/2,y+h/2];});
   setCoins(from.flatMap(([x,y],k)=>Array.from({length:10},(_,i)=>({id:`${round.id}-${k}-${i}`,x,y,dx:bal[0]-x+(i-5)*8,dy:bal[1]-y,delay:i*60}))));
   setTimeout(()=>audio.play('coin'),700);setTimeout(()=>setCoins([]),2200);}
 },[phase,round,g.myWin]);

 const cupLift=D.type==='dice'?(phase==='betting'?0:phase==='drawing'?Math.max(0,(p-.72)/.28):1):0;
 // Roulette motion: the wheel turns 2 turns and decelerates; the ball runs 5 turns the other way and drops into the drawn pocket.
 let angle=0,ball=null;
 if(D.type==='roulette'){
  const [,, r1,r0]=D.wheel,start=(round.bet_until/40)%360,e=ease(p),n=outcome?Number(outcome.slice(1)):null;
  if(phase==='betting'){angle=(start+(now/40)%360)%360;}
  else if(n!==null){const end=start+720,pocket=WHEEL_ORDER.indexOf(n)*360/37;angle=start+720*e;
   const fin=end+pocket,ba=fin+1800*(1-ease(Math.min(1,p*1.15)));ball=[ba,p<.7?r1+(r1-r0)*.12:r1+(r1-r0)*.12-(r1-r0)*.55*Math.min(1,(p-.7)/.3)];
   if(phase==='result'){angle=end;ball=[fin,r0+(r1-r0)*.57];}}
 }

 // Ball passing pockets ticks; the cup landing plays the throw.
 const lastPocket=useRef(-1),lastTick=useRef(0),thrown=useRef(null);
 useEffect(()=>{if(phase!=='drawing')return;
  if(ball){const k=Math.floor(((ball[0]-angle)%360+360)%360/(360/37));if(k!==lastPocket.current&&performance.now()-lastTick.current>55){lastPocket.current=k;lastTick.current=performance.now();audio.play('tick',{volume:.25,rate:1.6});}}
  if(D.type==='dice'&&cupLift>0&&thrown.current!==round.id){thrown.current=round.id;audio.play('throw');}
 },[now]);
 function bet(o){
  if(phase!=='betting')return;audio.play('chip');
  const i=GAME.chips.indexOf(chip),[x,y,w,h]=L.cells[o];
  const [cx,cy]=chipAt(id,i)||[L.chips.xs[i],L.chips.y],f={id:Math.random(),x:cx,y:cy,tx:x+w/2,ty:y+h/2,label:short(chip)};
  setFlies(v=>[...v,f]);requestAnimationFrame(()=>requestAnimationFrame(()=>setFlies(v=>v.map(z=>z.id===f.id?{...z,go:true}:z))));
  setTimeout(()=>setFlies(v=>v.filter(z=>z.id!==f.id)),500);g.bet(o,chip);
 }
 const totals=state.totals||{},[tx,ty,tr]=L.timer,[bx,by,bw,bh]=L.balance,[bnx,bny,bnw]=L.banner;
 const label=o=>tableOptionName(o,id);
 const outcomeText=o=>o[0]==='n'?o.slice(1):dice(o).join(' ');
 return <Stage plate={img('plate')} className={`wg tg tg-${id} wg-${phase}`} dir={isRtl()?'rtl':'ltr'}>
  {(L.glows||[]).map(([x,y,r],i)=><span key={'g'+i} className="cs-glow" style={{left:x-r,top:y-r,width:2*r,height:2*r,background:`radial-gradient(${L.accent}aa,${L.accent}33 40%,transparent 70%)`,animationDelay:`${i*.53}s`}}/>)}
  {SPARKS.map(([x,y],i)=><span key={i} className="cs-sparkle" style={{left:x,top:y,animationDelay:`${i*.37}s`}}/>)}
  {D.type==='roulette'&&<Roulette d={D} plate={img('plate')} angle={angle} ball={ball}/>}
  {D.type==='dice'&&<>
   {phase!=='betting'&&outcome&&<div className="tg-dice" style={{left:D.dice[0],top:D.dice[1]}}>{dice(outcome).map((v,i)=><Die key={i} v={v} size={D.dice[2]}/>)}</div>}
   <img className={`tg-cup ${phase==='drawing'&&cupLift===0?'shake':''}`} src={img('cup')} alt="" style={{left:D.cup[0],top:D.cup[1],width:D.cup[2],height:D.cup[3],transform:`translateY(${-cupLift*D.lift}px)`,opacity:1-cupLift*.85}}/>
  </>}
  {phase==='result'&&outcome&&<Box x={L.outcome[0]-90} y={L.outcome[1]-90} w={180} h={180} className={`tg-outcome ${outcome[0]==='n'?numColor(Number(outcome.slice(1))):'dice'}`}>
   <b>{outcome[0]==='n'?outcome.slice(1):dice(outcome).reduce((a,b)=>a+b,0)}</b></Box>}
  <PhaseBanner round={round} phase={phase} text={{betting:t('startBet'),drawing:t('stopBet')}} onShow={x=>audio.play(x==='betting'?'select':'close')}/>
  <Box x={tx-tr} y={ty-tr} w={2*tr} h={2*tr} className={`wg-timer ${phase==='betting'&&secs<=5?'urgent':''} plain`} style={{'--tf':`${Math.round(tr*.8)}px`}}>
   {phase==='betting'?<b>{secs}</b>:phase==='drawing'?<b className="wg-spin">★</b>:<small>{t('result')}</small>}
  </Box>
  {L.newBox&&state.history[0]&&<Box x={L.newBox[0]} y={L.newBox[1]} w={L.newBox[2]} h={L.newBox[3]} className="tg-new">
   {state.history[0].outcome[0]==='n'?<span className={`tg-num ${numColor(Number(state.history[0].outcome.slice(1)))}`}>{state.history[0].outcome.slice(1)}</span>:dice(state.history[0].outcome).map((v,i)=><Die key={i} v={v} size={L.newBox[3]*.62}/>)}</Box>}
  <RechargeTap x={bx} y={by} w={bw} h={bh}/><Box x={bx} y={by} w={bw} h={bh} className="wg-balance">{g.balance===null?'—':<CountUp value={Number(g.balance)} format={v=>full(Math.round(v))}/>}</Box>
  {GAME.options.map(o=>{const [x,y,w,h]=L.cells[o.id];return <React.Fragment key={o.id}>
   <button className={`tg-cell ${winners.includes(o.id)?'win':''} ${phase==='result'&&winners.length&&!winners.includes(o.id)?'dim':''}`} style={{left:x,top:y,width:w,height:h}} onClick={()=>bet(o.id)} aria-label={`${label(o.id)} x${o.multiplier}`}/>
   {totals[o.id]&&<Box x={x+w/2-60+(L.totalAt?.[0]||0)} y={y+(L.totalAt?.[1]??4)} w={120} h={30} className="wg-total">{short(totals[o.id].stake_minor)}</Box>}
   {g.mine[o.id]&&<Box x={x+w-92} y={y+h-46} w={84} h={40} className="wg-mine">{short(g.mine[o.id])}</Box>}
  </React.Fragment>;})}
  {phase==='result'&&result&&(g.myWin>0n||g.myStake>0n)&&<Box x={bnx} y={bny} w={bnw} h={110} className="wg-banner">
   {g.myWin>0n?<p className="won">{t('youWon')} <b><CountUp value={Number(g.myWin)} format={v=>full(Math.round(v))}/></b></p>:<p>{t('noWin')}</p>}
  </Box>}
  <ChipRow id={id} chips={GAME.chips} isOn={c=>chip===c} onPick={c=>{setChip(c);audio.play('click');}}/>
  <button className="wg-repeat" style={{left:L.repeat[0],top:L.repeat[1],width:L.repeat[2],height:L.repeat[3]}} disabled={phase!=='betting'||!g.canRepeat} onClick={()=>{audio.play('chips');g.repeat();}} aria-label={t('repeat')}/>
  {L.rulesBtn&&<button className="wg-hot" style={{left:L.rulesBtn[0]-L.rulesBtn[2],top:L.rulesBtn[1]-L.rulesBtn[2],width:2*L.rulesBtn[2],height:2*L.rulesBtn[2],borderRadius:'50%'}} onClick={()=>{audio.play('click');setRules(true);}} aria-label={t('rules')}/>}
  {L.backBtn&&<button className="wg-hot" style={{left:L.backBtn[0]-L.backBtn[2],top:L.backBtn[1]-L.backBtn[2],width:2*L.backBtn[2],height:2*L.backBtn[2],borderRadius:'50%'}} onClick={g.exit} aria-label="exit"/>}
  {L.results&&<Box x={L.results[0]} y={L.results[1]} w={L.results[2]} h={L.results[3]} className={`tg-results ${L.resultsStyle||''}`}>
   {state.history.slice(0,L.resultsMax||12).map(h=>h.outcome[0]==='n'?<span key={h.seq} className={`tg-num ${numColor(Number(h.outcome.slice(1)))}`}>{h.outcome.slice(1)}</span>
    :<span key={h.seq} className="tg-dset">{dice(h.outcome).map((v,i)=><Die key={i} v={v} size={L.results[3]*(L.resultsDie||.36)}/>)}</span>)}
  </Box>}
  {flies.map(f=><span key={f.id} className="cs-fly wg-flychip" style={{left:f.x-34,top:f.y-34,transform:f.go?`translate(${f.tx-f.x}px,${f.ty-f.y}px) scale(.7)`:'none',opacity:f.go?.2:1}}>{f.label}</span>)}
  {coins.map(c=><span key={c.id} className="cs-coin" style={{left:c.x-22,top:c.y-22,'--dx':`${c.dx}px`,'--dy':`${c.dy}px`,animationDelay:`${c.delay}ms`}}/>)}
  <div className="cs-menu" style={{right:22,top:L.menuY??20}}>
   <button className="cs-icon-btn" onClick={()=>setMenu(m=>!m)} aria-label="menu">≡</button>
   {menu&&<><button className="cs-icon-btn" onClick={()=>{setRules(true);setMenu(false);}} aria-label={t('rules')}>?</button>
    <button className="cs-icon-btn" onClick={()=>{setRecords(true);setMenu(false);}} aria-label={t('records')}>📜</button>
    <button className="cs-icon-btn" onClick={audio.toggle} aria-label={t('sound')}>{audio.muted?'🔇':'🔊'}</button>
    <button className="cs-icon-btn" onClick={g.exit} aria-label="exit">⏻</button></>}
  </div>
  {g.offline&&<div className="cs-toast">{t('offline')}</div>}
  {g.toast&&<div className="cs-toast" key={g.toast.id}>{t(g.toast.key,[GAME.maxOptionsPerRound])}</div>}
  {rules&&<div className="cs-modal-back" onClick={()=>setRules(false)}><div className="cs-modal" onClick={e=>e.stopPropagation()}>
   <h2>{t('rules')}</h2><p>{tableRules(GAME)}</p><h2>{t('fair')}</h2><p>{t('fairText')}</p>
   <button className="cs-gold-btn" onClick={()=>setRules(false)}>{t('close')}</button></div></div>}
  {records&&<HistoryModal onClose={()=>setRecords(false)} label={o=>o[0]==='n'||o[0]==='d'&&/^d\d{3}$/.test(o)?outcomeText(o):label(o)}/>}
 </Stage>;
}
