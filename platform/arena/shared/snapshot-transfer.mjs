const roomPath=/^\/api\/pvp\/rooms\/[A-Za-z0-9_-]+$/;
const validKey=key=>typeof key==='string'&&/^[a-f0-9]{64}$/.test(key);
function freezeTree(value){if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.freeze(value);for(const child of Object.values(value))freezeTree(child);}return value;}

// Small per-authorization cache. A request retains its own entry so an older
// poll can still be decoded after a newer response replaces the cache entry.
export function createSnapshotTransfer(){
 const entries=new Map();let generation=0;
 const assertCurrent=ticket=>{if(ticket.generation!==generation){const error=new Error('The game session changed. Reopen the room to confirm the last action.');error.code='SESSION_CHANGED';throw error;}};
 return {
  clear(){entries.clear();generation++;},
  assertCurrent,
  begin(path,isGet){return {path,generation,entry:isGet&&roomPath.test(path)?entries.get(path):undefined,enabled:isGet&&roomPath.test(path)};},
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
