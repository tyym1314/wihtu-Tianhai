/** Check the latest confirmed runner plus the current server clock at dispatch. */
export function canSendRunInput(game,key,type,serverNow){
 const p=game?.players?.find(player=>player.key===key);
 if(game?.status!=='active'||game.ruleVersion==='pvp-run-v2.1.0'&&!['racing','finish-window'].includes(game.phase)||!p||p.forfeited||p.finishTick!==null||serverNow<game.startedAt||serverNow>=game.deadlineAt)return false;
 const tick=Math.max(game.snapshotTick,(serverNow-game.startedAt)*.06);
 if(p.fallUntilTick!==null||tick<p.stunUntilTick)return false;
 if(type==='left'||type==='right')return tick>=p.changeEndTick&&(type==='left'?p.lane>0:p.lane<2);
 const jumping=p.jumpStartTick!==null&&tick<p.jumpStartTick+48,sliding=tick<p.slideUntilTick;
 if(type==='jump'||type==='slide')return !jumping&&!sliding;
 return type==='item'&&!!p.inventory&&!(p.inventory==='boost'&&tick<p.boostUntilTick);
}
