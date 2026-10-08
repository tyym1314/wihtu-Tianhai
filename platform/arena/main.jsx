import React,{lazy,Suspense,useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ArrowLeft,Volume2,VolumeX,Users,Copy,Check,ArrowRight,Trophy,Coins,Flag,ShieldCheck,RefreshCw,LoaderCircle,Sparkles,X,WifiOff,ChevronRight} from 'lucide-react';
const loadMatchGame=()=>import('./match/MatchGame.jsx');
const MatchGame=lazy(loadMatchGame);
const loadGolfGame=()=>import('./golf/GolfGame.jsx');
const GolfGame=lazy(loadGolfGame);
const loadTowerGame=()=>import('./towerlink/TowerLinkGame.jsx');
let resolvedRunModule;
const loadRunGame=()=>import('./run/RunGame.jsx').then(module=>(resolvedRunModule=module));
// A roster change must acquire its new asset lease in this effect setup, before
// the previous effect's last-consumer cancellation microtask runs.
const preloadRunGame=(kinds,options)=>resolvedRunModule?resolvedRunModule.preloadRunAssets(kinds,options):loadRunGame().then(module=>module.preloadRunAssets(kinds,options));
const loadBowlingGame=()=>import('./bowling/BowlingGame.jsx');
const TowerLinkGame=lazy(loadTowerGame);
import {ArenaAudio} from './shared/audio.mjs';
import {api,coins,requestId,waitForLaunch,registerHostControls,completeHostReturn} from './shared/client.mjs';
import {ARENA_GAMES,teamSizeFor} from '../shared/games.mjs';
import {TRAINING_LESSONS,TRAINING_VERSION,getTrainingLesson} from './towerlink/training.mjs';
import LobbyArt from './shared/LobbyArt.jsx';
import PlayerPortrait from './shared/PlayerPortrait.jsx';
import ThemeResult from './shared/ThemeResult.jsx';
import useResultPresentation from './shared/useResultPresentation.jsx';
import {startRoomPolling,createRoomPollCadence,startRunRoomPolling,readRunRoomOnce} from './shared/room-poller.mjs';
import {runRequiresSceneReady} from './run/start-policy.mjs';
import {readRunActionReceipt} from '../shared/run-action-receipt.mjs';
import './shell.css';
const GAME_LOADERS={match:loadMatchGame,golf:loadGolfGame,towerlink:loadTowerGame,carrom:()=>import('./carrom/CarromGame.jsx'),darts:()=>import('./darts/DartsGame.jsx'),ludo:()=>import('./ludo/LudoGame.jsx'),jackaroo:()=>import('./jackaroo/JackarooGame.jsx'),domino:()=>import('./domino/DominoGame.jsx'),pool:()=>import('./pool/PoolGame.jsx'),bowling:loadBowlingGame,run:loadRunGame};
const GAME_COMPONENTS=Object.fromEntries(Object.entries(GAME_LOADERS).map(([game,load])=>[game,lazy(load)]));
const GAME=location.pathname.split('/').pop(),IS_MATCH=GAME==='match',IS_TOWER=GAME==='towerlink',IS_RUN=GAME==='run',IS_GOLF=GAME==='golf',IS_BOWLING=GAME==='bowling',PRELOAD_GAME=!!GAME_LOADERS[GAME];
const RUN_LOCALE=['zh','en','ar'].includes(new URLSearchParams(location.search).get('locale'))?new URLSearchParams(location.search).get('locale'):'zh';
const META=ARENA_GAMES[GAME]||ARENA_GAMES.match,ActiveGame=GAME_COMPONENTS[GAME]||MatchGame;
const teamName=id=>id==='team_a'?'翡翠队':id==='team_b'?(GAME==='jackaroo'?'象牙队':'琥珀队'):'';
const terminal=s=>['settled','cancelled','voided'].includes(s);
// These are expected server-side race outcomes while a runner is recovering
// or an input is already being simulated. RunGame presents the short feedback
// in-scene; keeping the global alert open would cover the touch controls after
// the recovery window has ended.
const RUN_RECOVERABLE_ACTION_ERRORS=new Set(['STALE_INPUT','BUSY','RATE_LIMIT','INPUT_PENDING','ALREADY_JUMPING','SLIDING','AIRBORNE','CHANGING_LANE','TRACK_EDGE','NO_ITEM','WRONG_ITEM','BOOST_ACTIVE','SHIELD_ACTIVE']);
const RUN_PENDING_MESSAGES=new Set(['上一项操作仍待确认，可重试原请求核对结果。','上一动作仍待确认，请重试原请求核对结果。','上一局动作仍待确认，请重试原请求核对结果。']);
const TOWER_RECOVERABLE_ACTION_ERRORS=new Set(['GAME_NOT_STARTED','BUSY','DEADLINE_PASSED','NOT_ACTIVE','INVALID_LINK','NOT_YOUR_TOWER','ALREADY_UPGRADING','INSUFFICIENT_TROOPS','MAX_LEVEL','NOT_UPGRADABLE','INVALID_SEQUENCE']);
const unwrap=r=>r.room||r;
// An active Run GET can carry a fresher wall clock without a new committed
// game state. The HUD extrapolates that clock locally; committing this response
// would reconcile the whole React tree while the renderer keeps drawing.
// Room versions cover persisted state, and the Run view is deterministic for a
// fixed state. Presence is the one unversioned visible value, so compare every
// public player field before reusing the current room.
function unchangedRunPoll(old,next){
 if(!IS_RUN||old?.id!==next?.id||old?.status!=='active'||next.status!=='active'||!Number.isSafeInteger(next.version)||old.version!==next.version||old.me!==next.me||old.me_last_seq!==next.me_last_seq)return false;
 const a=old.game,b=next.game;
 if(!a||!b||a.snapshotTick!==b.snapshotTick||a.status!==b.status||a.phase!==b.phase||a.serverNow!==b.serverNow)return false;
 if(!Array.isArray(old.players)||!Array.isArray(next.players)||old.players.length!==next.players.length)return false;
 return old.players.every((player,index)=>{const current=next.players[index];return !!current&&Object.keys(player).length===Object.keys(current).length&&Object.entries(player).every(([key,value])=>current[key]===value);});
}
const sessionOwner=context=>context?JSON.stringify([context.scope?.app_id,context.game_id,context.external_user_id]):null;
const audio=new ArenaAudio(GAME);
function Avatar({player,index=0,empty=false,large=false}){return <div className={`arena-avatar avatar-${index%4} ${empty?'empty':''} ${large?'large':''}`}>{empty?<span>+</span>:<PlayerPortrait player={player} index={index}/>}{player?.ready&&<i><Check size={10}/></i>}</div>;}
function GolfArt(){return <div className="golf-diorama" aria-hidden="true"><svg viewBox="0 0 420 290"><defs><linearGradient id="sand" x2="0" y2="1"><stop stopColor="#ffe1a0"/><stop offset="1" stopColor="#b16d37"/></linearGradient><linearGradient id="green" x2="0" y2="1"><stop stopColor="#c2ef8d"/><stop offset="1" stopColor="#379a6c"/></linearGradient></defs><ellipse cx="210" cy="218" rx="180" ry="48" fill="#76ffdd" opacity=".18"/><path d="M53 154L220 85 366 137 352 207 195 271 63 224Z" fill="url(#sand)"/><path d="M53 154L220 85 366 137 352 183 198 245 63 201Z" fill="#edbb77"/><path d="M63 144L219 77 367 130 353 169 198 231 64 190Z" fill="#ffedbd"/><path d="M80 143L220 87 349 133 337 159 196 216 80 180Z" fill="url(#green)" stroke="#b5e482" strokeWidth="7"/><path d="M153 137Q217 147 239 109" fill="none" stroke="#59cbae" strokeWidth="15"/><ellipse cx="281" cy="141" rx="9" ry="4" fill="#173e32"/><path d="M281 139V50" stroke="#ffd48c" strokeWidth="4"/><path d="M283 51L327 60 283 77Z" fill="#fe735a"/><circle cx="125" cy="170" r="10" fill="#fff9d4"/><path d="M126 157Q160 125 199 136" fill="none" stroke="white" strokeDasharray="4 8" opacity=".7"/><g stroke="#a87745" strokeWidth="8" fill="none"><path d="M93 136Q108 77 97 50"/><path d="M337 153Q325 92 348 67"/></g><g fill="#249b79"><path d="M98 53Q58 37 41 65Q72 60 99 65Q95 25 122 18Q115 43 107 58Q135 33 154 57Q130 53 105 68Q70 77 66 91Q71 65 98 53Z"/><path d="M348 67Q319 31 300 57Q322 54 341 78Q361 30 383 46Q360 54 353 72Q388 62 396 84Q365 75 346 87Q319 93 308 111Q308 83 348 67Z"/></g></svg><span className="diorama-spark s1">✦</span><span className="diorama-spark s2">✧</span></div>;}
function Arena(){
 const [gameAssets,setGameAssets]=useState(PRELOAD_GAME?'loading':'ready'),[assetAttempt,setAssetAttempt]=useState(0);
 const [towerArt,setTowerArt]=useState('loading'),[towerArtAttempt,setTowerArtAttempt]=useState(0);
 const [preparedRunKinds,setPreparedRunKinds]=useState('');
 const runInFlightIntent=useRef(null),runRoomReads=useRef(new Set());
 const hostReturnSent=useRef(null),hostReturnTimer=useRef(null);
 const [trainingOpen,setTrainingOpen]=useState(false),[trainingDone,setTrainingDone]=useState([]);
 const [context,setContext]=useState(null),[boot,setBoot]=useState('正在连接游戏…'),[room,setRoom]=useState(null),[error,setError]=useState(''),[network,setNetwork]=useState(false),[busy,setBusy]=useState(false),[muted,setMuted]=useState(!audio.enabled),[capacity,setCapacity]=useState(META.players[0]),[entry,setEntry]=useState('10000'),[joinCode,setJoinCode]=useState(''),[copied,setCopied]=useState(false),[exitOpen,setExitOpen]=useState(false),[showRules,setShowRules]=useState(false),[balance,setBalance]=useState(null),[recovering,setRecovering]=useState(null);
 const contextRef=useRef(null),roomRef=useRef(null),pending=useRef(null),mounted=useRef(true),inFlight=useRef(false),celebrated=useRef(null),hostBackPending=useRef(false),runSceneReadyRequest=useRef(null);
 const runnerKinds=IS_RUN?[...new Set(room?.game?.players?.length?room.game.players.map(player=>player.character):['fox','cat','bear','rabbit'].slice(0,room?.capacity||capacity))].sort().join(','):'';
 const {presenting,presentationRoom,reveal}=useResultPresentation(room);
 function clearHostReturn(){hostReturnSent.current=null;clearTimeout(hostReturnTimer.current);hostReturnTimer.current=null;}
 function sendHostReturn(details){const sent=completeHostReturn(details);hostReturnSent.current=sent?{roomId:details.room_id,owner:contextRef.current,until:performance.now()+1000}:null;return sent;}
 const trainingStorageKey=context?.scope?.app_id?`oasis:tower-training:${TRAINING_VERSION}:${context.scope.app_id}:${context.external_user_id}`:null;
 useEffect(()=>{if(!IS_TOWER||!trainingStorageKey)return;try{const saved=JSON.parse(localStorage.getItem(trainingStorageKey)||'[]');setTrainingDone(Array.isArray(saved)?saved.filter(id=>getTrainingLesson(id)):[]);}catch{setTrainingDone([]);}},[trainingStorageKey]);
 useEffect(()=>{const training=room?.game?.training;if(!IS_TOWER||!trainingStorageKey||room?.status!=='settled'||!training?.completed||!getTrainingLesson(training.lessonId))return;setTrainingDone(old=>{const next=[...new Set([...old,training.lessonId])];try{localStorage.setItem(trainingStorageKey,JSON.stringify(next));}catch{}return next;});},[room?.id,room?.status,room?.game?.training?.completed,trainingStorageKey]);
 useEffect(()=>{if(!PRELOAD_GAME)return;let cancelled=false;const controller=new AbortController();setGameAssets('loading');const loading=IS_MATCH?Promise.all([loadMatchGame(),import('./match/assets.mjs').then(module=>module.preloadMatchAssets())]):IS_RUN?preloadRunGame(runnerKinds.split(','),{signal:controller.signal}):IS_GOLF?loadGolfGame().then(module=>module.preloadGolfAssets({signal:controller.signal})):IS_BOWLING?loadBowlingGame().then(module=>module.preloadBowlingAssets({signal:controller.signal})):IS_TOWER?loadTowerGame():Promise.all([GAME_LOADERS[GAME](),import('./shared/board-assets.mjs').then(module=>module.preloadBoardAssets(GAME))]);loading.then(()=>{if(!cancelled){setPreparedRunKinds(runnerKinds);setGameAssets('ready');}}).catch(()=>{if(!cancelled)setGameAssets('failed');});return()=>{cancelled=true;controller.abort();};},[assetAttempt,runnerKinds]);
 useEffect(()=>{if(!IS_TOWER||gameAssets!=='ready')return;let cancelled=false,unsubscribe=()=>{};setTowerArt('loading');import('./towerlink/tower-assets.mjs').then(module=>{if(cancelled)return;unsubscribe=module.subscribeTowerAssets(status=>{if(cancelled)return;setTowerArt(status.loaded===status.total?'ready':status.failed&&!status.loading?'failed':'loading');});return module.preloadTowerAssets();}).catch(()=>{if(!cancelled)setTowerArt('failed');});return()=>{cancelled=true;unsubscribe();};},[towerArtAttempt,gameAssets]);
 function cancelRunRoomReads(){for(const controller of runRoomReads.current)controller.abort(new DOMException('OASIS_ROOM_POLL_STOPPED','AbortError'));}
 function ownedRoomRead(id,owner,{controller=new AbortController(),isCurrent=()=>contextRef.current===owner}={}){if(!IS_RUN)return api(`/api/pvp/rooms/${id}`);runRoomReads.current.add(controller);return readRunRoomOnce({read:signal=>api(`/api/pvp/rooms/${id}`,undefined,{signal}),rateScope:JSON.stringify([owner?.scope?.app_id,owner?.external_user_id]),signal:controller.signal,isCurrent}).finally(()=>runRoomReads.current.delete(controller));}
 function accept(raw,{poll=false}={}){const r=unwrap(raw);if(!r?.id)return r;const old=roomRef.current;if(old?.id===r.id&&Number(r.version)<Number(old.version))return old;if(poll&&unchangedRunPoll(old,r))return old;roomRef.current=r;setRoom(r);return r;}
 useEffect(()=>{mounted.current=true;audio.subscribe(()=>setMuted(!audio.enabled));waitForLaunch(GAME,setBoot).then(async c=>{if(!mounted.current)return;contextRef.current=c;setContext(c);setBalance(c.balance?.balance?.available_minor??null);setBoot('');if(c.active_room_id)setRecovering(c.active_room_id);if(c.other_active_game)setError('你在另一款游戏中仍有进行中的房间，请先回到该游戏完成或退出。');}).catch(e=>setBoot(e.message));return()=>{mounted.current=false;cancelRunRoomReads();audio.dispose();};},[]);
 useEffect(()=>{if(!recovering)return;let stopped=false,timer;const owner=contextRef.current,controller=new AbortController();const recover=async()=>{try{const r=await ownedRoomRead(recovering,owner,{controller,isCurrent:()=>!stopped&&contextRef.current===owner});if(!stopped){accept(r);setRecovering(null);setError(pending.current?'上一项操作仍待确认，可重试原请求核对结果。':'');}}catch(e){if(!stopped){setError('原房间正在恢复：'+e.message);timer=setTimeout(recover,2000);}}};recover();return()=>{stopped=true;clearTimeout(timer);controller.abort(new DOMException('OASIS_ROOM_POLL_STOPPED','AbortError'));};},[recovering,IS_RUN&&context]);
 useEffect(()=>{const unlock=()=>audio.unlock();window.addEventListener('pointerdown',unlock,{passive:true});return()=>window.removeEventListener('pointerdown',unlock);},[]);
 useEffect(()=>registerHostControls({onBack:()=>{const r=roomRef.current;if(r&&!terminal(r.status)){hostBackPending.current=true;setExitOpen(true);}else sendHostReturn({reason:'user',room_id:r?.id||null,status:r?.status||'lobby'});}}),[]);
 useEffect(()=>{const authorized=e=>{const c=e.detail?.context;if(c?.game_id!==GAME)return;cancelRunRoomReads();clearHostReturn();const changed=sessionOwner(contextRef.current)!==sessionOwner(c);if(changed||c.active_room_id!==roomRef.current?.id){hostBackPending.current=false;setExitOpen(false);}contextRef.current=c;if(changed){pending.current=null;roomRef.current=null;setRoom(null);setBusy(inFlight.current);setExitOpen(false);hostBackPending.current=false;}setNetwork(false);setError(pending.current?'上一项操作仍待确认，可重试原请求核对结果。':'');setContext(c);setBalance(c.balance?.balance?.available_minor??null);setRecovering(c.active_room_id??null);};window.addEventListener('oasis:authorized',authorized);return()=>window.removeEventListener('oasis:authorized',authorized);},[]);
 useEffect(()=>{if(!hostBackPending.current||!room)return;const own=room.players.find(p=>p.external_user_id===context?.external_user_id);if(terminal(room.status)||own?.forfeited){hostBackPending.current=false;sendHostReturn({reason:'left',room_id:room.id,status:room.status});}},[room,context?.external_user_id]);
 useEffect(()=>{
  if(!room?.id||terminal(room.status))return;
  const owner=contextRef.current,interval=createRoomPollCadence({game:GAME,readRoom:()=>roomRef.current}),initialDelay=room.status==='funding'?interval():250;
  const activeRun=IS_RUN&&room.status==='active',poll=activeRun?startRunRoomPolling:startRoomPolling,rateScope=JSON.stringify([owner?.scope?.app_id,owner?.external_user_id]);
  const direct=signal=>api(`/api/pvp/rooms/${room.id}`,undefined,{signal});
  const read=signal=>IS_RUN&&!activeRun?readRunRoomOnce({read:direct,rateScope,signal,isCurrent:()=>contextRef.current===owner&&roomRef.current?.id===room.id}):direct(signal);
  return poll({read,onRoom:data=>{accept(data,{poll:true});setNetwork(false);},onError:e=>{setNetwork(true);if(e.status===401)setError('会话已到期。请从应用重新打开，后台保留原对局与结算。');},roomId:room.id,playerKey:owner?.external_user_id,rateScope,readVersion:()=>roomRef.current?.version,readRoom:()=>roomRef.current,interval,initialDelay});
 },[room?.id,terminal(room?.status),room?.status==='funding',IS_RUN&&room?.status==='active',IS_RUN&&context]);
 useEffect(()=>{
  if(!room||!terminal(room.status)||recovering)return;
  const owner=contextRef.current;let stopped=false;
  const refresh=()=>{hostReturnTimer.current=null;if(stopped||!mounted.current||contextRef.current!==owner||roomRef.current?.id!==room.id||!terminal(roomRef.current?.status))return;api('/api/arena/session').then(c=>{if(!stopped&&contextRef.current===owner&&roomRef.current?.id===room.id)setBalance(c.balance?.balance?.available_minor??null);}).catch(()=>{});};
  // postMessage confirms dispatch only. Avoid starting a GET during navigation,
  // but refresh normally if this same page remains after the host return request.
  const sent=hostReturnSent.current,delay=sent?.owner===owner&&sent.roomId===room.id?Math.max(0,sent.until-performance.now()):0;
  if(delay>0)hostReturnTimer.current=setTimeout(refresh,delay);else refresh();
  const stop=()=>{stopped=true;clearHostReturn();};window.addEventListener('pagehide',stop,{once:true});
  if(!presenting&&celebrated.current!==room.id){celebrated.current=room.id;const mine=room.players.find(p=>p.external_user_id===context?.external_user_id);audio.play(room.status==='settled'&&mine?.rank===1?'victory':'finish');}
  return()=>{stopped=true;clearTimeout(hostReturnTimer.current);hostReturnTimer.current=null;window.removeEventListener('pagehide',stop);};
 },[room?.id,room?.status,presenting,context,recovering]);
 async function perform(intent){
  const runAction=IS_RUN&&!!intent.body?.action;
  const ownsRoom=()=>!runAction||intent.owner===sessionOwner(contextRef.current)&&intent.roomId===roomRef.current?.id;
  const clearIntent=()=>{if(!runAction||pending.current===intent){pending.current=null;if(runAction)setError(message=>RUN_PENDING_MESSAGES.has(message)?'':message);}};
  const refreshRoom=async()=>{if(!roomRef.current||!ownsRoom())return;const owner=contextRef.current,next=await ownedRoomRead(roomRef.current.id,owner,{isCurrent:()=>contextRef.current===owner&&ownsRoom()});if(ownsRoom())accept(next);};
  if(intent.owner!==sessionOwner(contextRef.current)){clearIntent();setBusy(runAction?!!pending.current:false);throw new Error('会话已切换，请先同步当前账号的房间。');}
  if(inFlight.current)throw new Error('正在确认上一项操作');
  inFlight.current=true;pending.current=intent;if(runAction)runInFlightIntent.current=intent;setBusy(true);setError('');
  try{
   // Presentation starts only after this exact intent owns the dispatch slot.
   // Retrying an uncertain request must not replay its local animation.
   if(runAction&&!intent.dispatchNotified){intent.dispatchNotified=true;try{intent.onDispatch?.(intent.runInput);}catch(e){console.error('Run input presentation failed',e);}}
   const raw=await api(intent.path,intent.body),r=ownsRoom()?accept(raw):roomRef.current;
   const inputReceipt=runAction&&ownsRoom()?readRunActionReceipt(unwrap(raw),intent.runInput):null;
   clearIntent();if(ownsRoom())setNetwork(false);return{room:r,event:r?.game?.lastEvent,...(runAction?{inputReceipt}: {})};
  }catch(e){
   if(e.status&&e.status<500&&e.status!==429&&e.status!==408){clearIntent();if(e.code==='INVALID_SEQUENCE')try{await refreshRoom();}catch{}}
   if(intent.body?.action&&(GAME==='run'&&RUN_RECOVERABLE_ACTION_ERRORS.has(e.code)||IS_TOWER&&TOWER_RECOVERABLE_ACTION_ERRORS.has(e.code))){
    if(ownsRoom()){setError('');try{await refreshRoom();}catch{if(ownsRoom())setNetwork(true);}}
   }else if(ownsRoom())setError(e.code==='SESSION_CHANGED'?'会话已更新；上一项操作可能已受理，请同步房间或重试原请求核对结果。':e.message);
   // A retained Run intent must keep its explicit retry available, including
   // rate-limit recovery and an ACK crossing into another restored room.
   if(runAction&&pending.current===intent)setError(ownsRoom()?'上一动作仍待确认，请重试原请求核对结果。':'上一局动作仍待确认，请重试原请求核对结果。');
   throw e;
  }finally{
   if(!runAction||runInFlightIntent.current===intent){if(runAction)runInFlightIntent.current=null;inFlight.current=false;setBusy(!!pending.current);}
  }
 }
 const command=(path,body={},options={})=>{const payload={request_id:requestId(),...body},runAction=IS_RUN&&!!body.action;return perform({path,owner:sessionOwner(contextRef.current),...(runAction?{roomId:roomRef.current?.id,onDispatch:options.onDispatch,runInput:{roomId:roomRef.current?.id,playerKey:contextRef.current?.external_user_id,ruleVersion:roomRef.current?.game?.ruleVersion,request_id:payload.request_id,seq:payload.seq,type:payload.action.type}}:{}),body:payload});};
 const attempt=fn=>fn().catch(()=>{});
 function create(practice){audio.play('click');attempt(()=>command('/api/pvp/rooms',{game_id:GAME,capacity,entry_minor:practice||IS_TOWER&&capacity>2?'0':entry,practice}));}
 async function startTraining(lessonId){const lesson=getTrainingLesson(lessonId);if(!IS_TOWER||!lesson||gameAssets!=='ready'||inFlight.current||pending.current)return;setTrainingOpen(false);const response=await command('/api/pvp/rooms',{game_id:GAME,capacity:lesson.playerCount,entry_minor:'0',practice:true,training_lesson_id:lesson.id});await command(`/api/pvp/rooms/${response.room.id}/ready`);}
 async function onAction(action,options){if(assetsLoading)throw new Error('游戏资源尚未准备好，请稍候。');if(pending.current||inFlight.current)throw new Error('上一动作仍待确认，请稍候');const r=roomRef.current;if(r?.status!=='active')throw new Error('本局已结束');return command(`/api/pvp/rooms/${r.id}/action`,{seq:Number(r.me_last_seq)+1,action},options);}
 async function onRunSceneReady(roomId,refreshGeneration=0){
  const r=roomRef.current,owner=sessionOwner(contextRef.current);
  if(!IS_RUN||r?.id!==roomId||!runRequiresSceneReady(r?.game?.ruleVersion)||r.game.phase!=='arming'||!owner) return null;
  // One ID per rendered-frame generation: an uncertain retry replays safely,
  // while a later foreground frame can refresh the server's readiness proof.
  if(runSceneReadyRequest.current?.roomId!==roomId||runSceneReadyRequest.current.owner!==owner||runSceneReadyRequest.current.generation!==refreshGeneration)runSceneReadyRequest.current={roomId,owner,generation:refreshGeneration,requestId:requestId()};
  const response=await api(`/api/pvp/rooms/${roomId}/scene-ready`,{request_id:runSceneReadyRequest.current.requestId});
  if(roomRef.current?.id===roomId&&sessionOwner(contextRef.current)===owner)accept(response);
  return response;
 }
 function requestHostExit(){const r=roomRef.current;if(r&&!terminal(r.status)){hostBackPending.current=true;setExitOpen(true);}else sendHostReturn({reason:'user',room_id:r?.id||null,status:r?.status||'lobby'});}
 function newGame(){if(inFlight.current)return;clearHostReturn();hostBackPending.current=false;pending.current=null;setBusy(false);roomRef.current=null;setRoom(null);setError('');setExitOpen(false);audio.play('click');}
 const me=room?.players.find(p=>p.external_user_id===context?.external_user_id),fee=room?.fee_bps??context?.competitive_fee_bps??500;
 const isTeam=room?room.team_size===2:teamSizeFor(GAME,capacity)===2;
 const social=IS_TOWER&&(capacity>2||entry==='0'),roomSocial=IS_TOWER&&!room?.practice&&room?.entry_minor==='0';
 const amount=BigInt(social?'0':entry)*BigInt(capacity),prize=amount-amount*BigInt(fee)/10000n;
 const buttonDisabled=busy||!!recovering||!!context?.other_active_game;
 const assetsLoading=PRELOAD_GAME&&(gameAssets!=='ready'||IS_RUN&&preparedRunKinds!==runnerKinds);
 const assetLoadNotice=<>{assetsLoading&&<p role="status">{gameAssets==='failed'?<>游戏资源加载失败，请重试后准备。<button className="arena-text-button" onClick={()=>setAssetAttempt(n=>n+1)}>重新加载资源</button></>:<>正在准备游戏资源，完成后才能开局…</>}</p>}{IS_TOWER&&towerArt==='loading'&&<p role="status">战场画面正在后台加载，已可使用简化画面开局。</p>}{IS_TOWER&&towerArt==='failed'&&<p role="status">部分战场画面加载失败，简化画面仍可操作。<button className="arena-text-button" onClick={()=>setTowerArtAttempt(n=>n+1)}>重试画面资源</button></p>}</>;
 const sounds=<button className="arena-circle" aria-label={muted?'开启声音':'关闭声音'} onClick={()=>{audio.toggle();setMuted(!audio.enabled);}}>{muted?<VolumeX size={19}/>:<Volume2 size={19}/>}</button>;
 const active=room?.status==='active'||presenting;
 return <main className={`arena-app ${'theme-'+META.theme}`}>
 {!active&&<div className="ambient-sparkles" aria-hidden="true">{Array.from({length:14},(_,i)=><i key={i} style={{'--i':i}}/>)}</div>}
 {!context?<div className="arena-loading"><div className="brand-star">{META.icon}</div><h1>{META.en}</h1><LoaderCircle className="spinning"/><p>{boot}</p></div>:active&&assetsLoading?<section className="arena-loading" data-testid="active-assets-gate"><div className="brand-star">{META.icon}</div><h1>加载对局画面</h1>{gameAssets!=='failed'&&<LoaderCircle className="spinning"/>}<p role="status">{gameAssets==='failed'?'游戏资源加载失败，可以重试。':'正在恢复游戏资源，比赛时钟仍由服务器继续计时。'}</p>{gameAssets==='failed'&&<button className="arena-gold" onClick={()=>setAssetAttempt(n=>n+1)}>重新加载资源</button>}<button className="arena-text-button" onClick={()=>presenting?reveal():requestHostExit()}>返回或离开房间</button></section>:active?<><Suspense fallback={<div className="arena-loading"><LoaderCircle className="spinning"/><p>正在准备游戏画面…</p></div>}><ActiveGame key={IS_RUN?JSON.stringify([room?.id,context.external_user_id]):undefined} room={presentationRoom} me={context.external_user_id} onAction={onAction} onSceneReady={IS_RUN?onRunSceneReady:undefined} audio={audio} onExit={()=>presenting?reveal():requestHostExit()} locale={IS_RUN?RUN_LOCALE:'zh'} requestState={IS_RUN?(inFlight.current?'sending':pending.current?'unresolved':'idle'):undefined}/></Suspense></>:<div className={`arena-shell ${room&&(room.result||terminal(room.status))?'has-themed-result':''}`}>
 <header className="arena-top"><button className="arena-circle" aria-label="返回" onClick={requestHostExit}><ArrowLeft size={19}/></button><span className="oasis-wordmark">OASIS<span>PLAY TOGETHER</span></span>{sounds}</header>
 {recovering?<section className="arena-loading in-room"><LoaderCircle className="spinning"/><h1>恢复原房间</h1><p>正在读取你的对局状态，金币与结果继续由后台保留。</p></section>:!room?<>
 <section className="arena-hero"><div className="game-edition">{META.tag}</div><h1><><span>{META.brand[0]}</span>{META.brand[1]}</></h1><div className="hero-game-art">{IS_MATCH?<><div className="crystal-halo"/><img className="hero-fox" src="/arena/assets/fox-mascot-mobile-7d3781fba5.webp" alt="耳廓狐伙伴"/><span className="hero-jewel jewel-one">◆</span><span className="hero-jewel jewel-two">◆</span><span className="hero-jewel jewel-three">◆</span></>:GAME==='golf'?<GolfArt/>:<LobbyArt game={GAME}/>}</div><div className="hero-strap"><Sparkles size={13}/>{META.name} · {META.players.join(' / ')} 人对战</div></section>
 <section className="arena-glass lobby-settings"><div className="lobby-intro"><h2>召集你的对手</h2><button onClick={()=>setShowRules(true)}>玩法 <ChevronRight size={13}/></button></div><p>{META.description}</p><div className="arena-field-label">对局人数<span>{isTeam?'对座搭档 · 2v2':'个人对决 · 公平起点'}</span></div><div className="arena-segments">{META.players.map(n=><button key={n} className={capacity===n?'selected':''} onClick={()=>{setCapacity(n);audio.play('select');}}><Users size={15}/>{n} 人</button>)}</div><div className="arena-field-label">{IS_TOWER&&capacity>2?'真人娱乐房':'每人入场'}<span>{IS_TOWER&&capacity>2?'多人自由混战 · 无奖池':'金币仅在 App 内使用'}</span></div><div className="arena-stakes">{(IS_TOWER?(capacity>2?['0']:['0','1000','5000','10000']):['1000','5000','10000','20000']).map(n=><button key={n} className={(social?n==='0':entry===n)?'selected':''} onClick={()=>{setEntry(n);audio.play('select');}}><Coins size={12}/>{n==='0'?'免费娱乐':coins(n)}</button>)}</div><div className="lobby-prize"><span>{social?'真人好友娱乐':isTeam?'胜队奖池':'冠军奖池'}<small>{social?'无入场费 · 无奖金 · 不补机器人':<>服务费 {fee/100}% · {isTeam?'队友均分':IS_TOWER?'平局退本金':'并列平分'}</>}</small>{isTeam&&<small>每位胜方 {coins(prize/2n)} 金币</small>}</span><strong><Coins size={20}/>{social?'FREE':coins(prize)}</strong></div>{isTeam&&<p className="team-disclosure">第 1、3 位加入的玩家同队，第 2、4 位同队。开局后任一队员弃权，全队弃权。</p>}<>{assetLoadNotice}</><button className="arena-gold" disabled={buttonDisabled||assetsLoading} onClick={()=>create(false)}>{social?'创建免费好友房':'创建好友房'} <ArrowRight size={19}/></button><div className="lobby-secondary">{IS_TOWER&&<button disabled={buttonDisabled||assetsLoading} onClick={()=>setTrainingOpen(true)}><Flag size={14}/>策略训练<span>{trainingDone.length} / 12 已完成</span></button>}<button disabled={buttonDisabled||assetsLoading} onClick={()=>create(true)}><Sparkles size={14}/>免费练习<span>BOT · 不扣币</span></button><button onClick={()=>document.getElementById('room-code')?.focus()}><Users size={14}/>加入好友<span>使用房间码</span></button></div><form className="join-code" onSubmit={e=>{e.preventDefault();attempt(()=>command(`/api/pvp/rooms/${joinCode.trim().toUpperCase()}/join`));}}><input id="room-code" aria-label="房间码" placeholder="输入好友的房间码" value={joinCode} maxLength={64} autoComplete="off" onChange={e=>setJoinCode(e.target.value.replace(/[^a-zA-Z0-9_-]/g,''))}/><button disabled={buttonDisabled||!joinCode.trim()} aria-label="加入房间"><ArrowRight size={18}/></button></form></section>
 <footer className="arena-footer"><span><Coins size={13}/>{balance===null?'余额待同步':coins(balance)}</span><small>{context.external_user_id}</small><ShieldCheck size={14}/></footer>
 </>:room.status==='waiting'?<section className="waiting-room"><div className="room-emblem">{META.icon}</div><div className="game-edition">YOUR NEXT RIVALRY</div><h1>{room.practice?'练习准备':roomSocial?'免费好友房':'好友集结'}</h1><p>{room.practice?'BOT 仅参与免费练习，不使用金币。':'将房间码发送给同一应用里的好友。'}</p><button className="room-code" onClick={async()=>{try{await navigator.clipboard.writeText(room.code);setCopied(true);setTimeout(()=>setCopied(false),1800);}catch{setError('复制不可用，请直接选择并复制房间码。');}}}><small>ROOM CODE</small><strong>{room.code}</strong>{copied?<Check size={18}/>:<Copy size={18}/>}</button><div className="room-seats">{Array.from({length:room.capacity},(_,i)=>{const p=room.players[i];return <div className="room-seat" key={i}><Avatar player={p} index={i} empty={!p} large/><strong>{p?(p.external_user_id===context.external_user_id?'你':p.bot?'练习对手':p.name):'等待好友'}</strong>{isTeam&&<em className={`team-tag ${p?.team_id|| (i%2?'team_b':'team_a')}`}>{teamName(p?.team_id||(i%2?'team_b':'team_a'))}</em>}<span className={p?.ready?'ready':''}>{p?.bot?'BOT':p?.ready?'已准备':p?'待准备':'空位'}</span></div>;})}</div><section className="arena-glass ready-card"><div className="ready-facts"><div><small>每人入场</small><strong>{room.practice||roomSocial?'FREE':coins(room.entry_minor)}</strong></div><div><small>{isTeam?'胜队奖池':'冠军奖池'}</small><strong>{room.practice?'练习赛':roomSocial?'无奖池':coins(room.prize_minor)}</strong></div><div><small>服务费</small><strong>{room.fee_bps/100}%</strong></div></div><p>{room.practice?'所有人准备后开始练习。':roomSocial?'真人好友娱乐：全员准备后开始，不扣金币、不发奖金，不会自动加入机器人。':isTeam?'全员准备后扣款。胜队两人均分奖池；任一队员退出或超时弃权，全队弃权。':IS_TOWER?'全员准备后扣款，倒计时 3 秒开始。先比塔数再比总兵力；真正平局本金全退且不抽成。':'全部玩家准备后才扣款开局。并列第一平分奖池；未成局不收费。'}</p><>{assetLoadNotice}</><button className="arena-gold" disabled={busy||me?.ready||assetsLoading} onClick={()=>{audio.play('ready');attempt(()=>command(`/api/pvp/rooms/${room.id}/ready`));}}>{me?.ready?'已准备，等待其他玩家':'确认规则 · 准备开局'}{me?.ready?<Check size={18}/>:<ArrowRight size={18}/>}</button><button className="arena-text-button" disabled={busy} onClick={()=>setExitOpen(true)}>离开房间</button></section></section>:room.result||terminal(room.status)?<ThemeResult game={GAME} room={room} meId={context.external_user_id} meta={META} onAgain={newGame} locale={IS_RUN?RUN_LOCALE:'zh'} onRetryTraining={IS_TOWER&&room.game?.training?()=>attempt(()=>startTraining(room.game.training.lessonId)):undefined} onNextTraining={IS_TOWER&&room.game?.training?.completed&&room.game.training.nextLessonId?()=>attempt(()=>startTraining(room.game.training.nextLessonId)):undefined} onLobby={()=>{completeHostReturn({reason:'user',room_id:room.id,status:room.status});newGame();}}/>:<section className="arena-loading in-room"><div className="brand-star">{META.icon}</div><h1>{room.status==='fault'?'正在恢复对局':room.status==='funding'?'正在准备开局':'正在确认钱包'}</h1><LoaderCircle className="spinning"/><p>{room.status==='fault'?'比赛计时暂停。无法恢复时，将整局作废并退款。':'后台会查询原交易，确认完成后自动继续。'}</p></section>}
 </div>}
 {trainingOpen&&<div className="arena-modal-backdrop"><section className="arena-modal" role="dialog" aria-modal="true" aria-label="策略训练选关"><button className="modal-close" aria-label="关闭选关" onClick={()=>setTrainingOpen(false)}><X size={20}/></button><div className="room-emblem">⚑</div><h2>12 关策略训练</h2><p>全部免费 · AI 明示 · 进度不增加竞技战力</p><div className="tower-training-list">{TRAINING_LESSONS.map((lesson,index)=><button key={lesson.id} disabled={busy||assetsLoading} onClick={()=>attempt(()=>startTraining(lesson.id))}><span>{String(index+1).padStart(2,'0')}{trainingDone.includes(lesson.id)&&<Check size={13}/>}</span><strong>{lesson.title}</strong><small>{lesson.playerCount} 方训练</small></button>)}</div><p>训练记录保存在本设备；通关以服务器目标完成为准。</p></section></div>}
 {network&&<div className="arena-network" role="status"><WifiOff size={14}/>正在重连，保留原对局…</div>}
 {error&&context&&<div className="arena-error" role="alert"><span>{error}</span>{pending.current?<button disabled={inFlight.current} onClick={()=>attempt(()=>perform(pending.current))}><RefreshCw size={13}/>重试原请求</button>:<button aria-label="关闭提示" onClick={()=>setError('')}><X size={16}/></button>}</div>}
 {busy&&!pending.current?.body?.action&&<div className="arena-busy"><LoaderCircle className="spinning" size={15}/>确认中…</div>}
 {(exitOpen||showRules)&&<div className="arena-modal-backdrop"><section className="arena-modal" role="dialog" aria-modal="true"><button className="modal-close" aria-label="关闭" onClick={()=>{hostBackPending.current=false;setExitOpen(false);setShowRules(false);}}><X size={20}/></button><div className="room-emblem">{showRules?'✦':'↗'}</div><h2>{showRules?'怎么玩？':'离开本局？'}</h2>{showRules?<><p>{META.description}</p><ul>{META.rules.map(t=><li key={t}>{t}</li>)}</ul><p>{IS_TOWER?'同局使用相同初始条件。断线 30 秒弃权；双人金币局真正平局或整局作废，均返还本金且不抽成。三人、四人只开放无奖池娱乐。':'同局使用相同初始条件。断线 30 秒弃权；整局作废退回入场额。并列冠军按入场时规则平分。'}</p><button className="arena-gold" onClick={()=>setShowRules(false)}>开始挑战</button></>:<><p>{roomSocial?(room?.status==='waiting'?'免费好友房将取消，没有金币变化。':'离开会按弃权处理，其他好友继续本局。没有金币变化。'):room?.status==='waiting'?'房间将取消，已预留的金币会释放。':isTeam?'离开会导致全队弃权，包括你的队友。已开局的入场金币不会退回。':'离开会按弃权处理。已开局的入场金币不会因个人退出退回。'}</p><button className="arena-gold" onClick={()=>{hostBackPending.current=false;setExitOpen(false);}}>继续游戏</button><button className="arena-text-button" disabled={busy} onClick={()=>{setExitOpen(false);attempt(()=>command(`/api/pvp/rooms/${room.id}/leave`));}}>确认离开</button></>}</section></div>}
 </main>;
}
createRoot(document.getElementById('root')).render(<Arena/>);
