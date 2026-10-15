import React,{lazy,Suspense,useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {waitForLaunch} from './shared/client.mjs';
import {t,setLocale,isRtl} from './shared/i18n.mjs';
import './shared/shell.css';

const GAME=location.pathname.split('/').pop();
const SCENES={lionfeast:lazy(()=>import('./games/lionfeast/LionFeast.jsx')),rocketrush:lazy(()=>import('./games/rocketrush/RocketRush.jsx')),royalpatti:lazy(()=>import('./games/royalpatti/RoyalPatti.jsx')),skypalace:lazy(()=>import('./games/skypalace/SkyPalace.jsx'))};

function App(){
 const [launch,setLaunch]=useState(null),[status,setStatus]=useState('connecting');
 useEffect(()=>{waitForLaunch(GAME,setStatus).then(l=>{if(l.locale)setLocale(l.locale);setLaunch(l);}).catch(e=>setStatus(e.message));},[]);
 const Scene=SCENES[GAME];
 if(!Scene)return <div className="cs-boot">Unknown game</div>;
 if(!launch)return <div className="cs-boot" dir={isRtl()?'rtl':'ltr'}><div className="cs-spinner"/><p>{status==='connecting'?t('connecting'):status}</p></div>;
 return <Suspense fallback={<div className="cs-boot"><div className="cs-spinner"/></div>}><Scene initial={launch.state}/></Suspense>;
}
createRoot(document.getElementById('root')).render(<App/>);
