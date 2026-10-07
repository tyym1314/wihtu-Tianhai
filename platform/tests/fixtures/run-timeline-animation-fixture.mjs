import * as Engine from '../../arena/run/engine.mjs';
import {makeRunActionReceipt} from '../../shared/run-action-receipt.mjs';
import {createRunHeldBoostFixture,runFixtureTime} from './run-timeline-race-fixture.mjs';

/** Two ordinary accepted actions after the real 180m pickup. The snapshot is
 * taken after the animation has begun, before the server accepts the boost. */
export function createRunAnimatedBoostFixture({animation='right',baseOffset=2,acceptedOffset=4,dispatchMs=0,roomId='animated-boost-race'}={}){
 const {state,playerKey}=createRunHeldBoostFixture(),originTick=state.tick;
 const animationResult=Engine.act(state,playerKey,{type:animation},state.now);
 Engine.tick(state,runFixtureTime(state,originTick+baseOffset));
 const game=Engine.view(state,playerKey);
 const dispatch={token:'animated-boost',roomId,playerKey,request_id:'animated_boost_request',seq:1,type:'item',ruleVersion:state.ruleVersion,dispatchedAtMs:dispatchMs};
 Engine.tick(state,runFixtureTime(state,game.snapshotTick+acceptedOffset));
 const accepted=Engine.act(state,playerKey,{type:'item',observed_tick:game.snapshotTick},state.now);
 const receipt=makeRunActionReceipt({...dispatch,event:accepted.event});
 return {state,game,dispatch,receipt,animationEvent:animationResult.event,acceptedEvent:accepted.event,originTick};
}
