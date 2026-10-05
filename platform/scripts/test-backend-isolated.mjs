/** Full-suite safety wrapper. Never defaults wallet.integration to a working database. */
import pg from 'pg';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {dropOwnedTestDatabase} from '../tests/database-cleanup.mjs';

const adminURL=new URL(process.env.OASIS_TEST_ADMIN_DATABASE_URL||'postgres://oasis_local@127.0.0.1:5487/postgres');
if(!['127.0.0.1','localhost','[::1]'].includes(adminURL.hostname))throw Error('ISOLATED_LOCAL_POSTGRES_REQUIRED');
adminURL.pathname='/postgres';
const name=`oasis_release_test_${process.pid}_${randomBytes(6).toString('hex')}`;
const url=new URL(adminURL);url.pathname='/'+name;
const admin=new pg.Pool({connectionString:adminURL.href,max:1});
let created=false,privateDir,child;
try {
  await admin.query(`CREATE DATABASE ${name}`);created=true;
  privateDir=await mkdtemp(join(tmpdir(),'oasis-release-test-'));
  child=spawn('npm',['run','test:backend'],{cwd:new URL('../',import.meta.url),stdio:'inherit',env:{...process.env,
    DATABASE_URL:url.href,OASIS_DATABASE_URL:url.href,OASIS_LOCAL_DIR:privateDir,OASIS_TEST_ADMIN_DATABASE_URL:adminURL.href}});
  const stop=()=>child.kill('SIGTERM');process.once('SIGINT',stop);process.once('SIGTERM',stop);
  process.exitCode=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve(code??1));});
  process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
} finally {
  try{if(created){await dropOwnedTestDatabase(admin,name,{created});console.log('Full-suite isolated database removed.');}}
  finally{await admin.end();if(privateDir)await rm(privateDir,{recursive:true,force:true});}
}
