/** Presentation only. No timeout callback is required to unlock controls. */
export const DICE_ROLL_MS=580;
export function ludoDicePresentation(game,roomId,roomStatus,now){
 const event=game?.lastEvent,age=Number.isFinite(event?.at)?now-event.at:Infinity;
 const live=String(roomStatus).toLowerCase()==='active'&&game?.status==='active';
 const rolling=live&&event?.type==='roll'&&game.turnKey===event.playerKey&&age>=0&&age<DICE_ROLL_MS;
 return{rolling,eventKey:rolling?`${roomId}:${game.ruleVersion}:${event.id}:${event.type}:${event.at}`:null};
}
export function ludoAutoPassReason(game,now){
 if(!(now<(game?.busyUntil||0)))return null;
 const event=game.lastEvent;
 return event?.type==='auto-pass'?event.reason:event?.type==='roll'?event.autoPassReason||null:null;
}
