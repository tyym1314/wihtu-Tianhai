import {ARENA_IDS,LEGACY_IDS,RELEASED_IDS} from '../../shared/games.mjs';
import { useState } from 'react';
import { ArrowRight, LockKeyhole, LoaderCircle, ShieldCheck, Building2 } from 'lucide-react';
import { api, getApiMode, setApiMode } from '../api.js';
import '../components/partner-accounts.css';

export default function Login({ onLogin }) {
  const [mode,setMode]=useState(getApiMode),[username,setUsername]=useState(''),[password,setPassword]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const partner=mode==='partner';
  function choose(next){setMode(next);setPassword('');setError('');}
  async function submit(event){
    event.preventDefault();if(busy)return;setError('');
    if(!username.trim()||!password){setError('请输入用户名和密码。');return;}
    setBusy(true);setApiMode(mode);
    try{const result=await api('/api/admin/login',{method:'POST',body:{username:username.trim(),password},mode});if(result.user?.role!==(partner?'partner_developer':'platform_admin'))throw new Error('后台没有返回对应的有效身份。');setPassword('');onLogin(result.user);}catch(e){setError(e.message);setPassword('');}finally{setBusy(false);}
  }
  return <main className="login-page"><section className="login-story"><a className="brand" href="#/overview"><img src="/mark.svg" alt=""/><span>OASIS<small>GAME PLATFORM</small></span></a><div><div className="eyebrow">YOUR GAMES. ONE PLATFORM.</div><h1>连接每一场精彩，<br/><span>从可信的后台开始。</span></h1><p>应用、游戏与钱包，<br/>在一个清楚可追溯的工作空间里。</p><div className="login-orbit" aria-hidden="true"><span>O</span><i/><b>PLAY · CONNECT · GROW</b></div></div><small>PARTNER WORKSPACE · v0.7</small></section><section className="login-form-side"><form className="login-card" onSubmit={submit}><span className="login-icon">{partner?<Building2 size={25}/>:<LockKeyhole size={25}/>}</span><div className="eyebrow">WELCOME TO OASIS</div><h2>{partner?'登录合作方工作台':'登录管理工作台'}</h2><p>{partner?'使用平台为你创建的合作方账号。':'请输入管理员账号和密码。'}</p><div className="pa-login-modes" role="group" aria-label="选择登录身份"><button type="button" disabled={busy} aria-pressed={!partner} onClick={()=>choose('admin')}>平台管理员</button><button type="button" disabled={busy} aria-pressed={partner} onClick={()=>choose('partner')}>合作方账号</button></div><label className="field">用户名<input name="username" autoComplete="username" value={username} onChange={e=>setUsername(e.target.value)} autoFocus disabled={busy} maxLength={64}/></label><label className="field">密码<input name="password" type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} disabled={busy} maxLength={256}/></label>{error&&<div className="portal-form-error" role="alert">{error}</div>}<button className="button button-primary button-full" disabled={busy}>{busy?<LoaderCircle className="portal-spin" size={17}/>:<ArrowRight size={17}/>} {busy?'正在验证…':'登录工作台'}</button><div className="login-note"><ShieldCheck size={18}/><p>{partner?'仅能管理所属合作方的沙箱应用与接入记录。':'管理员可管理合作方账号、应用授权与平台配置。'}</p></div><span className="login-foot">{RELEASED_IDS.length} 款游戏联调 · 正式运营待接入验收</span></form></section></main>;
}
