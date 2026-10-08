/** Read-only provider inventory. Configuration/readability is not a settlement audit. */
const scopeFields=['partner_id','app_id','environment','wallet_scope_id','currency_id'];
const origin=value=>{try{const u=new URL(value);return !u.username&&!u.password&&!u.search&&!u.hash&&u.pathname==='/'&&[u.origin,u.origin+'/'].includes(value)?u.origin:null;}catch{return null;}};
const walletTables=['wallet_scopes','wallet_users','wallet_operations','wallet_matches','wallet_reservations','wallet_math_profiles','wallet_probability','wallet_events','wallet_ledger','wallet_operation_ids'];
export const DEPENDENCY_APPS_SQL=`SELECT a.id,a.partner_id,a.environment,a.status,a.wallet_scope_id,a.currency_id,a.currency_scale,a.wallet_url,
 b.provider,b.wallet_url AS binding_url,b.wallet_key_id,b.scope AS binding_scope,
 EXISTS(SELECT 1 FROM gp_keys k WHERE k.app_id=a.id AND k.direction='platform-to-wallet' AND k.active AND (b.wallet_key_id IS NULL OR k.id=b.wallet_key_id)) AS wallet_key_ready,
 EXISTS(SELECT 1 FROM wallet_scopes s WHERE s.scope_id=concat_ws(':',a.partner_id,a.id,a.environment,a.wallet_scope_id,a.currency_id) AND s.partner_id=a.partner_id AND s.app_id=a.id AND s.environment=a.environment AND s.wallet_scope_id=a.wallet_scope_id AND s.currency_id=a.currency_id AND s.currency_scale=a.currency_scale) AS ledger_scope_ready,
 (EXISTS(SELECT 1 FROM gp_cycles c WHERE c.app_id=a.id AND c.status NOT IN ('SETTLED','REJECTED')) OR
 EXISTS(SELECT 1 FROM gp_operations o WHERE o.app_id=a.id AND o.state='PENDING') OR
 EXISTS(SELECT 1 FROM pvp_operations o WHERE o.app_id=a.id AND o.state='PENDING') OR
 EXISTS(SELECT 1 FROM pvp_rooms r WHERE r.app_id=a.id AND r.status NOT IN ('settled','cancelled','voided'))) AS has_obligations
 FROM gp_apps a LEFT JOIN gp_wallet_bindings b ON b.app_id=a.id ORDER BY a.id LIMIT 2001`;

export function evaluateWalletDependencies(rows,{environment,referenceOrigin,allowedOrigins=[]}){
 if(!['sandbox','production'].includes(environment)||!Array.isArray(rows)||rows.length>2000)throw Error('DEPENDENCY_INVENTORY_INVALID');
 const codes=new Set(),providers={platform:0,external:0,reference:0,unconfigured:0},allow=new Set(allowedOrigins.map(origin)),reference=origin(referenceOrigin);
 let referenceRequired=false,externalRequired=0;
 for(const a of rows){
  if(a.environment!==environment){codes.add('DATABASE_ENVIRONMENT_MISMATCH');continue;}
  const required=a.status==='active'||a.has_obligations===true;
  if(!['active','paused'].includes(a.status)){codes.add('APP_STATUS_INVALID');continue;}
  const scope={partner_id:a.partner_id,app_id:a.id,environment:a.environment,wallet_scope_id:a.wallet_scope_id,currency_id:a.currency_id};
  if(a.provider!=null&&(!a.binding_scope||scopeFields.some(k=>a.binding_scope[k]!==scope[k])))codes.add('WALLET_BINDING_CHANGED');
  if(a.provider==='platform'){
   providers.platform++;
   if(environment!=='production'||a.wallet_url!==''||a.binding_url!==null||a.wallet_key_id!==null||a.ledger_scope_ready!==true)codes.add('PLATFORM_LEDGER_NOT_READY');
  }else if(a.provider==='external'){
   providers.external++;if(required)externalRequired++;
   const value=origin(a.wallet_url),protocol=value&&new URL(value).protocol;
   if(!value||value!==a.binding_url||!allow.has(value)||value===reference||a.wallet_key_ready!==true||
      (environment==='production'?protocol!=='https:':!['http:','https:'].includes(protocol))||
      (protocol==='http:'&&!['127.0.0.1','[::1]'].includes(new URL(value).hostname)))codes.add('EXTERNAL_WALLET_NOT_CONFIGURED');
  }else if(a.provider==null&&environment==='sandbox'){
   providers.reference++;if(required)referenceRequired=true;
   if(!reference||origin(a.wallet_url)!==reference||a.wallet_key_ready!==true||a.ledger_scope_ready!==true)codes.add('REFERENCE_WALLET_NOT_CONFIGURED');
  }else if(a.provider==null&&environment==='production'){
   providers.unconfigured++;
   if(required||a.wallet_url!=='')codes.add('WALLET_BINDING_REQUIRED');
  }else codes.add('WALLET_PROVIDER_INVALID');
 }
 // No generic external /health contract exists. Never substitute reference-wallet health.
 if(externalRequired)codes.add('EXTERNAL_WALLET_PROBE_REQUIRED');
 return {status:codes.size?'failed':'ok',codes:[...codes].sort(),providers,reference_required:referenceRequired,external_required:externalRequired,external_connectivity:'not_checked'};
}

export async function readWalletDependencies(db,options){
 const identity=(await db.query('SELECT environment FROM gp_runtime_identity WHERE singleton')).rows;
 if(identity.length!==1||identity[0].environment!==options.environment)throw Error('DATABASE_ENVIRONMENT_MISMATCH');
 const tables=(await db.query('SELECT name,to_regclass(\'public.\'||name) AS relation FROM unnest($1::text[]) AS name',[walletTables])).rows;
 if(tables.length!==walletTables.length||tables.some(row=>!row.relation))throw Error('WALLET_SCHEMA_MISSING');
 return evaluateWalletDependencies((await db.query(DEPENDENCY_APPS_SQL)).rows,options);
}

export async function referenceWalletHealth(url,{request,timeoutMs=1000}={}){
 const r=await request(new URL('/health',url).href,{timeoutMs});
 let body;try{body=typeof r.body==='string'?JSON.parse(r.body):r.body;}catch{throw Error('REFERENCE_HEALTH_INVALID');}
 if(r.status!==200||body?.status!=='ok'||body.service!=='reference-partner-wallet'||body.deployment!=='local-reference-not-a-partner-production-wallet')throw Error('REFERENCE_HEALTH_INVALID');
 return {reachable:true};
}

export async function checkWalletDependencies(db,options,{request,timeoutMs=1000}={}){
 const inventory=await readWalletDependencies(db,options);
 if(inventory.reference_required){
  try{await referenceWalletHealth(options.referenceOrigin,{request,timeoutMs});}
  catch{inventory.codes.push('REFERENCE_WALLET_UNAVAILABLE');inventory.status='failed';}
 }
 return inventory;
}
