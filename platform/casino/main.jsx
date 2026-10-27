import React,{lazy,Suspense,useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {waitForLaunch,reportProgress,reportShown} from './shared/client.mjs';
import {t,setLocale,isRtl} from './shared/i18n.mjs';
import './shared/shell.css';

const GAME=location.pathname.split('/').pop();
const LOADERS={greedylion:()=>import('./games/greedylion/GreedyLion.jsx'),rocketstar2:()=>import('./games/rocketstar2/RocketStar2.jsx'),teenpatti:()=>import('./games/teenpatti/TeenPatti.jsx'),olympus:()=>import('./games/olympus/Olympus.jsx'),piratefish:()=>import('./games/piratefish/PirateFish.jsx'),fishstar:()=>import('./games/fishstar/FishStar.jsx')};
const family=(loader,ids)=>{for(const id of ids)LOADERS[id]=loader;};
family(()=>import('./games/wheel/WheelGame.jsx'),['greedycat2','greedyking','fruitmachine','greedybrutal','bigeater','fruitparty','greedyforest','herochest','crazyfruit','footballleague','glorycup','bountyfootball','magiccard','solomonmines']);
family(()=>import('./games/table/TableGame.jsx'),['roulette','roulettepro','sicbo']);
family(()=>import('./games/crash/CrashGame.jsx'),['crash','crashstar']);
family(()=>import('./games/arcade/ArcadeGame.jsx'),['monster','molestar']);
family(()=>import('./games/slot/SlotGame.jsx'),['oceanslot','mahjongslot','cleopatraslot','crazygems','slot777','djlive','jackpotslots','yummy','worldgoal','chillislot','sphinxlegend','nights1001','pyramidslots','magicslot']);
const Scene=LOADERS[GAME]&&lazy(LOADERS[GAME]);

// Before the scene mounts: its code, its full-screen plate and (slots) every reel symbol, reported as progress,
// so a slow connection never opens on empty reels. Capped at 15 s; anything still loading keeps loading in place.
const img=n=>{const i=new Image();i.src=`/casino/${GAME}/${n}.webp?v=${__ASSET_VERSION__}`;return i.decode().catch(()=>{});};
async function preload(){
 // plate-ext fills the screen above/below (left/right for landscape) the design area: load it with the plate,
 // otherwise the game opens with bare bands that fill in a moment later. Games without one resolve on the 404.
 const plate=Promise.all([img('plate'),img('plate-ext')]),{CASINO_GAMES}=await import('../shared/casino-games.mjs');
 const S=CASINO_GAMES[GAME]?.slot,symbols=S?[...new Set([...(S.symbols||[]).map(x=>x.id),S.wild?.id,S.scatter?.id].filter(Boolean))]:[];
 const extra={olympus:['spinbtn']}[GAME]||[];
 const steps=[LOADERS[GAME](),plate,...[...symbols,...extra].map(img)];let done=0;
 await Promise.race([Promise.all(steps.map(p=>p.then(()=>reportProgress(.25+.7*(++done/steps.length))))),new Promise(r=>setTimeout(r,15000))]);
}
/** Tells the host the first frame is on screen (two frames after mount, once the plate is painted). */
function Shown(){useEffect(()=>{let id=requestAnimationFrame(()=>{id=requestAnimationFrame(reportShown);});return()=>cancelAnimationFrame(id);},[]);return null;}

function App(){
 const [launch,setLaunch]=useState(null),[status,setStatus]=useState('connecting');
 useEffect(()=>{waitForLaunch(GAME,setStatus).then(async l=>{if(l.locale)setLocale(l.locale);reportProgress(.25);await preload();setLaunch(l);}).catch(e=>setStatus(e.message));},[]);
 if(!Scene)return <div className="cs-boot">Unknown game</div>;
 if(!launch)return <div className="cs-boot" dir={isRtl()?'rtl':'ltr'}><div className="cs-spinner"/><p>{status==='connecting'?t('connecting'):status}</p></div>;
 return <Suspense fallback={<div className="cs-boot"><div className="cs-spinner"/></div>}><Scene initial={launch.state}/><Shown/></Suspense>;
}
createRoot(document.getElementById('root')).render(<App/>);
