import React,{useEffect,useRef,useState} from 'react';
import {useCelebration} from '../../shared/fx/Celebrate.jsx';
import {burst,toScreen} from '../../shared/fx/particles.js';
import {themeOf} from '../../shared/fx/themes.js';
import {t,isRtl} from '../../shared/i18n.mjs';
import {full,short} from '../../shared/useRound.js';
import {useAudio} from '../../shared/audio.mjs';
import {useArcade} from '../../shared/useArcade.js';
import {api,haptic} from '../../shared/client.mjs';
import {Stage,Box,CountUp} from '../../shared/Stage.jsx';
import {RechargeTap} from '../../shared/recharge.jsx';
import {CASINO_GAMES} from '../../../shared/casino-games.mjs';
import {optionName} from '../../shared/rules.mjs';
import './fishstar.css';

// Design pixels on the 1672x941 landscape plate.
export const L={
 W:1672,H:941,field:{top:120,bottom:790},origin:[851,822],
 balance:[95,858,185,52],piggy:[1395,36,160,46],piggyBtn:[1230,15,345,75],menu:[1623,53,36],
 aim:[1600,593,50],fast:[1600,710,50],auto:[1600,836,50],minus:[696,882,36],plus:[996,882,36],betBox:[770,860,156,56],max:18,
};
// w = width in design px; weight = spawn share; speed px/s; school = how many swim together; cap = most alive at once.
const KINDS=[
 {id:'butterfly',w:86,weight:20,speed:120,school:[3,6]},{id:'yellowfish',w:92,weight:18,speed:115,school:[3,5]},{id:'blackfish',w:96,weight:15,speed:110,school:[2,4]},
 {id:'greenfish',w:100,weight:13,speed:105,school:[2,4]},{id:'guppy',w:110,weight:11,speed:100,school:[2,3]},
 {id:'swordfish',w:220,weight:6,speed:120},{id:'shark',w:260,weight:4,speed:95,cap:2},{id:'goldjelly',w:170,weight:3.5,speed:45,cap:2},{id:'goldturtle',w:210,weight:3,speed:50,cap:2},
 {id:'manta',w:280,weight:2.6,speed:70,cap:1},{id:'goldwhale',w:430,weight:1.2,speed:45,cap:1},
 {id:'swordking',w:360,weight:.7,speed:70,cap:1,king:1},{id:'harrierking',w:340,weight:.6,speed:60,cap:1,king:1},{id:'agate',w:300,weight:.55,speed:55,cap:1,king:1},
 {id:'thunderjelly',w:300,weight:.5,speed:40,cap:1,king:1},{id:'kingcrab',w:320,weight:.45,speed:40,cap:1,king:1},{id:'kingoctopus',w:360,weight:.4,speed:38,cap:1,king:1},
 {id:'spinnercrab',w:260,weight:1.4,speed:45,cap:1,boss:1},{id:'hammercrab',w:270,weight:1,speed:42,cap:1,boss:1},{id:'whirlpool',w:230,weight:1.1,speed:50,cap:1,boss:1},
 {id:'joker',w:250,weight:.8,speed:35,cap:1,boss:1},
];
const KIND=Object.fromEntries(KINDS.map(k=>[k.id,k]));
const pick=items=>{const tot=items.reduce((a,x)=>a+x.weight,0);let r=Math.random()*tot;for(const x of items){r-=x.weight;if(r<0)return x;}return items.at(-1);};
const circ=([x,y,r])=>({left:x-r,top:y-r,width:2*r,height:2*r,borderRadius:'50%'});
const angleTo=(x,y)=>Math.atan2(x-L.origin[0],L.origin[1]-y)*180/Math.PI;
let uid=0;

/** Fish enter from either side, often in schools, and swim across on a gentle wave. Presentation only. */
function useFish(){
 const [list,setList]=useState([]),ref=useRef([]),last=useRef(performance.now()),banner=useRef(null);
 useEffect(()=>{let raf;const step=now=>{const dt=Math.min(.05,(now-last.current)/1000);last.current=now;
  let a=ref.current.filter(f=>f.x>-f.w-60&&f.x<L.W+f.w+60&&!(f.dead&&now-f.dead>900));
  for(const f of a)if(!f.dead&&!f.held){f.t+=dt;f.x+=f.vx*dt;f.y=f.y0+Math.sin(f.t*f.fr)*f.amp;}
  const first=!ref.current.length;
  while(a.filter(f=>!f.dead).length<L.max){
   const live=a.filter(f=>!f.dead),kinds=KINDS.filter(k=>!k.cap||live.filter(f=>f.kind===k.id).length<k.cap),k=pick(kinds);
   const dir=Math.random()<.5?1:-1,n=k.school?k.school[0]+Math.floor(Math.random()*(k.school[1]-k.school[0]+1)):1;
   const y0=L.field.top+k.w*.35+Math.random()*(L.field.bottom-L.field.top-k.w*.7),speed=k.speed*(.85+Math.random()*.3);
   if((k.king||k.boss)&&!first)banner.current={kind:k.id,at:now};
   for(let i=0;i<n;i++){
    const start=first?120+Math.random()*1430:dir>0?-k.w/2-i*k.w*.8:L.W+k.w/2+i*k.w*.8;
    a.push({id:++uid,kind:k.id,w:k.w,x:start,y0:y0+(i%2?1:-1)*i*k.w*.3,y:0,vx:dir*speed,t:Math.random()*6,fr:.6+Math.random()*.6,amp:k.w>200?16:26});
   }
  }
  ref.current=a;setList([...a]);raf=requestAnimationFrame(step);};raf=requestAnimationFrame(step);return()=>cancelAnimationFrame(raf);},[]);
 return {list,ref,banner};
}

export default function FishStar({initial}){
 const id=initial.game_id,GAME=CASINO_GAMES[id],img=n=>`/casino/${id}/${n}.webp?v=${__ASSET_VERSION__}`;
 const A=useArcade(initial,GAME);
 const audio=useAudio(id,['shoot','zap','hit','coin','click','win','bigwin','reel-stop','thunder','ding','nice','stamp','rollup','roll-end','charge','cheer','celebrate-loop','sting-big','sting-mega','sting-epic','sting-legend']);
 const cel=useCelebration(id,audio),F=useFish();
 const [auto,setAuto]=useState(false),[aim,setAim]=useState(false),[fast,setFast]=useState(false),[locked,setLocked]=useState(null);
 const [panel,setPanel]=useState(null),[menu,setMenu]=useState(false),[angle,setAngle]=useState(0),[recoil,setRecoil]=useState(0),[fx,setFx]=useState([]);
 const [piggy,setPiggy]=useState(null),[coming,setComing]=useState(null);
 const T=Object.fromEntries(GAME.arcade.targets.map(x=>[x.id,x])),mult=k=>T[k].multiplier??`${T[k].min}-${T[k].max}`;
 const addFx=(f,ms)=>{const k=Math.random();setFx(v=>[...v,{...f,k}]);setTimeout(()=>setFx(v=>v.filter(x=>x.k!==k)),ms);};
 const busy=useRef(false),bet=()=>BigInt(A.open?.bet_minor||A.bet);
 const loadPiggy=()=>api('/api/casino/piggy').then(setPiggy).catch(()=>{});
 useEffect(()=>{loadPiggy();const tm=setInterval(loadPiggy,30000);return()=>clearInterval(tm);},[]);
 // "{boss} is coming!" when a king or special boss swims in.
 useEffect(()=>{const tm=setInterval(()=>{const b=F.banner.current;if(b&&performance.now()-b.at<300){F.banner.current=null;setComing(b.kind);audio.play('charge',{volume:.6});setTimeout(()=>setComing(null),2200);}},250);return()=>clearInterval(tm);},[]);

 function pay(f,minor,coinsFrom=[f]){
  const x=Number(minor/bet()),[sx,sy]=toScreen(f.x,f.y);
  addFx({type:'pop',x:f.x,y:f.y-f.w*.3,text:`+${full(minor)}`,big:x>=30},1500);
  for(const c of coinsFrom)for(let i=0;i<(coinsFrom.length>1?3:10);i++)addFx({type:'coin',x:c.x,y:c.y,dx:L.balance[0]+L.balance[2]/2-c.x+(Math.random()-.5)*60,dy:L.balance[1]+20-c.y,delay:120+i*45},1100);
  burst({kind:'sparks',x:sx,y:sy,count:x>=10?30:14,theme:themeOf(id)});
  if(x>=10){cel.celebrate(minor,bet(),{fast:true});haptic(x>=50?'heavy':'medium');}else{audio.play(x>=3?'win':'coin');haptic('light');}
 }
 function caught(f,hit,along){
  const minor=bet()*BigInt(hit.multiplier),k=KIND[f.kind];
  if(f.kind==='joker'){f.hurt=performance.now();addFx({type:'gift',x:f.x,y:f.y-80,to:hit.multiplier},1300);setTimeout(()=>pay(f,minor),700);return;}
  if(f.kind==='spinnercrab'){f.held=true;addFx({type:'wheel',x:f.x,y:f.y,to:hit.multiplier},1700);audio.play('reel-stop',{rate:1.2});setTimeout(()=>{f.held=false;f.dead=performance.now();pay(f,minor);},1500);return;}
  if(f.kind==='hammercrab'){f.held=true;addFx({type:'hammer',x:f.x,y:f.y},1100);setTimeout(()=>{audio.play('thunder');addFx({type:'flash'},500);
   const victims=[];for(const kind of hit.with||[]){const v=along.find(x=>x.kind===kind&&!x.dead&&!victims.includes(x));if(v){v.dead=performance.now();victims.push(v);addFx({type:'bolt',x:v.x,y:v.y},500);}}
   f.held=false;f.dead=performance.now();pay(f,minor,[f,...victims]);},800);return;}
  if(f.kind==='whirlpool'){f.held=true;addFx({type:'vortex',x:f.x,y:f.y},1400);setTimeout(()=>{const victims=along.filter(x=>!x.dead).slice(0,(hit.with||[]).length);
   for(const v of victims){v.dead=performance.now();v.pull={x:f.x,y:f.y};}f.held=false;f.dead=performance.now();pay(f,minor,[f,...victims]);},900);return;}
  f.dead=performance.now();if(k.king)addFx({type:'flash'},400);pay(f,minor);
 }
 async function fire(target){
  const alive=F.ref.current.filter(f=>!f.dead&&!f.held&&f.x>30&&f.x<L.W-30);if(!alive.includes(target)||busy.current)return;
  let entry=target.kind,along=[];
  // Bosses that take other fish along: the client names them, the server prices the capture on all of them.
  if(target.kind==='hammercrab'){along=alive.filter(f=>f!==target&&T[f.kind].multiplier<=50&&!T[f.kind].type).slice(0,GAME.arcade.sweepCap);entry={id:'hammercrab',with:along.map(f=>f.kind)};}
  if(target.kind==='whirlpool'){const n={};for(const f of alive)if(f!==target&&!T[f.kind].type&&T[f.kind].multiplier<=50)n[f.kind]=(n[f.kind]||0)+1;
   const kind=Object.entries(n).sort((a,b)=>b[1]-a[1])[0]?.[0];along=kind?alive.filter(f=>f.kind===kind).slice(0,GAME.arcade.sweepCap):[];entry={id:'whirlpool',with:along.map(f=>f.kind)};}
  setAngle(angleTo(target.x,target.y));setRecoil(r=>r+1);busy.current=true;audio.play('shoot');haptic('tick');
  addFx({type:'shell',tx:target.x,ty:target.y},240);
  const r=await A.shoot('cannon',[entry]);busy.current=false;if(!r)return;
  addFx({type:'net',x:target.x,y:target.y},500);
  const hit=r.hits[0];if(hit)caught(target,hit,along);else{target.hurt=performance.now();audio.play('hit',{volume:.45});}
 }
 useEffect(()=>{if(A.toast?.key==='insufficient'){setAuto(false);setAim(false);}},[A.toast]);
 // AIM keeps firing at the chosen fish; AUTO fires at random fish; FAST shortens the interval.
 useEffect(()=>{if(!auto&&!(aim&&locked))return;const tm=setInterval(()=>{
  const live=F.ref.current.filter(f=>!f.dead&&!f.held&&f.x>80&&f.x<L.W-80);
  const lf=locked&&live.find(f=>f.id===locked);if(aim&&locked&&!lf){setLocked(null);if(!auto)return;}
  const target=lf||(auto&&live[Math.floor(Math.random()*live.length)]);if(target)fire(target);
 },fast?260:520);return()=>clearInterval(tm);},[auto,aim,locked,fast,A.bet]);
 const stepBet=d=>{audio.play('click');const i=A.bets.indexOf(A.bet);A.setBet(A.bets[Math.min(A.bets.length-1,Math.max(0,i+d))]);};
 const tapField=e=>{const r=e.currentTarget.getBoundingClientRect(),s=r.width/L.W,p={x:(e.clientX-r.left)/s,y:(e.clientY-r.top)/s};
  const c=F.ref.current.filter(f=>!f.dead&&!f.held).map(f=>({f,d:Math.hypot(f.x-p.x,f.y-p.y)})).filter(x=>x.d<Math.max(55,x.f.w*.5)).sort((a,b)=>a.d-b.d)[0];
  if(!c)return;if(aim)setLocked(c.f.id);fire(c.f);};
 const claim=async()=>{audio.play('click');try{const s=await api('/api/casino/piggy/claim',{});setPiggy(s);audio.play('nice');haptic('medium');burst({kind:'coins',count:40,theme:themeOf(id)});}catch(e){A.say(e.code==='NOTHING_TO_CLAIM'?'nothingToClaim':'failed');}};
 const lockedFish=locked&&F.list.find(f=>f.id===locked&&!f.dead);
 const toggle=(set,v)=>{audio.play('click');set(x=>!x);};
 return <Stage plate={img('plate')} width={L.W} height={L.H} className="fs" dir={isRtl()?'rtl':'ltr'}>
  {cel.node}
  <div className="fs-field" onPointerDown={tapField}>
   {F.list.map(f=><div key={f.id} className={`fs-fish ${f.kind} ${KIND[f.kind].king?'king':''} ${KIND[f.kind].boss?'boss':''} ${f.dead?(f.pull?'pulled':'dead'):''} ${f.hurt&&performance.now()-f.hurt<220?'hurt':''}`}
    style={{left:f.x,top:f.y,width:f.w,'--flip':f.vx<0?-1:1,'--tilt':`${Math.cos(f.t*f.fr)*f.fr*f.amp*0.3*(f.vx<0?-1:1)}deg`,...(f.pull?{'--px':`${f.pull.x-f.x}px`,'--py':`${f.pull.y-f.y}px`}:{})}}>
    <img src={img(f.kind)} alt="" draggable="false"/>{f.w>=170&&!f.dead&&<b>x{mult(f.kind)}</b>}</div>)}
   {lockedFish&&aim&&<i className="fs-crosshair" style={{left:lockedFish.x,top:lockedFish.y,width:lockedFish.w*.85,height:lockedFish.w*.85}}/>}
  </div>
  {fx.map(f=>f.type==='shell'?<img key={f.k} className="fs-shell" src={img('shell')} alt="" style={{left:L.origin[0],top:L.origin[1]-70,'--dx':`${f.tx-L.origin[0]}px`,'--dy':`${f.ty-L.origin[1]+70}px`}}/>
   :f.type==='net'?<i key={f.k} className="fs-net" style={{left:f.x,top:f.y}}/>
   :f.type==='wheel'?<span key={f.k} className="fs-wheel" style={{left:f.x,top:f.y}}><i/><b>x{f.to}</b></span>
   :f.type==='gift'?<span key={f.k} className="fs-gift" style={{left:f.x,top:f.y}}>🎁<b>x{f.to}</b></span>
   :f.type==='hammer'?<img key={f.k} className="fs-hammer" src={img('hammer')} alt="" style={{left:f.x,top:f.y}}/>
   :f.type==='bolt'?<i key={f.k} className="fs-bolt" style={{left:f.x,top:f.y}}/>
   :f.type==='vortex'?<i key={f.k} className="fs-vortex" style={{left:f.x,top:f.y}}/>
   :f.type==='flash'?<i key={f.k} className="fs-flash"/>
   :f.type==='pop'?<span key={f.k} className={`fs-pop ${f.big?'big':''}`} style={{left:f.x,top:f.y}}>{f.text}</span>
   :<span key={f.k} className="cs-coin fs-coin" style={{left:f.x-22,top:f.y-22,'--dx':`${f.dx}px`,'--dy':`${f.dy}px`,animationDelay:`${f.delay}ms`}}/>)}
  {coming&&<div className="fs-coming"><img src={img(coming)} alt=""/><b>{t('bossComing').replace('{fish}',optionName(coming,id))}</b></div>}
  <img className="fs-over" src={img('column')} alt="" style={{left:1540,top:530,width:122,height:370}}/>
  <img className="fs-over" src={img('topbar')} alt="" style={{left:1220,top:8,width:448,height:92}}/>
  <img className="fs-cannon" key={recoil} src={img('cannon')} alt="" style={{left:L.origin[0]-62,top:L.origin[1]-176,'--rot':`${angle}deg`}}/>
  <RechargeTap x={L.balance[0]} y={L.balance[1]} w={L.balance[2]} h={L.balance[3]}/>
  <Box x={L.balance[0]} y={L.balance[1]} w={L.balance[2]} h={L.balance[3]} className="fs-balance">{A.balance===null?'—':<CountUp value={Number(A.balance)} format={v=>full(Math.round(v))}/>}</Box>
  <button className="fs-hot" style={{left:L.piggyBtn[0],top:L.piggyBtn[1],width:L.piggyBtn[2],height:L.piggyBtn[3]}} onClick={()=>{audio.play('click');loadPiggy();setPanel('piggy');}} aria-label="piggy"/>
  <Box x={L.piggy[0]} y={L.piggy[1]} w={L.piggy[2]} h={L.piggy[3]} className={`fs-piggy ${piggy&&piggy.claimable_minor!=='0'?'ready':''}`}>{piggy?short(piggy.today_minor):'—'}</Box>
  <button className="fs-hot" style={circ(L.menu)} onClick={()=>toggle(setMenu)} aria-label="menu"/>
  {menu&&<div className="cs-menu fs-menu" style={{right:16,top:L.menu[1]+L.menu[2]+10}}>
   <button className="cs-icon-btn" onClick={()=>{setPanel('rules');setMenu(false);}} aria-label={t('rules')}>?</button>
   <button className="cs-icon-btn" onClick={()=>{setPanel('records');setMenu(false);}} aria-label={t('records')}>☰</button>
   <button className="cs-icon-btn" onClick={()=>{setPanel('rank');setMenu(false);}} aria-label={t('rank')}>🏆</button>
   <button className="cs-icon-btn" onClick={audio.toggle}>{audio.muted?'🔇':'🔊'}</button></div>}
  <button className={`fs-btn ${aim?'on':''}`} style={circ(L.aim)} onClick={()=>{toggle(setAim);setLocked(null);}} aria-label="aim"/>
  <button className={`fs-btn ${fast?'on':''}`} style={circ(L.fast)} onClick={()=>toggle(setFast)} aria-label="fast"/>
  <button className={`fs-btn ${auto?'on':''}`} style={circ(L.auto)} onClick={()=>toggle(setAuto)} aria-label="auto"/>
  <button className="wg-hot" style={circ(L.minus)} onClick={()=>stepBet(-1)} aria-label="-"/>
  <button className="wg-hot" style={circ(L.plus)} onClick={()=>stepBet(1)} aria-label="+"/>
  <Box x={L.betBox[0]} y={L.betBox[1]} w={L.betBox[2]} h={L.betBox[3]} className="fs-bet">{short(A.bet)}</Box>
  {A.toast&&<div className="cs-toast" key={A.toast.id}>{t(A.toast.key)}</div>}
  {panel&&<Panel kind={panel} close={()=>setPanel(null)} piggy={piggy} claim={claim} GAME={GAME} img={img} mult={mult} id={id}/>}
 </Stage>;
}

function Panel({kind,close,piggy,claim,GAME,img,mult,id}){
 const [data,setData]=useState(null),[period,setPeriod]=useState('day');
 useEffect(()=>{if(kind==='records')api('/api/casino/records').then(setData).catch(()=>setData({records:[]}));
  if(kind==='rank'){setData(null);api(`/api/casino/rank?period=${period}`).then(setData).catch(()=>setData({rows:[]}));}},[kind,period]);
 return <div className="cs-modal-back" onClick={close}><div className={`cs-modal fs-panel fs-${kind}`} onClick={e=>e.stopPropagation()}>
  <button className="fs-x" onClick={close} aria-label={t('close')}>×</button>
  {kind==='piggy'&&<div className="fs-piggy-wrap"><img className="fs-piggy-art" src={img('piggy')} alt=""/><div><h2>{t('piggyBank')}</h2><p>{t('piggyText')}</p>
   <div className="fs-piggy-cols"><div><small>{t('rewardToday')}</small><b>{piggy?full(BigInt(piggy.claimable_minor)):'—'}</b>
    <button className="cs-gold-btn" disabled={!piggy||piggy.claimable_minor==='0'} onClick={claim}>{piggy&&piggy.claimed_minor!=='0'?t('received'):t('receive')}</button></div>
    <div><small>{t('rewardTomorrow')}</small><b>{piggy?full(BigInt(piggy.today_minor)):'—'}</b><em>{t('piggyExpire')}</em></div></div></div></div>}
  {kind==='rules'&&<><h2>{t('rules')}</h2><p>{t('fishStarRules')}</p><div className="fs-codex">{GAME.arcade.targets.map(x=><div key={x.id}><img src={img(x.id)} alt=""/><span>{optionName(x.id,id)}</span><b>x{mult(x.id)}</b></div>)}</div></>}
  {kind==='records'&&<><h2>{t('records')}</h2><table className="fs-table"><thead><tr><th>{t('time')}</th><th>{t('spend')}</th><th>{t('income')}</th></tr></thead>
   <tbody>{(data?.records||[]).map((r,i)=><tr key={i}><td>{new Date(r.at).toLocaleString()}</td><td>{full(BigInt(r.spent_minor))}</td><td>{full(BigInt(r.won_minor))}</td></tr>)}</tbody></table>
   {data&&!data.records.length&&<p>{t('noRecords')}</p>}</>}
  {kind==='rank'&&<><h2>{t('rank')}</h2><div className="fs-tabs">{['day','week','fame'].map(p=><button key={p} className={p===period?'on':''} onClick={()=>setPeriod(p)}>{t('rank_'+p)}</button>)}</div>
   <div className="fs-rank">{(data?.rows||[]).map(r=><div key={r.rank} className={r.me?'me':''}><em>{r.rank}</em>{r.avatar_url?<img src={r.avatar_url} alt=""/>:<i/>}<span>{r.name||r.tag}</span><b>{short(BigInt(r.amount_minor))}</b></div>)}
   {data&&!data.rows.length&&<p>{t('noRecords')}</p>}</div></>}
 </div></div>;
}
