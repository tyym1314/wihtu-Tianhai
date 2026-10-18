import React,{lazy,Suspense,useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {waitForLaunch} from './shared/client.mjs';
import {t,setLocale,isRtl} from './shared/i18n.mjs';
import './shared/shell.css';

const GAME=location.pathname.split('/').pop();
const SCENES={greedylion:lazy(()=>import('./games/greedylion/GreedyLion.jsx')),rocketstar2:lazy(()=>import('./games/rocketstar2/RocketStar2.jsx')),teenpatti:lazy(()=>import('./games/teenpatti/TeenPatti.jsx')),olympus:lazy(()=>import('./games/olympus/Olympus.jsx'))};
const Wheel=lazy(()=>import('./games/wheel/WheelGame.jsx'));
for(const id of ['greedycat2','greedyking','greedybrutal','bigeater','fruitparty','greedyforest','herochest','crazyfruit','footballleague','glorycup','bountyfootball','magiccard','solomonmines'])SCENES[id]=Wheel;
const Table=lazy(()=>import('./games/table/TableGame.jsx'));
for(const id of ['roulette','roulettepro','sicbo'])SCENES[id]=Table;
const Crash=lazy(()=>import('./games/crash/CrashGame.jsx'));
for(const id of ['crash','crashstar'])SCENES[id]=Crash;

function App(){
 const [launch,setLaunch]=useState(null),[status,setStatus]=useState('connecting');
 useEffect(()=>{waitForLaunch(GAME,setStatus).then(l=>{if(l.locale)setLocale(l.locale);setLaunch(l);}).catch(e=>setStatus(e.message));},[]);
 const Scene=SCENES[GAME];
 if(!Scene)return <div className="cs-boot">Unknown game</div>;
 if(!launch)return <div className="cs-boot" dir={isRtl()?'rtl':'ltr'}><div className="cs-spinner"/><p>{status==='connecting'?t('connecting'):status}</p></div>;
 return <Suspense fallback={<div className="cs-boot"><div className="cs-spinner"/></div>}><Scene initial={launch.state}/></Suspense>;
}
createRoot(document.getElementById('root')).render(<App/>);
