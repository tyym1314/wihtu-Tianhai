import React,{useEffect,useRef,useState} from 'react';
import {useCelebration} from '../../shared/fx/Celebrate.jsx';
import {burst,toScreen} from '../../shared/fx/particles.js';
import {themeOf} from '../../shared/fx/themes.js';
import {t,isRtl} from '../../shared/i18n.mjs';
import {full,short} from '../../shared/useRound.js';
import {useAudio} from '../../shared/audio.mjs';
import {useArcade} from '../../shared/useArcade.js';
import {Stage,Box,CountUp} from '../../shared/Stage.jsx';
import {RechargeTap} from '../../shared/recharge.jsx';
import {CASINO_GAMES} from '../../../shared/casino-games.mjs';
import {optionName} from '../../shared/rules.mjs';
import './piratefish.css';

// Design pixels on the 941x1672 plate. Fish swim across the whole width between top and bottom.
const L={
 field:{top:190,bottom:1330},origin:[469,1508],
 balance:[722,26,196,50],settings:[878,143,46],lock:[878,261,46],laser:[878,379,46],hook:[878,497,46],auto:[878,615,46],
 minus:[301,1534,46],plus:[638,1534,46],betBox:[353,1572,232,54],max:15,
};
// w = width in design px; weight = spawn share; speed px/s; school = how many swim together; cap = most alive at once.
const KINDS=[
 {id:'clownfish',w:104,weight:22,speed:120,school:[3,5]},{id:'bluetang',w:118,weight:19,speed:110,school:[2,4]},
 {id:'angelfish',w:126,weight:15,speed:95,school:[2,3]},{id:'lanternfish',w:136,weight:12,speed:90,school:[1,3]},
 {id:'pufferfish',w:146,weight:9,speed:70},{id:'seaturtle',w:190,weight:6,speed:55,cap:2},{id:'shark',w:320,weight:3,speed:80,cap:1},
 {id:'crab',w:240,weight:2.2,speed:45,cap:1},{id:'goldturtle',w:220,weight:2.6,speed:50,cap:1},
];
const pick=items=>{const tot=items.reduce((a,x)=>a+x.weight,0);let r=Math.random()*tot;for(const x of items){r-=x.weight;if(r<0)return x;}return items.at(-1);};
const circ=([x,y,r])=>({left:x-r,top:y-r,width:2*r,height:2*r,borderRadius:'50%'});
const angleTo=(x,y)=>Math.atan2(x-L.origin[0],L.origin[1]-y)*180/Math.PI;
let uid=0;

/** Fish enter from either side, often in schools, and swim across on a gentle wave. Presentation only. */
function useFish(){
 const [list,setList]=useState([]),ref=useRef([]),last=useRef(performance.now());
 useEffect(()=>{let raf;const step=now=>{const dt=Math.min(.05,(now-last.current)/1000);last.current=now;
  let a=ref.current.filter(f=>f.x>-f.w-40&&f.x<941+f.w+40&&!(f.dead&&now-f.dead>900));
  for(const f of a)if(!f.dead&&!f.held){f.t+=dt;f.x+=f.vx*dt;f.y=f.y0+Math.sin(f.t*f.fr)*f.amp;}
  const first=!ref.current.length;
  while(a.filter(f=>!f.dead).length<L.max){
   const live=a.filter(f=>!f.dead),kinds=KINDS.filter(k=>!k.cap||live.filter(f=>f.kind===k.id).length<k.cap),k=pick(kinds);
   const dir=Math.random()<.5?1:-1,n=k.school?k.school[0]+Math.floor(Math.random()*(k.school[1]-k.school[0]+1)):1;
   const y0=L.field.top+k.w/2+Math.random()*(L.field.bottom-L.field.top-k.w),speed=k.speed*(.85+Math.random()*.3);
   for(let i=0;i<n;i++){
    const start=first?80+Math.random()*780:dir>0?-k.w/2-i*k.w*.8:941+k.w/2+i*k.w*.8;
    a.push({id:++uid,kind:k.id,w:k.w,x:start,y0:y0+(i%2?1:-1)*i*k.w*.35,y:0,vx:dir*speed,t:Math.random()*6,fr:.7+Math.random()*.6,amp:k.w>200?18:30});
   }
  }
  ref.current=a;setList([...a]);raf=requestAnimationFrame(step);};raf=requestAnimationFrame(step);return()=>cancelAnimationFrame(raf);},[]);
 return {list,ref};
}

export default function PirateFish({initial}){
 const id=initial.game_id,GAME=CASINO_GAMES[id],img=n=>`/casino/${id}/${n}.webp?v=${__ASSET_VERSION__}`;
 const A=useArcade(initial,GAME);
 const audio=useAudio(id,['shoot','zap','hit','coin','click','win','bigwin','reel-stop','ding','nice','stamp','rollup','roll-end','charge','cheer','celebrate-loop','sting-big','sting-mega','sting-epic','sting-legend']);
 const cel=useCelebration(id,audio),F=useFish();
 const [weapon,setWeapon]=useState('cannon'),[auto,setAuto]=useState(false),[lock,setLock]=useState(false),[locked,setLocked]=useState(null);
 const [menu,setMenu]=useState(false),[rules,setRules]=useState(false),[angle,setAngle]=useState(0),[recoil,setRecoil]=useState(0),[fx,setFx]=useState([]);
 const mult=Object.fromEntries(GAME.arcade.targets.map(x=>[x.id,x.multiplier??`${x.min}-${x.max}`]));
 const addFx=(f,ms)=>{const k=Math.random();setFx(v=>[...v,{...f,k}]);setTimeout(()=>setFx(v=>v.filter(x=>x.k!==k)),ms);};
 const busy=useRef(false);

 function caught(f,minor,multiplier){
  const bet=BigInt(A.open?.bet_minor||A.bet),x=Number(minor/bet),[sx,sy]=toScreen(f.x,f.y),ranged=GAME.arcade.targets.find(t=>t.id===f.kind)?.min;
  const pay=()=>{addFx({type:'pop',x:f.x,y:f.y-f.w*.3,text:`+${full(minor)}`,big:x>=20},1400);
   for(let i=0;i<10;i++)addFx({type:'coin',x:f.x,y:f.y,dx:L.balance[0]+L.balance[2]/2-f.x+(Math.random()-.5)*60,dy:L.balance[1]+25-f.y,delay:120+i*45},1100);
   burst({kind:'sparks',x:sx,y:sy,count:x>=5?26:12,theme:themeOf(id)});
   if(x>=10)cel.celebrate(minor,bet,{fast:true});else audio.play(x>=3?'win':'coin');};
  // The crab and the golden turtle spin their multiplier on a small reel before paying.
  if(ranged){f.held=true;addFx({type:'reel',x:f.x,y:f.y-f.w*.55,to:multiplier},1300);audio.play('reel-stop',{rate:1.2});setTimeout(()=>{f.held=false;f.dead=performance.now();pay();},1100);}
  else{f.dead=performance.now();pay();}
 }

 async function fire(target){
  const w=GAME.arcade.weapons.find(x=>x.id===weapon);
  const alive=F.ref.current.filter(f=>!f.dead&&f.x>20&&f.x<921);if(!alive.includes(target)||busy.current&&weapon!=='cannon')return;
  const chosen=[target,...alive.filter(f=>f!==target).sort((a,b)=>Math.hypot(a.x-target.x,a.y-target.y)-Math.hypot(b.x-target.x,b.y-target.y)).slice(0,w.targets-1)];
  setAngle(angleTo(target.x,target.y));setRecoil(r=>r+1);busy.current=true;
  if(weapon==='laser'){audio.play('zap');addFx({type:'laser',pts:[{x:L.origin[0],y:L.origin[1]},...chosen.map(f=>({x:f.x,y:f.y}))]},520);}
  else if(weapon==='hook'){audio.play('shoot',{rate:.8});addFx({type:'hook',x:target.x,y:target.y},700);}
  else{audio.play('shoot');addFx({type:'shell',tx:target.x,ty:target.y},260);}
  chosen.forEach(f=>f.locked=true);
  const r=await A.shoot(weapon,chosen.map(f=>f.kind));busy.current=false;chosen.forEach(f=>f.locked=false);if(!r)return;
  if(weapon==='cannon')addFx({type:'net',x:target.x,y:target.y},500);
  const pool=[...r.hits],bet=BigInt(A.open?.bet_minor||A.bet);
  for(const f of chosen){const h=pool.findIndex(x=>x.target===f.kind);
   if(h>=0){const hit=pool.splice(h,1)[0];caught(f,bet*BigInt(hit.multiplier),hit.multiplier);}
   else{f.hurt=performance.now();audio.play('hit',{volume:.5});}}
 }
 useEffect(()=>{if(A.toast?.key==='insufficient'){setAuto(false);setLock(false);}},[A.toast]);
 // LOCK keeps firing at the chosen fish; AUTO fires at a random fish (or the locked one).
 useEffect(()=>{if(!auto&&!(lock&&locked))return;const tm=setInterval(()=>{
  const live=F.ref.current.filter(f=>!f.dead&&!f.held&&f.x>60&&f.x<880&&f.y<L.field.bottom-60);
  const lf=locked&&live.find(f=>f.id===locked);if(lock&&locked&&!lf){setLocked(null);if(!auto)return;}
  const target=lf||(auto&&live[Math.floor(Math.random()*live.length)]);if(target)fire(target);
 },lock&&locked?420:620);return()=>clearInterval(tm);},[auto,lock,locked,weapon,A.bet]);
 const stepBet=d=>{audio.play('click');const i=A.bets.indexOf(A.bet);A.setBet(A.bets[Math.min(A.bets.length-1,Math.max(0,i+d))]);};
 const choose=w=>{audio.play('click');setWeapon(v=>v===w?'cannon':w);};
 const tapField=e=>{const r=e.currentTarget.getBoundingClientRect(),s=r.width/941,p={x:(e.clientX-r.left)/s,y:(e.clientY-r.top)/s};
  const c=F.ref.current.filter(f=>!f.dead&&!f.held).map(f=>({f,d:Math.hypot(f.x-p.x,f.y-p.y)})).filter(x=>x.d<Math.max(60,x.f.w*.5)).sort((a,b)=>a.d-b.d)[0];
  if(!c)return;if(lock)setLocked(c.f.id);fire(c.f);};
 const lockedFish=locked&&F.list.find(f=>f.id===locked&&!f.dead);
 return <Stage plate={img('plate')} className={`pf ${weapon}`} dir={isRtl()?'rtl':'ltr'}>
  {cel.node}
  <div className="pf-field" onPointerDown={tapField}>
   {F.list.map(f=><div key={f.id} className={`pf-fish ${f.kind} ${f.dead?'dead':''} ${f.hurt&&performance.now()-f.hurt<220?'hurt':''}`} style={{left:f.x,top:f.y,width:f.w,'--flip':f.vx<0?-1:1,'--tilt':`${Math.cos(f.t*f.fr)*f.fr*f.amp*0.35*(f.vx<0?-1:1)}deg`}}>
    <img src={img(f.kind)} alt="" draggable="false"/>{f.w>=180&&!f.dead&&<b>x{mult[f.kind]}</b>}</div>)}
   {lockedFish&&lock&&<i className="pf-crosshair" style={{left:lockedFish.x,top:lockedFish.y,width:lockedFish.w*.9,height:lockedFish.w*.9}}/>}
  </div>
  {fx.map(f=>f.type==='shell'?<img key={f.k} className="pf-shell" src={img('shell')} alt="" style={{left:L.origin[0],top:L.origin[1]-60,'--dx':`${f.tx-L.origin[0]}px`,'--dy':`${f.ty-L.origin[1]+60}px`}}/>
   :f.type==='net'?<i key={f.k} className="pf-net" style={{left:f.x,top:f.y}}/>
   :f.type==='hook'?<span key={f.k} className="pf-hook" style={{left:L.origin[0],top:L.origin[1]-40,'--len':`${Math.hypot(f.x-L.origin[0],f.y-L.origin[1]+40)}px`,'--rot':`${angleTo(f.x,f.y)}deg`}}><img src={img('hook')} alt=""/></span>
   :f.type==='laser'?<svg key={f.k} className="pf-laser" viewBox="0 0 941 1672"><polyline points={f.pts.map(p=>`${p.x},${p.y}`).join(' ')}/><polyline className="core" points={f.pts.map(p=>`${p.x},${p.y}`).join(' ')}/></svg>
   :f.type==='reel'?<span key={f.k} className="pf-reel" style={{left:f.x,top:f.y}}><b style={{'--to':f.to}}>x{f.to}</b></span>
   :f.type==='pop'?<span key={f.k} className={`pf-pop ${f.big?'big':''}`} style={{left:f.x,top:f.y}}>{f.text}</span>
   :<span key={f.k} className="cs-coin pf-coin" style={{left:f.x-22,top:f.y-22,'--dx':`${f.dx}px`,'--dy':`${f.dy}px`,animationDelay:`${f.delay}ms`}}/>)}
  <img className="pf-over" src={img('column')} alt="" style={{left:826,top:92,width:110,height:584}}/>
  <img className="pf-over" src={img('deck')} alt="" style={{left:0,top:1395,width:941,height:277}}/>
  <img className="pf-cannon" key={recoil} src={img('cannon')} alt="" style={{left:L.origin[0]-75,top:L.origin[1]-190,'--rot':`${angle}deg`}}/>
  <RechargeTap x={L.balance[0]} y={L.balance[1]} w={L.balance[2]} h={L.balance[3]}/>
  <Box x={L.balance[0]} y={L.balance[1]} w={L.balance[2]} h={L.balance[3]} className="pf-balance">{A.balance===null?'—':<CountUp value={Number(A.balance)} format={v=>full(Math.round(v))}/>}</Box>
  <button className="pf-btn" style={circ(L.settings)} onClick={()=>{audio.play('click');setMenu(m=>!m);}} aria-label="settings"/>
  <button className={`pf-btn ${lock?'on':''}`} style={circ(L.lock)} onClick={()=>{audio.play('click');setLock(v=>!v);setLocked(null);}} aria-label="lock"/>
  <button className={`pf-btn ${weapon==='laser'?'on':''}`} style={circ(L.laser)} onClick={()=>choose('laser')} aria-label="laser"/>
  <button className={`pf-btn ${weapon==='hook'?'on':''}`} style={circ(L.hook)} onClick={()=>choose('hook')} aria-label="hook"/>
  <button className={`pf-btn ${auto?'on':''}`} style={circ(L.auto)} onClick={()=>{audio.play('click');setAuto(v=>!v);}} aria-label="auto"/>
  <button className="wg-hot" style={circ(L.minus)} onClick={()=>stepBet(-1)} aria-label="-"/>
  <button className="wg-hot" style={circ(L.plus)} onClick={()=>stepBet(1)} aria-label="+"/>
  <Box x={L.betBox[0]} y={L.betBox[1]} w={L.betBox[2]} h={L.betBox[3]} className="pf-bet">{short(A.bet)}{weapon!=='cannon'&&<small>×{GAME.arcade.weapons.find(w=>w.id===weapon).cost}</small>}</Box>
  {menu&&<div className="cs-menu" style={{right:90,top:L.settings[1]-L.settings[2]}}>
   <button className="cs-icon-btn" onClick={()=>{setRules(true);setMenu(false);}}>?</button>
   <button className="cs-icon-btn" onClick={audio.toggle}>{audio.muted?'🔇':'🔊'}</button></div>}
  {A.toast&&<div className="cs-toast" key={A.toast.id}>{t(A.toast.key)}</div>}
  {rules&&<div className="cs-modal-back" onClick={()=>setRules(false)}><div className="cs-modal" onClick={e=>e.stopPropagation()}>
   <h2>{t('rules')}</h2><p>{t('fishRules')}</p>
   <p>{GAME.arcade.targets.map(x=>`${optionName(x.id,id)} ×${x.multiplier??`${x.min}-${x.max}`}`).join(' · ')}</p>
   <button className="cs-gold-btn" onClick={()=>setRules(false)}>{t('close')}</button></div></div>}
 </Stage>;
}
