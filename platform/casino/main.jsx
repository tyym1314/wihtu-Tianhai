import React,{lazy,Suspense,useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {waitForLaunch,reportProgress,reportShown} from './shared/client.mjs';
import {t,setLocale,isRtl} from './shared/i18n.mjs';
import './shared/shell.css';

const GAME=location.pathname.split('/').pop();
const LOADERS={greedylion:()=>import('./games/greedylion/GreedyLion.jsx'),rocketstar2:()=>import('./games/rocketstar2/RocketStar2.jsx'),teenpatti:()=>import('./games/teenpatti/TeenPatti.jsx'),olympus:()=>import('./games/olympus/Olympus.jsx')};
const family=(loader,ids)=>{for(const id of ids)LOADERS[id]=loader;};
family(()=>import('./games/wheel/WheelGame.jsx'),['greedycat2','greedyking','greedybrutal','bigeater','fruitparty','greedyforest','herochest','crazyfruit','footballleague','glorycup','bountyfootball','magiccard','solomonmines']);
family(()=>import('./games/table/TableGame.jsx'),['roulette','roulettepro','sicbo']);
family(()=>import('./games/crash/CrashGame.jsx'),['crash','crashstar']);
family(()=>import('./games/arcade/ArcadeGame.jsx'),['monster','molestar']);
family(()=>import('./games/slot/SlotGame.jsx'),['oceanslot','mahjongslot','cleopatraslot','crazygems','slot777','djlive','jackpotslots','yummy','worldgoal','chillislot','sphinxlegend','nights1001','pyramidslots','magicslot']);
const Scene=LOADERS[GAME]&&lazy(LOADERS[GAME]);

// Before the scene mounts: its code and its full-screen plate (the largest asset), reported as progress.
async function preload(){
 const plate=new Image();plate.src=`/casino/${GAME}/plate.webp?v=${__ASSET_VERSION__}`;
 const steps=[LOADERS[GAME](),plate.decode().catch(()=>{})];let done=0;
 await Promise.all(steps.map(p=>p.then(()=>reportProgress(.25+.7*(++done/steps.length)))));
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
