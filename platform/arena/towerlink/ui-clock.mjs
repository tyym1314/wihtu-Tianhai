const remaining=(deadline,now)=>Number.isFinite(deadline)?Math.max(0,Math.ceil((deadline-now)/1000)):0;
/** The canvas owns smooth time; React owns visible seconds and control edges. */
export function towerUiClockKey(game,now,localNow,lastReceipt){
 return JSON.stringify([
  remaining(game.deadlineAt,now),remaining(game.startedAt,now),now<(game.startedAt??0),
  now<(game.busyUntil??0),localNow-lastReceipt>8000,
  ...(game.towers??[]).map(tower=>remaining(tower.upgrade?.completesAt,now)),
 ]);
}
