/** Single-game shell for the native App. All play and return decisions stay in the game/SDK. */
export const NATIVE_GAME_IDS = Object.freeze(['match','golf','carrom','darts','ludo','jackaroo','domino','pool','bowling','run','towerlink','thunder','tiger']);

export function createNativeGameHost({window,document,OasisHost,fetch=window.fetch.bind(window),navigate=url=>window.location.replace(url)}) {
 const gameId=document.body.dataset.game,origin=window.location.origin;
 if(!NATIVE_GAME_IDS.includes(gameId)||window.location.pathname!==`/demo/native/${gameId}`)throw new Error('Invalid native game route');
 const mount=document.querySelector('#native-game'),status=document.querySelector('#native-status'),title=document.querySelector('#native-status-title'),message=document.querySelector('#native-status-message'),back=document.querySelector('#native-back');
 if(!mount||!status||!title||!message||!back)throw new Error('Native game shell is incomplete');
 const returnUrl=new URL('/demo/native-return',origin).href,requests=new Set();
 let sdk=null,config=null,disposed=false,leaving=false,startPromise=null;
 function show(kind){
  if(disposed||leaving)return;
  status.hidden=false;status.dataset.state=kind;
  title.textContent=kind==='error'?'游戏暂时无法连接':kind==='reauthorizing'?'正在恢复连接':'正在进入游戏';
  message.textContent=kind==='error'?'请返回 App 后重新进入。':'请稍候，正在准备游戏画面。';
  mount.setAttribute('aria-busy',kind==='error'?'false':'true');
 }
 function dispose(){
  if(disposed)return;disposed=true;
  for(const controller of requests)controller.abort();requests.clear();
  sdk?.destroy();window.removeEventListener('pagehide',dispose);
 }
 function leave(){if(leaving)return;leaving=true;dispose();navigate(returnUrl);}
 function requestBack(){
  if(disposed||leaving)return true;
  if(sdk?.loaded&&!sdk.closed){
   // Let the game show its own confirmation/recovery UI. The overlay must not
   // obscure that confirmation. Only its authenticated SDK return can exit.
   status.hidden=true;sdk.requestBack();
  }else leave();
  return true;
 }
 Object.defineProperty(window,'OasisNativeHost',{value:Object.freeze({requestBack}),writable:false,configurable:false});
 back.addEventListener('click',requestBack);window.addEventListener('pagehide',dispose);
 async function json(url,options={}){
  if(disposed)throw new Error('Host closed');
  const controller=new AbortController();requests.add(controller);
  const timer=setTimeout(()=>controller.abort(),8000);
  try{
   const response=await fetch(url,{credentials:'same-origin',cache:'no-store',...options,signal:controller.signal});
   const body=await response.json();
   if(!response.ok)throw Object.assign(new Error('Game connection failed'),{status:response.status});
   return body;
  }finally{clearTimeout(timer);requests.delete(controller);}
 }
 async function requestLaunch({gameId:requested,resumeSessionId}){
  if(requested!==gameId)throw new Error('Game selection changed');
  const body={game_id:gameId,request_id:window.crypto.randomUUID().replaceAll('-',''),...(resumeSessionId?{resume_session_id:resumeSessionId}:{})};
  for(let attempt=0;attempt<2;attempt++){
   try{return await json('/api/demo/launch',{method:'POST',headers:{'content-type':'application/json','x-host-csrf':config.csrf},body:JSON.stringify(body)});}
   catch(error){if(disposed||attempt===1||error.status&&error.status<500&&error.status!==408)throw error;}
  }
 }
 function onEvent(event){
  if(disposed||leaving)return;
  if(event.type==='loaded'){status.hidden=true;mount.setAttribute('aria-busy','false');}
  else if(event.type==='return_requested')leave();
  else if(event.type==='reauthorizing')show('reauthorizing');
  else if(event.type==='error')show('error');
 }
 async function boot(){
  show('loading');
  try{
   config=await json('/api/demo/config');
   if(disposed)return;
   if(config.platform_origin!==origin||!/^[a-f0-9]{64}$/.test(config.csrf||''))throw new Error('Invalid host configuration');
   sdk=new OasisHost({platformOrigin:origin,gameId,requestLaunch,onEvent});
   await sdk.mount(mount);
  }catch{show('error');}
 }
 return Object.freeze({start(){return startPromise??=boot();},requestBack,dispose});
}
