import React,{useEffect,useMemo,useRef,useState} from 'react';
import {OasisHost} from '../../public/sdk/oasis-h5.mjs';
import {ARENA_GAMES} from '../../shared/games.mjs';
import {createPlayerClient,playerMessage,formatPlayerMinor,createPlayerBackBridge,requestPlayerGameBack} from './PlayerClient.mjs';
import './Player.css';

function Credentials({client,canRegister,onLogin,onCancel,reauth=false,username:originalUsername=''}){
 const [register,setRegister]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const submit=async event=>{
  event.preventDefault();if(busy)return;
  const form=event.currentTarget,passwordInput=form.elements.password,fields=new FormData(form),username=String(fields.get('username')||'').trim(),password=String(fields.get('password')||'');
  setBusy(true);setError('');setNotice('');
  try{if(register){await client.register(username,password);setRegister(false);setNotice('账号已注册，请登录。');}else await onLogin(await client.login(username,password));}
  catch(failure){setError(playerMessage(failure));}
  finally{passwordInput.value='';setBusy(false);}
 };
 return <section className="player-auth" aria-label={reauth?'重新登录':'玩家登录'}>
  <h2>{reauth?'重新登录，恢复原游戏':register?'创建玩家账号':'登录游戏大厅'}</h2>
  {reauth&&<p>登录原账号后继续已受理的游戏。</p>}
  <form onSubmit={submit}>
   <label>账号<input name="username" autoComplete="username" required minLength={3} maxLength={64} pattern="[A-Za-z0-9][A-Za-z0-9_.\-]*" autoCapitalize="none" spellCheck="false" disabled={busy} defaultValue={originalUsername} readOnly={reauth}/></label>
   <label>密码<input name="password" type="password" autoComplete={register?'new-password':'current-password'} required minLength={register?12:1} maxLength={256} disabled={busy}/></label>
   {register&&<p className="player-help">账号使用 3–64 位，以英文字母或数字开头，可包含下划线、点和横线；密码 12–256 位。</p>}
   {error&&<p role="alert" className="player-error">{error}</p>}
   {notice&&<p role="status">{notice}</p>}
   <button className="player-primary" disabled={busy}>{busy?'正在处理…':register?'注册账号':'登录'}</button>
  </form>
  {!reauth&&canRegister&&<button className="player-text-button" disabled={busy} onClick={()=>{setRegister(!register);setError('');setNotice('');}}>{register?'已有账号，去登录':'没有账号，创建账号'}</button>}
  {onCancel&&<button disabled={busy} onClick={onCancel}>暂不登录，查看原游戏</button>}
 </section>;
}

function PasswordChange({client,onComplete,onCancel}){
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 const submit=async event=>{
  event.preventDefault();if(busy)return;
  const form=event.currentTarget,current=form.elements.current_password,next=form.elements.new_password;
  setBusy(true);setError('');
  try{await client.changePassword(current.value,next.value);onComplete('密码已修改，请使用新密码重新登录。');}
  catch(failure){
   if(failure.status===401||['CSRF_FORBIDDEN','CREDENTIAL_CHANGED'].includes(failure.code))onComplete('登录状态已变化，请重新登录；若刚才提交过改密，请先尝试新密码。');
   else setError(failure.status?playerMessage(failure):'修改结果未确认。可重新提交；若提示登录已过期，请使用新密码重新登录。');
  }finally{current.value='';next.value='';setBusy(false);}
 };
 return <section className="player-auth" aria-label="修改密码">
  <h2>修改密码</h2><p className="player-help">修改后需要在所有应用中重新登录；已受理的游戏仍可用原账号恢复。</p>
  <form onSubmit={submit}>
   <label>当前密码<input name="current_password" type="password" autoComplete="current-password" required maxLength={256} disabled={busy}/></label>
   <label>新密码<input name="new_password" type="password" autoComplete="new-password" required minLength={12} maxLength={256} disabled={busy}/></label>
   {error&&<p role="alert" className="player-error">{error}</p>}
   <button className="player-primary" disabled={busy}>{busy?'正在修改…':'确认修改'}</button>
  </form>
  <button className="player-text-button" disabled={busy} onClick={onCancel}>取消</button>
 </section>;
}

function MoneyBalance({wallet,loading,error,onRetry}){
 return <section className="player-recovery" aria-label="账户余额">
  <h2>账户余额</h2>
  {loading?<p role="status">正在读取余额…</p>:error?<><p className="player-error" role="alert">余额暂不可用。{error}</p><button onClick={onRetry}>重新读取余额</button></>:wallet&&<div role="status">
   <p>可用 <strong>{formatPlayerMinor(wallet.balance.available_minor,wallet.balance.currency_scale)} {wallet.currency_id}</strong></p>
   <p>冻结 {formatPlayerMinor(wallet.balance.reserved_minor,wallet.balance.currency_scale)} {wallet.currency_id}</p>
  </div>}
 </section>;
}

function PlayerGame({gameId,client,recoveryRevision,onReturn,backHandler,initialSessionId=null}){
 const mount=useRef(null),host=useRef(null),sessionId=useRef(initialSessionId),[revision,setRevision]=useState(0),[state,setState]=useState('loading'),[error,setError]=useState('');
 const requestLaunch=useMemo(()=>client.launchRequester(gameId),[client,gameId]);
 useEffect(()=>{
  const controller=new AbortController();let alive=true;
  setState('loading');setError('');
  const sdk=new OasisHost({platformOrigin:location.origin,gameId,requestLaunch:args=>requestLaunch({...args,resumeSessionId:args.resumeSessionId||sessionId.current,signal:controller.signal}),onEvent:event=>{
   if(!alive)return;
   if(event.type==='loaded'){sessionId.current=sdk.sessionId;setState('loaded');}
   else if(event.type==='return_requested')onReturn();
   else if(event.type==='reauthorizing')setState('loading');
   else if(event.type==='error'){sessionId.current=sdk.sessionId||sessionId.current;setError('连接暂时中断。重试会恢复原游戏；已受理的操作请以游戏内状态为准。');setState('error');}
  }});
  host.current=sdk;sdk.mount(mount.current).catch(failure=>{if(alive){sessionId.current=sdk.sessionId||sessionId.current;setError(playerMessage(failure));setState('error');}});
  return()=>{alive=false;controller.abort();sdk.destroy();host.current=null;};
 },[gameId,client,requestLaunch,revision,recoveryRevision]);
 const back=()=>requestPlayerGameBack({host:host.current,pending:state==='loading',accepted:Boolean(sessionId.current||host.current?.sessionId),onReturn,onBlocked:()=>{
  if(state!=='loading'){setError('原游戏尚未确认返回。请重试连接后从游戏内返回大厅。');setState('error');}
 }});
 useEffect(()=>{backHandler.current=back;return()=>{if(backHandler.current===back)backHandler.current=null;};},[backHandler,back]);
 return <section className="player-game" data-state={state} aria-label={ARENA_GAMES[gameId]?.name||gameId}>
  <div className="player-game-bar"><button onClick={back}>返回大厅</button><strong>{ARENA_GAMES[gameId]?.name||gameId}</strong></div>
  <div className="player-game-mount" ref={mount} aria-busy={state==='loading'}/>
  {state!=='loaded'&&<div className="player-game-status" role="status"><h2>{state==='loading'?'正在连接游戏':'连接未完成'}</h2><p>{state==='error'?error:'请稍候，正在准备游戏画面。'}</p>{state==='error'&&<button className="player-primary" onClick={()=>setRevision(value=>value+1)}>重试连接</button>}</div>}
 </section>;
}

export default function Player(){
 const query=new URLSearchParams(location.search),appId=query.get('app_id'),validApp=query.getAll('app_id').length===1&&/^[-A-Za-z0-9_]{1,128}$/.test(appId||'');
 const [metadata,setMetadata]=useState(null),[session,setSession]=useState(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[gameId,setGameId]=useState(null),[resumeSessionId,setResumeSessionId]=useState(null),[recoverable,setRecoverable]=useState([]),[reauth,setReauth]=useState(false),[recoveryRevision,setRecoveryRevision]=useState(0),[busy,setBusy]=useState(false);
 const [changingPassword,setChangingPassword]=useState(false),[accountNotice,setAccountNotice]=useState('');
 const [wallet,setWallet]=useState(null),[walletLoading,setWalletLoading]=useState(false),[walletError,setWalletError]=useState(''),[walletRevision,setWalletRevision]=useState(0);
 const gameBack=useRef(null),selectedGame=useRef(null);selectedGame.current=gameId;
 const client=useMemo(()=>createPlayerClient({appId,origin:location.origin,onExpired:()=>setReauth(true)}),[appId]);
 const load=async()=>{
  setLoading(true);setError('');
  if(!validApp){setError('链接缺少有效的应用编号，请从应用提供的游戏入口打开。');setLoading(false);return;}
  try{const app=await client.metadata();if(!Array.isArray(app.game_ids)||typeof app.name!=='string'||typeof app.admission_open!=='boolean')throw Error('INVALID_METADATA');setMetadata(app);
   try{setSession(await client.session());setRecoverable((await client.recovery()).sessions);}catch(failure){if(failure.status!==401)throw failure;setSession(null);setRecoverable([]);}
  }catch(failure){setError(playerMessage(failure));}finally{setLoading(false);}
 };
 useEffect(()=>{load();},[client]);
 useEffect(()=>{
  const bridge=createPlayerBackBridge({appId,origin:location.origin,window,requestBack:()=>{
   if(selectedGame.current===null)return false;
   gameBack.current?.();return true;
  }});
  window.OasisPlayerHost=bridge;
  return()=>{if(window.OasisPlayerHost===bridge)delete window.OasisPlayerHost;};
 },[appId]);
 useEffect(()=>{
  const controller=new AbortController();setWallet(null);setWalletError('');setWalletLoading(false);
  if(!session||gameId)return;
  setWalletLoading(true);
  client.wallet({signal:controller.signal}).then(value=>{if(!controller.signal.aborted)setWallet(value);}).catch(failure=>{
   if(controller.signal.aborted)return;
   setWalletError(playerMessage(failure));
   if(failure.status===401){setSession(null);setRecoverable([]);}
  }).finally(()=>{if(!controller.signal.aborted)setWalletLoading(false);});
  return()=>controller.abort();
 },[client,session,gameId,walletRevision]);
 const login=async result=>{setAccountNotice('');if(reauth){setSession(result);setReauth(false);setRecoveryRevision(value=>value+1);}else{const accepted=await client.recovery();setRecoverable(accepted.sessions);setSession(result);}};
 const logout=async()=>{if(busy)return;setBusy(true);setError('');try{await client.logout();setSession(null);}catch(failure){setError(playerMessage(failure));}finally{setBusy(false);}};
 return <main className="player-page">
  {gameId?<PlayerGame key={gameId} gameId={gameId} client={client} backHandler={gameBack} initialSessionId={resumeSessionId} recoveryRevision={recoveryRevision} onReturn={()=>{setGameId(null);setResumeSessionId(null);setReauth(false);load();}}/>:<div className="player-lobby">
   <header className="player-header"><div><span className="player-brand">OASIS</span><h1>{metadata?.name||'游戏大厅'}</h1></div>{session&&<button disabled={busy||changingPassword} onClick={logout}>{busy?'正在退出…':'退出登录'}</button>}</header>
   {accountNotice&&<p role="status" className="player-notice">{accountNotice}</p>}
   {loading?<p role="status">正在读取游戏大厅…</p>:error?<section className="player-notice"><p role="alert">{error}</p><button onClick={load}>重新加载</button></section>:<>
    {!metadata.admission_open&&<p className="player-notice" role="status">此应用暂未开放新游戏和注册。已有未完成对局的玩家可登录后恢复对局。</p>}
    {!session?<Credentials client={client} canRegister={metadata.admission_open} onLogin={login}/>:<>
     <p className="player-welcome">{session.player.username}，选择一款游戏开始。</p>
     <MoneyBalance wallet={wallet} loading={walletLoading} error={walletError} onRetry={()=>setWalletRevision(value=>value+1)}/>
     {changingPassword?<PasswordChange client={client} onCancel={()=>setChangingPassword(false)} onComplete={notice=>{setChangingPassword(false);setAccountNotice(notice);setSession(null);setRecoverable([]);setReauth(false);}}/>:<>
     <button disabled={busy} onClick={()=>{setAccountNotice('');setChangingPassword(true);}}>修改密码</button>
     {recoverable.length>0&&<section className="player-recovery" aria-label="未完成对局"><h2>继续未完成的对局</h2>{recoverable.map(accepted=><button key={accepted.session_id} onClick={()=>{setResumeSessionId(accepted.session_id);setGameId(accepted.game_id);}}>恢复 {ARENA_GAMES[accepted.game_id]?.name||accepted.game_id}</button>)}</section>}
     <div className="player-games">{metadata.game_ids.map(game=><button key={game} className="player-game-card" disabled={!metadata.admission_open} onClick={()=>{setResumeSessionId(null);setGameId(game);}}><span aria-hidden="true">{ARENA_GAMES[game]?.icon||'✦'}</span><strong>{ARENA_GAMES[game]?.name||({thunder:'雷霆',tiger:'虎虎生财'}[game]||game)}</strong><small>{metadata.admission_open?'进入游戏':'暂未开放'}</small></button>)}</div>
     {!metadata.game_ids.length&&<p>此应用暂未开放游戏。</p>}
     </>}
    </>}
   </>}
  </div>}
  {reauth&&gameId&&<div className="player-dialog" role="dialog" aria-modal="true" aria-label="重新登录"><Credentials client={client} canRegister={false} onLogin={login} reauth username={session?.player.username} onCancel={()=>setReauth(false)}/></div>}
 </main>;
}
