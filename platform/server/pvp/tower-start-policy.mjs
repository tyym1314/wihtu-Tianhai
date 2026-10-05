/** Coordinator policy for newly created solo BOT practice; never migrate old rooms. */
export const TOWER_PRACTICE_START_POLICY='towerlink-practice-start-v1';
export const TOWER_PRACTICE_START_DELAY_MS=1000;
const policyRuleVersion='towerlink-v2.2.0';
function eligible(room){
 const players=room?.players,terms=room?.terms;
 return room?.game_id==='towerlink'&&room.practice===true&&room.entry_minor==='0'&&room.fee_bps===0
  &&room.rule_version===policyRuleVersion&&terms?.rule_version===policyRuleVersion&&terms?.game_id==='towerlink'
  &&terms.entry_minor==='0'&&terms.fee_bps===0&&terms.player_count===room.capacity
  &&[2,3,4].includes(room.capacity)&&Array.isArray(players)&&players.length===room.capacity
  &&players.every(p=>p&&typeof p.external_user_id==='string'&&p.external_user_id.length>0&&typeof p.bot==='boolean')
  &&new Set(players.map(p=>p.external_user_id)).size===players.length
  &&players.filter(p=>p.bot===false).length===1&&players.filter(p=>p.bot===true).length===players.length-1;
}
/** Call only while inserting a new room, with server-normalized terms and roster. */
export function newTowerPracticeStartOptions(room){
 return eligible(room)?{start_policy:TOWER_PRACTICE_START_POLICY,start_delay_ms:TOWER_PRACTICE_START_DELAY_MS}:{};
}
export function roomStartDelayMs(room){
 if(room?.game_id!=='towerlink')return 0;
 const options=room.game_options;
 return eligible(room)&&options?.start_policy===TOWER_PRACTICE_START_POLICY&&options.start_delay_ms===TOWER_PRACTICE_START_DELAY_MS?TOWER_PRACTICE_START_DELAY_MS:3000;
}
