import React,{useEffect,useRef,useState} from 'react';
import {api,requestId,registerHostControls,requestExit} from '../../shared/client.mjs';
import {t,isRtl} from '../../shared/i18n.mjs';
import {full} from '../../shared/useRound.js';
import {useAudio} from '../../shared/audio.mjs';
import {Stage,Box,CountUp} from '../../shared/Stage.jsx';
import {CASINO_GAMES} from '../../../shared/casino-games.mjs';
import {HistoryModal} from '../../shared/History.jsx';
import {SLOTS} from './layouts.mjs';
import '../olympus/olympus.css';
import './slot.css';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const ERR={INSUFFICIENT_FUNDS:'insufficient',SPIN_PENDING:'pending',WALLET_PENDING:'pending'};
const AUTO=[10,25,50,100,Infinity];
const circ=([x,y,r])=>({left:x-r,top:y-r,width:2*r,height:2*r});

/** Line / ways slots on a concept plate. Grids are column-major (grid[col][row]) as served by slot-lines.mjs. */
export default function SlotGame({initial}){
 const id=initial.game_id,GAME=CASINO_GAMES[id],S=GAME.slot,L=SLOTS[id],img=n=>`/casino/${id}/${n}.webp`;
 const COLS=S.columns,rowsOf=c=>Array.isArray(S.rows)?S.rows[c]:S.rows,MAXR=Math.max(...Array.from({length:COLS},(_,c)=>rowsOf(c)));
 const SYMS=[...new Set([...Object.keys(S.weights.base),...Object.keys(S.weights.free||{})])];
 const randomGrid=()=>Array.from({length:COLS},(_,c)=>Array.from({length:rowsOf(c)},(_,r)=>({s:SYMS.filter(x=>x!==S.scatter?.id&&x!==S.wild?.id)[(c*3+r*5+1)%(SYMS.length-2)]})));
 const last=initial.last_spin?.result?.spins?.[0];
 const [balance,setBalance]=useState(initial.balance?.available_minor??null),[stake,setStake]=useState(GAME.stakes[2]);
 const [grid,setGrid]=useState(()=>last?.initial||randomGrid()),[boards,setBoards]=useState(null);
 const [spinning,setSpinning]=useState([]),[gen,setGen]=useState(0),[winCells,setWinCells]=useState([]),[popping,setPopping]=useState(false),[line,setLine]=useState(null),[lines,setLines]=useState([]);
 const [win,setWin]=useState(0n),[busy,setBusy]=useState(false),[free,setFree]=useState(null),[big,setBig]=useState(null),[summary,setSummary]=useState(null),[turbo,setTurbo]=useState(false);
 const [toast,setToast]=useState(null),[modal,setModal]=useState(null),[auto,setAuto]=useState(0),[menu,setMenu]=useState(false),[records,setRecords]=useState(false);
 const [ladder,setLadder]=useState(0),[reelMult,setReelMult]=useState(null),[feature,setFeature]=useState(null),[fountain,setFountain]=useState(0),[pops,setPops]=useState([]),[expanded,setExpanded]=useState([]),[collected,setCollected]=useState(null),[choice,setChoice]=useState(null);
 const audio=useAudio(id,['spin','stop','drop','tumble','win','bigwin','feature','click','coin','orb','thunder']);
 const speed=useRef(1);speed.current=turbo?0.45:1;
 const autoRef=useRef(0),balanceRef=useRef(balance);balanceRef.current=balance;
 const wait=ms=>sleep(ms*speed.current);
 useEffect(()=>registerHostControls({onBack:()=>{if(!busy)requestExit();}}),[busy]);
 const say=key=>setToast({key,id:Math.random()});
 // Cell geometry inside the reel window.
 const [rx,ry,rw,rh]=L.reels,cw=rw/COLS,ch=rh/MAXR;
 const cellXY=(c,r)=>[rx+(c+.5)*cw,ry+(MAXR-rowsOf(c))*ch/2+(r+.5)*ch];
 // Unchanged cells keep their key across cascades so only new symbols drop in.
 const keys=useRef({grid:null,keys:[],gen:-1});
 if(keys.current.grid!==grid){const k=keys.current,prev=k.grid;keys.current={grid,gen,keys:grid.map((col,c)=>col.map((x,r)=>prev&&gen===k.gen&&prev[c]?.[r]?.s===x.s&&prev[c]?.[r]?.g===x.g?k.keys[c][r]:`${gen}-${c}-${r}-${Math.random()}`))};}

 async function land(next,{free:isFree}={}){
  setGrid(next);setGen(g=>g+1);
  // Reels stop left to right.
  for(let c=0;c<COLS;c++){await wait(c?150:250);setSpinning(s=>s.map((v,i)=>i===c?false:v));audio.play('stop',{volume:.5});}
  await wait(200);
 }
 async function showWins(wins,unit,{cascade=false}={}){
  if(!wins.length)return;
  setWinCells(wins.flatMap(w=>w.cells.map(([c,r])=>c+':'+r)));audio.play('win',{volume:.6});
  if(S.pay==='lines'){setLines(wins.map(w=>w.line));setPops(wins.map(w=>{const [c,r]=w.cells[Math.floor(w.cells.length/2)];const [x,y]=cellXY(c,r);return{id:Math.random(),x,y,v:unit*BigInt(Math.round(w.pay_x100))/100n};}));await wait(900);
   if(!autoRef.current&&wins.length>1)for(const w of wins.slice(0,6)){setLines([w.line]);setWinCells(w.cells.map(([c,r])=>c+':'+r));await wait(420);}}
  else{setPops(wins.map(w=>{const [c,r]=w.cells[0];const [x,y]=cellXY(c,r);return{id:Math.random(),x,y,v:unit*BigInt(Math.round(w.pay_x100))/100n};}));await wait(cascade?750:900);}
  setLines([]);setPops([]);
 }
 async function playSpin(sp,unit,totalBefore,freeIndex,freeOf){
  if(sp.free)setFree(f=>({n:freeIndex,of:freeOf,total:f?.total||0n}));
  setWinCells([]);setLadder(0);setReelMult(null);setExpanded([]);
  if(sp.boards){
   setBoards(sp.boards.map(b=>b.initial));setSpinning(Array(COLS).fill(false));audio.play('drop',{volume:.6});await wait(700);
   setCollected({n:sp.collected,wild:sp.wild_reels});
   for(const [bi,b] of sp.boards.entries())if(b.steps.length){setLine({board:bi,cells:b.steps[0].wins.flatMap(w=>w.cells.map(([c,r])=>c+':'+r))});audio.play('win',{volume:.6});await wait(650);}
   setLine(null);
  }else{
   setBoards(null);setSpinning(Array(COLS).fill(true));audio.play('spin',{volume:.5});await wait(350);
   if(L.multReel)setReelMult('spin');
   await land(sp.initial,{free:sp.free});
   if(sp.random_wilds){setFeature({kind:'magic'});audio.play('orb');await wait(900);setFeature(null);}
   if(sp.expanded?.length){setExpanded(sp.expanded);setFeature({kind:'mega'});audio.play('thunder');await wait(900);setFeature(null);}
   let g=sp.initial;
   for(const [i,st] of sp.steps.entries()){
    if(S.cascade)setLadder(i);
    await showWins(st.wins,unit*BigInt(st.multiplier||1),{cascade:!!st.grid});
    if(st.grid){setPopping(true);audio.play('tumble');await wait(260);setPopping(false);setWinCells([]);setGrid(st.grid);g=st.grid;await wait(420);}
   }
   if(L.multReel){setReelMult(sp.reel_multiplier);if(sp.reel_multiplier>1&&sp.win_x100>0){audio.play('orb');await wait(700);}}
   if(sp.bonus){setFeature({kind:'bonus',x:S.bonus.multiplier});audio.play('feature');await wait(1500);setFeature(null);}
   if(sp.collect){setFeature({kind:'collect',values:sp.collect.values,total:sp.collect.total,cells:g.flatMap((col,c)=>col.map((x,r)=>x.s===S.collect.id?[c,r]:null)).filter(Boolean)});audio.play('coin');await wait(1800);setFeature(null);}
   if(sp.wheel){setFeature({kind:'wheel',x:sp.wheel.x});audio.play('feature');await wait(3600);setFeature(null);}
  }
  const total=totalBefore+unit*BigInt(Math.round(sp.win_x100))/100n;setWin(total);
  if(sp.free)setFree(f=>({...f,total:(f?.total||0n)+unit*BigInt(Math.round(sp.win_x100))/100n}));
  if(S.scatter&&!sp.free&&sp.scatters>=(S.freeSpins?.trigger||99)){setWinCells(g2=>[...g2]);setFeature({kind:'scatter'});audio.play('feature');await wait(900);setFeature(null);}
  return total;
 }
 async function play(result,spinRow){
  const unit=BigInt(result.base_stake_minor);let total=0n,si=0;
  const freeOf=result.free_spins;
  const base=result.spins.filter(x=>!x.free);
  for(const sp of base){total=await playSpin(sp,unit,total);si++;}
  if(result.pending){
   setBig({kind:'free'});audio.play('feature');await wait(1800);setBig(null);
   const k=await new Promise(res=>setChoice({choices:result.pending.choices,pick:res}));setChoice(null);
   const r=await api('/api/casino/choose',{spin_id:spinRow.id,choice:k});return {after:await play({...r.result,spins:r.result.spins.slice(base.length),skipIntro:true},r),payout:r.payout_minor,prefix:total};
  }
  const frees=result.spins.filter(x=>x.free);
  if(frees.length){if(!result.skipIntro){setBig({kind:'free',n:frees.length});audio.play('feature');await wait(2000);setBig(null);}
   for(const [i,sp] of frees.entries()){total=await playSpin(sp,unit,total,i+1,frees.length);await wait(sp.win_x100>0?500:300);}
   setSummary(total);audio.play('bigwin',{volume:.7});await wait(2200);setSummary(null);setFree(null);setBoards(null);setCollected(null);}
  return {total};
 }
 async function spinOnce(){
  const cost=stake;
  if(balanceRef.current!==null&&BigInt(balanceRef.current)<BigInt(cost)){say('insufficient');return false;}
  setWin(0n);setBalance(b=>b===null?b:String(BigInt(b)-BigInt(cost)));
  try{
   setSpinning(Array(COLS).fill(true));audio.play('spin',{volume:.5});
   const [r]=await Promise.all([api('/api/casino/spin',{request_id:requestId(),stake_minor:stake}),sleep(300)]);
   const out=await play(r.result,r);const total=out.after?out.prefix+out.after.total:out.total;
   const payout=BigInt(out.payout??r.payout_minor??0);setWin(total);
   const x=Number(total*100n/BigInt(stake))/100;
   if(x>=10){setBig({kind:x>=50?'epicWin':x>=25?'megaWin':'bigWin',amount:total});setFountain(f=>f+1);audio.play('bigwin');await wait(3200);setBig(null);}
   else if(total>0n){setFountain(f=>f+1);audio.play('coin');}
   setBalance(b=>b===null?b:String(BigInt(b)+payout));return true;
  }catch(e){setSpinning(Array(COLS).fill(false));setChoice(null);setBalance(b=>b===null?b:String(BigInt(b)+BigInt(cost)));say(ERR[e.code]||'failed');return false;}
 }
 async function run(task){if(busy)return;setBusy(true);try{await task();}finally{setBusy(false);api('/api/casino/state?balance=1').then(s=>s.balance&&setBalance(s.balance.available_minor)).catch(()=>{});}}
 const spin=()=>run(()=>spinOnce());
 const startAuto=n=>{setModal(null);autoRef.current=n;setAuto(n);run(async()=>{for(let left=n;left>0&&autoRef.current>0;left--){autoRef.current=left;setAuto(left);if(!await spinOnce())break;await sleep(250);}autoRef.current=0;setAuto(0);});};
 const step=d=>{audio.play('click');setStake(s=>GAME.stakes[Math.min(GAME.stakes.length-1,Math.max(0,GAME.stakes.indexOf(s)+d))]);};
 const payText=s=>{const div=S.pay==='lines'?S.lines.length:S.waysDivisor;return s.pays.map(([n,x])=>`${n}× ${+(x*(S.payScale||1)/div/100).toFixed(2)}`).join('  ');};

 const Cell=({x,c,r,board})=>{const k=c+':'+r,lit=board===undefined?winCells.includes(k):line?.board===board&&line.cells.includes(k);
  const coinV=feature?.kind==='collect'&&feature.cells.findIndex(([a,b])=>a===c&&b===r);
  return <div className={`sg-cell ${lit?(popping?'pop':'win'):''} ${x.g?'gold':''} ${x.random?'magic':''} ${x.mega?'mega':''} ${x.s===S.scatter?.id?'scatter':''} ${x.s===S.wild?.id?'wild':''}`}>
   <img src={img(x.s)} alt="" draggable="false"/>{coinV!==false&&coinV>=0&&<b className="sg-coinv">×{feature.values[coinV]}</b>}</div>;};
 const colTop=c=>(MAXR-rowsOf(c))*ch/2;
 return <Stage plate={img('plate')} className={`sg sg-${id} ${free?'sg-free':''}`} dir={isRtl()?'rtl':'ltr'}>
  {(L.glows||[]).map(([x,y,r],i)=><span key={'g'+i} className="cs-glow" style={{left:x-r,top:y-r,width:2*r,height:2*r,background:`radial-gradient(${L.accent||'#ffd34d'}aa,transparent 70%)`,animationDelay:`${i*.5}s`}}/>)}
  {[[60,300],[880,420],[90,1040],[860,1100],[460,200]].map(([x,y],i)=><span key={i} className="cs-sparkle" style={{left:x,top:y,animationDelay:`${i*.37}s`}}/>)}
  {free&&<div className="sg-freetint"/>}
  {!boards&&<Box x={rx} y={ry} w={rw} h={rh} className="sg-reels">
   {grid.map((col,c)=><div key={c} className={`sg-col ${spinning[c]?'spinning':''} ${expanded.includes(c)?'expanded':''} ${collected?.wild?.includes(c)?'wildreel':''}`} style={{left:c*cw,top:colTop(c),width:cw,height:rowsOf(c)*ch}}>
    {spinning[c]?<div className="sg-strip" style={{'--h':`${rowsOf(c)*ch}px`}}>{Array.from({length:rowsOf(c)*3},(_,i)=><div key={i} className="sg-cell blur" style={{height:ch}}><img src={img(SYMS[(i*5+c*3)%SYMS.length])} alt=""/></div>)}</div>
     :col.map((x,r)=><div key={keys.current.keys[c]?.[r]||r} className="sg-slot" style={{height:ch,animationDelay:`${r*30}ms`}}><Cell x={x} c={c} r={r}/></div>)}
   </div>)}
   {lines.length>0&&S.lines&&<svg className="sg-lines" viewBox={`0 0 ${rw} ${rh}`}>{lines.map((li,k)=><polyline key={k} style={{'--c':`hsl(${li*47%360} 95% 60%)`}} points={S.lines[li].map((row,c)=>`${(c+.5)*cw},${colTop(c)+(row+.5)*ch}`).join(' ')}/>)}</svg>}
  </Box>}
  {boards&&<Box x={rx} y={ry} w={rw} h={rh} className="sg-boards">
   {boards.map((b,bi)=><div key={bi} className="sg-board" style={{width:rw/2-8,height:rh/2-8}}>{b.map((col,c)=><div key={c} className={`sg-mcol ${collected?.wild?.includes(c)?'wildreel':''}`}>{col.map((x,r)=><Cell key={r} x={x} c={c} r={r} board={bi}/>)}</div>)}</div>)}
  </Box>}
  {L.ladder&&L.ladder.map(([x,y,w,h],i)=><Box key={i} x={x} y={y} w={w} h={h} className={`sg-step ${S.cascade&&ladder===i&&busy?'on':''}`}/>)}
  {L.multReel&&<Box x={L.multReel[0]} y={L.multReel[1]} w={L.multReel[2]} h={L.multReel[3]} className={`sg-mreel ${reelMult==='spin'?'spinning':''}`}>
   {reelMult==='spin'?<div className="sg-mstrip">{[...S.multiplierReel,...S.multiplierReel].map((m,i)=><b key={i}>{m.x}x</b>)}</div>:<b className={reelMult>1?'hit':''}>{reelMult||1}x</b>}</Box>}
  {L.jackpot&&<Box x={L.jackpot[0]} y={L.jackpot[1]} w={L.jackpot[2]} h={L.jackpot[3]} className="sg-jackpot"><CountUp value={Number(BigInt(stake)*BigInt(S.maxWin))} format={v=>full(Math.round(v))}/></Box>}
  {pops.map(p=><span key={p.id} className="ol-pop" style={{left:p.x,top:p.y}}>+{full(p.v)}</span>)}
  {feature?.kind==='magic'&&<div className="sg-banner magic"><b>MAGIC WILDS</b></div>}
  {feature?.kind==='mega'&&<div className="sg-banner mega"><b>MEGA WILD</b></div>}
  {feature?.kind==='bonus'&&<div className="sg-banner bonus"><b>BONUS</b><em>×{feature.x}</em></div>}
  {feature?.kind==='collect'&&<div className="sg-banner collect"><b>COLLECT</b><em>×{feature.total}</em></div>}
  {feature?.kind==='scatter'&&<div className="sg-banner scatter"><b>{t('freeSpins')}</b></div>}
  {feature?.kind==='wheel'&&<Wheel values={S.wheel.values.map(v=>v.x)} x={feature.x} stake={stake}/>}
  {collected&&<Box x={rx+rw*.15} y={ry-124} w={rw*.7} h={52} className="sg-collected"><img src={img(S.freeSpins.boards.collect)} alt=""/><b>{collected.n}</b>{S.freeSpins.boards.steps.map(s=><span key={s.at} className={collected.n>=s.at?'on':''}>{s.at}</span>)}</Box>}
  {free&&<Box x={rx} y={L.freebar||ry-64} w={rw} h={56} className="sg-freebar"><b>{t('freeLeft',[free.n||0,free.of||0])}</b><span>{full(free.total||0n)}</span></Box>}
  {fountain>0&&<div key={fountain} className="ol-fountain">{Array.from({length:big?46:18},(_,i)=><span key={i} className="ol-coinf" style={{left:470+(i%2?1:-1)*(i*7%160),'--dx':`${(i%2?1:-1)*(80+i*17%420)}px`,'--h':`${-500-(i*37%500)}px`,animationDelay:`${i*35}ms`}}/>)}</div>}
  <Box x={L.win[0]} y={L.win[1]} w={L.win[2]} h={L.win[3]} className="sg-win">{win>0n?<CountUp value={Number(win)} format={v=>full(Math.round(v))} ms={500}/>:<span>{busy?'':'GOOD LUCK'}</span>}</Box>
  <Box x={L.balance[0]} y={L.balance[1]} w={L.balance[2]} h={L.balance[3]} className="sg-balance">{balance===null?'—':<CountUp value={Number(balance)} format={v=>full(Math.round(v))}/>}</Box>
  <button className="wg-hot" style={{...circ(L.minus),borderRadius:'50%'}} disabled={busy} onClick={()=>step(-1)} aria-label="-"/>
  <Box x={L.bet[0]} y={L.bet[1]} w={L.bet[2]} h={L.bet[3]} className="sg-bet">{full(stake)}</Box>
  <button className="wg-hot" style={{...circ(L.plus),borderRadius:'50%'}} disabled={busy} onClick={()=>step(1)} aria-label="+"/>
  <button className={`sg-spin ${busy?'busy':''} ${auto?'auto':''}`} style={{...circ(L.spin),borderRadius:'50%'}} onClick={()=>auto?(autoRef.current=0,setAuto(0)):spin()} disabled={busy&&!auto} aria-label={t('spin')}>{auto?<span className="ol-stop">{t('stop')} {auto===Infinity?'∞':auto}</span>:null}</button>
  <button className={`sg-round ${auto?'on':''}`} style={{...circ(L.auto),borderRadius:L.autoRect?18:'50%'}} onClick={()=>auto?(autoRef.current=0,setAuto(0)):!busy&&setModal('auto')} aria-label={t('autoSpin')}/>
  {L.turbo&&<button className={`sg-round ${turbo?'on':''}`} style={{...circ(L.turbo),borderRadius:L.autoRect?18:'50%'}} onClick={()=>{audio.play('click');setTurbo(v=>!v);}} aria-label={t('turbo')}/>}
  {L.back&&<button className="wg-hot" style={{...circ(L.back),borderRadius:'50%'}} disabled={busy} onClick={()=>requestExit()} aria-label="exit"/>}
  <div className="cs-menu" style={{right:22,top:L.menuY??20}}>
   <button className="cs-icon-btn" onClick={()=>setMenu(m=>!m)} aria-label="menu">≡</button>
   {menu&&<><button className="cs-icon-btn" onClick={()=>{setModal('rules');setMenu(false);}}>?</button>
    <button className="cs-icon-btn" onClick={()=>{setRecords(true);setMenu(false);}} aria-label={t('records')}>📜</button>
    <button className="cs-icon-btn" onClick={audio.toggle}>{audio.muted?'🔇':'🔊'}</button>
    <button className="cs-icon-btn" disabled={busy} onClick={()=>requestExit()}>⏻</button></>}
  </div>
  {big&&<div className={`ol-big ${big.kind}`} onClick={()=>setBig(null)}><i className="ol-rays"/><div>{big.kind==='free'?<>{S.scatter&&<img src={img(S.scatter.id)} alt=""/>}<b>{t('freeSpins')}</b>{big.n&&<em>×{big.n}</em>}</>:<><b>{t(big.kind)}</b><em><CountUp value={Number(big.amount)} format={v=>full(Math.round(v))} ms={2600}/></em></>}</div></div>}
  {summary!==null&&<div className="ol-big summary"><i className="ol-rays"/><div><b>{t('totalWin')}</b><em><CountUp value={Number(summary)} format={v=>full(Math.round(v))} ms={1800}/></em></div></div>}
  {choice&&<div className="cs-modal-back"><div className="cs-modal sg-choice"><h2>{t('chooseFree')}</h2>
   <div>{choice.choices.map((c,i)=><button key={i} onClick={()=>{audio.play('click');choice.pick(i);}}><b>{c.award}</b><small>{t('freeSpins')}</small><em>×{c.multiplier}</em></button>)}</div></div></div>}
  {toast&&<div className="cs-toast" key={toast.id}>{t(toast.key)}</div>}
  {modal==='auto'&&<div className="cs-modal-back" onClick={()=>setModal(null)}><div className="cs-modal" onClick={e=>e.stopPropagation()}>
   <h2>{t('autoSpin')}</h2><div className="ol-autos">{AUTO.map(n=><button key={n} onClick={()=>startAuto(n)}>{n===Infinity?t('untilStop'):n}</button>)}</div>
   <button className="cs-gold-btn" onClick={()=>setModal(null)}>{t('cancel')}</button></div></div>}
  {modal==='rules'&&<div className="cs-modal-back" onClick={()=>setModal(null)}><div className="cs-modal" onClick={e=>e.stopPropagation()}>
   <h2>{t('rules')}</h2><p>{t(S.pay==='lines'?'linesRules':'waysRules',[S.lines?.length||'',S.waysDivisor||''])}</p>
   <div className="ol-pay">{S.symbols.map(s=><div key={s.id}><img src={img(s.id)} alt=""/><span>{payText(s)}</span></div>)}</div>
   <button className="cs-gold-btn" onClick={()=>setModal(null)}>{t('close')}</button></div></div>}
  {records&&<HistoryModal onClose={()=>setRecords(false)}/>}
 </Stage>;
}

function Wheel({values,x}){
 const n=values.length,target=values.indexOf(x),[deg,setDeg]=useState(0);
 useEffect(()=>{const id=requestAnimationFrame(()=>setDeg(360*5+(360-(target+.5)*360/n)));return()=>cancelAnimationFrame(id);},[]);
 return <div className="sg-wheel-back"><div className="sg-wheel"><svg viewBox="-100 -100 200 200" style={{transform:`rotate(${deg}deg)`}}>
  {values.map((v,i)=>{const a0=(i/n)*2*Math.PI-Math.PI/2,a1=((i+1)/n)*2*Math.PI-Math.PI/2,am=(a0+a1)/2;
   return <g key={i}><path d={`M0 0 L${95*Math.cos(a0)} ${95*Math.sin(a0)} A95 95 0 0 1 ${95*Math.cos(a1)} ${95*Math.sin(a1)}Z`} fill={i%2?'#c8102e':'#f3b81a'} stroke="#fff3c4" strokeWidth="2"/>
    <text x={62*Math.cos(am)} y={62*Math.sin(am)} transform={`rotate(${am*180/Math.PI+90} ${62*Math.cos(am)} ${62*Math.sin(am)})`}>×{v}</text></g>;})}
  <circle r="16" fill="#7a4a00" stroke="#ffe37a" strokeWidth="4"/></svg><i className="sg-pointer"/></div></div>;
}
