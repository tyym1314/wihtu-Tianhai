import {acquireRunImageSource} from './asset-sources.mjs';
import {runAssetAborted} from './source-cache.mjs';

const kinds=['fox','cat','bear','rabbit'];
export function runLobbyCharacter(room,player,index=0){
 const assigned=room?.game?.players?.find(runner=>runner.key===player?.external_user_id)?.character;
 if(kinds.includes(assigned))return assigned;
 const seat=Number.isSafeInteger(player?.seat_index)&&player.seat_index>=0?player.seat_index:index;
 return kinds[seat%kinds.length]||kinds[0];
}
export const runLobbyPortraitPosition=kind=>`100% ${Math.max(0,kinds.indexOf(kind))*100/3}%`;
/** The waiting room owns only this URL; source bytes remain shared with Run. */
export async function createRunLobbyPortraitLease(url,{signal}={}){
 const blob=await acquireRunImageSource(url,{signal});
 if(signal?.aborted)throw runAssetAborted(signal);
 const objectURL=URL.createObjectURL(blob);let disposed=false;
 return{url:objectURL,dispose(){if(disposed)return;disposed=true;URL.revokeObjectURL(objectURL);}};
}
