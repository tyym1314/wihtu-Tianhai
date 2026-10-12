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
export function createRunControlFrameSync(onChange){
 let previous=null;
 return sample=>{
  const player=sample?.pose?.visualPlayer,tick=sample?.pose?.controlTick;
  const {busy,jumping,sliding,changing}=readRunControlState(player,tick);
  const signature=(sample?.mode==='provisional'?1:0)|(busy?2:0)|(jumping?4:0)|(sliding?8:0)|(changing?16:0)
   |(player?.lane===0?32:0)|(player?.lane===2?64:0)|(player?.inventory==='shield'?128:0)|(player?.inventory==='boost'?256:0);
  if(signature===previous)return false;
  previous=signature;
  onChange();
  return true;
 };
}
