import {useCelebration} from '../../shared/fx/Celebrate.jsx';
import React,{useEffect,useRef,useState} from 'react';
import {t,isRtl} from '../../shared/i18n.mjs';
import {useRound,full,short} from '../../shared/useRound.js';
import {useAudio} from '../../shared/audio.mjs';
import {Stage,Box,CountUp,PhaseBanner} from '../../shared/Stage.jsx';
import {RechargeTap,useHostBalance} from '../../shared/recharge.jsx';
import {HistoryModal} from '../../shared/History.jsx';
import {wheelRules,optionName} from '../../shared/rules.mjs';
import {RIMS,CHIP_FIX} from './rims.mjs';
import {CASINO_GAMES} from '../../../shared/casino-games.mjs';
import {LAYOUTS} from './layouts.mjs';
import {ChipRow,chipAt} from '../../shared/ChipRow.jsx';
import './wheel.css';

const SPARKS=[[60,320],[880,420],[90,1040],[860,1100],[460,250],[300,1300],[700,1300]];
const ell=([x,y,rx,ry])=>({left:x-rx,top:y-ry,width:2*rx,height:2*ry,borderRadius:'50%'});
const rect=([x,y,a,b])=>b===undefined?{left:x-a,top:y-a,width:2*a,height:2*a,borderRadius:'50%'}:{left:x-a/2,top:y-b/2,width:a,height:b,borderRadius:22};

/** Greedy-style shared-round game rendered on its concept plate; everything game-specific comes from LAYOUTS. */
export default function WheelGame({initial}){
 const id=initial.game_id,GAME=CASINO_GAMES[id],L=CHIP_FIX[id]?{...LAYOUTS[id],chips:{...LAYOUTS[id].chips,...CHIP_FIX[id]}}:LAYOUTS[id],img=n=>`/casino/${id}/${n}.webp?v=${__ASSET_VERSION__}`;
 const g=useRound(initial,GAME),{state,round,phase,now}=g;
 const audio=useAudio(id,['chip','tick','win','lose','coin','click','select','close','chips','spin','ding','nice','stamp','rollup','roll-end','charge','cheer','celebrate-loop','sting-big','sting-mega','sting-epic','sting-legend']);
 const fx=useCelebration(id,audio);
 const [chip,setChip]=useState(GAME.chips[1]),[menu,setMenu]=useState(false),[records,setRecords]=useState(false),[rules,setRules]=useState(false);
 const [light,setLight]=useState(-1),[landed,setLanded]=useState(false),[flies,setFlies]=useState([]),[coins,setCoins]=useState([]);
 const [sessionWin,setSessionWin]=useState(0);
 const lastStep=useRef(-1),lastSec=useRef(-1),played=useRef(null);
 const ORDER=L.order,MULT=Object.fromEntries(GAME.options.map(o=>[o.id,o.multiplier]));
 const icon=o=>L.items[o]?img(`icon-${o}`):null;
 const groupOf=s=>GAME.options.filter(o=>o.group===GAME.specials?.find(x=>x.id===s)?.covers).map(o=>o.id);
 const result=round.result,bonus=result?.bonus;
 // The light runs over the draw window and lands on the drawn item (specials light every covered item).
 const end=round.reveal_at-(L.miniReels?2200:450);
 useEffect(()=>{
  if(phase==='betting'){setLight(-1);setLanded(false);lastStep.current=-1;return;}
  if(!result)return;
  const target=ORDER.indexOf(result.outcome),special=target<0,steps=special?4*ORDER.length:3*ORDER.length+target;
  const p=Math.min(1,Math.max(0,(now-round.bet_until)/(end-round.bet_until))),step=Math.floor((1-(1-p)**3)*steps);
  if(now>=end){setLight(special?-2:target);if(!landed){setLanded(true);audio.play(special?'win':'select');}}
  else{setLight(step%ORDER.length);if(step!==lastStep.current){lastStep.current=step;audio.play('tick',{volume:.5,rate:1+p*.3});}}
 },[now,phase,round]);
 const secs=Math.max(0,Math.ceil((round.bet_until-now)/1000));
 useEffect(()=>{if(phase==='betting'&&secs<=5&&secs>0&&secs!==lastSec.current){lastSec.current=secs;audio.play('tick');}},[secs,phase]);
 useEffect(()=>{
  if(phase!=='result'||played.current===round.id||!result)return;played.current=round.id;
  const won=g.myWin>0n;if(won){setSessionWin(v=>v+Number(g.myWin));fx.celebrate(g.myWin,g.myStake,{fast:true,within:round?.ends_at?round.ends_at-now:undefined});}else audio.play(g.myStake>0n?'lose':'select');
  if(won){const bal=[L.balance[0]+L.balance[2]/2,L.balance[1]+L.balance[3]/2];
   const from=result.winners.filter(w=>L.items[w]&&g.mine[w]).map(w=>L.items[w]);
   setCoins(from.flatMap(([x,y],k)=>Array.from({length:10},(_,i)=>({id:`${round.id}-${k}-${i}`,x,y,dx:bal[0]-x+(i-5)*8,dy:bal[1]-y,delay:i*60}))));
   setTimeout(()=>audio.play('coin'),700);setTimeout(()=>setCoins([]),2200);}
 },[phase,round,g.myWin]);

 function bet(o){
  if(phase!=='betting'||!MULT[o])return;audio.play('chip');
  const i=GAME.chips.indexOf(chip),target=L.items[o]||[L.groups[o][0]+L.groups[o][2]/2,L.groups[o][1]+L.groups[o][3]/2];
  const [cx,cy]=chipAt(id,i)||[L.chips.xs[i],L.chips.y],f={id:Math.random(),x:cx,y:cy,tx:target[0],ty:target[1],label:short(chip)};
  setFlies(v=>[...v,f]);requestAnimationFrame(()=>requestAnimationFrame(()=>setFlies(v=>v.map(x=>x.id===f.id?{...x,go:true}:x))));
  setTimeout(()=>setFlies(v=>v.filter(x=>x.id!==f.id)),500);g.bet(o,chip);
 }
 const winners=phase==='result'&&result?result.winners:[];
 const totals=state.totals||{},[tx,ty,tr]=L.timer,[bx,by,bw,bh]=L.balance,[bnx,bny,bnw]=Array.isArray(L.banner)?L.banner:[170,L.bannerY,600];
 const reelText=b=>!b||b.type==='none'?['—','—','—']:b.type==='jackpot'?['★','JACKPOT','★']:b.type==='multiplier'?['×'+b.value,'×'+b.value,'×'+b.value]:['+'+b.value,'FRUIT','+'+b.value];
 const reelsSpinning=L.miniReels&&phase==='drawing'&&now>=end-1800&&now<end;
 return <Stage plate={img('plate')} className={`wg wg-${id} wg-${phase}`} dir={isRtl()?'rtl':'ltr'}>
  {(L.glows||[]).map(([x,y,r],i)=><span key={'g'+i} className="cs-glow" style={{left:x-r,top:y-r,width:2*r,height:2*r,background:`radial-gradient(${L.accent}cc,${L.accent}44 40%,transparent 70%)`,animationDelay:`${i*.53}s`}}/>)}
  {SPARKS.map(([x,y],i)=><span key={i} className="cs-sparkle" style={{left:x,top:y,animationDelay:`${i*.37}s`}}/>)}
  <PhaseBanner round={round} phase={phase} text={{betting:t('startBet'),drawing:t('stopBet')}} onShow={p=>audio.play(p==='betting'?'select':'close')}/>
  {landed&&result&&result.winners.filter(w=>L.items[w]).map(w=><span key={w} className="cs-burst" style={{left:L.items[w][0],top:L.items[w][1]}}/>)}
  <Box x={tx-tr} y={ty-tr} w={2*tr} h={2*tr} className={`wg-timer ${phase==='betting'&&secs<=5?'urgent':''} ${L.timerStyle||''}`} style={{'--tf':`${Math.round(tr*.62)}px`}}>
   {L.timerStyle==='led'?<b>{phase==='betting'?String(secs).padStart(2,'0'):'--'}</b>:L.timerStyle==='clock'?<b>{`00:${String(phase==='betting'?secs:0).padStart(2,'0')}`}</b>:L.timerStyle==='plain'?(phase==='betting'?<b>{secs}s</b>:phase==='drawing'?<b className="wg-spin">★</b>:<small>{t('result')}</small>)
    :phase==='betting'?<><small>{t('bet')}</small><b>{secs}s</b></>:phase==='drawing'?<b className="wg-spin">★</b>:<small>{t('result')}</small>}
  </Box>
  <RechargeTap x={bx} y={by} w={bw} h={bh}/><Box x={bx} y={by} w={bw} h={bh} className="wg-balance">{g.balance===null?'—':<CountUp value={Number(g.balance)} format={v=>full(Math.round(v))}/>}</Box>
  {L.winners&&<Box x={L.winners[0]} y={L.winners[1]} w={L.winners[2]} h={L.winners[3]} className="wg-winners">
   {(state.today_winners||[]).length?state.today_winners.slice(0,L.winners[4]).map((w,i)=><div key={w.external_user_id}><em className={`r${i}`}>{w.external_user_id===state.me?'★':(w.external_user_id[0]||'?').toUpperCase()}</em><span>{w.external_user_id===state.me?t('myBet'):w.external_user_id.slice(0,9)}</span><b>{short(w.payout_minor)}</b></div>):<p>—</p>}
  </Box>}
  {L.pool&&<Box x={L.pool[0]} y={L.pool[1]} w={L.pool[2]} h={L.pool[3]} className="wg-jackpot"><CountUp value={Object.values(totals).reduce((a,x)=>a+Number(x.stake_minor),0)} format={v=>full(Math.round(v))}/></Box>}
  {L.todayWin&&<Box x={L.todayWin[0]} y={L.todayWin[1]} w={L.todayWin[2]} h={L.todayWin[3]} className="wg-balance"><CountUp value={sessionWin} format={v=>full(Math.round(v))}/></Box>}
  {L.jackpot&&<Box x={L.jackpot[0]} y={L.jackpot[1]} w={L.jackpot[2]} h={L.jackpot[3]} className="wg-jackpot"><CountUp value={Number(state.jackpot_minor||0)} format={v=>full(Math.round(v))}/></Box>}
  {L.miniReels&&L.miniReels.map(([x,y,w,h],i)=><Box key={i} x={x} y={y} w={w} h={h} className={`wg-reel ${reelsSpinning?'spinning':''} ${phase==='result'&&bonus&&bonus.type!=='none'?'hit':''}`}>
   <span>{reelsSpinning?'':(phase!=='betting'&&now>=end?reelText(bonus)[i]:'')}</span></Box>)}
  {ORDER.map((o,i)=>{const it=L.items[o];return <React.Fragment key={o}>
   <button className={`wg-item ${light===i||light===-2&&winners.includes(o)?'lit':''} ${winners.includes(o)?'win':''} ${phase==='result'&&winners.length&&!winners.includes(o)?'dim':''}`} style={RIMS[id]?.[o]?ell(RIMS[id][o]):rect(it)} onClick={()=>bet(o)} aria-label={`${o} x${MULT[o]}`}/>
   {totals[o]&&<Box x={it[0]-60+(L.totalAt?.[0]||0)} y={it[1]-(it[3]||2*it[2])/2-6+(L.totalAt?.[1]||0)} w={120} h={30} className="wg-total">{short(totals[o].stake_minor)}</Box>}
   {g.mine[o]&&<Box x={it[0]+(it[3]?it[2]/2-90:it[2]*.35)} y={it[1]-(it[3]?it[3]/2-6:it[2]*.95)} w={84} h={40} className="wg-mine">{short(g.mine[o])}</Box>}
  </React.Fragment>;})}
  {L.groups&&Object.entries(L.groups).map(([o,[x,y,w,h]])=>{const covered=GAME.options.find(x=>x.id===o).covers,hit=phase==='result'&&covered.some(c=>winners.includes(c));
   return <React.Fragment key={o}><button className={`wg-group ${hit?'win':''}`} style={{left:x,top:y,width:w,height:h}} onClick={()=>bet(o)} aria-label={o}/>
    {totals[o]&&<Box x={x+12} y={y+8} w={120} h={30} className="wg-total">{short(totals[o].stake_minor)}</Box>}
    {g.mine[o]&&<Box x={x+w-100} y={y+8} w={84} h={40} className="wg-mine">{short(g.mine[o])}</Box>}</React.Fragment>;})}
  {phase==='result'&&result&&!MULT[result.outcome]&&now<round.reveal_at+2200&&<div className="cs-special"><div><div className="wg-special-icons">{groupOf(result.outcome).map(o=><img key={o} src={icon(o)} alt=""/>)}</div><b>{result.outcome.toUpperCase()}</b></div></div>}
  {phase==='result'&&bonus?.type==='extra'&&now<round.reveal_at+2600&&<div className="cs-special"><div><div className="wg-special-icons">{result.winners.filter(w=>w!==result.outcome).map(o=><img key={o} src={icon(o)} alt=""/>)}</div><b>{t('godPrize')}</b></div></div>}
  {phase==='result'&&bonus?.type==='jackpot'&&now<round.reveal_at+2600&&<div className="cs-special wg-jp"><div><b>JACKPOT</b>{result.jackpot&&<b className="amt"><CountUp value={Number(result.jackpot.paid_minor)} format={v=>full(Math.round(v))} ms={1800}/></b>}</div></div>}
  {phase==='result'&&result&&L.center&&L.items[result.outcome]&&<Box x={L.center[0]-L.center[2]*.7} y={L.center[1]-L.center[2]*.7} w={L.center[2]*1.4} h={L.center[2]*1.4} className="wg-center"><img src={icon(result.outcome)} alt=""/></Box>}
  {fx.node}
  {phase==='result'&&result&&(g.myWin>0n||g.myStake>0n)&&<Box x={bnx} y={bny} w={bnw} h={110} className="wg-banner">
   {g.myWin>0n?<p className="won">{t('youWon')} <b><CountUp value={Number(g.myWin)} format={v=>full(Math.round(v))}/></b></p>:<p>{t('noWin')}</p>}
  </Box>}
  <ChipRow id={id} chips={GAME.chips} isOn={c=>chip===c} onPick={c=>{setChip(c);audio.play('click');}}/>
  {L.repeat&&<button className="wg-repeat" style={{left:L.repeat[0],top:L.repeat[1],width:L.repeat[2],height:L.repeat[3]}} disabled={phase!=='betting'||!g.canRepeat} onClick={()=>{audio.play('chips');g.repeat();}} aria-label={t('repeat')}/>}
  {L.rulesBtn&&<button className="wg-hot" style={rect(L.rulesBtn)} onClick={()=>{audio.play('click');setRules(true);}} aria-label={t('rules')}/>}
  {L.backBtn&&<button className="wg-hot" style={rect(L.backBtn)} onClick={g.exit} aria-label="exit"/>}
  <Box x={L.results[0]} y={L.results[1]} w={L.results[2]} h={L.results[3]} className="wg-results">
   {state.history.slice(0,Math.floor(L.results[2]/(L.results[3]*.82))).map(h=>icon(h.outcome)?<img key={h.seq} src={icon(h.outcome)} alt={h.outcome}/>:<span key={h.seq} className="wg-sp">{h.outcome.slice(0,1).toUpperCase()}</span>)}
  </Box>
  {flies.map(f=><span key={f.id} className="cs-fly wg-flychip" style={{left:f.x-34,top:f.y-34,transform:f.go?`translate(${f.tx-f.x}px,${f.ty-f.y}px) scale(.7)`:'none',opacity:f.go?.2:1}}>{f.label}</span>)}
  {coins.map(c=><span key={c.id} className="cs-coin" style={{left:c.x-22,top:c.y-22,'--dx':`${c.dx}px`,'--dy':`${c.dy}px`,animationDelay:`${c.delay}ms`}}/>)}
  <div className="cs-menu" style={{right:22,top:L.menuY??(L.winners?L.winners[1]+L.winners[3]+24:110)}}>
   <button className="cs-icon-btn" onClick={()=>setMenu(m=>!m)} aria-label="menu">≡</button>
   {menu&&<><button className="cs-icon-btn" onClick={()=>{setRules(true);setMenu(false);}} aria-label={t('rules')}>?</button>
    <button className="cs-icon-btn" onClick={()=>{setRecords(true);setMenu(false);}} aria-label={t('records')}>📜</button>
    <button className="cs-icon-btn" onClick={audio.toggle} aria-label={t('sound')}>{audio.muted?'🔇':'🔊'}</button>
    <button className="cs-icon-btn" onClick={g.exit} aria-label="exit">⏻</button></>}
  </div>
  {g.offline&&<div className="cs-toast">{t('offline')}</div>}
  {g.toast&&<div className="cs-toast" key={g.toast.id}>{t(g.toast.key,[GAME.maxOptionsPerRound])}</div>}
  {rules&&<div className="cs-modal-back" onClick={()=>setRules(false)}><div className="cs-modal" onClick={e=>e.stopPropagation()}>
   <h2>{t('rules')}</h2><p>{wheelRules(GAME)}</p><h2>{t('fair')}</h2><p>{t('fairText')}</p>
   <button className="cs-gold-btn" onClick={()=>setRules(false)}>{t('close')}</button></div></div>}
  {records&&<HistoryModal onClose={()=>setRecords(false)} label={o=>optionName(o,id)}/>}
 </Stage>;
}
