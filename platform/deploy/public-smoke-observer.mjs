const bodyUnavailable=/^response\.json: Protocol error \(Network\.getResponseBody\): No data found for resource with given identifier(?:\nResponse body is not available for a response that was navigated away from\. Read response\.body\(\) before triggering any navigation\.)?$/;
const terminal=status=>['cancelled','settled','voided'].includes(status);

export function classifyReturningRoomBodyLoss({method,path,status,phase,gameFrameRequest,returnStarted,error}){
 if(method!=='GET'||status!==200||!['returning','cleanup'].includes(phase)||gameFrameRequest!==true||returnStarted!==true||!bodyUnavailable.test(String(error?.message||'')))return null;
 return /^\/api\/pvp\/rooms\/([A-Za-z0-9_-]{1,128})$/.exec(path)?.[1]||null;
}

export function proveReturningRoomBodyLoss(loss,{attempt,ownedRoom,frameDetached,terminalReads}){
 if(classifyReturningRoomBodyLoss(loss)!==loss.roomId||!Number.isSafeInteger(loss.order)||frameDetached!==true||attempt?.game!==loss.game||attempt.returned!==true||attempt.acceptedAction!==true||attempt.cleanupComplete!==true||attempt.cleanup?.complete!==true)return null;
 if(!attempt.roomIds?.includes(loss.roomId)||ownedRoom?.id!==loss.roomId||ownedRoom.game_id!==attempt.game||ownedRoom.me!==attempt.guest||ownedRoom.practice!==true||ownedRoom.entry_minor!=='0')return null;
 const cleanup=attempt.cleanup;
 if(cleanup.activeRoomId!==null||cleanup.otherActiveGame!==null||!Array.isArray(cleanup.unresolvedCreations)||cleanup.unresolvedCreations.length)return null;
 const cleaned=cleanup.rooms?.find(room=>room.roomId===loss.roomId&&room.terminal===true&&terminal(room.after)&&!room.error);
 if(!cleaned)return null;
 const readback=terminalReads?.find(read=>Number.isSafeInteger(read.startedOrder)&&read.startedOrder>loss.order&&read.roomId===loss.roomId&&read.game===attempt.game&&read.sessionId===attempt.sessionId&&read.me===attempt.guest&&read.practice===true&&read.entry==='0'&&terminal(read.status));
 return readback?{...readback,cleanupStatus:cleaned.after,frameDetached:true}:null;
}
