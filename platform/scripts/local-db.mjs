import {spawnSync} from 'node:child_process';
import {existsSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
const data=resolve('.local/postgres'),log=resolve('.local/postgres.log');
const bin=process.env.OASIS_PG_BIN||'/opt/homebrew/bin';
function run(command,args,allowFailure=false){const r=spawnSync(`${bin}/${command}`,args,{stdio:'inherit'});if(r.status!==0&&!allowFailure)process.exit(r.status||1);return r.status;}
mkdirSync(resolve('.local'),{recursive:true,mode:0o700});
if(!existsSync(data+'/PG_VERSION'))run('initdb',['-D',data,'-A','trust','-U','oasis_local','--no-locale','-E','UTF8']);
if(process.argv[2]==='stop'){run('pg_ctl',['-D',data,'stop','-m','fast']);process.exit(0);}
if(run('pg_ctl',['-D',data,'status'],true)!==0)run('pg_ctl',['-D',data,'-l',log,'-o','-p 5487 -h 127.0.0.1 -k /tmp','start']);
const check=spawnSync(`${bin}/psql`,['-h','127.0.0.1','-p','5487','-U','oasis_local','-d','postgres','-tAc',"SELECT 1 FROM pg_database WHERE datname='oasis_platform'"],{encoding:'utf8'});
if(check.status!==0)process.exit(check.status||1);
if(check.stdout.trim()!=='1')run('createdb',['-h','127.0.0.1','-p','5487','-U','oasis_local','oasis_platform']);
console.log('Isolated local PostgreSQL ready on 127.0.0.1:5487');
