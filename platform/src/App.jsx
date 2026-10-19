import ReleaseOperations from './components/ReleaseOperations.jsx';
import SecurityPanel from './components/SecurityPanel.jsx';
import React, { useEffect, useRef, useState } from 'react';
import { LayoutDashboard, Gamepad2, Layers3, SlidersHorizontal, WalletCards, BookOpen, Rocket, Search, Bell, ChevronDown, ArrowUpRight, Menu, X, Check, Command, CircleHelp, Building2, Leaf, ExternalLink } from 'lucide-react';
import { Overview, Games, Configuration, Ledger, Releases } from './pages/Admin.jsx';
import Partner from './pages/Partner.jsx';
import Developer from './pages/Developer.jsx';
import { games } from './data.js';
import { api, useApi, getApiMode } from './api.js';
import ApiState from './components/ApiState.jsx';
import Login from './pages/Login.jsx';
import './phase-b.css';

const navigation = [
  { group:'工作空间', items:[['overview','运营总览',LayoutDashboard],['games','游戏中心',Gamepad2],['partners','合作方与应用',Layers3]] },
  { group:'运营管理', items:[['settings','规则与收益',SlidersHorizontal],['ledger','局单与对账',WalletCards],['releases','版本与发布',Rocket],['security','账户安全',SlidersHorizontal]] },
  { group:'开发者', items:[['docs','接入与文档',BookOpen]] }
];
const titles = {overview:'运营总览',games:'游戏中心',partners:'合作方与应用',settings:'规则与收益',ledger:'局单与对账',releases:'版本与发布',docs:'开发者中心',security:'账户安全'};
const normalize = value => ({developer:'docs',partner:'partners',applications:'partners',config:'settings'}[value] || value);
const getRoute = () => { const value=normalize(location.hash.replace(/^#\/?/,'').split('?')[0]); return titles[value] ? value : 'overview'; };

export default function App() {
  return <AdminApp/>;
}

function AdminApp() {
  const sessionRequest=useRef({generation:0,controller:null});
  const [user,setUser]=useState(null), [environment,setEnvironment]=useState(null), [sessionLoading,setSessionLoading]=useState(true), [sessionError,setSessionError]=useState(''), [loggingOut,setLoggingOut]=useState(false);
  const appsResource=useApi('/api/admin/apps',Boolean(user));
  const apps=appsResource.data?.apps || [];
  const production=environment==='production';
  const environmentLabel=production?'生产环境':'联调沙箱';
  const invalidateSession=()=>{sessionRequest.current.controller?.abort();sessionRequest.current={generation:sessionRequest.current.generation+1,controller:null};};
  const clearSession=()=>{invalidateSession();setUser(null);setEnvironment(null);setSessionLoading(false);setSessionError('');};
  const loadSession=async()=>{
    invalidateSession();const mode=getApiMode(),controller=new AbortController(),generation=sessionRequest.current.generation;
    sessionRequest.current.controller=controller;
    const current=()=>!controller.signal.aborted&&generation===sessionRequest.current.generation&&mode===getApiMode();
    setSessionLoading(true);setSessionError('');
    try{const result=await api('/api/admin/session',{mode,signal:controller.signal});if(!current())return;
      if(result.user&&!['sandbox','production'].includes(result.environment))throw new Error('后台环境信息不可用，请重新读取。');
      setEnvironment(result.environment);setUser(result.user || null);
    }catch(error){if(current())setSessionError(error.message);}finally{if(current())setSessionLoading(false);}
  };
  useEffect(()=>{
    loadSession();const expired=e=>{if(e.detail?.mode&&e.detail.mode!==getApiMode())return;clearSession();setToast('登录已过期，请重新登录。');};
    const modeChanged=()=>clearSession();
    window.addEventListener('oasis:unauthorized',expired);window.addEventListener('oasis:api-mode',modeChanged);
    return()=>{invalidateSession();window.removeEventListener('oasis:unauthorized',expired);window.removeEventListener('oasis:api-mode',modeChanged);};
  },[]);
  const [route,setRoute]=useState(getRoute), [appScope,setAppScope]=useState('all');
  const [mobileNav,setMobileNav]=useState(false), [toast,setToast]=useState(''), [searchOpen,setSearchOpen]=useState(false), [query,setQuery]=useState(''), [notifications,setNotifications]=useState(false);
  const isPartner=user?.role==='partner_developer';
  const visibleNavigation=navigation.map(group=>({...group,items:group.items.filter(([id])=>!isPartner||!['settings','releases'].includes(id))})).filter(group=>group.items.length);
  const navigate = next => { const requested=normalize(next),value=isPartner&&['settings','releases'].includes(requested)?'partners':requested; location.hash=`/${titles[value]?value:'overview'}`; setMobileNav(false); setNotifications(false); };
  const notify = message => setToast(message);
  useEffect(()=>{if(isPartner&&['settings','releases'].includes(route))navigate('partners');},[isPartner,route]);
  useEffect(()=>{const onHash=()=>{setRoute(getRoute());window.scrollTo({top:0});};window.addEventListener('hashchange',onHash);return()=>window.removeEventListener('hashchange',onHash);},[]);
  useEffect(()=>{if(!toast)return;const t=setTimeout(()=>setToast(''),4200);return()=>clearTimeout(t);},[toast]);
  useEffect(()=>{const key=e=>{if((e.metaKey||e.ctrlKey)&&e.key==='k'){e.preventDefault();setSearchOpen(v=>!v);}if(e.key==='Escape'){setMobileNav(false);setSearchOpen(false);setNotifications(false);}};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);},[]);
  const logout=async()=>{if(loggingOut)return;setLoggingOut(true);invalidateSession();const mode=getApiMode(),generation=sessionRequest.current.generation;try{await api('/api/admin/logout',{method:'POST',mode});if(mode!==getApiMode()||generation!==sessionRequest.current.generation)return;clearSession();setAppScope('all');setNotifications(false);}catch(error){if(mode===getApiMode()&&generation===sessionRequest.current.generation)notify(error.message);}finally{setLoggingOut(false);}};
  const props={user,environment,appScope,notify,navigate,apps,appsLoading:appsResource.loading,appsError:appsResource.error,refreshApps:appsResource.refresh};
  const result=games.filter(g=>`${g.name} ${g.en}`.toLowerCase().includes(query.toLowerCase()));
  if(sessionLoading||sessionError)return <main className="session-screen"><ApiState loading={sessionLoading} error={sessionError} refresh={loadSession}/></main>;
  if(!user)return <Login onLogin={loadSession}/>;
  return <div className="app-shell">
    {mobileNav&&<button className="nav-scrim" aria-label="关闭导航" onClick={()=>setMobileNav(false)}/>}
    <aside className={`sidebar ${mobileNav?'is-open':''}`}>
      <a className="brand" href="#/overview"><img src="/mark.svg" alt=""/><span>Tianhai<small>游戏平台</small></span></a>
      <div className="workspace-label"><span className="workspace-icon"><Building2 size={16}/></span><div>{isPartner?'合作方接入工作台':'游戏平台工作台'}<small>{isPartner?'Partner workspace':'Platform workspace'}</small></div><ChevronDown size={14}/></div>
      <nav aria-label="主导航">{visibleNavigation.map(group=><div className="nav-group" key={group.group}><p>{group.group}</p>{group.items.map(([id,label,Icon])=><a key={id} className={`nav-item ${route===id?'active':''}`} aria-current={route===id?'page':undefined} href={`#/${id}`} onClick={()=>setMobileNav(false)}><Icon size={18}/><span>{label}</span>{id==='games'&&<b>{games.length}</b>}{id==='docs'&&<ArrowUpRight size={14} className="nav-arrow"/>}</a>)}</div>)}</nav>
      <div className="sidebar-bottom"><div className="design-note"><div><span className="pulse-dot"/>{production?'PRODUCTION':'SANDBOX'}</div><strong>从这里，连接每一场精彩。</strong><p>合作方自助接入</p><button onClick={()=>navigate('docs')}>查看接入指南 <ArrowUpRight size={14}/></button></div><button className="sidebar-user" onClick={logout} disabled={loggingOut} aria-label="退出登录"><span className="avatar">{user.name?.[0]||'O'}</span><span>{user.name||user.id}<small>{loggingOut?'正在退出…':'点击退出登录'}</small></span><ArrowUpRight size={16}/></button></div>
    </aside>
    <div className="workspace">
      <header className="topbar"><div className="breadcrumbs"><button className="icon-button mobile-menu" aria-label="打开导航" onClick={()=>setMobileNav(true)}><Menu size={20}/></button><span className="desktop-label">工作台</span><span className="breadcrumb-divider">/</span><strong>{titles[route]}</strong><span className="preview-tag">{environmentLabel}</span></div><div className="topbar-tools"><button className="search-trigger" onClick={()=>setSearchOpen(true)}><Search size={16}/><span>搜索游戏</span><kbd>⌘ K</kbd></button><span className={`environment-switch ${production?'is-live':''}`} aria-label="当前后台环境"><span className="status-dot"/>{environmentLabel}</span><button className="icon-button notification-button" aria-label="通知" aria-expanded={notifications} onClick={()=>setNotifications(v=>!v)}><Bell size={19}/><span/></button><span className="top-avatar">O</span></div>
      {notifications&&<div className="notification-popover"><strong>服务与文档 <small>{environmentLabel}</small></strong><button onClick={()=>navigate('ledger')}><WalletCards size={18}/><span>查看实际局单<small>状态以后台读回记录为准</small></span></button><button onClick={()=>navigate('docs')}><BookOpen size={18}/><span>开发者中心<small>服务健康与接入文档</small></span></button></div>}
      </header>
      <main className="main-content" id="main-content"><div className="context-row"><span><span className="status-dot"/>{environmentLabel} / 后台实际数据</span>{route==='ledger'&&<label>应用范围 <select aria-label="应用范围" value={appScope} onChange={e=>setAppScope(e.target.value)}><option value="all">全部应用</option>{apps.map(app=><option key={app.id} value={app.id}>{app.name}</option>)}</select></label>}</div>
      <>
      {route==='overview'&&<Overview {...props}/>}{route==='games'&&<Games {...props}/>}{route==='partners'&&<Partner {...props}/>}{route==='settings'&&!isPartner&&<Configuration {...props}/>}{route==='ledger'&&<Ledger {...props}/>}{route==='releases'&&!isPartner&&<ReleaseOperations {...props}/>}{route==='docs'&&<Developer {...props}/>}{route==='security'&&<SecurityPanel {...props}/>}</>
      <footer className="workspace-footer"><span><Leaf size={14}/> Tianhai 游戏平台</span><span>平台 v1.0 <i/> 正式运营</span><a href="/specs/partner-integration-production.md" target="_blank" rel="noreferrer">接入指南 <ExternalLink size={12}/></a></footer></main>
    </div>
    {toast&&<div className="toast" role="status"><Check size={18}/><span>{toast}</span><button aria-label="关闭提示" onClick={()=>setToast('')}><X size={14}/></button></div>}
    {searchOpen&&<div className="modal-backdrop" onClick={e=>{if(e.target===e.currentTarget)setSearchOpen(false);}}><section className="search-dialog" role="dialog" aria-modal="true" aria-label="搜索游戏"><div className="search-input"><Search size={20}/><input autoFocus placeholder="搜索名称，例如 Carrom、三消…" value={query} onChange={e=>setQuery(e.target.value)}/><button className="icon-button" aria-label="关闭搜索" onClick={()=>setSearchOpen(false)}><X size={18}/></button></div><div className="search-results">{result.length?result.map(g=><button key={g.id} onClick={()=>{sessionStorage.setItem('oasis-game-focus',g.id);navigate('games');setSearchOpen(false);setQuery('');}}><span className="search-game-dot" style={{background:g.accent}}><Gamepad2 size={16}/></span><span>{g.name}<small>{g.en}</small></span><span className="badge">{g.category==='competitive'?'竞技':'概率'}</span><ArrowUpRight size={16}/></button>):<div className="empty-state">没有找到对应游戏</div>}</div><div className="search-help"><Command size={13}/> 搜索游戏目录 <span>ESC 关闭</span></div></section></div>}
  </div>;
}
