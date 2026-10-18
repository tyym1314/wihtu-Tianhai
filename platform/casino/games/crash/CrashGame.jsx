import React,{useCallback,useEffect,useRef,useState} from 'react';
import {api,requestId,registerHostControls,requestExit} from '../../shared/client.mjs';
import {t,isRtl} from '../../shared/i18n.mjs';
import {full,short} from '../../shared/useRound.js';
import {useAudio} from '../../shared/audio.mjs';
import {Stage,Box,CountUp,PhaseBanner} from '../../shared/Stage.jsx';
import {CASINO_GAMES} from '../../../shared/casino-games.mjs';
import {HistoryModal} from '../../shared/History.jsx';
import '../rocketstar2/rocketstar2.css';
import './crash.css';

const GROWTH=Math.log(2)/8000;
const multAt=ms=>Math.floor(100*Math.exp(GROWTH*Math.max(0,ms))+1e-9);
const fx=x100=>(x100/100).toFixed(2);
const ERR={INSUFFICIENT_FUNDS:'insufficient',BETTING_CLOSED:'closed',OPTION_ALREADY_BET:'already',CRASHED:'crashedErr',ROUND_STAKE_LIMIT:'limit'};
const AUTO=[110,120,150,200,300,500,1000,2000,5000,10000];
const live=b=>!['REJECTED','VOIDED','VOIDING'].includes(b.status);
function phaseOf(r,n){if(n<r.bet_until)return'betting';if(!r.result)return'flying';return'crashed';}
const circ=([x,y,r])=>({left:x-r,top:y-r,width:2*r,height:2*r,borderRadius:'50%'});
const box=([x,y,w,h])=>({left:x,top:y,width:w,height:h});
const praise=x=>x>=1000?'Amazing':x>=500?'Excellent':x>=200?'Great':x>=150?'Good':'Nice';

// Design pixels on each 941x1672 plate. graph: plot area [x, top, w, h] (origin bottom-left); axes: draw tick labels.
const LAYOUTS={
 crash:{graph:[97,487,793,518],axes:true,curve:['#ff2a4a','#ff7a8a'],ship:190,heading:45,
  pills:{x:42,y:390,w:84,h:44,gap:9.5,n:9},balance:[428,1104,170,52],
  chips:{xs:[114,294,472,650,828],y:1263,w:160,h:168},take:[50,1366,840,163],
  autoToggle:[134,1560,230,60],autoBox:[163,1589,22],minus:[447,1589,37],plus:[764,1589,37],autoValue:[504,1565,200,48],
  back:[84,84,45],sound:[857,84,45],badge:true,menuY:150},
 crashstar:{graph:[67,400,840,810],axes:false,curve:['#ffb84d','#fff1a8'],ship:230,heading:72,
  pills:{x:34,y:296,w:100,h:44,gap:1.5,n:8},balance:[101,1521,190,50],best:[428,30,200,42],players:[67,395,240,380],
  chips:{xs:[118,294,470,647,823],y:1369,r:70},take:[319,1475,302,141],
  autoToggle:[655,1470,260,52],autoSwitch:[865,1495,28],minus:[680,1579,30],plus:[887,1579,30],autoValue:[722,1556,134,46],
  back:[55,50,35],help:[793,50,35],list:[885,50,35],praise:[504,672],menuY:110},
};

function Graph({L,round,now,phase,ship,tip}){
 const ref=useRef(null),[gx,gy,W,H]=L.graph,PL=L.axes?90:0,PB=L.axes?50:0;
 useEffect(()=>{
  const c=ref.current;if(!c)return;if(c.width!==W+PL){c.width=W+PL;c.height=H+PB;}const g=c.getContext('2d');g.setTransform(1,0,0,1,0,0);g.clearRect(0,0,W+PL,H+PB);g.translate(PL,0);
  const flight=phase==='betting'?0:phase==='flying'?now-round.bet_until:Math.log(round.result.crash_x100/100)/GROWTH;
  const tMax=Math.max(11000,flight*1.12),mMax=Math.max(1.8,Math.exp(GROWTH*flight)*1.2);
  const X=s=>s/tMax*W*.92,Y=m=>H-(m-1)/(mMax-1)*H*.9;
  if(L.axes){g.fillStyle='#e9d8ff';g.font='bold 24px sans-serif';g.textAlign='right';g.textBaseline='middle';
   for(let i=1;i<=7;i++){const m=1+(mMax-1)*i/7.8;g.fillText(`${m.toFixed(m<10?1:0)}X`,-8+0,Y(m));}
   g.textAlign='center';g.textBaseline='top';const step=Math.ceil(tMax/11000)*1000;for(let s=step;s<tMax;s+=step)g.fillText(`${s/1000}s`,X(s),H+10);}
  const el=ship.current;
  if(phase==='betting'){el.style.transform=`translate(${gx+X(0)+L.ship*.3}px,${gy+Y(1)-L.ship*.3}px) translate(-50%,-50%) rotate(${L.heading-45}deg)`;el.style.opacity=1;tip.current=[gx+X(0),gy+Y(1)];return;}
  const pts=[];for(let i=0;i<=90;i++){const s=flight*i/90;pts.push([X(s),Y(Math.exp(GROWTH*s))]);}
  const crashed=phase==='crashed';
  g.lineCap='round';g.lineJoin='round';
  const line=()=>{g.beginPath();pts.forEach((p,i)=>i?g.lineTo(p[0],p[1]):g.moveTo(p[0],p[1]));};
  line();g.strokeStyle=crashed?'#ff3b5c55':L.curve[0]+'66';g.lineWidth=26;g.shadowColor=L.curve[0];g.shadowBlur=36;g.stroke();
  line();g.strokeStyle=L.curve[0];g.lineWidth=10;g.shadowBlur=16;g.stroke();
  line();g.strokeStyle=L.curve[1];g.lineWidth=3;g.shadowBlur=0;g.stroke();
  const [x,y]=pts.at(-1),[px,py]=pts[Math.max(0,pts.length-5)],ang=Math.atan2(py-y,x-px)*180/Math.PI;
  el.style.transform=`translate(${gx+x}px,${gy+y}px) translate(-50%,-50%) rotate(${L.heading-ang}deg)`;el.style.opacity=crashed?0:1;
  tip.current=[gx+x,gy+y];
 });
 return <canvas ref={ref} className="cg-canvas" style={{left:gx-PL,top:gy,width:W+PL,height:H+PB}}/>;
}

/** Single-panel crash games (Crash, CrashStar): tap a chip to bet, TAKE to cash out, optional auto take. */
export default function CrashGame({initial}){
 const id=initial.game_id,GAME=CASINO_GAMES[id],L=LAYOUTS[id],img=n=>`/casino/${id}/${n}.webp?v=${__ASSET_VERSION__}`;
 const [state,setState]=useState(initial),[balance,setBalance]=useState(initial.balance?.available_minor??null),[now,setNow]=useState(Date.now());
 const [toast,setToast]=useState(null),[menu,setMenu]=useState(false),[records,setRecords]=useState(false),[rules,setRules]=useState(false),[offline,setOffline]=useState(false),[pop,setPop]=useState(null);
 const [autoOn,setAutoOn]=useState(false),[autoIdx,setAutoIdx]=useState(0),[busy,setBusy]=useState(false);
 const audio=useAudio(id,['launch','boom','cash','click','chip','tick','coin','select','close']);
 const offset=useRef(initial.server_now-Date.now()),balanceRound=useRef(null),ref=useRef(initial),ship=useRef(null),seen=useRef({}),tip=useRef([400,900]);
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
 useEffect(()=>{const k=round.id+phase;if(seen.current[k])return;seen.current[k]=1;if(phase==='flying')audio.play('launch');if(phase==='crashed')audio.play('boom');},[phase,round.id]);
 const secs=Math.max(0,Math.ceil((round.bet_until-now)/1000));
 useEffect(()=>{if(phase==='betting'&&secs<=3&&secs>0)audio.play('tick');},[secs]);
 const mult=phase==='flying'?multAt(now-round.bet_until):phase==='crashed'?round.result.crash_x100:100;
 const bet=state.my_bets.find(b=>b.option_id==='a'&&live(b));
 async function placeBet(stake){
  if(phaseOf(ref.current.round,serverNow())!=='betting'){say('closed');return;}
  if(bet){say('already');return;}
  if(balance!==null&&BigInt(balance)<BigInt(stake)){say('insufficient');return;}
  setBusy(true);audio.play('chip');if(balance!==null)setBalance(b=>String(BigInt(b)-BigInt(stake)));
  try{const placed=await api('/api/casino/bets',{request_id:requestId(),round_id:round.id,option_id:'a',stake_minor:stake,...(autoOn?{auto_x100:AUTO[autoIdx]}:{})});
   setState(s=>s.round.id===round.id?{...s,my_bets:[...s.my_bets,placed]}:s);}
  catch(e){if(balance!==null)setBalance(b=>String(BigInt(b)+BigInt(stake)));say(ERR[e.code]||'failed');}
  finally{setBusy(false);}
 }
 async function cash(){
  if(!bet||phase!=='flying'||bet.cashout_x100)return;
  try{const done=await api('/api/casino/cashout',{bet_id:bet.id});audio.play('cash');audio.play('coin');setPop({id:Math.random(),x:done.cashout_x100,v:done.payout_minor});setTimeout(()=>setPop(null),1800);
   setState(s=>({...s,my_bets:s.my_bets.map(b=>b.id===done.id?done:b)}));if(balance!==null)setBalance(b=>String(BigInt(b)+BigInt(done.payout_minor)));}
  catch(e){say(ERR[e.code]||'failed');}
 }
 const canCash=bet&&phase==='flying'&&!bet.cashout_x100&&bet.status==='ACCEPTED';
 const tone=x=>x>=1000?'gold':x>=200?'green':'red';
 const tier=mult>=1000?'t4':mult>=500?'t3':mult>=200?'t2':'t1';
 const best=Math.max(0,...state.history.map(h=>Number(h.outcome)));
 let takeText;
 if(bet?.cashout_x100)takeText=<><b>{fx(bet.cashout_x100)}x</b><small>+{full(bet.payout_minor)}</small></>;
 else if(canCash)takeText=<><b>TAKE</b><small>{full(BigInt(bet.stake_minor)*BigInt(mult)/100n)}</small></>;
 else if(bet&&phase==='crashed'){const w=BigInt(bet.payout_minor||0);takeText=<b className="cg-small">{w>0n?`+${full(w)}`:t('lost')}</b>;}
 else if(bet)takeText=<><b className="cg-small">{t('betPlaced')}</b><small>{full(bet.stake_minor)}{bet.auto_x100?` · ${fx(bet.auto_x100)}x`:''}</small></>;
 else if(phase==='betting')takeText=<b className="cg-small">{t('nextIn',[secs])}</b>;
 else takeText=<b className="cg-small">{t('waitNext')}</b>;
 const {pills:P}=L;
 return <Stage plate={img('plate')} className={`cg cg-${id} rs-${phase}`} dir={isRtl()?'rtl':'ltr'}>
  {phase==='flying'&&<div className="rs-stars" style={{animationDuration:`${Math.max(.25,1.6-Math.log2(mult/100)*.35)}s`}}/>}
  <div className={phase==='crashed'?'rs-shake':''}><Graph L={L} round={round} now={now} phase={phase} ship={ship} tip={tip}/></div>
  <img ref={ship} className="cg-ship" src={img('ship')} alt="" style={{width:L.ship,height:L.ship}} draggable="false"/>
  {L.badge&&phase!=='betting'&&<div className={`cg-badge ${phase}`} style={{left:tip.current[0],top:tip.current[1]-L.ship*.75}}><b>{fx(mult)}X</b><small>{phase==='crashed'?'Crash':'Payout'}</small></div>}
  {L.praise&&<Box x={L.praise[0]-280} y={L.praise[1]-130} w={560} h={260} className={`cg-praise ${phase} ${tier}`}>
   {phase==='betting'?<><b className="cg-count">{secs}</b><small>{t('nextIn',[secs])}</small></>:<><b key={phase==='flying'?tier:'c'}>{phase==='crashed'?'Crash':praise(mult)}</b><span>{fx(mult)}x</span></>}</Box>}
  {L.axes&&phase==='betting'&&<Box x={L.graph[0]} y={L.graph[1]+L.graph[3]*.3} w={L.graph[2]} h={160} className="rs-center"><b className="rs-count">{t('nextIn',[secs])}</b></Box>}
  {L.axes&&phase==='crashed'&&<Box x={L.graph[0]} y={L.graph[1]+L.graph[3]*.3} w={L.graph[2]} h={160} className="rs-center"><b className="rs-mult crashed">{fx(mult)}x</b><small>{t('crashedAt',[fx(mult)])}</small></Box>}
  {phase==='crashed'&&<React.Fragment key={round.id}><div className="rs-smoke" style={{left:tip.current[0],top:tip.current[1]}}/><div className="rs-boom" style={{left:tip.current[0],top:tip.current[1],margin:0,transform:'translate(-50%,-50%)'}}/>
   {Array.from({length:14},(_,i)=>{const a=i/14*Math.PI*2;return <span key={i} className="rs-debris" style={{left:tip.current[0],top:tip.current[1],'--dx':`${Math.cos(a)*(160+i%3*70)}px`,'--dy':`${Math.sin(a)*(160+i%4*50)}px`}}/>;})}</React.Fragment>}
  <PhaseBanner round={round} phase={phase} text={{betting:t('startBet'),flying:t('stopBet')}} onShow={p=>audio.play(p==='betting'?'select':'close')}/>
  {pop&&<Box key={pop.id} x={170} y={L.graph[1]+120} w={600} h={160} className="rs-pop"><b>{fx(pop.x)}x</b><span>+{full(pop.v)}</span></Box>}
  {state.history.slice(0,P.n).map((h,i)=>{const x=Math.round(Number(h.outcome)*100);return <Box key={h.seq} x={P.x+i*(P.w+P.gap)} y={P.y} w={P.w} h={P.h} className={`cg-pill ${tone(x)}`}>{h.outcome}{id==='crash'?'X':''}</Box>;})}
  {L.best&&<Box x={L.best[0]} y={L.best[1]} w={L.best[2]} h={L.best[3]} className="cg-best">{best?`${best.toFixed(2)}x`:'—'}</Box>}
  {L.players&&<Box x={L.players[0]} y={L.players[1]} w={L.players[2]} h={L.players[3]} className="cg-players">
   {(state.cashouts||[]).slice(-4).reverse().map((c,i)=><div key={c.external_user_id+i}><em>{c.external_user_id===state.me?'★':(c.external_user_id[0]||'?').toUpperCase()}</em><span><b>{c.external_user_id===state.me?t('myBet'):c.external_user_id.slice(0,8)}</b><small>{fx(c.cashout_x100)}x · win {short(BigInt(c.stake_minor)*BigInt(c.cashout_x100)/100n)}</small></span></div>)}</Box>}
  <Box x={L.balance[0]} y={L.balance[1]} w={L.balance[2]} h={L.balance[3]} className="wg-balance cg-bal">{balance===null?'—':<CountUp value={Number(balance)} format={v=>full(Math.round(v))}/>}</Box>
  {GAME.chips.map((c,i)=>{const C=L.chips,style=C.r?circ([C.xs[i],C.y,C.r]):box([C.xs[i]-C.w/2,C.y-C.h/2,C.w,C.h]);
   return <button key={c} className={`cg-chip ${bet&&bet.stake_minor===c?'on':''}`} style={style} disabled={busy||phase!=='betting'||!!bet} onClick={()=>placeBet(c)} aria-label={short(c)}/>;})}
  <button className={`cg-take ${canCash?'cash':bet?.cashout_x100?'done':''}`} style={box(L.take)} disabled={!canCash} onClick={cash}>{takeText}</button>
  <button className="wg-hot" style={box(L.autoToggle)} onClick={()=>{audio.play('click');setAutoOn(v=>!v);}} aria-label="auto take"/>
  {L.autoBox&&autoOn&&<span className="cg-check" style={circ(L.autoBox)}>✓</span>}
  {L.autoSwitch&&<span className={`cg-switch ${autoOn?'on':''}`} style={circ(L.autoSwitch)}/>}
  <button className="wg-hot" style={circ(L.minus)} onClick={()=>{audio.play('click');setAutoIdx(i=>Math.max(0,i-1));}} aria-label="-"/>
  <button className="wg-hot" style={circ(L.plus)} onClick={()=>{audio.play('click');setAutoIdx(i=>Math.min(AUTO.length-1,i+1));}} aria-label="+"/>
  <Box x={L.autoValue[0]} y={L.autoValue[1]} w={L.autoValue[2]} h={L.autoValue[3]} className={`cg-auto ${autoOn?'':'off'}`}>{fx(AUTO[autoIdx])}X</Box>
  <button className="wg-hot" style={circ(L.back)} onClick={()=>requestExit()} aria-label="exit"/>
  {L.sound&&<button className="wg-hot" style={circ(L.sound)} onClick={audio.toggle} aria-label={t('sound')}/>}
  {L.help&&<button className="wg-hot" style={circ(L.help)} onClick={()=>setRules(true)} aria-label={t('rules')}/>}
  {L.list&&<button className="wg-hot" style={circ(L.list)} onClick={()=>setRecords(true)} aria-label={t('records')}/>}
  <div className="cs-menu" style={{right:22,top:L.menuY}}>
   <button className="cs-icon-btn" onClick={()=>setMenu(m=>!m)} aria-label="menu">≡</button>
   {menu&&<><button className="cs-icon-btn" onClick={()=>{setRules(true);setMenu(false);}}>?</button>
    <button className="cs-icon-btn" onClick={()=>{setRecords(true);setMenu(false);}} aria-label={t('records')}>📜</button>
    <button className="cs-icon-btn" onClick={audio.toggle}>{audio.muted?'🔇':'🔊'}</button></>}
  </div>
  {offline&&<div className="cs-toast">{t('offline')}</div>}
  {toast&&<div className="cs-toast" key={toast.id}>{t(toast.key)}</div>}
  {rules&&<div className="cs-modal-back" onClick={()=>setRules(false)}><div className="cs-modal" onClick={e=>e.stopPropagation()}>
   <h2>{t('rules')}</h2><p>{t('crashRules')}</p><h2>{t('fair')}</h2><p>{t('fairText')}</p><small>commitment: {round.commitment}</small>{round.seed&&<small>seed: {round.seed}</small>}
   <button className="cs-gold-btn" onClick={()=>setRules(false)}>{t('close')}</button></div></div>}
  {records&&<HistoryModal onClose={()=>setRecords(false)} label={()=>'TAKE'}/>}
 </Stage>;
}
