// Transfer identity only; no authority state or clocks are inferred here.
export const RUN_GAME_TRANSFER_SCHEMA='oasis-run-game-v1';
export const isSnapshotKey=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const text=value=>typeof value==='string'&&value.length>0;
export function runGameEnvelope(room){
 return !!room&&room.game_id==='run'&&text(room.id)&&text(room.me)&&Number.isSafeInteger(room.version)&&room.version>=0;
}
export function runGameKeyMaterial(room,scope){
 const game=room?.game;
 if(!runGameEnvelope(room)||!isSnapshotKey(scope)||!game||game.gameId!=='run'||game.me!==room.me||!text(game.ruleVersion)||!text(game.physicsVersion)||!Number.isSafeInteger(game.snapshotTick)||game.snapshotTick<0)return null;
 // Include the whole game, not only version/tick. A same-version content
 // change must produce a different key and therefore a complete response.
 return JSON.stringify([RUN_GAME_TRANSFER_SCHEMA,scope,room.id,room.me,room.version,game]);
}
export function validRunTransfer(value){
 return !!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===4&&value.schema===RUN_GAME_TRANSFER_SCHEMA&&isSnapshotKey(value.scope)&&isSnapshotKey(value.key)&&typeof value.omitted==='boolean';
}
export async function digestRunGame(material){
 const bytes=await globalThis.crypto.subtle.digest('SHA-256',new TextEncoder().encode(material));
 return Array.from(new Uint8Array(bytes),byte=>byte.toString(16).padStart(2,'0')).join('');
}
