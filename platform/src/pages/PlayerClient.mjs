export const playerMessage=error=>({
 LOGIN_REQUIRED:'登录已过期，请重新登录后恢复游戏。',
 INVALID_CREDENTIALS:'账号或密码不正确。',
 LOGIN_FAILED:'账号或密码不正确。',
 USERNAME_TAKEN:'这个账号已被注册，请登录或换一个账号。',
 INVALID_USERNAME:'账号需为 3–64 位，以英文字母或数字开头，可包含下划线、点和横线。',
 INVALID_PASSWORD:'请使用 12–256 位的密码。',
 PRODUCTION_ACCEPTANCE_REQUIRED:'当前暂未开放新玩家和新游戏。',
 APP_PAUSED:'这个游戏大厅暂时停止开放。',
 PLAYER_WALLET_NOT_READY:'账号还未准备就绪，请联系应用客服。',
 CSRF_FORBIDDEN:'登录状态已变化，请重新登录。',
 RATE_LIMITED:'操作太频繁，请稍后再试。',
 NOT_FOUND:'此玩家入口暂不可用，请确认应用链接。',
 GAME_DISABLED:'这个游戏暂未开放。',
 GAME_NOT_RELEASED:'这个游戏暂未开放。'
}[error?.code]||(error?.status===429?'操作太频繁，请稍后再试。':'连接暂时未完成，请检查网络后重试。'));

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
   if(value.csrf_token)csrf=value.csrf_token;
   return value;
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
 }
 return {
  metadata:()=>api('app?app_id='+encodeURIComponent(appId)),
  session:()=>api('session'),
  recovery:()=>api('recovery?app_id='+encodeURIComponent(appId)),
  login:(username,password)=>api('login',{body:{app_id:appId,username,password}}),
  register:(username,password)=>api('register',{body:{app_id:appId,username,password}}),
  async logout(){await api('logout',{body:{}});csrf='';},
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
