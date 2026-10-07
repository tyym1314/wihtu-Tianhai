import {createHash} from 'node:crypto';
import {RUN_GAME_TRANSFER_SCHEMA,isSnapshotKey,runGameKeyMaterial} from '../../shared/run-snapshot-transfer.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
function compactRunGame(room,known,session){
 // Only a validated GET caller opts in. Never retain personalized server
 // responses, trust a client identity, or use this as an authentication cache.
 if(known!=='full'&&!isSnapshotKey(known))return room;
 if(!session||typeof session.app_id!=='string'||!session.app_id||session.game_id!=='run'||session.external_user_id!==room?.me)return room;
 const scope=hash(JSON.stringify([RUN_GAME_TRANSFER_SCHEMA,session.app_id,session.game_id,session.external_user_id]));
 const material=runGameKeyMaterial(room,scope);if(material===null)return room;
 const key=hash(material),meta={schema:RUN_GAME_TRANSFER_SCHEMA,scope,key,omitted:known===key};
 if(!meta.omitted)return {...room,run_game_transfer:meta};
 const {game,...outer}=room;
 return {...outer,run_game_transfer:meta};
}

// Opt-in transfer optimization only. Authentication and personalized view
// construction must happen before this function; this is never a room cache.
export function compactRoomSnapshot(room,knownKey,{runKey,session}={}){
 if(room?.game_id==='run')return compactRunGame(room,runKey,session);
 if(room?.game_id!=='jackaroo'||!Array.isArray(room.game?.legalActions))return room;
 const serialized=JSON.stringify(room.game.legalActions);
 if(Buffer.byteLength(serialized)<16384)return room;
 const key=createHash('sha256').update(JSON.stringify([room.id,room.me,room.game.ruleVersion])).update(serialized).digest('hex');
 if(knownKey!==key)return {...room,legal_actions_key:key};
 const {legalActions,...game}=room.game;
 return {...room,legal_actions_key:key,game:{...game,legalActionsOmitted:true}};
}
