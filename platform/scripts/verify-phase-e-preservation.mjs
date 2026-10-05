import fs from 'node:fs';
import crypto from 'node:crypto';
import pg from 'pg';
const before=JSON.parse(fs.readFileSync(new URL('../.local/phase-e-before.json',import.meta.url))),digest=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
const db=new pg.Pool({connectionString:process.env.OASIS_DATABASE_URL||'postgres://oasis_local@127.0.0.1:5487/oasis_platform'});
try{
 const admins=(await db.query('SELECT * FROM gp_admins ORDER BY id')).rows;
 const users=(await db.query('SELECT u.* FROM wallet_users u JOIN wallet_scopes s USING(scope_id) WHERE s.app_id IN (SELECT id FROM gp_apps) ORDER BY u.scope_id,u.external_user_id')).rows;
 const apps=(await db.query('SELECT id,name,status,game_ids,competitive_fee_bps FROM gp_apps ORDER BY id')).rows;
 const credentialHash=crypto.createHash('sha256').update(fs.readFileSync(new URL('../.local/development-credentials.json',import.meta.url))).digest('hex');
 const checks={adminCredentialsUnchanged:digest(admins)===before.adminsHash,credentialFileUnchanged:credentialHash===before.credentialsHash,existingWalletUsersUnchanged:digest(users)===before.walletUsersHash,existingAppSettingsUnchanged:before.apps.every(p=>apps.some(a=>a.id===p.id&&a.name===p.name&&a.status===p.status&&a.competitive_fee_bps===p.competitive_fee_bps)),defaultGrantsUpgraded:before.apps.every(p=>{const a=apps.find(a=>a.id===p.id);return p.game_ids.length===9?a?.game_ids.length===12:p.game_ids.every(g=>a?.game_ids.includes(g))&&a?.game_ids.length===p.game_ids.length;})};
 const active=(await db.query("SELECT count(*)::int AS n FROM pvp_rooms WHERE status NOT IN ('settled','cancelled','voided')")).rows[0].n;
 const report={at:new Date().toISOString(),checks,existingApps:before.apps.length,existingWalletUsers:users.length,activeRooms:active};
 fs.mkdirSync(new URL('../review/phase-e/',import.meta.url),{recursive:true});fs.writeFileSync(new URL('../review/phase-e/preservation.json',import.meta.url),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 if(Object.values(checks).some(v=>!v))process.exitCode=1;
}finally{await db.end();}
