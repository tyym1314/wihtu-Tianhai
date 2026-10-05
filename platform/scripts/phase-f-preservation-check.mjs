import pg from 'pg';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..'),baseline=JSON.parse(await readFile(resolve(root,'.local/phase-f-before.json'),'utf8'));
const sha=v=>createHash('sha256').update(v).digest('hex'),hash=v=>sha(JSON.stringify(v));
const db=new pg.Pool({connectionString:'postgres://oasis_local@127.0.0.1:5487/oasis_platform'});
try{
 const admins=(await db.query('SELECT * FROM gp_admins ORDER BY id')).rows;
 assert.equal(hash(admins),baseline.adminsHash,'original administrator record changed');
 assert.equal(sha(await readFile(resolve(root,'.local/development-credentials.json'))),baseline.credentialHash,'original administrator credential file changed');
 const appIds=baseline.apps.map(a=>a.id),apps=(await db.query('SELECT * FROM gp_apps WHERE id=ANY($1)',[appIds])).rows;
 for(const before of baseline.apps){const app=apps.find(a=>a.id===before.id);for(const [key,value]of Object.entries(before))assert.deepEqual(app[key],value,'original App changed: '+key);}
 const users=(await db.query('SELECT u.* FROM wallet_users u JOIN wallet_scopes s USING(scope_id) WHERE s.app_id=ANY($1) ORDER BY u.scope_id,u.external_user_id',[appIds])).rows;
 assert.equal(users.length,baseline.walletUserCount);assert.equal(hash(users),baseline.walletUsersHash,'original wallet users changed');
 const manifest=JSON.parse(await readFile(resolve(root,'legacy/build-manifest.json'),'utf8'));
 for(const source of manifest.originalSources)assert.equal(sha(await readFile(resolve(root,'..',source.path))),source.sha256,'original game source changed: '+source.path);
 const legacy=[];for(const port of [8787,8790]){const response=await fetch('http://127.0.0.1:'+port+'/');assert.equal(response.status,200);legacy.push({port,status:response.status});}
 const report={at:new Date().toISOString(),passed:true,original_admin_record_unchanged:true,original_admin_credential_file_unchanged:true,original_apps_unchanged:apps.length,original_wallet_users_unchanged:users.length,original_source_files_unchanged:manifest.originalSources.length,original_services:legacy};
 await writeFile(resolve(root,'review/phase-f/preservation.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await db.end();}
