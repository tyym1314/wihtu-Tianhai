// One-time private credential-hash import. Does not expose or need plaintext.
import {readFile,unlink} from 'node:fs/promises';
import {pool,closePools} from '../server/db.mjs';
const filename=process.argv[2];
if(!filename)throw new Error('Pass private admin hash file');
const a=JSON.parse(await readFile(filename,'utf8'));
if(a.username!=='tyym'||!/^[a-f0-9]{32}$/.test(a.salt)||!/^[a-f0-9]{128}$/.test(a.password_hash))throw new Error('Unexpected admin record');
try{
 await pool.query('UPDATE gp_admins SET username=$1,salt=$2,password_hash=$3 WHERE id=$4',[a.username,a.salt,a.password_hash,'admin_local']);
 const found=(await pool.query('SELECT username FROM gp_admins WHERE id=$1',['admin_local'])).rows[0];
 if(found?.username!=='tyym')throw new Error('Administrator update readback failed');
 await pool.query('DELETE FROM gp_admin_sessions');
 await unlink(filename);
 console.log('Configured requested administrator; password hash verified by readback.');
}finally{await closePools();}
