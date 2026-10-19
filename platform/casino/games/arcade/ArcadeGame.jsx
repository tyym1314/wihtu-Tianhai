import React,{useEffect,useRef,useState} from 'react';
import {t,isRtl} from '../../shared/i18n.mjs';
import {full,short} from '../../shared/useRound.js';
import {useAudio} from '../../shared/audio.mjs';
import {useArcade} from '../../shared/useArcade.js';
import {Stage,Box,CountUp} from '../../shared/Stage.jsx';
import {RechargeTap,useHostBalance} from '../../shared/recharge.jsx';
import {CASINO_GAMES} from '../../../shared/casino-games.mjs';
import './arcade.css';

const circ=([x,y,r])=>({left:x-r,top:y-r,width:2*r,height:2*r,borderRadius:'50%'});
const pick=(items,rnd=Math.random())=>{const tot=items.reduce((a,x)=>a+x.w,0);let r=rnd*tot;for(const x of items){r-=x.w;if(r<0)return x;}return items.at(-1);};
const dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);

// Design pixels on each 941x1672 plate.
const MONSTER={
 field:{x0:110,x1:830,top:150,bottom:1230},origin:[471,1320],bow:[195,1210,552,399],
 kinds:[{id:'bat',w:200,weight:22,speed:95,fly:true},{id:'slime',w:130,weight:20,speed:55},{id:'goblin',w:150,weight:16,speed:65},{id:'wolf',w:115,weight:12,speed:80},
  {id:'orc',w:190,weight:9,speed:55},{id:'troll',w:230,weight:7,speed:52,cap:2},{id:'golem',w:220,weight:5,speed:48,cap:2},{id:'dragon',w:400,weight:2,speed:55,fly:true,cap:1},{id:'chest',w:170,weight:3,speed:70,fly:true,cap:1}],
 weapons:{arrow:[84,1273,60],triple:[84,1416,60],lightning:[84,1559,60]},auto:[827,1420,75],
 minus:[685,1579,32],plus:[874,1579,32],betBox:[731,1554,100,50],balance:[188,40,112,40],prize:[638,76,193,36],back:[59,59,40],menu:[887,59,40],max:9,
};
const MOLE={
 holes:[[168,563],[470,563],[776,563],[168,840],[470,840],[776,840],[168,1109],[470,1109],[776,1109]],
 kinds:[{id:'mole',weight:30},{id:'helmet',weight:22},{id:'miner',weight:16},{id:'ninja',weight:10},{id:'king',weight:6},{id:'golden',weight:3},{id:'star',weight:1.6}],
 weapons:{hammer:[773,1504,100],bomb:[702,1277,67]},auto:[857,1277,67],
 minus:[306,1562,42],plus:[605,1562,42],betBox:[378,1535,160,56],balance:[386,1428,252,60],slots:[[272,74],[470,74],[669,74]],back:[87,72,55],menu:[853,72,55],
};

let uid=0;
/** Monster: creatures drift down the river; tap one to shoot it with the selected weapon. */
function useMonsters(L,game){
 const [list,setList]=useState([]),ref=useRef([]),last=useRef(performance.now());
 useEffect(()=>{let raf;const step=now=>{const dt=Math.min(.05,(now-last.current)/1000);last.current=now;
  let a=ref.current.filter(m=>m.y<L.field.bottom+80&&!(m.dead&&now-m.dead>700));
  for(const m of a)if(!m.dead){m.t+=dt;m.y+=m.vy*dt;m.x=m.x0+Math.sin(m.t*m.f)*m.amp;}
  const first=!ref.current.length;
  while(a.filter(m=>!m.dead).length<L.max){
   // Rare big creatures are capped so slow ones do not pile up; the first wave fills the whole river.
   const live=a.filter(m=>!m.dead),kinds=L.kinds.filter(k=>!k.cap||live.filter(m=>m.kind===k.id).length<k.cap),k=pick(kinds);
   a.push({id:++uid,kind:k.id,w:k.w,x0:L.field.x0+k.w/2+Math.random()*(L.field.x1-L.field.x0-k.w),x:0,y:first?L.field.top+Math.random()*(L.field.bottom-L.field.top-200):L.field.top-60-Math.random()*240,vy:k.speed*(.8+Math.random()*.4),t:Math.random()*6,f:.6+Math.random()*.8,amp:k.fly?60:25});}
  ref.current=a;setList([...a]);raf=requestAnimationFrame(step);};raf=requestAnimationFrame(step);return()=>cancelAnimationFrame(raf);},[]);
 return {list,ref};
}

export default function ArcadeGame({initial}){
 const id=initial.game_id,GAME=CASINO_GAMES[id],img=n=>`/casino/${id}/${n}.webp?v=${__ASSET_VERSION__}`,isMonster=id==='monster',L=isMonster?MONSTER:MOLE;
 const A=useArcade(initial,GAME);
 const audio=useAudio(id,['shoot','zap','hit','whack','bomb','coin','click','win','bigwin']);
 const weapons=GAME.arcade.weapons,[weapon,setWeapon]=useState(weapons[0].id),[auto,setAuto]=useState(false),[menu,setMenu]=useState(false),[rules,setRules]=useState(false);
 const [fx,setFx]=useState([]),[recoil,setRecoil]=useState(0),[slots,setSlots]=useState([]);
 const mult=Object.fromEntries(GAME.arcade.targets.map(x=>[x.id,x.multiplier??`${x.min}-${x.max}`]));
 const addFx=(f,ms)=>{const k=Math.random();setFx(v=>[...v,{...f,k}]);setTimeout(()=>setFx(v=>v.filter(x=>x.k!==k)),ms);};
 const M=isMonster?useMonsters(L,GAME):null;
 const holes=isMonster?null:useHoles(L);
 const win=(at,minor,big)=>{addFx({type:'pop',x:at.x,y:at.y,text:`+${full(minor)}`,big},1300);for(let i=0;i<8;i++)addFx({type:'coin',x:at.x,y:at.y,dx:(Math.random()-.5)*260,dy:-120-Math.random()*200,delay:i*40},1000);
  audio.play(big?'bigwin':'coin');if(big)setSlots(s=>[{k:Math.random(),kind:at.kind,minor},...s].slice(0,3));};

 async function fire(target){
  const w=weapons.find(x=>x.id===weapon);
  if(isMonster){
   const alive=M.ref.current.filter(m=>!m.dead&&m.y>L.field.top-40);if(!alive.includes(target))return;
   const chosen=[target,...alive.filter(m=>m!==target).sort((a,b)=>dist(a,target)-dist(b,target)).slice(0,w.targets-1)];
   chosen.forEach(m=>m.locked=true);setRecoil(r=>r+1);
   audio.play(weapon==='lightning'?'zap':'shoot');
   if(weapon==='lightning')addFx({type:'bolt',pts:[{x:L.origin[0],y:L.origin[1]},...chosen.map(m=>({x:m.x,y:m.y}))]},450);
   else chosen.forEach((m,i)=>addFx({type:'arrow',x:L.origin[0]+(i-1)*(chosen.length>1?28:0),y:L.origin[1],tx:m.x,ty:m.y},320));
   const r=await A.shoot(weapon,chosen.map(m=>m.kind));chosen.forEach(m=>m.locked=false);if(!r)return;
   const pool=[...r.hits];
   for(const m of chosen){const h=pool.findIndex(x=>x.target===m.kind);
    if(h>=0){const hit=pool.splice(h,1)[0];m.dead=performance.now();win({x:m.x,y:m.y,kind:m.kind},BigInt(A.open?.bet_minor||A.bet)*BigInt(hit.multiplier),hit.multiplier>=20);}
    else{m.hurt=performance.now();audio.play('hit');}}
  }else{
   const up=holes.ref.current.filter(h=>h.mole&&!h.mole.hit);if(!target.mole||target.mole.hit)return;
   const chosen=[target,...up.filter(h=>h!==target).sort((a,b)=>dist(a,target)-dist(b,target)).slice(0,w.targets-1)];
   chosen.forEach(h=>h.mole.hold=true);
   if(weapon==='bomb'){audio.play('bomb');addFx({type:'boom',x:target.x,y:target.y-80},700);}else{audio.play('whack');addFx({type:'hammer',x:target.x,y:target.y-150},380);}
   const r=await A.shoot(weapon,chosen.map(h=>h.mole.kind));if(!r){chosen.forEach(h=>h.mole&&(h.mole.hold=false));return;}
   const pool=[...r.hits];
   for(const h of chosen){const m=h.mole;if(!m)continue;const i=pool.findIndex(x=>x.target===m.kind);
    if(i>=0){const hit=pool.splice(i,1)[0];m.hit='ko';win({x:h.x,y:h.y-140,kind:m.kind},BigInt(A.open?.bet_minor||A.bet)*BigInt(hit.multiplier),hit.multiplier>=20);}
    else{m.hit='dodge';}
    m.hold=false;m.until=performance.now()+(m.hit==='ko'?700:250);}
  }
 }
 useEffect(()=>{if(A.toast?.key==='insufficient')setAuto(false);},[A.toast]);
 // Auto: shoots the nearest target every 0.7 s.
 useEffect(()=>{if(!auto)return;const tm=setInterval(()=>{
  if(isMonster){const c=M.ref.current.filter(m=>!m.dead&&!m.locked&&m.y>L.field.top+40&&m.y<L.field.bottom-120);if(c.length)fire(c[Math.floor(Math.random()*c.length)]);}
  else{const c=holes.ref.current.filter(h=>h.mole&&!h.mole.hit&&!h.mole.hold);if(c.length)fire(c[Math.floor(Math.random()*c.length)]);}
 },700);return()=>clearInterval(tm);},[auto,weapon,A.bet]);
 const stepBet=d=>{audio.play('click');const i=A.bets.indexOf(A.bet);A.setBet(A.bets[Math.min(A.bets.length-1,Math.max(0,i+d))]);};
 const tapField=e=>{if(!isMonster)return;const r=e.currentTarget.getBoundingClientRect(),s=r.width/941,p={x:(e.clientX-r.left)/s,y:(e.clientY-r.top)/s};
  const c=M.ref.current.filter(m=>!m.dead).map(m=>({m,d:Math.hypot(m.x-p.x,m.y-p.y)})).filter(x=>x.d<Math.max(70,x.m.w*.45)).sort((a,b)=>a.d-b.d)[0];if(c)fire(c.m);};
 return <Stage plate={img('plate')} className={`ag ag-${id}`} dir={isRtl()?'rtl':'ltr'}>
  {isMonster&&<div className="ag-field" onPointerDown={tapField}>
   {M.list.map(m=><div key={m.id} className={`ag-mon ${m.dead?'dead':''} ${m.hurt&&performance.now()-m.hurt<250?'hurt':''} ${m.locked?'locked':''}`} style={{left:m.x,top:m.y,width:m.w}}>
    <img src={img(m.kind)} alt="" draggable="false"/><b>x{mult[m.kind]}</b></div>)}
  </div>}
  {isMonster&&<img className="ag-bow" key={recoil} src={img('bow')} alt="" style={{left:L.bow[0],top:L.bow[1],width:L.bow[2],height:L.bow[3]}}/>}
  {!isMonster&&holes.list.map((h,i)=><div key={i} className="ag-hole" style={{left:h.x-130,top:h.y-270,width:260,height:290}} onPointerDown={()=>h.mole&&fire(h)}>
   {h.mole&&<div className={`ag-mole ${h.mole.state} ${h.mole.hit||''}`}><img src={img(h.mole.kind)} alt="" draggable="false"/><b>x{mult[h.mole.kind]}</b></div>}</div>)}
  {fx.map(f=>f.type==='arrow'?<span key={f.k} className="ag-arrow" style={{left:f.x,top:f.y,'--dx':`${f.tx-f.x}px`,'--dy':`${f.ty-f.y}px`,'--rot':`${Math.atan2(f.ty-f.y,f.tx-f.x)*180/Math.PI+90}deg`}}/>
   :f.type==='bolt'?<svg key={f.k} className="ag-bolt" viewBox="0 0 941 1672"><polyline points={f.pts.map((p,i)=>i?`${(p.x+f.pts[i-1].x)/2+(i%2?30:-30)},${(p.y+f.pts[i-1].y)/2} ${p.x},${p.y}`:`${p.x},${p.y}`).join(' ')}/></svg>
   :f.type==='pop'?<span key={f.k} className={`ag-pop ${f.big?'big':''}`} style={{left:f.x,top:f.y}}>{f.text}</span>
   :f.type==='coin'?<span key={f.k} className="cs-coin" style={{left:f.x-22,top:f.y-22,'--dx':`${f.dx}px`,'--dy':`${f.dy}px`,animationDelay:`${f.delay}ms`}}/>
   :f.type==='hammer'?<img key={f.k} className="ag-hammer" src={img('hammer')} alt="" style={{left:f.x,top:f.y}}/>
   :<span key={f.k} className="ag-boom" style={{left:f.x,top:f.y}}/>)}
  <RechargeTap x={L.balance[0]} y={L.balance[1]} w={L.balance[2]} h={L.balance[3]}/><Box x={L.balance[0]} y={L.balance[1]} w={L.balance[2]} h={L.balance[3]} className="ag-balance">{A.balance===null?'—':<CountUp value={Number(A.balance)} format={v=>full(Math.round(v))}/>}</Box>
  {L.prize&&<Box x={L.prize[0]} y={L.prize[1]} w={L.prize[2]} h={L.prize[3]} className="ag-prize"><CountUp value={Number(A.sessionWin)} format={v=>full(Math.round(v))}/></Box>}
  {L.slots&&slots.map((s,i)=><Box key={s.k} x={L.slots[i][0]-92} y={L.slots[i][1]-33} w={184} h={66} className="ag-slot"><img src={img(s.kind)} alt=""/><b>{short(s.minor)}</b></Box>)}
  {Object.entries(L.weapons).map(([w,c])=><button key={w} className={`ag-weapon ${weapon===w?'on':''}`} style={circ(c)} onClick={()=>{audio.play('click');setWeapon(w);}} aria-label={w}/>)}
  <button className={`ag-auto ${auto?'on':''}`} style={circ(L.auto)} onClick={()=>{audio.play('click');setAuto(v=>!v);}} aria-label="auto"/>
  <button className="wg-hot" style={circ(L.minus)} onClick={()=>stepBet(-1)} aria-label="-"/>
  <button className="wg-hot" style={circ(L.plus)} onClick={()=>stepBet(1)} aria-label="+"/>
  <Box x={L.betBox[0]} y={L.betBox[1]} w={L.betBox[2]} h={L.betBox[3]} className="ag-bet">{short(A.bet)}</Box>
  <button className="wg-hot" style={circ(L.menu)} onClick={()=>setMenu(m=>!m)} aria-label="menu"/>
  {menu&&<div className="cs-menu" style={{right:22,top:L.menu[1]+L.menu[2]+14}}>
   <button className="cs-icon-btn" onClick={()=>{setRules(true);setMenu(false);}}>?</button>
   <button className="cs-icon-btn" onClick={audio.toggle}>{audio.muted?'🔇':'🔊'}</button></div>}
  {A.toast&&<div className="cs-toast" key={A.toast.id}>{t(A.toast.key)}</div>}
  {rules&&<div className="cs-modal-back" onClick={()=>setRules(false)}><div className="cs-modal" onClick={e=>e.stopPropagation()}>
   <h2>{t('rules')}</h2><p>{t(isMonster?'monsterRules':'moleRules')}</p>
   <p>{GAME.arcade.targets.map(x=>`${x.id} ×${x.multiplier??`${x.min}-${x.max}`}`).join(' · ')}</p>
   <button className="cs-gold-btn" onClick={()=>setRules(false)}>{t('close')}</button></div></div>}
 </Stage>;
}

/** MoleStar: moles pop out of the nine holes and duck back after a while. */
function useHoles(L){
 const ref=useRef(L.holes.map(([x,y])=>({x,y,mole:null,next:performance.now()+Math.random()*1500}))),[list,setList]=useState(ref.current);
 useEffect(()=>{let raf;const step=now=>{
  for(const h of ref.current){const m=h.mole;
   if(!m){if(now>h.next&&ref.current.filter(x=>x.mole).length<5)h.mole={kind:pick(L.kinds.map(k=>({...k,w:k.weight}))).id,state:'up',until:now+1400+Math.random()*1400};continue;}
   if(m.hold)continue;
   if(now>m.until){if(m.state==='up'&&!m.hit){m.state='down';m.until=now+260;}else{h.mole=null;h.next=now+500+Math.random()*1800;}}
   else if(m.hit&&m.state==='up'&&now>m.until-60){m.state='down';}
  }
  setList([...ref.current]);raf=requestAnimationFrame(step);};raf=requestAnimationFrame(step);return()=>cancelAnimationFrame(raf);},[]);
 return {list,ref};
}
