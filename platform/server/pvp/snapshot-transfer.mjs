import {createHash} from 'node:crypto';

// Opt-in transfer optimization only. Authentication and personalized view
// construction must happen before this function; this is never a room cache.
export function compactRoomSnapshot(room,knownKey){
 if(room?.game_id!=='jackaroo'||!Array.isArray(room.game?.legalActions))return room;
 const serialized=JSON.stringify(room.game.legalActions);
 if(Buffer.byteLength(serialized)<16384)return room;
 const key=createHash('sha256').update(JSON.stringify([room.id,room.me,room.game.ruleVersion])).update(serialized).digest('hex');
 if(knownKey!==key)return {...room,legal_actions_key:key};
 const {legalActions,...game}=room.game;
 return {...room,legal_actions_key:key,game:{...game,legalActionsOmitted:true}};
}
