import {runGameEnvelope} from '../../shared/run-snapshot-transfer.mjs';

const fields=['requestStartedAtMs','headersObservedAtMs','bodyParsedAtMs','restoredAtMs'];
const isRunRoom=room=>runGameEnvelope(room)&&room.game?.gameId==='run'&&room.game.me===room.me;

// Local observations belong to a returned room object, never its reusable game
// object or serialized authority data. Each client authorization owns its map.
export function createRoomResponseTiming(){
 let rooms=new WeakMap();
 return {
  clear(){rooms=new WeakMap();},
  read(room){return rooms.get(room);},
  record(value,timing){
   const times=fields.map(field=>timing[field]);
   if(times.some((time,index)=>!Number.isFinite(time)||time<0||index>0&&time<times[index-1]))return;
   const observed=Object.freeze(Object.fromEntries(fields.map((field,index)=>[field,times[index]])));
   if(isRunRoom(value))rooms.set(value,observed);
   if(isRunRoom(value?.room))rooms.set(value.room,observed);
  },
 };
}
