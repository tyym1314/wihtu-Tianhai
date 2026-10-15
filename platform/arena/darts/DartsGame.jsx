import {t as $t} from '../shared/i18n.mjs';
import {createPresentationClock,syncGamePresentationClock,bindPresentationClock} from '../shared/presentation-clock.mjs';
import {uiClockChanged} from '../shared/ui-clock.mjs';
import {startVisibleInterval} from '../shared/visible-interval.mjs';
import React,{useEffect,useRef,useState} from 'react';
import {ArrowLeft,Volume2,VolumeX,Info,Target,Clock3,Trophy,X,ChevronUp} from 'lucide-react';
import {SEGMENTS,RINGS,sectorPath,mapGesture} from './geometry.mjs';
import './darts.css';
import './ready-v4.css';
import PlayerPortrait from '../shared/PlayerPortrait.jsx';
import {DartMaterialDefs,MetalDart,FlyingDart,DartImpact} from './DartVisuals.jsx';
const BOARD_MATERIAL=new URL('./assets/v3/board-material.webp',import.meta.url).href;
const HELD_DART=new URL('./assets/v4/held-dart.webp',import.meta.url).href;
// SVG turbulence and large drop shadows are disproportionately expensive in
// Android WebView. Keep the same board geometry and hit coordinates, while
// using authored solid colours on touch devices.
const SIMPLE_BOARD=typeof window!=='undefined'&&((window.matchMedia?.('(pointer: coarse)').matches)||Math.min(window.innerWidth,window.innerHeight)<=600);
const coins=n=>(Number(n||0)/100).toLocaleString('en-US',{maximumFractionDigits:2});
const DartNumberLabels=React.memo(function DartNumberLabels(){return <>{SEGMENTS.map((n,i)=><text key={n} x={Math.sin(i*Math.PI/10)*1.10} y={-Math.cos(i*Math.PI/10)*1.10+.025} textAnchor="middle" fill="#fbe9bd" stroke="#271a10" strokeWidth=".002" paintOrder="stroke" fontSize=".105" fontFamily="Georgia,serif" fontWeight="bold">{n}</text>)}</>});
const DartBoardStatic=React.memo(function DartBoardStatic({simple}){
 if(simple)return <>
  {/* board-material already contains the complete artwork; mobile only adds
      the legal ring outlines and labels that stay legible over the texture. */}
  <image href={BOARD_MATERIAL} x="-1.25" y="-1.25" width="2.5" height="2.5" pointerEvents="none"/>
  <g className="da-mobile-rings" fill="none" stroke="#f5e5bb" strokeWidth=".004" opacity=".68" pointerEvents="none">
   <circle r={RINGS.innerBull}/><circle r={RINGS.outerBull}/><circle r={RINGS.tripleIn}/><circle r={RINGS.tripleOut}/><circle r={RINGS.doubleIn}/>
  </g>
  <DartNumberLabels/>
 </>;
 return <>
  <DartMaterialDefs simple={false}/><defs><radialGradient id="da-case"><stop stopColor="#172834"/><stop offset=".84" stopColor="#07121f"/><stop offset="1" stopColor="#060810"/></radialGradient><linearGradient id="da-gold" x2="1" y2="1"><stop stopColor="#806037"/><stop offset=".3" stopColor="#fff0b8"/><stop offset=".56" stopColor="#c88c3d"/><stop offset="1" stopColor="#634626"/></linearGradient></defs>
  <image href={BOARD_MATERIAL} x="-1.25" y="-1.25" width="2.5" height="2.5" pointerEvents="none"/>
  <defs>{[['ivory',738,220],['black',598,218]].map(([name,x,y])=><pattern key={name} id={'da-fiber-'+name} width=".28" height=".28" patternUnits="userSpaceOnUse"><svg width=".28" height=".28" viewBox={`${x} ${y} 50 50`} preserveAspectRatio="none"><image href={BOARD_MATERIAL} width="1254" height="1254"/></svg></pattern>)}</defs>
  {/* Material samples are clipped to exact server rings; generated art cannot move a scoring boundary. */}
  {SEGMENTS.map((n,i)=><g key={'surface-'+n}>{[[RINGS.outerBull,RINGS.tripleIn],[RINGS.tripleOut,RINGS.doubleIn]].map(([a,b])=><path key={a} d={sectorPath(a,b,i)} fill={`url(#da-fiber-${i%2?'ivory':'black'})`} stroke="#d4c8ac" strokeWidth=".0035"/>)}{[[RINGS.tripleIn,RINGS.tripleOut],[RINGS.doubleIn,1]].map(([a,b])=><path key={a} d={sectorPath(a,b,i)} fill={i%2?'#087950':'#c5302c'} filter="url(#da-surface)" stroke="#efe6cb" strokeWidth=".0035"/>)}</g>)}
  <circle r={RINGS.outerBull} fill="#087950" filter="url(#da-surface)" stroke="#e6d8b6" strokeWidth=".004"/><circle r={RINGS.innerBull} fill="#c5302c" filter="url(#da-surface)" stroke="#efe4c8" strokeWidth=".004"/>
  <DartNumberLabels/>
 </>;
});
export function DartBoard({hit,flight,now=0,getNow,embedded=[],aim,onPointerDown,onPointerMove,onPointerUp,onPointerCancel,onLostPointerCapture,disabled=false}){return <svg className="da-board" data-render-quality={SIMPLE_BOARD?'mobile':'desktop'} viewBox="-1.25 -1.25 2.5 2.5" role="application" aria-label={$t("拖动瞄准，松手投掷飞镖")} onPointerDown={disabled?undefined:onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel} onLostPointerCapture={onLostPointerCapture}>
 <DartBoardStatic simple={SIMPLE_BOARD}/>
 {/* Legal hit coordinates remain derived solely from geometry.mjs; art never decides score. */}
 {aim&&<g className="da-aim" transform={`translate(${aim.x} ${aim.y})`}><circle r=".07" fill="none" stroke="#74f6ff" strokeWidth=".011"/><path d="M -.11 0H-.04M.04 0H.11M0 -.11V-.04M0 .04V.11" stroke="#c8ffff" strokeWidth=".007"/><circle r=".009" fill="white"/></g>}
 {embedded.filter(d=>!flight||d.at!==flight.at).map((d,i)=><g key={`${d.at}-${i}`} transform={`translate(${d.x} ${d.y}) rotate(-12)`} pointerEvents="none"><MetalDart scale={.68}/></g>)}
 {hit&&<g data-testid="darts-landed" data-hit-x={hit.hit.x} data-hit-y={hit.hit.y} transform={`translate(${hit.hit.x} ${hit.hit.y})`} className="da-hit-marker"><circle className="da-impact-ring" r=".11" fill="none" stroke="#7ffaff" strokeWidth=".012"/>{!embedded.some(d=>d.at===hit.at)&&<g transform="rotate(-12)"><MetalDart scale={.68}/></g>}</g>}
 {hit&&<DartImpact event={hit}/>}{flight&&<FlyingDart event={flight} now={now} getNow={getNow}/>}

 </svg>;}
function City(){return <div className="da-palace-scene" aria-hidden="true"><i/><i/><i/></div>;}
export default function DartsGame({room,me,onAction,audio,onExit,locale='zh'}){
 const game=room.game||{},players=game.players||[],mine=players.find(p=>p.key===me),turn=game.turnKey===me,zh=locale==='zh';const [now,setNow]=useState(room.server_now||Date.now()),[aim,setAim]=useState(null),[hit,setHit]=useState(null),[flying,setFlying]=useState(null),[pending,setPending]=useState(false),[message,setMessage]=useState(''),[help,setHelp]=useState(false),[sound,setSound]=useState(audio?.enabled!==false);
 const visualClock=useRef(null);if(!visualClock.current)visualClock.current=createPresentationClock();syncGamePresentationClock(visualClock.current,game,room.server_now,room.id);useEffect(()=>bindPresentationClock(visualClock.current),[]);
 const clock=useRef({server:room.server_now||Date.now(),local:performance.now()}),drag=useRef(null),input=useRef(null),sending=useRef(false),seen=useRef(null),timeouts=useRef(new Set()),mounted=useRef(true),clockUi=useRef(null),aimFrame=useRef(0),latestAim=useRef(null);
 clockUi.current={deadlines:[game.turnDeadlineAt],boundaries:[game.busyUntil,game.turnDeadlineAt,game.deadlineAt,hit?hit.at+2200:undefined]};
 const presentTime=value=>setNow(previous=>uiClockChanged(previous,value,clockUi.current)?value:previous);
 useEffect(()=>{clock.current={server:room.server_now||Date.now(),local:performance.now()};presentTime(clock.current.server);},[room.server_now]);
 useEffect(()=>{mounted.current=true;const stopClock=startVisibleInterval(()=>presentTime(clock.current.server+performance.now()-clock.current.local),50);return()=>{mounted.current=false;stopClock();timeouts.current.forEach(clearTimeout);};},[]);
 function later(fn,ms){const t=setTimeout(()=>{timeouts.current.delete(t);if(mounted.current)fn();},ms);timeouts.current.add(t);}
 function reactTo(event){if(!event||seen.current===event.id)return;seen.current=event.id;if(event.type==='throw'){
  const serverTime=clock.current.server+performance.now()-clock.current.local,remaining=Math.max(0,event.busyUntil-serverTime);
  setFlying(remaining>0?event:null);setHit(null);if(remaining>0)audio?.play?.('shot');
  later(()=>{setHit(event);setFlying(null);audio?.play?.(event.hit.score>=50?'win':'hit');setMessage(event.bust?($t("爆分 · 本回合回退")):event.checkout?($t("归零！等待等轮结果")):event.hit.score?`${event.hit.label}  +${event.hit.score}`:($t("脱靶 · 0 分")));},remaining);
 }else if(event.type==='timeout'){setMessage($t("回合时间到"));audio?.play?.('click');}}

 useEffect(()=>{reactTo(game.lastEvent);},[game.lastEvent?.id]);
 const seconds=Math.min(20,Math.max(0,Math.ceil(((game.turnDeadlineAt||now)-now)/1000))),locked=room.status!=='active'||!turn||game.status!=='active'||mine?.forfeited||pending||help||now<(game.busyUntil||0)||now>=game.turnDeadlineAt||now>=game.deadlineAt,darts=turn?game.currentDarts?.length||0:0;
 function point(e,node,rect){const r=rect||node.getBoundingClientRect();return{x:Math.max(-1.5,Math.min(1.5,(e.clientX-r.left-r.width/2)/(r.width/2.5))),y:Math.max(-1.5,Math.min(1.5,(e.clientY-r.top-r.height/2)/(r.height/2.5))) };}
 // Bind a drag to one pointer and one server turn. A later snapshot cannot
 // turn an old, interrupted gesture into a throw in the next turn.
 const turnToken=JSON.stringify([game.gameId,game.turnKey,game.turnStartedAt,game.currentDarts?.length]);
 input.current={locked,game,turnToken};
 function allowed(d){const current=input.current,t=clock.current.server+performance.now()-clock.current.local;return !sending.current&&!document.hidden&&!current.locked&&t>=(current.game.busyUntil||0)&&t<current.game.turnDeadlineAt&&t<current.game.deadlineAt&&(!d||d.turnToken===current.turnToken&&d.node.hasPointerCapture(d.id));}
 function cancel(e){if(!e||drag.current?.id===e.pointerId){drag.current=null;cancelAnimationFrame(aimFrame.current);aimFrame.current=0;latestAim.current=null;setAim(null);}}
 function presentAim(value){latestAim.current=value;if(!aimFrame.current)aimFrame.current=requestAnimationFrame(()=>{aimFrame.current=0;if(mounted.current&&drag.current)setAim(latestAim.current);});}
 useEffect(()=>{if(locked)cancel();else if(drag.current?.turnToken!==turnToken)cancel();},[locked,turnToken]);
 useEffect(()=>{const blur=()=>cancel(),visibility=()=>{if(document.hidden)cancel();},secondary=e=>{if(e.pointerType==='touch'&&e.isPrimary===false)cancel();};document.addEventListener('pointerdown',secondary,true);window.addEventListener('blur',blur);window.addEventListener('resize',blur);window.addEventListener('scroll',blur,true);document.addEventListener('visibilitychange',visibility);return()=>{drag.current=null;cancelAnimationFrame(aimFrame.current);window.removeEventListener('resize',blur);window.removeEventListener('scroll',blur,true);window.removeEventListener('blur',blur);document.removeEventListener('visibilitychange',visibility);document.removeEventListener('pointerdown',secondary,true);};},[]);
 function down(e){if(e.button!==0||e.isPrimary===false||drag.current){cancel();return;}if(!allowed())return;e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId);const rect=e.currentTarget.getBoundingClientRect(),start=point(e,e.currentTarget,rect);drag.current={id:e.pointerId,turnToken,start:performance.now(),node:e.currentTarget,rect,points:[{...start,t:0}]};setAim(start);setMessage('');audio?.unlock?.();}
 function sample(e){const d=drag.current;if(!d||d.id!==e.pointerId)return;if(!allowed(d)){cancel();return;}const p={...point(e,d.node,d.rect),t:Math.max(d.points.at(-1).t+1,Math.round(performance.now()-d.start))};if(d.points.length>=128)d.points.splice(1,1);d.points.push(p);try{presentAim(mapGesture(d.points));}catch{presentAim(p);}return d;}
 function move(e){if(drag.current?.id===e.pointerId){e.preventDefault();sample(e);}}
 async function up(e){const d=sample(e);if(!d)return;cancel();try{mapGesture(d.points);}catch{setMessage($t("请按住并拖动准星，再松手投镖"));return;}sending.current=true;setPending(true);try{const response=await onAction({type:'throw',gesture:d.points});reactTo(response?.event);}catch(error){if(mounted.current)setMessage(error.message||$t("暂时无法投掷"));}finally{sending.current=false;if(mounted.current)setPending(false);}}
 const target=players.find(p=>p.key===game.turnKey);
 return <section className={`da-scene ${turn?'da-your-turn':''}`} aria-label={$t("飞镖301竞技场")} dir={locale==='ar'?'rtl':'ltr'}><City/><div className="da-vignette"/>
 <header className="da-header"><button onClick={onExit} aria-label={$t("离开游戏")}><ArrowLeft size={19}/></button><h1>✦ DARTS <span>301 ARENA</span></h1><button aria-label={sound?$t("关闭声音"):$t("开启声音")} onClick={()=>{setSound(!sound);audio?.setEnabled?.(!sound);}}>{sound?<Volume2 size={19}/>:<VolumeX size={19}/>}</button></header>
 <div className="da-scoreboard">{players.map((p,i)=><React.Fragment key={p.key}><div className={`da-player da-player-${i} ${p.key===game.turnKey?'is-turn':''}`}><div className="da-avatar"><PlayerPortrait player={p} index={p.seatIndex??i}/></div><div><small>{p.key===me?($t("你")):p.isBot?'BOT':p.name}</small><strong key={p.remaining}>{p.remaining}</strong></div></div>{i===0&&<div className="da-prize"><Trophy size={15}/><small>{room.practice?'FREE PRACTICE':'WINNER PRIZE'}</small><b>{room.practice?'BOT':coins(room.prize_minor)}</b></div>}</React.Fragment>)}</div>
 <div className="da-turn-strip"><span>{$t("第 {0} / 10 轮",[game.round||1])}</span><strong>{turn?($t("你的回合")):$t("{0} 投掷中",[target?.isBot?'BOT':target?.name||$t("对手")])}</strong><b className={seconds<=5?'urgent':''}><Clock3 size={12}/>{seconds}s</b></div>
 <div className={`da-target-wrap ${flying?'is-flying':''}`}><div className="da-target-aura"/><DartBoard hit={hit} flight={flying} now={now} getNow={()=>visualClock.current.now()} embedded={game.currentDarts||[]} aim={aim} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={cancel} onLostPointerCapture={cancel} disabled={locked}/>{hit&&now-hit.at<2200&&<div key={hit.id} className={`da-score-flash ${hit.bust?'is-bust':''}`}>{hit.bust?'BUST!':hit.checkout?'CHECKOUT!':hit.hit.label==='BULL'?'BULL!':hit.hit.multiplier===3?`TRIPLE ${hit.hit.number}`:hit.hit.label}<span>{hit.bust?'TURN RESET':`+${hit.hit.score}`}</span></div>}</div>
 <div className={`da-held-stage ${locked||flying||(hit&&now-hit.at<2200)?'is-hidden':''}`} aria-hidden="true"><svg className="da-swipe-arc" viewBox="0 0 260 94"><defs><linearGradient id="da-swipe-light"><stop stopColor="#45cbea" stopOpacity=".15"/><stop offset=".55" stopColor="#a1f7ff" stopOpacity=".95"/><stop offset="1" stopColor="#64eaff"/></linearGradient></defs><path d="M20 78C60 11 190 9 237 68" fill="none" stroke="url(#da-swipe-light)" strokeWidth="2.2"/><path d="m231 51 7 20-20-8" fill="#83f4ff"/><path d="M29 82C68 22 181 20 226 66" fill="none" stroke="#63eaff" strokeOpacity=".18" strokeWidth="1"/></svg><img className="da-ready-dart" data-testid="darts-ready-dart" src={HELD_DART} alt="" draggable="false"/></div>
 <div className="da-gesture-instruction"><ChevronUp size={17}/><span>{pending?($t("正在确认投镖…")):turn?($t("按住靶面拖动 · 松手投镖")):($t("等待对手 · 双方享有相同轮次"))}</span></div>
 <div className="da-message" aria-live="polite">{message|| ($t("没有隐藏散布，落点取决于你的释放手势。"))}</div>
 <div className="da-control-deck"><div className="da-dart-stock">{[0,1,2].map(i=><i key={i} className={i<darts?'used':''}><svg viewBox="0 0 18 50" aria-hidden="true"><path d="M9 47V19" stroke="#ecd69a" strokeWidth="2"/><path d="M9 5L2 1L1 15L9 23L17 15L16 1Z" fill="#1a6379" stroke="#e9d195" strokeWidth="1"/><path d="M9 4V23" stroke="#7de9ec" strokeWidth="1.5"/></svg></i>)}</div><div className="da-power"><small>{$t("释放控制")}</small><div>{Array.from({length:10},(_,i)=><i key={i} className={aim&&i<8?'lit':i<3?'ready':''}/>)}</div><span>{$t("3 镖 / 回合 · 共 20 秒")}</span></div><div className="da-entry"><small>{room.practice?'ENTRY':'ENTRY'}</small><strong>✦ {room.practice?'FREE':coins(room.entry_minor)}</strong></div></div>
 <footer className="da-footer"><button onClick={()=>setHelp(true)}><Info size={17}/>{$t("规则")}</button><span><Target size={15}/> STRAIGHT OUT · EQUAL ROUNDS</span><b>✧</b></footer>
 {help&&<div className="da-help-backdrop"><div className="da-help"><button className="da-help-close" onClick={()=>setHelp(false)} aria-label={$t("关闭")}><X size={19}/></button><Target size={32}/><h2>{$t("301 · 直出等轮")}</h2><p>{$t("在靶面按住拖动，松手投镖。落点由拖动轨迹和释放速度确定，没有隐藏随机散布。")}</p><p>{$t("每回合 3 镖、共 20 秒。刚好归零可直出；负分则恢复回合初分数。双方同轮归零并列，10 轮后剩分较少者胜。")}</p><p>{$t("连续三次回合没有有效投镖即弃权；有效脱靶也算投掷。关闭页面断线 30 秒后弃权。")}</p><button className="da-help-confirm" onClick={()=>setHelp(false)}>{$t("瞄准，出手")}</button></div></div>}
 </section>;
}
