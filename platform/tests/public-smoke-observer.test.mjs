import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyReturningRoomBodyLoss,proveReturningRoomBodyLoss} from '../deploy/public-smoke-observer.mjs';

const message='response.json: Protocol error (Network.getResponseBody): No data found for resource with given identifier\nResponse body is not available for a response that was navigated away from. Read response.body() before triggering any navigation.';
const loss=()=>({method:'GET',path:'/api/pvp/rooms/room_owned',status:200,phase:'returning',gameFrameRequest:true,returnStarted:true,error:{message},order:5,game:'golf',roomId:'room_owned'});
function evidence(){return{frameDetached:true,attempt:{game:'golf',guest:'guest_owned',sessionId:'session_owned',returned:true,acceptedAction:true,cleanupComplete:true,roomIds:['room_owned'],cleanup:{complete:true,activeRoomId:null,otherActiveGame:null,unresolvedCreations:[],rooms:[{roomId:'room_owned',terminal:true,after:'cancelled'}]}},ownedRoom:{id:'room_owned',game_id:'golf',me:'guest_owned',practice:true,entry_minor:'0'},terminalReads:[{startedOrder:6,roomId:'room_owned',game:'golf',sessionId:'session_owned',me:'guest_owned',status:'cancelled',practice:true,entry:'0'}]};}

test('only the known return-phase GET room-body protocol failure is a reconciliation candidate',()=>{
 assert.equal(classifyReturningRoomBodyLoss(loss()),'room_owned');
 assert.equal(classifyReturningRoomBodyLoss({...loss(),phase:'cleanup'}),'room_owned');
 for(const patch of [{method:'POST'},{method:'PUT'},{status:201},{status:500},{phase:'playing'},{phase:'entry'},{phase:'lobby'},{gameFrameRequest:false},{returnStarted:false},{path:'/api/pvp/rooms'},{path:'/api/pvp/rooms/room_owned/action'},{path:'/api/play/tiger/spin'},{path:'/api/pvp/rooms/room_owned?poll=1'},{error:{message:'Unexpected end of JSON input'}},{error:{message:'response.json: Target page, context or browser has been closed'}},{error:{message:'Protocol error (Network.getResponseBody): No data found for resource with given identifier'}},{error:{message:message+'\nOther unrelated failure'}}])assert.equal(classifyReturningRoomBodyLoss({...loss(),...patch}),null,JSON.stringify(patch));
});

test('known body loss passes only with exact subsequent authenticated terminal readback and complete owned-room cleanup',()=>{
 const proof=proveReturningRoomBodyLoss(loss(),evidence());assert.equal(proof.roomId,'room_owned');assert.equal(proof.frameDetached,true);assert.equal(proof.cleanupStatus,'cancelled');
});

test('missing return, detach, accepted action, ownership or cleanup evidence remains a failure',()=>{
 const variants=[
  value=>value.frameDetached=false,
  value=>value.attempt.returned=false,
  value=>value.attempt.acceptedAction=false,
  value=>value.attempt.cleanupComplete=false,
  value=>value.attempt.cleanup.complete=false,
  value=>value.attempt.cleanup.activeRoomId='room_owned',
  value=>value.attempt.cleanup.otherActiveGame='match',
  value=>value.attempt.cleanup.unresolvedCreations=[{requestId:'uncertain'}],
  value=>delete value.attempt.cleanup.unresolvedCreations,
  value=>value.attempt.cleanup.rooms[0].terminal=false,
  value=>value.attempt.cleanup.rooms[0].after='active',
  value=>value.attempt.cleanup.rooms[0].error={message:'leave failed'},
  value=>value.attempt.cleanup.rooms[0].roomId='other_room',
  value=>value.attempt.roomIds=[],
  value=>value.ownedRoom.id='other_room',
  value=>value.ownedRoom.me='other_guest',
  value=>value.ownedRoom.game_id='match',
  value=>value.ownedRoom.practice=false,
  value=>value.ownedRoom.entry_minor='1000',
  value=>value.ownedRoom=null
 ];
 for(const change of variants){const value=evidence();change(value);assert.equal(proveReturningRoomBodyLoss(loss(),value),null,String(change));}
});

test('terminal data from an earlier request, another App session, guest, game or room cannot replace the lost response',()=>{
 for(const patch of [{startedOrder:4},{startedOrder:5},{startedOrder:NaN},{roomId:'other_room'},{game:'match'},{sessionId:'other_session'},{me:'other_guest'},{status:'active'},{practice:false},{entry:'1000'}]){
  const value=evidence();Object.assign(value.terminalReads[0],patch);assert.equal(proveReturningRoomBodyLoss(loss(),value),null,JSON.stringify(patch));
 }
 const value=evidence();value.terminalReads=[];assert.equal(proveReturningRoomBodyLoss(loss(),value),null);
 assert.equal(proveReturningRoomBodyLoss({...loss(),method:'POST'},evidence()),null);
 assert.equal(proveReturningRoomBodyLoss({...loss(),roomId:'other_room'},evidence()),null);
});
