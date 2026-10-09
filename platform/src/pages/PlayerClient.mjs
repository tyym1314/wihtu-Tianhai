export const playerMessage=error=>({
 LOGIN_REQUIRED:'登录已过期，请重新登录后恢复游戏。',
 INVALID_CREDENTIALS:'账号或密码不正确。',
 LOGIN_FAILED:'账号或密码不正确。',
 USERNAME_TAKEN:'这个账号已被注册，请登录或换一个账号。',
 INVALID_USERNAME:'账号需为 3–64 位，以英文字母或数字开头，可包含下划线、点和横线。',
 INVALID_PASSWORD:'请使用 12–256 位的密码。',
 CURRENT_PASSWORD_INVALID:'当前密码不正确，请重新输入。',
 PASSWORD_UNCHANGED:'新密码不能与当前密码相同。',
 CREDENTIAL_CHANGED:'账号凭证已变化，请重新登录。',
 PRODUCTION_ACCEPTANCE_REQUIRED:'当前暂未开放新玩家和新游戏。',
 APP_PAUSED:'这个游戏大厅暂时停止开放。',
 PLAYER_WALLET_NOT_READY:'账号还未准备就绪，请联系应用客服。',
 CSRF_FORBIDDEN:'登录状态已变化，请重新登录。',
 RATE_LIMITED:'操作太频繁，请稍后再试。',
 NOT_FOUND:'此玩家入口暂不可用，请确认应用链接。',
 GAME_DISABLED:'这个游戏暂未开放。',
 GAME_NOT_RELEASED:'这个游戏暂未开放。'
}[error?.code]||(error?.status===429?'操作太频繁，请稍后再试。':'连接暂时未完成，请检查网络后重试。'));

const identifier=value=>typeof value==='string'&&/^[-A-Za-z0-9_]{1,128}$/.test(value);
const minor=value=>typeof value==='string'&&/^(0|[1-9][0-9]{0,18})$/.test(value)&&BigInt(value)<=9223372036854775807n;
export function formatPlayerMinor(value,scale){
 if(!minor(value)||!Number.isInteger(scale)||scale<0||scale>6)return '—';
 const digits=value.padStart(scale+1,'0'),whole=(scale?digits.slice(0,-scale):digits).replace(/\B(?=(\d{3})+(?!\d))/g,',');
 return whole+(scale?'.'+digits.slice(-scale):'');
}
function validatePlayerWallet(value,appId){
 const balance=value?.balance;
 if(value?.app_id!==appId||value?.environment!=='production'||!identifier(value.currency_id)||!identifier(value.partner_id)||!identifier(value.wallet_scope_id)||
  !identifier(balance?.external_user_id)||!minor(balance.available_minor)||!minor(balance.reserved_minor)||!minor(balance.ledger_version)||
  !Number.isInteger(balance.currency_scale)||balance.currency_scale<0||balance.currency_scale>6||typeof value.as_of!=='string'||!Number.isFinite(Date.parse(value.as_of)))
  throw Object.assign(new Error('INVALID_WALLET_BALANCE'),{code:'WALLET_INVALID_BALANCE'});
 return value;
}

/** Native presentation bridge; the existing game host keeps return authority. */
export function createPlayerBackBridge({appId,origin,window:hostWindow,requestBack}){
 return Object.freeze({requestBack(){
  const location=hostWindow.location;
  if(hostWindow!==hostWindow.top||!identifier(appId)||!origin.startsWith('https://')||location.origin!==origin||location.pathname!=='/player'||location.hash||location.search!=='?app_id='+appId)return false;
  return requestBack()===true;
 }});
}

export function requestPlayerGameBack({host,pending,accepted,onReturn,onBlocked}){
 if(host?.loaded&&!host.closed){host.requestBack();return;}
 if(pending||accepted){onBlocked();return;}
 onReturn();
}

export function createPlayerClient({appId,origin,fetch=globalThis.fetch.bind(globalThis),requestId=()=>crypto.randomUUID().replaceAll('-',''),timeoutMs=8000,onExpired=()=>{}}){
 let csrf='';
 async function api(path,{body,signal}={}){
  const controller=new AbortController(),abort=()=>controller.abort();
  if(signal?.aborted)controller.abort();else signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(abort,timeoutMs);
  try{
   const response=await fetch('/api/player/'+path,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',signal:controller.signal,
    headers:body===undefined?{}:{'content-type':'application/json',...(csrf?{'x-oasis-csrf':csrf}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
   let value;try{value=await response.json();}catch{throw Object.assign(new Error('INVALID_RESPONSE'),{status:response.status});}
   if(!response.ok){const error=Object.assign(new Error('PLAYER_REQUEST_FAILED'),{status:response.status,code:value?.error?.code});if((error.status===401&&path==='launch')||error.code==='CSRF_FORBIDDEN')onExpired();throw error;}
   if(value?.csrf_token)csrf=value.csrf_token;
   return value;
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
 }
 return {
  metadata:()=>api('app?app_id='+encodeURIComponent(appId)),
  session:()=>api('session'),
  recovery:()=>api('recovery?app_id='+encodeURIComponent(appId)),
  wallet:async({signal}={})=>validatePlayerWallet(await api('wallet?app_id='+encodeURIComponent(appId),{signal}),appId),
  login:(username,password)=>api('login',{body:{app_id:appId,username,password}}),
  register:(username,password)=>api('register',{body:{app_id:appId,username,password}}),
  async logout(){await api('logout',{body:{}});csrf='';},
  async changePassword(currentPassword,newPassword){
   const result=await api('password',{body:{current_password:currentPassword,new_password:newPassword}});
   if(result.ok!==true||result.reauthenticate!==true)throw new Error('INVALID_RESPONSE');
   csrf='';return result;
  },
  launchRequester(gameId){
   let pending=null;
   return async({gameId:requested,resumeSessionId,signal}={})=>{
    if(requested!==gameId)throw new Error('GAME_SELECTION_CHANGED');
    const resume=resumeSessionId||null;
    if(!pending||pending.resume!==resume)pending={resume,body:{app_id:appId,game_id:gameId,request_id:requestId(),locale:'zh-CN',host_platform:'web',host_origin:origin,...(resume?{resume_session_id:resume}:{})}};
    const intent=pending;
    for(let attempt=0;attempt<2;attempt++)try{
     const result=await api('launch',{body:intent.body,signal});pending=null;return result;
    }catch(error){if(signal?.aborted||attempt===1||error.status&&error.status<500&&![408,429].includes(error.status))throw error;if(error.status===429)throw error;}
   };
  }
 };
}
