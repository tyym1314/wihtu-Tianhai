import {pool} from '../db.mjs';
import {command} from '../cycles.mjs';
import {mergedProbability} from '../wallet-binding.mjs';

export const MERGED_PROBABILITY='/wallet/v1/probability/authorize-accept';
/**
 * Fund a casino cycle: authorize the stake and full liability, then accept (no cancel after this).
 * simple-v1 Apps do both in one wallet transaction (one operation 'accept_<cycle>'); other wallets, and
 * cycles already started with the two-step protocol, use 'authorize_<cycle>' then 'accept_<cycle>'.
 */
export async function openProbability(app,cycleId,authorizeBody){
 const legacy=(await pool.query('SELECT 1 FROM gp_operations WHERE id=$1',['authorize_'+cycleId])).rowCount;
 if(!legacy&&await mergedProbability(app))return command(app,cycleId,MERGED_PROBABILITY,{...authorizeBody,request_id:'accept_'+cycleId});
 await command(app,cycleId,'/wallet/v1/probability/authorize',{...authorizeBody,request_id:'authorize_'+cycleId});
 const {partner_id,app_id,environment,wallet_scope_id,currency_id,authorization_id,cycle_id}=authorizeBody;
 return command(app,cycleId,'/wallet/v1/probability/accept',{partner_id,app_id,environment,wallet_scope_id,currency_id,authorization_id,cycle_id,request_id:'accept_'+cycleId});
}
