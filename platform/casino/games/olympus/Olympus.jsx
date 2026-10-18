import React,{useEffect,useRef,useState} from 'react';
import {api,requestId,registerHostControls,requestExit} from '../../shared/client.mjs';
import {t,isRtl} from '../../shared/i18n.mjs';
import {full,short} from '../../shared/useRound.js';
import {useAudio} from '../../shared/audio.mjs';
import {Stage,Box,CountUp} from '../../shared/Stage.jsx';
import {CASINO_GAMES} from '../../../shared/casino-games.mjs';
import {HistoryModal} from '../../shared/History.jsx';
import './olympus.css';

const GAME=CASINO_GAMES.olympus,SLOT=GAME.slot,COLS=SLOT.columns,ROWS=SLOT.rows;
const img=n=>`/casino/olympus/${n}.webp?v=${__ASSET_VERSION__}`;
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
 const [modal,setModal]=useState(null),[auto,setAuto]=useState(0),[menu,setMenu]=useState(false),[records,setRecords]=useState(false);
 const [leaving,setLeaving]=useState(false),[pops,setPops]=useState([]),[flash,setFlash]=useState(0),[fountain,setFountain]=useState(0),[scatterHit,setScatterHit]=useState(false),[summary,setSummary]=useState(null);
 const audio=useAudio('olympus',['spin','drop','tumble','win','bigwin','orb','thunder','feature','click','coin']);
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
  if(result.mode==='buy'){setBig({kind:'free'});setFlash(f=>f+1);audio.play('thunder');audio.play('feature');await wait(2200);setBig(null);}
  for(let si=0;si<result.spins.length;si++){
   const sp=result.spins[si],freeIndex=result.spins.slice(0,si+1).filter(x=>x.free).length;
   if(sp.free)setFree(f=>({n:freeIndex,of:result.free_spins,total:f?.total||0}));
   if(si>0){setLeaving(true);await wait(280);setLeaving(false);}
   setWinCells([]);setMult(null);setGrid(sp.initial);setGen(g=>g+1);audio.play('drop',{volume:.6});await wait(sp.free?700:600);
   if(sp.initial.some(c=>c.s==='orb'))audio.play('orb',{volume:.5});
   let spinWin=0;
   for(const tb of sp.tumbles){
    setWinCells(tb.wins.flatMap(w=>w.cells));audio.play('win',{volume:.55});
    // Show each cluster's pay where it landed.
    setPops(tb.wins.map((w,k)=>{const cx=w.cells.reduce((a,i)=>a+i%COLS,0)/w.cells.length,cy=w.cells.reduce((a,i)=>a+Math.floor(i/COLS),0)/w.cells.length;
     return{id:Math.random(),x:87+(cx+.5)*764/COLS,y:615+(cy+.5)*592/ROWS,v:unit*BigInt(w.pay_x100)/100n,d:k*120};}));
    await wait(700);
    spinWin+=tb.wins.reduce((a,w)=>a+w.pay_x100,0);setWin(total+unit*BigInt(spinWin)/100n);
    setPopping(true);audio.play('tumble');await wait(280);setPopping(false);setWinCells([]);setPops([]);setGrid(tb.grid);await wait(460);
   }
   if(sp.multiplier>1&&spinWin>0){setFlash(f=>f+1);audio.play('thunder');setMult(sp.multiplier);audio.play('orb');await wait(1100);setWin(total+unit*BigInt(sp.win_x100)/100n);}
   if(sp.scatters>=(sp.free?SLOT.freeSpins.retrigger:SLOT.freeSpins.trigger)){setScatterHit(true);audio.play('feature',{volume:.6});await wait(900);setScatterHit(false);}
   total+=unit*BigInt(sp.win_x100)/100n;setWin(total);
   if(!sp.free&&sp.scatters>=SLOT.freeSpins.trigger){setBig({kind:'free'});setFlash(f=>f+1);audio.play('thunder');await wait(2200);setBig(null);}
   if(sp.free){setFree(f=>({...f,total:sp.total_multiplier}));await wait(spinWin>0?700:1000);}
  }
  const x=Number(total*100n/unit)/100;
  if(result.free_spins>0){setSummary(total);audio.play('bigwin',{volume:.7});await wait(2400);setSummary(null);}
  if(x>=10){setBig({kind:x>=50?'epicWin':x>=25?'megaWin':'bigWin',amount:total});setFountain(f=>f+1);audio.play('bigwin');await wait(3400);setBig(null);}
  else if(total>0n){setFountain(f=>f+1);audio.play('coin');}
  setFree(null);setMult(null);
 }

 async function spinOnce({buy=false}={}){
  const cost=buy?buyCost(stake):stake;
  if(balanceRef.current!==null&&BigInt(balanceRef.current)<BigInt(cost)){say('insufficient');return false;}
  setWin(0n);audio.play('spin');setBalance(b=>b===null?b:String(BigInt(b)-BigInt(cost)));
  try{
   setLeaving(true);const [r]=await Promise.all([api('/api/casino/spin',{request_id:requestId(),stake_minor:stake,...(buy?{buy:true}:{})}),sleep(320*speed.current)]);setLeaving(false);
   await play(r.result);setBalance(b=>b===null?b:String(BigInt(b)+BigInt(r.payout_minor)));return true;
  }catch(e){setLeaving(false);setBalance(b=>b===null?b:String(BigInt(b)+BigInt(cost)));say(ERR[e.code]||'failed');return false;}
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

 return <Stage plate={img('plate')} className={free?'ol-free':''} dir={isRtl()?'rtl':'ltr'}>
  {free&&<div className="ol-freetint"/>}
  <span className="ol-eye" style={{left:736,top:126}}/><span className="ol-eye" style={{left:772,top:126}}/>
  <span className="ol-staff" style={{left:846,top:48}}/>
  <svg className="ol-bolt idle" style={{left:850,top:40}} width="90" height="260" viewBox="0 0 90 260"><path d="M60 0 L20 110 L48 110 L10 260 L80 90 L50 90 L80 0Z"/></svg>
  {flash>0&&<React.Fragment key={flash}><div className="ol-flash"/><svg className="ol-bolt strike" style={{left:420,top:60}} width="420" height="600" viewBox="0 0 420 600"><path d="M400 0 L250 230 L300 230 L120 420 L170 420 L20 600 L230 380 L180 380 L330 200 L280 200 Z"/></svg></React.Fragment>}
  {[[60,300],[140,520],[880,560],[60,1150],[880,1180],[300,250],[600,560]].map(([x,y],i)=><span key={i} className="cs-sparkle" style={{left:x,top:y,animationDelay:`${i*.41}s`}}/>)}
  <Box x={87} y={615} w={764} h={592} className="ol-grid">
   {grid.map((c,i)=><div key={keys.current.keys[i]} className={`ol-cell ${leaving?'leave':''} ${winCells.includes(i)?(popping?'pop':'win'):''} ${scatterHit&&c.s==='scatter'?'scatter':''} ${c.s==='orb'?'orbcell':''}`} style={{animationDelay:`${(i%COLS)*40+Math.floor(i/COLS)*0}ms`}}>
    <img src={img(c.s)} alt="" draggable="false"/>{c.s==='orb'&&<b className="ol-orb">×{c.m}</b>}
   </div>)}
   {mult&&<div className="ol-mult">×{mult}</div>}
  </Box>
  {pops.map(p=><span key={p.id} className="ol-pop" style={{left:p.x,top:p.y,animationDelay:`${p.d}ms`}}>+{full(p.v)}</span>)}
  {fountain>0&&<div key={fountain} className="ol-fountain">{Array.from({length:big?46:18},(_,i)=><span key={i} className="ol-coinf" style={{left:470+(i%2?1:-1)*(i*7%160),'--dx':`${(i%2?1:-1)*(80+i*17%420)}px`,'--h':`${-500-(i*37%500)}px`,animationDelay:`${i*35}ms`}}/>)}</div>}
  {free&&<Box x={170} y={545} w={600} h={60} className="ol-freebar"><b>{t('freeLeft',[free.n,free.of])}</b>{free.total>0&&<span>{t('totalMult',[free.total])}</span>}</Box>}
  <Box x={520} y={1230} w={250} h={60} className="ol-win"><CountUp value={Number(win)} format={v=>full(Math.round(v))} ms={500}/></Box>
  <Box x={96} y={1352} w={170} h={44} className="ol-balance">{balance===null?'—':<CountUp value={Number(balance)} format={v=>full(Math.round(v))}/>}</Box>
  <button className="ol-hit" style={{left:300,top:1335,width:58,height:58}} disabled={busy} onClick={()=>step(-1)} aria-label="-"/>
  <Box x={360} y={1345} w={220} h={50} className="ol-bet">{full(stake)}</Box>
  <button className="ol-hit" style={{left:585,top:1335,width:58,height:58}} disabled={busy} onClick={()=>step(1)} aria-label="+"/>
  <button className="ol-hit ol-buy" style={{left:672,top:1310,width:248,height:94}} disabled={busy||!!free} onClick={()=>{audio.play('click');setModal('buy');}} aria-label={t('buyFree')}/>
  <button className={`ol-hit ol-round ${turbo?'on':''}`} style={{left:167,top:1431,width:114,height:114}} onClick={()=>{audio.play('click');setTurbo(v=>!v);}} aria-label={t('turbo')}/>
  <img className={`ol-spindisc ${busy?'busy':''}`} src={img('spinbtn')} alt="" style={{left:375,top:1393}} draggable="false"/>
  <button className={`ol-hit ol-spin ${busy?'busy':''} ${auto?'auto':''}`} style={{left:375,top:1393,width:190,height:190}} onClick={()=>auto?(autoRef.current=0,setAuto(0)):spin()} disabled={busy&&!auto} aria-label={t('spin')}>{auto?<span className="ol-stop">{t('stop')} {auto===Infinity?'∞':auto}</span>:null}</button>
  <button className={`ol-hit ol-round ${auto?'on':''}`} style={{left:663,top:1431,width:114,height:114}} onClick={()=>auto?(autoRef.current=0,setAuto(0)):!busy&&setModal('auto')} aria-label={t('autoSpin')}/>
  <div className="cs-menu" style={{right:22,top:30}}>
   <button className="cs-icon-btn ol-ib" onClick={()=>setMenu(m=>!m)} aria-label="menu">≡</button>
   {menu&&<><button className="cs-icon-btn ol-ib" onClick={()=>{setModal('rules');setMenu(false);}}>?</button>
    <button className="cs-icon-btn ol-ib" onClick={()=>{setRecords(true);setMenu(false);}} aria-label={t('records')}>📜</button>
    <button className="cs-icon-btn ol-ib" onClick={audio.toggle}>{audio.muted?'🔇':'🔊'}</button>
    <button className="cs-icon-btn ol-ib" disabled={busy} onClick={()=>requestExit()}>⏻</button></>}
  </div>
  {big&&<div className={`ol-big ${big.kind}`} onClick={()=>setBig(null)}><i className="ol-rays"/><div>{big.kind==='free'?<><img src={img('scatter')} alt=""/><b>{t('freeSpins')}</b><em>×{SLOT.freeSpins.award}</em></>:<><b>{t(big.kind)}</b><em><CountUp value={Number(big.amount)} format={v=>full(Math.round(v))} ms={2600}/></em></>}</div></div>}
  {summary!==null&&<div className="ol-big summary"><i className="ol-rays"/><div><b>{t('totalWin')}</b><em><CountUp value={Number(summary)} format={v=>full(Math.round(v))} ms={1800}/></em></div></div>}
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
   {records&&<HistoryModal onClose={()=>setRecords(false)}/>}
 </Stage>;
}
