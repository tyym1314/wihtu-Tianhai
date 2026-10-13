// Read the same control boundaries as the HUD without advancing simulation.
export function readRunControlState(player,tick){
 return {
  busy:!!player&&(player.fallUntilTick!==null||tick<player.stunUntilTick),
  jumping:player?.jumpStartTick!==null&&tick<(player?.jumpStartTick||0)+48,
  sliding:tick<(player?.slideUntilTick||0),
  changing:tick<(player?.changeEndTick||0),
 };
}

// Frame time/distance never enter the signature. Ordinary motion therefore
// leaves React on its existing clock; a control boundary refreshes the HUD.
export function createRunControlFrameSync(onChange,{exactInputs=false}={}){
 let previous=null;
 return sample=>{
  const player=sample?.pose?.visualPlayer,tick=sample?.pose?.controlTick;
  const {busy,jumping,sliding,changing}=readRunControlState(player,tick);
  const signature=(sample?.mode==='provisional'?1:0)|(busy?2:0)|(jumping?4:0)|(sliding?8:0)|(changing?16:0)
   |(player?.lane===0?32:0)|(player?.lane===2?64:0)|(player?.inventory==='shield'?128:0)|(player?.inventory==='boost'?256:0)
   |(exactInputs?['left','right','jump','slide','item'].reduce((mask,type,index)=>mask|(sample?.inputs?.actions?.[type]?.ok?1<<index:0),0)<<10:0);
  if(signature===previous)return false;
  previous=signature;
  onChange();
  return true;
 };
}

// Read fresh local admission without sampling, renewing authority or dispatching.
export function readRunPracticeControlReadiness(controller,{at,sceneReady,foreground}){
 const inputs=controller?.inputReadiness(at);
 return {ready:sceneReady&&foreground&&inputs?.ready===true,inputs,
  allowed:Object.fromEntries(['left','right','jump','slide','item'].map(type=>[type,sceneReady&&foreground&&inputs?.actions?.[type]?.ok===true]))};
}
export function runInputRejectionMessage(reason,locale='zh'){
 const messages={
  zh:{busy:'正在恢复，请稍候再操作',ground:'请等落地或滑铲结束后再操作',sync:'正在同步比赛，请稍候再试',wait:'当前动作暂不可用，请稍候再试',item:'当前没有可用道具'},
  en:{busy:'Recovering. Try again shortly.',ground:'Wait until landing or sliding ends.',sync:'Syncing the race. Try again shortly.',wait:'This action is unavailable. Try again shortly.',item:'No item is available.'},
  ar:{busy:'جارٍ التعافي. حاول بعد قليل.',ground:'انتظر الهبوط أو نهاية الانزلاق.',sync:'تجري مزامنة السباق. حاول بعد قليل.',wait:'هذه الحركة غير متاحة. حاول بعد قليل.',item:'لا توجد أداة متاحة.'},
 };
 const text=messages[locale]||messages.en;
 return reason==='BUSY'?text.busy:['ALREADY_JUMPING','AIRBORNE','SLIDING'].includes(reason)?text.ground:
  ['provisional-budget-expired','awaiting-new-head','no-authority','transport-stopped','epoch-mismatch','input-expired'].includes(reason)?text.sync:reason==='NO_ITEM'?text.item:text.wait;
}
