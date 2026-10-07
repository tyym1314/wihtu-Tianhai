import {ledgerRequest} from './wallet/index.mjs';
import {WalletError} from './wallet/security.mjs';
import {fail} from './security.mjs';

const fields=['partner_id','app_id','environment','wallet_scope_id','currency_id'];
const scopeOf=app=>({partner_id:app.partner_id,app_id:app.id,environment:app.environment,wallet_scope_id:app.wallet_scope_id,currency_id:app.currency_id});
const scopeId=app=>fields.map(field=>scopeOf(app)[field]).join(':');

export function assertPlatformWalletBinding(app,binding){
 if(app.environment!=='production'||binding?.provider!=='platform'||binding.wallet_url!==null||binding.wallet_key_id!==null||app.wallet_url!==''||fields.some(field=>binding.scope?.[field]!==scopeOf(app)[field]))fail(503,'WALLET_BINDING_CHANGED');
}

export async function createPlatformWallet(db,app,actor){
 if(app.environment!=='production'||app.status!=='paused'||app.wallet_url!=='')fail(409,'PLATFORM_WALLET_REQUIRES_PAUSED_PRODUCTION');
 const result=await db.query(`INSERT INTO wallet_scopes(scope_id,partner_id,app_id,environment,wallet_scope_id,currency_id,currency_scale,treasury_available)
  VALUES($1,$2,$3,$4,$5,$6,$7,0) ON CONFLICT DO NOTHING RETURNING scope_id`,[scopeId(app),app.partner_id,app.id,app.environment,app.wallet_scope_id,app.currency_id,app.currency_scale]);
 if(!result.rowCount)fail(409,'PLATFORM_WALLET_SCOPE_EXISTS');
 const binding=(await db.query(`INSERT INTO gp_wallet_bindings(app_id,provider,wallet_url,wallet_key_id,scope,configured_by)
  VALUES($1,'platform',NULL,NULL,$2,$3) RETURNING *`,[app.id,JSON.stringify(scopeOf(app)),actor])).rows[0];
 await db.query("INSERT INTO gp_audit(actor,action,app_id,detail) VALUES($1,'wallet.bound',$2,$3)",[actor,app.id,{provider:'platform',opening_balance_minor:'0',balance_migration:false}]);
 return binding;
}

export async function ensurePlatformWalletAccount(db,appId,playerId,externalUserId){
 const row=(await db.query(`SELECT app.*,binding.provider,binding.scope,binding.wallet_url AS bound_url,binding.wallet_key_id
  FROM gp_apps app LEFT JOIN gp_wallet_bindings binding ON binding.app_id=app.id WHERE app.id=$1`,[appId])).rows[0];
 if(!row)fail(404,'NOT_FOUND');
 if(row.provider!=='platform')return;
 assertPlatformWalletBinding(row,{provider:row.provider,scope:row.scope,wallet_url:row.bound_url,wallet_key_id:row.wallet_key_id});
 const mapped=(await db.query('SELECT 1 FROM gp_player_app_ids WHERE app_id=$1 AND player_id=$2 AND external_user_id=$3',[appId,playerId,externalUserId])).rowCount;
 if(!mapped)fail(403,'SCOPE_FORBIDDEN');
 const inserted=await db.query(`INSERT INTO wallet_users(scope_id,external_user_id,available) VALUES($1,$2,0)
  ON CONFLICT DO NOTHING RETURNING external_user_id`,[scopeId(row),externalUserId]);
 if(inserted.rowCount)await db.query("INSERT INTO gp_audit(actor,action,app_id,detail) VALUES($1,'wallet.account_opened',$2,$3)",[playerId,appId,{external_user_id:externalUserId,opening_balance_minor:'0',provider:'platform'}]);
}

export async function platformWalletRequest(db,app,binding,method,path,raw,requestId){
 assertPlatformWalletBinding(app,binding);
 try{return(await ledgerRequest(db,{scope:scopeOf(app),method,path,raw,requestId})).body;}
 catch(error){if(error instanceof WalletError)fail(error.status,error.code,error.message);throw error;}
}
