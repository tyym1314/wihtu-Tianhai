import {digestRunGame,runGameEnvelope,runGameKeyMaterial,validRunTransfer} from '../../shared/run-snapshot-transfer.mjs';

const roomPath=/^\/api\/pvp\/rooms\/[A-Za-z0-9_-]+$/;
const validKey=key=>typeof key==='string'&&/^[a-f0-9]{64}$/.test(key);
function freezeTree(value){if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.freeze(value);for(const child of Object.values(value))freezeTree(child);}return value;}

// Small per-authorization cache. A request retains its own entry so an older
// poll can still be decoded after a newer response replaces the cache entry.
export function createSnapshotTransfer(){
 const entries=new Map(),runEntries=new Map();let generation=0,runCryptoAvailable=true;
 const refresh=()=>{const error=new Error('Room snapshot needs a full refresh.');error.code='SNAPSHOT_REFRESH_REQUIRED';throw error;};
 const assertCurrent=ticket=>{if(ticket.generation!==generation){const error=new Error('The game session changed. Reopen the room to confirm the last action.');error.code='SESSION_CHANGED';throw error;}};
 return {
  clear(){entries.clear();runEntries.clear();generation++;runCryptoAvailable=true;},
  assertCurrent,
  begin(path,isGet,{full=false}={}){const enabled=isGet&&roomPath.test(path);return {path,generation,entry:enabled&&!full?entries.get(path):undefined,runEntry:enabled&&!full?runEntries.get(path):undefined,runEnabled:enabled&&runCryptoAvailable&&!!globalThis.crypto?.subtle,enabled};},
  async restoreRun(ticket,room){
   assertCurrent(ticket);
   if(!ticket.enabled)return room;
   const meta=room?.run_game_transfer;
   if(meta===undefined){
    if(runGameEnvelope(room)&&!Object.hasOwn(room,'game'))refresh();
    const old=runEntries.get(ticket.path);
    if(old&&(!Number.isSafeInteger(room?.version)||room.version>=old.version))runEntries.delete(ticket.path);
    return room;
   }
   const target=ticket.path.slice(ticket.path.lastIndexOf('/')+1);
   if(!validRunTransfer(meta)||!runGameEnvelope(room)||(target!==room.id&&target!==room.code))refresh();
   const entry=ticket.runEntry;let game;
   if(meta.omitted){
    if(Object.hasOwn(room,'game')||!entry||entry.key!==meta.key||entry.scope!==meta.scope||entry.id!==room.id||entry.me!==room.me||entry.version!==room.version)refresh();
    game=entry.game;
   }else{
    const material=runGameKeyMaterial(room,meta.scope);
    if(material===null||!ticket.runEnabled)refresh();
    let digest;
    try{digest=await digestRunGame(material);}catch{
     // A browser without usable WebCrypto keeps the ordinary complete GET
     // path. Do not make a transfer optimization a gameplay prerequisite.
     assertCurrent(ticket);runCryptoAvailable=false;runEntries.clear();refresh();
    }
    if(digest!==meta.key)refresh();
    // WebCrypto can finish after a new authorization has replaced this one.
    assertCurrent(ticket);game=freezeTree(room.game);
   }
   const prior=runEntries.get(ticket.path);
   if(!prior||room.version>=prior.version){
    runEntries.delete(ticket.path);runEntries.set(ticket.path,{id:room.id,me:room.me,version:room.version,scope:meta.scope,key:meta.key,game});
    while(runEntries.size>2)runEntries.delete(runEntries.keys().next().value);
   }
   return {...room,game};
  },
  restore(ticket,room){
   // A POST may already have been accepted. Discard its old identity's view,
   // without replaying the action; the new session recovers authority state.
   assertCurrent(ticket);
   if(!ticket.enabled)return room;
   const key=room?.legal_actions_key,entry=ticket.entry;
   if(room?.game?.legalActionsOmitted){
    if(!validKey(key)||entry?.key!==key||entry.id!==room.id||entry.me!==room.me){const error=new Error('Room snapshot needs a full refresh.');error.code='SNAPSHOT_REFRESH_REQUIRED';throw error;}
    const {legalActionsOmitted,...game}=room.game;
    room={...room,game:{...game,legalActions:entry.actions}};
   }
   if(ticket.generation===generation){
    const prior=entries.get(ticket.path);
    if(!prior||!Number.isFinite(prior.version)||room.version>=prior.version){
     entries.delete(ticket.path);
     if(validKey(key)&&Array.isArray(room.game?.legalActions)){
      entries.set(ticket.path,{key,id:room.id,me:room.me,version:room.version,actions:freezeTree(room.game.legalActions)});
      while(entries.size>2)entries.delete(entries.keys().next().value);
     }
    }
   }
   return room;
  }
 };
}
