import {useState} from 'react';
import {KeyRound,LoaderCircle,ShieldCheck} from 'lucide-react';
import {api,getApiMode} from '../api.js';
import './integration-panel.css';

export default function SecurityPanel({notify=()=>{},onChanged=()=>{}}){
 const [current,setCurrent]=useState(''),[next,setNext]=useState(''),[confirm,setConfirm]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 async function submit(event){
  event.preventDefault();if(busy)return;setError('');
  if(next!==confirm){setError('两次输入的新密码不一致。');return;}
  if(current===next){setError('新密码不能与当前密码相同。');return;}
  setBusy(true);const mode=getApiMode();
  try{await api('/api/admin/password',{method:'POST',body:{current_password:current,new_password:next},mode});setCurrent('');setNext('');setConfirm('');notify('密码已修改，所有旧登录已退出，请使用新密码重新登录。');onChanged();window.dispatchEvent(new CustomEvent('oasis:unauthorized',{detail:{mode}}));}
  catch(e){setError(e.message);setCurrent('');setNext('');setConfirm('');}finally{setBusy(false);}
 }
 return <section className="panel integration-panel" data-testid="security-panel"><div className="ip-heading"><div><div className="portal-kicker"><ShieldCheck size={15}/> ACCOUNT SECURITY</div><h2>修改登录密码</h2><p>修改后将退出这个账号的所有浏览器登录。应用接入密钥和已开始的游戏保持有效。</p></div></div><form className="ip-wallet-form" onSubmit={submit}>
  <label className="field">当前密码<input name="currentPassword" type="password" autoComplete="current-password" required maxLength={256} disabled={busy} value={current} onChange={e=>setCurrent(e.target.value)}/></label>
  <label className="field">新密码<input name="newPassword" type="password" autoComplete="new-password" required minLength={12} maxLength={256} disabled={busy} value={next} onChange={e=>setNext(e.target.value)}/></label>
  <label className="field">再次输入新密码<input name="confirmPassword" type="password" autoComplete="new-password" required minLength={12} maxLength={256} disabled={busy} value={confirm} onChange={e=>setConfirm(e.target.value)}/></label>
  <button className="button button-primary" disabled={busy}>{busy?<LoaderCircle size={15} className="portal-spin"/>:<KeyRound size={15}/>}修改密码并重新登录</button>
  {error&&<div className="portal-form-error" role="alert">{error}</div>}
 </form></section>;
}
